const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('./db');
const { authenticate } = require('./auth');
const { bufferToBase64 } = require('./fileStorage');

const router = express.Router();

const STAR_DIR = path.join(__dirname, 'uploads', 'stars');
const MAX_STAR_IMAGE = 5 * 1024 * 1024;
if (!fs.existsSync(STAR_DIR)) {
  fs.mkdirSync(STAR_DIR, { recursive: true });
}

const starUpload = multer({
  storage: multer.diskStorage({
    destination: STAR_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `${uuidv4()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_STAR_IMAGE },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed for stars'));
    }
  },
});

function formatStarRow(row) {
  const star = {
    id: row.id,
    user_id: row.user_id,
    content: row.content || null,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
  if (row.image_data || row.image_mime) {
    star.image_url = `/stars/db/${row.id}`;
    star.image_mime = row.image_mime || null;
  }
  if (row.username) {
    star.user = {
      id: row.user_id,
      username: row.username,
      surname: row.surname || null,
      avatar_color: row.avatar_color,
      avatar_url: row.avatar_url || null,
    };
  }
  return star;
}

async function getFollowerIds(userId) {
  const result = await pool.query(
    'SELECT follower_id FROM follows WHERE following_id = $1',
    [userId]
  );
  return result.rows.map((r) => r.follower_id);
}

function emitStarToFollowers(io, authorId, star) {
  if (!io) return;
  getFollowerIds(authorId).then((followerIds) => {
    followerIds.forEach((followerId) => {
      io.to(`user:${followerId}`).emit('star_posted', { star, author_id: authorId });
    });
    io.to(`user:${authorId}`).emit('star_posted', { star, author_id: authorId });
  });
}

router.post('/follow/:userId', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'You cannot follow yourself' });
    }

    const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (!userCheck.rows[0]) return res.status(404).json({ error: 'User not found' });

    const existing = await pool.query(
      'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2',
      [req.user.id, userId]
    );

    let following;
    if (existing.rows.length > 0) {
      await pool.query(
        'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2',
        [req.user.id, userId]
      );
      following = false;
    } else {
      await pool.query(
        'INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)',
        [req.user.id, userId]
      );
      following = true;
    }

    const counts = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM follows WHERE following_id = $1) AS follower_count,
         (SELECT COUNT(*)::int FROM follows WHERE follower_id = $1) AS following_count`,
      [userId]
    );

    res.json({
      following,
      user_id: userId,
      follower_count: counts.rows[0].follower_count,
      following_count: counts.rows[0].following_count,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/stars/feed', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const usersResult = await pool.query(
      `SELECT DISTINCT u.id, u.username, u.surname, u.avatar_color, u.avatar_url,
              EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.following_id = u.id) AS followed_by_me,
              (u.id = $1) AS is_me
       FROM users u
       WHERE u.id = $1
          OR u.id IN (SELECT following_id FROM follows WHERE follower_id = $1)
       ORDER BY is_me DESC, u.username`,
      [userId]
    );

    const feed = [];
    for (const userRow of usersResult.rows) {
      const starsResult = await pool.query(
        `SELECT id, user_id, content, image_mime, created_at, expires_at,
                CASE WHEN image_data IS NOT NULL THEN true ELSE false END AS has_image
         FROM stars
         WHERE user_id = $1 AND expires_at > NOW()
         ORDER BY created_at ASC`,
        [userRow.id]
      );
      if (starsResult.rows.length === 0 && !userRow.is_me) continue;

      feed.push({
        user: {
          id: userRow.id,
          username: userRow.username,
          surname: userRow.surname || null,
          avatar_color: userRow.avatar_color,
          avatar_url: userRow.avatar_url || null,
        },
        followed_by_me: !!userRow.followed_by_me || !!userRow.is_me,
        is_me: !!userRow.is_me,
        stars: starsResult.rows.map((s) => ({
          id: s.id,
          user_id: s.user_id,
          content: s.content || null,
          image_url: s.has_image ? `/stars/db/${s.id}` : null,
          image_mime: s.image_mime || null,
          created_at: s.created_at,
          expires_at: s.expires_at,
        })),
      });
    }

    res.json(feed);
  } catch (err) {
    console.error('Stars feed error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/stars/user/:userId', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    const viewerId = req.user.id;

    if (userId !== viewerId) {
      const followCheck = await pool.query(
        'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2',
        [viewerId, userId]
      );
      if (followCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Follow this user to see their stars' });
      }
    }

    const userResult = await pool.query(
      'SELECT id, username, surname, avatar_color, avatar_url FROM users WHERE id = $1',
      [userId]
    );
    if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' });

    const starsResult = await pool.query(
      `SELECT id, user_id, content, image_mime, created_at, expires_at,
              CASE WHEN image_data IS NOT NULL THEN true ELSE false END AS has_image
       FROM stars
       WHERE user_id = $1 AND expires_at > NOW()
       ORDER BY created_at ASC`,
      [userId]
    );

    res.json({
      user: userResult.rows[0],
      stars: starsResult.rows.map((s) => ({
        id: s.id,
        user_id: s.user_id,
        content: s.content || null,
        image_url: s.has_image ? `/stars/db/${s.id}` : null,
        image_mime: s.image_mime || null,
        created_at: s.created_at,
        expires_at: s.expires_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/stars', authenticate, (req, res) => {
  starUpload.single('image')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Image too large (max 5 MB)' });
      }
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }

    try {
      const content = (req.body.content || '').trim().slice(0, 500);
      const hasImage = !!req.file;

      if (!content && !hasImage) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'Add text or an image for your star' });
      }

      let imageData = null;
      let imageMime = null;
      if (hasImage) {
        imageData = bufferToBase64(fs.readFileSync(req.file.path));
        imageMime = req.file.mimetype;
        fs.unlink(req.file.path, () => {});
      }

      const result = await pool.query(
        `INSERT INTO stars (user_id, content, image_data, image_mime, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + INTERVAL '24 hours')
         RETURNING id, user_id, content, image_mime, created_at, expires_at`,
        [req.user.id, content || null, imageData, imageMime]
      );

      const row = result.rows[0];
      const star = {
        id: row.id,
        user_id: row.user_id,
        content: row.content,
        image_url: imageData ? `/stars/db/${row.id}` : null,
        image_mime: row.image_mime,
        created_at: row.created_at,
        expires_at: row.expires_at,
        user: {
          id: req.user.id,
          username: req.user.username,
          avatar_color: req.user.avatar_color,
          avatar_url: req.user.avatar_url || null,
        },
      };

      const io = req.app.get('io');
      emitStarToFollowers(io, req.user.id, star);

      res.json({ star });
    } catch (uploadErr) {
      if (req.file) fs.unlink(req.file.path, () => {});
      console.error('Star post error:', uploadErr);
      res.status(500).json({ error: 'Server error' });
    }
  });
});

router.delete('/stars/:starId', authenticate, async (req, res) => {
  try {
    const { starId } = req.params;
    const result = await pool.query(
      'DELETE FROM stars WHERE id = $1 AND user_id = $2 RETURNING id',
      [starId, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Star not found' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = { router, formatStarRow };
