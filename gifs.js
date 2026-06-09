const express = require('express');
const { pool } = require('./db');
const { authenticate } = require('./auth');
const { bufferToBase64 } = require('./fileStorage');

const router = express.Router();

const TENOR_BASE = 'https://tenor.googleapis.com/v2';
const GIPHY_BASE = 'https://api.giphy.com/v1/gifs';
const TENOR_CLIENT_KEY = 'eganira';
const MAX_GIF_BYTES = 8 * 1024 * 1024;

let deps = null;

function initGifRoutes(dependencies) {
  deps = dependencies;
}

function getGiphyKey() {
  return process.env.GIPHY_API_KEY?.trim() || null;
}

function getTenorKey() {
  return process.env.TENOR_API_KEY?.trim() || null;
}

function getGifProvider() {
  if (getGiphyKey()) return 'giphy';
  if (getTenorKey()) return 'tenor';
  return null;
}

function mapGiphyResults(data) {
  return (data?.data || []).map((item) => {
    const images = item.images || {};
    const gif = images.downsized || images.fixed_height || images.original;
    const preview = images.preview_gif || images.fixed_width || images.fixed_height_small || gif;
    if (!gif?.url) return null;
    return {
      id: item.id,
      title: item.title || 'GIF',
      previewUrl: preview?.url || gif.url,
      gifUrl: gif.url,
      width: parseInt(gif.width, 10) || null,
      height: parseInt(gif.height, 10) || null,
    };
  }).filter(Boolean);
}

function mapTenorResults(data) {
  const results = data?.results || [];
  return results.map((item) => {
    const formats = item.media_formats || {};
    const gif = formats.gif || formats.mediumgif || formats.tinygif;
    const preview = formats.tinygif || formats.nanogif || formats.gif;
    if (!gif?.url) return null;
    return {
      id: item.id,
      title: item.title || item.content_description || 'GIF',
      previewUrl: preview?.url || gif.url,
      gifUrl: gif.url,
      width: gif.dims?.[0] || null,
      height: gif.dims?.[1] || null,
    };
  }).filter(Boolean);
}

async function fetchGiphy(path, params) {
  const key = getGiphyKey();
  if (!key) return null;

  const url = new URL(`${GIPHY_BASE}${path}`);
  url.searchParams.set('api_key', key);
  url.searchParams.set('rating', 'g');
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  });

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Giphy API error ${res.status}: ${text.slice(0, 120)}`);
  }
  return res.json();
}

async function fetchTenor(path, params) {
  const key = getTenorKey();
  if (!key) return null;

  const url = new URL(`${TENOR_BASE}${path}`);
  url.searchParams.set('key', key);
  url.searchParams.set('client_key', TENOR_CLIENT_KEY);
  url.searchParams.set('media_filter', 'gif,tinygif,mediumgif');
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  });

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tenor API error ${res.status}: ${text.slice(0, 120)}`);
  }
  return res.json();
}

function isGifBuffer(buffer) {
  return buffer.length >= 6
    && buffer[0] === 0x47
    && buffer[1] === 0x49
    && buffer[2] === 0x46;
}

router.get('/search', authenticate, async (req, res) => {
  try {
    const provider = getGifProvider();
    if (!provider) {
      return res.status(503).json({
        error: 'GIF search is not configured. Set GIPHY_API_KEY (easy — developers.giphy.com) or paste a GIF link in the app.',
        gifs: [],
        provider: null,
        pasteSupported: true,
      });
    }

    const q = (req.query.q || '').trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 30);

    let gifs = [];
    if (provider === 'giphy') {
      const data = q
        ? await fetchGiphy('/search', { q, limit })
        : await fetchGiphy('/trending', { limit });
      gifs = mapGiphyResults(data);
    } else {
      const data = q
        ? await fetchTenor('/search', { q, limit, contentfilter: 'high' })
        : await fetchTenor('/featured', { limit, contentfilter: 'high' });
      gifs = mapTenorResults(data);
    }

    res.json({ gifs, provider, pasteSupported: true });
  } catch (err) {
    console.error('GIF search error:', err.message);
    res.status(500).json({ error: 'Could not load GIFs', gifs: [], pasteSupported: true });
  }
});

router.post('/send', authenticate, async (req, res) => {
  if (!deps) return res.status(500).json({ error: 'GIF routes not initialized' });

  const { roomId, gifUrl, title, replyToId } = req.body || {};
  if (!roomId || !gifUrl) {
    return res.status(400).json({ error: 'roomId and gifUrl are required' });
  }

  if (!(await deps.canAccessRoom(req.user.id, roomId))) {
    return res.status(403).json({ error: 'Access denied' });
  }

  let parsed;
  try {
    parsed = new URL(gifUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid GIF URL' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Invalid GIF URL' });
  }

  try {
    const gifRes = await fetch(gifUrl, {
      headers: { 'User-Agent': 'EganirA/1.0' },
    });
    if (!gifRes.ok) {
      return res.status(400).json({ error: 'Could not download GIF — use a direct image link' });
    }

    const buffer = Buffer.from(await gifRes.arrayBuffer());
    if (buffer.length > MAX_GIF_BYTES) {
      return res.status(400).json({ error: 'GIF is too large (max 8 MB)' });
    }
    if (buffer.length < 100) {
      return res.status(400).json({ error: 'GIF file is too small or empty' });
    }
    if (!isGifBuffer(buffer)) {
      return res.status(400).json({
        error: 'URL is not a GIF image — copy the direct link (e.g. media.giphy.com/.../giphy.gif)',
      });
    }

    let replyTo = null;
    if (replyToId) {
      const replyRow = await pool.query(
        `SELECT m.id, m.content, m.room_id, u.username
         FROM messages m JOIN users u ON m.user_id = u.id
         WHERE m.id = $1`,
        [replyToId]
      );
      if (replyRow.rows[0]?.room_id === roomId) {
        replyTo = {
          id: replyRow.rows[0].id,
          username: replyRow.rows[0].username,
          content: replyRow.rows[0].content,
        };
      }
    }

    await deps.ensureChannelMembership(req.user.id, roomId);

    const safeTitle = (title || 'animation.gif').replace(/[^\w.\-() ]+/g, '').slice(0, 80) || 'animation.gif';
    const fileName = safeTitle.endsWith('.gif') ? safeTitle : `${safeTitle}.gif`;
    const attachmentData = bufferToBase64(buffer);

    const inserted = await pool.query(
      `INSERT INTO messages (room_id, user_id, content, reply_to_id, attachment_name, attachment_mime, attachment_data)
       VALUES ($1, $2, '', $3, $4, 'image/gif', $5)
       RETURNING id, content, created_at, attachment_name, attachment_mime`,
      [roomId, req.user.id, replyTo?.id || null, fileName, attachmentData]
    );

    const attachmentUrl = `/attachments/db/${inserted.rows[0].id}`;
    const result = await pool.query(
      `UPDATE messages SET attachment_url = $1 WHERE id = $2
       RETURNING id, content, created_at, attachment_url, attachment_name, attachment_mime`,
      [attachmentUrl, inserted.rows[0].id]
    );

    const row = result.rows[0];
    const msg = deps.buildLiveMessage(row, req.user, roomId, replyTo);
    deps.io.to(roomId).emit('new_message', msg);
    deps.notifyRoomMessage(msg, req.user.id).catch(() => {});

    res.json({
      message: deps.formatMessageRow({
        ...row,
        user_id: req.user.id,
        username: req.user.username,
        avatar_color: req.user.avatar_color,
        avatar_url: req.user.avatar_url || null,
        reply_to_id: replyTo?.id,
        reply_username: replyTo?.username,
        reply_content: replyTo?.content,
      }),
    });
  } catch (err) {
    console.error('GIF send error:', err);
    res.status(500).json({ error: 'Failed to send GIF' });
  }
});

module.exports = { router, initGifRoutes };
