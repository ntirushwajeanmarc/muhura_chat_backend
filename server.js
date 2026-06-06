require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { pool, initDB } = require('./db');
const { router: authRouter, authenticate } = require('./auth');
const { router: profileRouter } = require('./profile');
const { router: socialRouter } = require('./social');
const {
  router: pushRouter,
  configureVapid,
  notifyRoomMessage,
  notifyIncomingCall,
} = require('./push');
const { bufferToBase64, resolveStoredBytes } = require('./fileStorage');

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
]);

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${uuidv4()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('File type not allowed'));
    }
  },
});

const app = express();
const server = http.createServer(app);

const defaultOrigins = [
  'https://muhura-chat-frontend.onrender.com',
  'https://www.muhura-chat-frontend.onrender.com',
  'https://eganira.circuitnotion.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

function formatMessageRow(row) {
  const msg = {
    id: row.id,
    content: row.content,
    created_at: row.created_at,
    user_id: row.user_id,
    username: row.username,
    avatar_color: row.avatar_color,
    avatar_url: row.avatar_url || null,
  };
  if (row.edited_at) msg.edited_at = row.edited_at;
  if (row.attachment_url) {
    msg.attachment = {
      url: row.attachment_url,
      name: row.attachment_name,
      mime: row.attachment_mime,
    };
  }
  if (row.reply_to_id && row.reply_username) {
    msg.reply_to = {
      id: row.reply_to_id,
      username: row.reply_username,
      content: row.reply_content,
    };
  }
  if (row.like_count !== undefined && row.like_count !== null) {
    msg.likes = {
      count: parseInt(row.like_count, 10) || 0,
      liked_by_me: !!row.liked_by_me,
    };
  }
  return msg;
}

function buildLiveMessage(row, socketUser, roomId, replyTo = null) {
  const msg = {
    id: row.id,
    content: row.content,
    created_at: row.created_at,
    user_id: socketUser.id,
    username: socketUser.username,
    avatar_color: socketUser.avatar_color,
    avatar_url: socketUser.avatar_url || null,
    room_id: roomId,
    reply_to: replyTo,
  };
  if (row.attachment_url) {
    msg.attachment = {
      url: row.attachment_url,
      name: row.attachment_name,
      mime: row.attachment_mime,
    };
  }
  msg.likes = { count: 0, liked_by_me: false };
  return msg;
}

async function canAccessRoom(userId, roomId) {
  const result = await pool.query(
    `SELECT r.type FROM rooms r WHERE r.id = $1`,
    [roomId]
  );
  const room = result.rows[0];
  if (!room) return false;
  if (room.type === 'public') return true;
  const member = await pool.query(
    `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
    [roomId, userId]
  );
  return member.rows.length > 0;
}

async function isGroupMember(userId, roomId) {
  const result = await pool.query(
    `SELECT 1 FROM rooms r
     JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = $2
     WHERE r.id = $1 AND r.type = 'group'`,
    [roomId, userId]
  );
  return result.rows.length > 0;
}

async function ensureChannelMembership(userId, roomId) {
  const room = await pool.query('SELECT type FROM rooms WHERE id = $1', [roomId]);
  if (room.rows[0]?.type !== 'public') return;
  await pool.query(
    `INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [roomId, userId]
  );
}

async function getParticipatedPublicRoomIds(userId) {
  const result = await pool.query(
    `SELECT DISTINCT r.id
     FROM rooms r
     WHERE r.type = 'public'
       AND (
         EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = r.id AND rm.user_id = $1)
         OR EXISTS (SELECT 1 FROM messages m WHERE m.room_id = r.id AND m.user_id = $1)
       )`,
    [userId]
  );
  return result.rows.map((row) => row.id);
}

function unreadCountSql(userParam) {
  return `(
    SELECT COUNT(*)::int
    FROM messages um
    LEFT JOIN room_read_state urrs ON urrs.room_id = um.room_id AND urrs.user_id = ${userParam}
    LEFT JOIN messages uread ON uread.id = urrs.last_read_message_id
    WHERE um.room_id = r.id
      AND um.user_id <> ${userParam}
      AND (
        urrs.last_read_message_id IS NULL
        OR um.created_at > uread.created_at
      )
  )`;
}

async function formatRoomRow(row, currentUserId) {
  const room = {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    created_by: row.created_by,
    created_at: row.created_at,
  };
  if (row.type === 'direct' && row.peer_id) {
    room.peer = {
      id: row.peer_id,
      username: row.peer_username,
      avatar_color: row.peer_avatar_color,
      avatar_url: row.peer_avatar_url || null,
    };
    room.display_name = row.peer_username;
  } else if (row.type === 'group') {
    room.display_name = row.name;
    if (row.member_count) room.member_count = parseInt(row.member_count, 10);
  } else {
    room.display_name = row.name;
  }
  if (row.last_message) room.last_message = row.last_message;
  if (row.last_message_at) room.last_message_at = row.last_message_at;
  if (row.unread_count !== undefined && row.unread_count !== null) {
    room.unread_count = parseInt(row.unread_count, 10) || 0;
  }
  return room;
}

const envOrigins = process.env.CLIENT_URL
  ? process.env.CLIENT_URL.split(',').map((o) => o.trim()).filter(Boolean)
  : [];

const allowedOrigins = [...new Set([...defaultOrigins, ...envOrigins])];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked origin: ${origin}`);
      callback(new Error(`CORS policy: Origin ${origin} not allowed`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 200,
};

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  }
});

app.set('io', io);

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());
// Files served only via authenticated /api/files (see below)

// Routes
configureVapid();

app.use('/api/auth', authRouter);
app.use('/api/profile', profileRouter);
app.use('/api/social', socialRouter);
app.use('/api/push', pushRouter);

function resolveUploadPath(urlPath) {
  const uploadRoot = path.resolve(UPLOAD_DIR);
  const diskPath = path.resolve(path.join(__dirname, urlPath.slice(1)));
  if (!diskPath.startsWith(uploadRoot + path.sep) && diskPath !== uploadRoot) {
    return null;
  }
  return diskPath;
}

function mimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.zip': 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

function resolveStoredMime(mime, diskPath) {
  const fromPath = mimeFromPath(diskPath);
  if (!mime || mime === 'application/octet-stream') return fromPath;
  if (mime.startsWith('image/')) return mime;
  if (fromPath.startsWith('image/')) return fromPath;
  return mime;
}

function sendStoredFile(res, diskPath, { mime, filename, forceDownload = false }) {
  const resolvedMime = resolveStoredMime(mime, diskPath);
  res.type(resolvedMime);
  const basename = filename || path.basename(diskPath);
  const safeName = basename.replace(/[^\w.\-() ]+/g, '_') || 'download';
  const inline = !forceDownload && resolvedMime.startsWith('image/');

  if (inline) {
    return res.sendFile(diskPath, {
      headers: {
        'Content-Disposition': `inline; filename="${safeName}"`,
      },
    });
  }

  return res.download(diskPath, safeName);
}

// Secure file access — only room members (or avatar owner) can view files
app.get('/api/files', authenticate, async (req, res) => {
  try {
    const urlPath = req.query.path;
    if (!urlPath || typeof urlPath !== 'string' || urlPath.includes('..')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const forceDownload = req.query.download === '1' || req.query.download === 'true';

    // Profile photos stored as base64 in DB
    if (urlPath.startsWith('/avatars/user/')) {
      const userId = urlPath.slice('/avatars/user/'.length).split('/')[0];
      if (!userId) return res.status(400).json({ error: 'Invalid path' });
      const avatar = await pool.query(
        `SELECT avatar_data, avatar_image, avatar_mime FROM users
         WHERE id = $1 AND (avatar_data IS NOT NULL OR avatar_image IS NOT NULL)`,
        [userId]
      );
      const bytes = resolveStoredBytes(avatar.rows[0], { dataKey: 'avatar_data', binaryKey: 'avatar_image' });
      if (!bytes) return res.status(404).json({ error: 'Avatar not found' });
      res.type(avatar.rows[0].avatar_mime || 'image/jpeg');
      if (forceDownload) {
        res.setHeader('Content-Disposition', 'attachment; filename="avatar.jpg"');
      } else {
        res.setHeader('Content-Disposition', 'inline');
      }
      return res.send(bytes);
    }

    // Star images stored as base64 in DB
    if (urlPath.startsWith('/stars/db/')) {
      const starId = urlPath.slice('/stars/db/'.length).split('/')[0];
      if (!starId) return res.status(400).json({ error: 'Invalid path' });
      const row = await pool.query(
        `SELECT s.user_id, s.image_data, s.image_mime, s.expires_at
         FROM stars s WHERE s.id = $1 AND s.image_data IS NOT NULL`,
        [starId]
      );
      if (!row.rows[0]) return res.status(404).json({ error: 'Star not found' });
      if (new Date(row.rows[0].expires_at) < new Date()) {
        return res.status(410).json({ error: 'Star expired' });
      }
      const viewerId = req.user.id;
      const authorId = row.rows[0].user_id;
      if (authorId !== viewerId) {
        const followCheck = await pool.query(
          'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2',
          [viewerId, authorId]
        );
        if (followCheck.rows.length === 0) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }
      const bytes = resolveStoredBytes(row.rows[0], { dataKey: 'image_data' });
      res.type(row.rows[0].image_mime || 'image/jpeg');
      res.setHeader('Content-Disposition', 'inline');
      return res.send(bytes);
    }

    // Message attachments stored as base64 in DB
    if (urlPath.startsWith('/attachments/db/')) {
      const messageId = urlPath.slice('/attachments/db/'.length).split('/')[0];
      if (!messageId) return res.status(400).json({ error: 'Invalid path' });
      const row = await pool.query(
        `SELECT room_id, attachment_data, attachment_mime, attachment_name
         FROM messages WHERE id = $1 AND attachment_data IS NOT NULL`,
        [messageId]
      );
      if (!row.rows[0]) return res.status(404).json({ error: 'File not found' });
      if (!(await canAccessRoom(req.user.id, row.rows[0].room_id))) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const bytes = resolveStoredBytes(row.rows[0], { dataKey: 'attachment_data' });
      const mime = row.rows[0].attachment_mime || 'application/octet-stream';
      const inline = !forceDownload && mime.startsWith('image/');
      res.type(mime);
      const safeName = (row.rows[0].attachment_name || 'file').replace(/[^\w.\-() ]+/g, '_');
      res.setHeader(
        'Content-Disposition',
        inline ? `inline; filename="${safeName}"` : `attachment; filename="${safeName}"`
      );
      return res.send(bytes);
    }

    if (!urlPath.startsWith('/uploads/')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const diskPath = resolveUploadPath(urlPath);
    if (!diskPath || !fs.existsSync(diskPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    if (urlPath.includes('/avatars/')) {
      const owner = await pool.query('SELECT id FROM users WHERE avatar_url = $1', [urlPath]);
      if (owner.rows[0]) {
        return sendStoredFile(res, diskPath, { mime: mimeFromPath(diskPath), forceDownload: false });
      }
    }

    const msg = await pool.query(
      `SELECT id, room_id, attachment_name, attachment_mime, attachment_data
       FROM messages WHERE attachment_url = $1 LIMIT 1`,
      [urlPath]
    );
    if (msg.rows[0] && (await canAccessRoom(req.user.id, msg.rows[0].room_id))) {
      const dbBytes = resolveStoredBytes(msg.rows[0], { dataKey: 'attachment_data' });
      if (dbBytes) {
        const mime = msg.rows[0].attachment_mime || 'application/octet-stream';
        const inline = !forceDownload && mime.startsWith('image/');
        res.type(mime);
        const safeName = (msg.rows[0].attachment_name || 'file').replace(/[^\w.\-() ]+/g, '_');
        res.setHeader(
          'Content-Disposition',
          inline ? `inline; filename="${safeName}"` : `attachment; filename="${safeName}"`
        );
        return res.send(dbBytes);
      }
      return sendStoredFile(res, diskPath, {
        mime: msg.rows[0].attachment_mime,
        filename: msg.rows[0].attachment_name,
        forceDownload,
      });
    }

    res.status(403).json({ error: 'Access denied' });
  } catch (err) {
    console.error('File access error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Search users (for starting DMs or adding to groups)
app.get('/api/users/search', authenticate, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 1) return res.json([]);
    const pattern = `%${q}%`;
    const prefixPattern = `${q}%`;
    const phoneDigits = q.replace(/[^\d]/g, '');
    const params = [req.user.id, pattern, prefixPattern];
    let phoneClause = '';
    if (phoneDigits.length >= 1) {
      phoneClause = 'OR (phone IS NOT NULL AND phone ILIKE $4)';
      params.push(`%${phoneDigits}%`);
    }

    const result = await pool.query(
      `SELECT id, username, surname, email, phone, avatar_color, avatar_url
       FROM (
         SELECT id, username, surname, email, phone, avatar_color, avatar_url,
                CASE
                  WHEN username ILIKE $3 OR surname ILIKE $3 THEN 0
                  WHEN username ILIKE $2 OR surname ILIKE $2 OR email ILIKE $2 THEN 1
                  ELSE 2
                END AS rank
         FROM users
         WHERE id <> $1 AND (
           username ILIKE $2 OR surname ILIKE $2 OR email ILIKE $2
           OR (phone IS NOT NULL AND phone ILIKE $2)
           ${phoneClause}
         )
       ) matched
       ORDER BY rank, username
       LIMIT 20`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Public channels the user has participated in (not all channels)
app.get('/api/rooms', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (r.name) r.id, r.name, r.description, r.type, r.created_by, r.created_at,
              lm.content AS last_message, lm.created_at AS last_message_at,
              ${unreadCountSql('$1')} AS unread_count
       FROM rooms r
       LEFT JOIN LATERAL (
         SELECT content, created_at FROM messages
         WHERE room_id = r.id ORDER BY created_at DESC LIMIT 1
       ) lm ON true
       WHERE r.type = 'public'
         AND (
           EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = r.id AND rm.user_id = $1)
           OR EXISTS (SELECT 1 FROM messages m WHERE m.room_id = r.id AND m.user_id = $1)
         )
       ORDER BY r.name, r.created_at ASC`,
      [req.user.id]
    );
    const rooms = await Promise.all(
      result.rows.map((r) => formatRoomRow({ ...r, type: 'public' }, req.user.id))
    );
    res.json(rooms);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Search all public channels (for discovery)
app.get('/api/rooms/search', authenticate, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 1) return res.json([]);
    const pattern = `%${q}%`;
    const result = await pool.query(
      `SELECT r.id, r.name, r.description, r.type, r.created_at,
              (
                EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = r.id AND rm.user_id = $1)
                OR EXISTS (SELECT 1 FROM messages m WHERE m.room_id = r.id AND m.user_id = $1)
              ) AS joined
       FROM rooms r
       WHERE r.type = 'public' AND (r.name ILIKE $2 OR COALESCE(r.description, '') ILIKE $2)
       ORDER BY r.name
       LIMIT 20`,
      [req.user.id, pattern]
    );
    res.json(
      result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        type: 'public',
        display_name: r.name,
        joined: !!r.joined,
        created_at: r.created_at,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

function normalizeChannelName(name) {
  return (name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// Create a public channel
app.post('/api/rooms', authenticate, async (req, res) => {
  try {
    const channelName = normalizeChannelName(req.body.name);
    const description = (req.body.description || '').trim().slice(0, 255) || null;

    if (!channelName || channelName.length < 2) {
      return res.status(400).json({ error: 'Channel name must be at least 2 characters (letters, numbers, hyphens)' });
    }
    if (channelName.length > 50) {
      return res.status(400).json({ error: 'Channel name is too long' });
    }

    const existing = await pool.query(
      `SELECT id FROM rooms WHERE type = 'public' AND name = $1`,
      [channelName]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Channel name already taken' });
    }

    const result = await pool.query(
      `INSERT INTO rooms (name, description, type, created_by)
       VALUES ($1, $2, 'public', $3)
       RETURNING id, name, description, type, created_at`,
      [channelName, description, req.user.id]
    );
    const room = result.rows[0];

    await pool.query(
      `INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [room.id, req.user.id]
    );

    res.status(201).json({
      id: room.id,
      name: room.name,
      description: room.description,
      type: 'public',
      display_name: room.name,
      created_at: room.created_at,
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Channel name already taken' });
    }
    console.error('Create channel error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Join a public channel
app.post('/api/rooms/:roomId/join', authenticate, async (req, res) => {
  try {
    const { roomId } = req.params;
    const roomResult = await pool.query(
      `SELECT id, name, description, type, created_at FROM rooms WHERE id = $1`,
      [roomId]
    );
    const room = roomResult.rows[0];
    if (!room || room.type !== 'public') {
      return res.status(404).json({ error: 'Channel not found' });
    }

    await pool.query(
      `INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [roomId, req.user.id]
    );

    res.json({
      id: room.id,
      name: room.name,
      description: room.description,
      type: 'public',
      display_name: room.name,
      created_at: room.created_at,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// User's private chats and groups
app.get('/api/chats', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    const directResult = await pool.query(
      `SELECT r.id, r.name, r.description, r.type, r.created_by, r.created_at,
              u.id AS peer_id, u.username AS peer_username, u.avatar_color AS peer_avatar_color,
              u.avatar_url AS peer_avatar_url,
              lm.content AS last_message, lm.created_at AS last_message_at,
              ${unreadCountSql('$1')} AS unread_count
       FROM rooms r
       JOIN room_members rm ON r.id = rm.room_id AND rm.user_id = $1
       JOIN room_members rm2 ON r.id = rm2.room_id AND rm2.user_id <> $1
       JOIN users u ON u.id = rm2.user_id
       LEFT JOIN LATERAL (
         SELECT content, created_at FROM messages
         WHERE room_id = r.id ORDER BY created_at DESC LIMIT 1
       ) lm ON true
       WHERE r.type = 'direct'
       ORDER BY COALESCE(lm.created_at, r.created_at) DESC`,
      [userId]
    );

    const groupResult = await pool.query(
      `SELECT r.id, r.name, r.description, r.type, r.created_by, r.created_at,
              (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) AS member_count,
              lm.content AS last_message, lm.created_at AS last_message_at,
              ${unreadCountSql('$1')} AS unread_count
       FROM rooms r
       JOIN room_members rm ON r.id = rm.room_id AND rm.user_id = $1
       LEFT JOIN LATERAL (
         SELECT content, created_at FROM messages
         WHERE room_id = r.id ORDER BY created_at DESC LIMIT 1
       ) lm ON true
       WHERE r.type = 'group'
       ORDER BY COALESCE(lm.created_at, r.created_at) DESC`,
      [userId]
    );

    const direct = await Promise.all(
      directResult.rows.map((row) => formatRoomRow(row, userId))
    );
    const groups = await Promise.all(
      groupResult.rows.map((row) => formatRoomRow(row, userId))
    );

    res.json({ direct, groups });
  } catch (err) {
    console.error('Chats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Unread message counts per room (messages from others since last read)
app.get('/api/chats/unread-counts', authenticate, async (req, res) => {
  try {
    const counts = await getUnreadCountsForUser(req.user.id);
    res.json({ counts });
  } catch (err) {
    console.error('Unread counts error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Start or open a direct chat
app.post('/api/chats/direct', authenticate, async (req, res) => {
  try {
    const { userId: peerId } = req.body;
    const userId = req.user.id;
    if (!peerId) return res.status(400).json({ error: 'userId required' });
    if (peerId === userId) return res.status(400).json({ error: 'Cannot chat with yourself' });

    const peerCheck = await pool.query(
      'SELECT id, username, avatar_color, avatar_url FROM users WHERE id = $1',
      [peerId]
    );
    if (!peerCheck.rows[0]) return res.status(404).json({ error: 'User not found' });

    const existing = await pool.query(
      `SELECT r.id FROM rooms r
       JOIN room_members rm1 ON r.id = rm1.room_id AND rm1.user_id = $1
       JOIN room_members rm2 ON r.id = rm2.room_id AND rm2.user_id = $2
       WHERE r.type = 'direct'
       LIMIT 1`,
      [userId, peerId]
    );

    let roomId;
    if (existing.rows[0]) {
      roomId = existing.rows[0].id;
    } else {
      const dmName = `__dm__${[userId, peerId].sort().join('__')}`;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const room = await client.query(
          `INSERT INTO rooms (name, type, created_by) VALUES ($1, 'direct', $2) RETURNING id`,
          [dmName, userId]
        );
        roomId = room.rows[0].id;
        await client.query(
          `INSERT INTO room_members (room_id, user_id) VALUES ($1, $2), ($1, $3)`,
          [roomId, userId, peerId]
        );
        await client.query('COMMIT');
        notifyRoomAdded(roomId, [userId, peerId]);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    const peer = peerCheck.rows[0];
    res.json({
      id: roomId,
      type: 'direct',
      display_name: peer.username,
      peer: {
        id: peer.id,
        username: peer.username,
        avatar_color: peer.avatar_color,
        avatar_url: peer.avatar_url || null,
      },
    });
  } catch (err) {
    console.error('Direct chat error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create a group chat
app.post('/api/chats/groups', authenticate, async (req, res) => {
  try {
    const { name, memberIds = [] } = req.body;
    const userId = req.user.id;
    const groupName = (name || '').trim();
    if (!groupName) return res.status(400).json({ error: 'Group name required' });

    const uniqueMembers = [...new Set(memberIds.filter((id) => id && id !== userId))];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const room = await client.query(
        `INSERT INTO rooms (name, type, created_by) VALUES ($1, 'group', $2) RETURNING id, name, type, created_at`,
        [groupName, userId]
      );
      const roomId = room.rows[0].id;
      const allMembers = [userId, ...uniqueMembers];
      for (const memberId of allMembers) {
        await client.query(
          `INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [roomId, memberId]
        );
      }
      await client.query('COMMIT');
      notifyRoomAdded(roomId, allMembers);

      res.json({
        id: roomId,
        name: groupName,
        type: 'group',
        display_name: groupName,
        member_count: allMembers.length,
        created_at: room.rows[0].created_at,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Group chat error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// List group members
app.get('/api/chats/groups/:roomId/members', authenticate, async (req, res) => {
  try {
    const { roomId } = req.params;
    if (!(await isGroupMember(req.user.id, roomId))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const result = await pool.query(
      `SELECT u.id, u.username, u.surname, u.email, u.phone, u.avatar_color, u.avatar_url
       FROM room_members rm
       JOIN users u ON u.id = rm.user_id
       WHERE rm.room_id = $1
       ORDER BY u.username`,
      [roomId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Add members to an existing group
app.post('/api/chats/groups/:roomId/members', authenticate, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { memberIds = [] } = req.body;
    if (!(await isGroupMember(req.user.id, roomId))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const existing = await pool.query(
      'SELECT user_id FROM room_members WHERE room_id = $1',
      [roomId]
    );
    const existingIds = new Set(existing.rows.map((r) => r.user_id));
    const toAdd = [...new Set(memberIds.filter((id) => id && !existingIds.has(id)))];

    if (toAdd.length === 0) {
      return res.status(400).json({ error: 'No new members to add' });
    }

    for (const memberId of toAdd) {
      const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [memberId]);
      if (!userCheck.rows[0]) continue;
      await pool.query(
        `INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [roomId, memberId]
      );
    }

    notifyRoomAdded(roomId, toAdd);

    const countRes = await pool.query(
      'SELECT COUNT(*)::int AS count FROM room_members WHERE room_id = $1',
      [roomId]
    );

    res.json({
      added: toAdd,
      member_count: countRes.rows[0].count,
    });
  } catch (err) {
    console.error('Add group members error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

const MESSAGE_PAGE_SIZE = 50;
const MESSAGE_PAGE_MAX = 100;

function messageSelectSql(viewerIdParam) {
  return `
  SELECT m.id, m.content, m.created_at, m.edited_at, m.reply_to_id,
         m.attachment_url, m.attachment_name, m.attachment_mime,
         u.id AS user_id, u.username, u.avatar_color, u.avatar_url,
         ru.username AS reply_username,
         rm.content AS reply_content,
         (SELECT COUNT(*)::int FROM message_likes ml WHERE ml.message_id = m.id) AS like_count,
         EXISTS(
           SELECT 1 FROM message_likes ml2
           WHERE ml2.message_id = m.id AND ml2.user_id = $${viewerIdParam}
         ) AS liked_by_me
  FROM messages m
  JOIN users u ON m.user_id = u.id
  LEFT JOIN messages rm ON m.reply_to_id = rm.id
  LEFT JOIN users ru ON rm.user_id = ru.id
`;
}

// Upload a file and post it as a message
app.post('/api/rooms/:roomId/upload', authenticate, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large (max 10 MB)' });
      }
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const roomId = req.params.roomId;
    if (!(await canAccessRoom(req.user.id, roomId))) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'Access denied' });
    }

    try {
      const caption = (req.body.content || '').trim();
      const replyToId = req.body.replyToId || null;
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

      await ensureChannelMembership(req.user.id, roomId);

      const fileMime = resolveStoredMime(
        req.file.mimetype,
        path.join(UPLOAD_DIR, req.file.filename)
      );
      const attachmentData = bufferToBase64(fs.readFileSync(req.file.path));
      fs.unlink(req.file.path, () => {});

      const inserted = await pool.query(
        `INSERT INTO messages (room_id, user_id, content, reply_to_id, attachment_name, attachment_mime, attachment_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, content, created_at, attachment_name, attachment_mime`,
        [
          roomId,
          req.user.id,
          caption,
          replyTo?.id || null,
          req.file.originalname,
          fileMime,
          attachmentData,
        ]
      );

      const attachmentUrl = `/attachments/db/${inserted.rows[0].id}`;
      const result = await pool.query(
        `UPDATE messages SET attachment_url = $1 WHERE id = $2
         RETURNING id, content, created_at, attachment_url, attachment_name, attachment_mime`,
        [attachmentUrl, inserted.rows[0].id]
      );

      const row = result.rows[0];
      const msg = buildLiveMessage(row, req.user, roomId, replyTo);
      io.to(roomId).emit('new_message', msg);
      notifyRoomMessage(msg, req.user.id).catch(() => {});
      res.json({ message: formatMessageRow({ ...row, username: req.user.username, avatar_color: req.user.avatar_color, reply_to_id: replyTo?.id, reply_username: replyTo?.username, reply_content: replyTo?.content }) });
    } catch (uploadErr) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      console.error('Upload error:', uploadErr);
      res.status(500).json({ error: 'Server error' });
    }
  });
});

// Paginated messages: ?limit=50&before=<messageId> loads older history
app.get('/api/rooms/:roomId/messages', authenticate, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    if (!(await canAccessRoom(req.user.id, roomId))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || MESSAGE_PAGE_SIZE, 1),
      MESSAGE_PAGE_MAX
    );
    const beforeId = req.query.before;

    let result;
    if (beforeId) {
      result = await pool.query(
        `${messageSelectSql(4)}
         WHERE m.room_id = $1
           AND m.created_at < (
             SELECT created_at FROM messages WHERE id = $2 AND room_id = $1
           )
         ORDER BY m.created_at DESC
         LIMIT $3`,
        [roomId, beforeId, limit, req.user.id]
      );
    } else {
      result = await pool.query(
        `${messageSelectSql(3)}
         WHERE m.room_id = $1
         ORDER BY m.created_at DESC
         LIMIT $2`,
        [roomId, limit, req.user.id]
      );
    }

    const rows = result.rows.reverse().map(formatMessageRow);
    res.json({ messages: rows, hasMore: result.rows.length === limit });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

async function getMessageCreatedAt(messageId, roomId) {
  const result = await pool.query(
    'SELECT created_at FROM messages WHERE id = $1 AND room_id = $2',
    [messageId, roomId]
  );
  return result.rows[0]?.created_at || null;
}

async function getUnreadCountsForUser(userId) {
  const result = await pool.query(
    `SELECT r.id AS room_id, ${unreadCountSql('$1')} AS unread_count
     FROM rooms r
     JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = $1
     WHERE ${unreadCountSql('$1')} > 0`,
    [userId]
  );
  const counts = {};
  for (const row of result.rows) {
    counts[row.room_id] = row.unread_count;
  }
  return counts;
}

async function markRoomRead(userId, roomId, messageId) {
  if (!(await canAccessRoom(userId, roomId))) {
    return { error: 'Access denied', status: 403 };
  }

  const messageAt = await getMessageCreatedAt(messageId, roomId);
  if (!messageAt) return { error: 'Message not found', status: 404 };

  const current = await pool.query(
    `SELECT rrs.last_read_message_id, m.created_at AS last_read_at
     FROM room_read_state rrs
     LEFT JOIN messages m ON m.id = rrs.last_read_message_id
     WHERE rrs.room_id = $1 AND rrs.user_id = $2`,
    [roomId, userId]
  );

  const prevAt = current.rows[0]?.last_read_at;
  if (prevAt && new Date(messageAt) <= new Date(prevAt)) {
    const existing = await pool.query(
      `SELECT rrs.user_id, u.username, rrs.last_read_message_id, m.created_at AS last_read_at
       FROM room_read_state rrs
       JOIN users u ON u.id = rrs.user_id
       LEFT JOIN messages m ON m.id = rrs.last_read_message_id
       WHERE rrs.room_id = $1 AND rrs.user_id = $2`,
      [roomId, userId]
    );
    const row = existing.rows[0];
    return {
      receipt: {
        room_id: roomId,
        user_id: row.user_id,
        username: row.username,
        last_read_message_id: row.last_read_message_id,
        last_read_at: row.last_read_at,
      },
    };
  }

  await pool.query(
    `INSERT INTO room_read_state (room_id, user_id, last_read_message_id, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (room_id, user_id)
     DO UPDATE SET last_read_message_id = $3, updated_at = NOW()`,
    [roomId, userId, messageId]
  );

  const userRow = await pool.query('SELECT username FROM users WHERE id = $1', [userId]);
  return {
    receipt: {
      room_id: roomId,
      user_id: userId,
      username: userRow.rows[0]?.username,
      last_read_message_id: messageId,
      last_read_at: messageAt,
    },
  };
}

app.get('/api/rooms/:roomId/read-state', authenticate, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    if (!(await canAccessRoom(req.user.id, roomId))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await pool.query(
      `SELECT rrs.user_id, u.username, rrs.last_read_message_id, m.created_at AS last_read_at
       FROM room_read_state rrs
       JOIN users u ON u.id = rrs.user_id
       LEFT JOIN messages m ON m.id = rrs.last_read_message_id
       WHERE rrs.room_id = $1`,
      [roomId]
    );

    res.json({
      reads: result.rows.map((row) => ({
        user_id: row.user_id,
        username: row.username,
        last_read_message_id: row.last_read_message_id,
        last_read_at: row.last_read_at,
      })),
    });
  } catch (err) {
    console.error('Read state error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

async function updateMessageContent(userId, roomId, messageId, content) {
  if (!(await canAccessRoom(userId, roomId))) {
    return { error: 'Access denied', status: 403 };
  }

  const existing = await pool.query(
    `SELECT m.id, m.user_id, m.attachment_url
     FROM messages m WHERE m.id = $1 AND m.room_id = $2`,
    [messageId, roomId]
  );
  const row = existing.rows[0];
  if (!row) return { error: 'Message not found', status: 404 };
  if (row.user_id !== userId) return { error: 'You can only edit your own messages', status: 403 };

  const trimmed = (content || '').trim();
  if (!trimmed && !row.attachment_url) {
    return { error: 'Message cannot be empty', status: 400 };
  }

  await pool.query(
    `UPDATE messages SET content = $1, edited_at = NOW() WHERE id = $2`,
    [trimmed, messageId]
  );

  const full = await pool.query(`${messageSelectSql(2)} WHERE m.id = $1`, [messageId, userId]);
  const msg = formatMessageRow(full.rows[0]);
  msg.room_id = roomId;
  return { message: msg };
}

app.post('/api/messages/:messageId/like', authenticate, async (req, res) => {
  try {
    const { messageId } = req.params;
    const msgRow = await pool.query('SELECT room_id FROM messages WHERE id = $1', [messageId]);
    if (!msgRow.rows[0]) return res.status(404).json({ error: 'Message not found' });

    const roomId = msgRow.rows[0].room_id;
    if (!(await canAccessRoom(req.user.id, roomId))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const existing = await pool.query(
      'SELECT 1 FROM message_likes WHERE user_id = $1 AND message_id = $2',
      [req.user.id, messageId]
    );

    let liked;
    if (existing.rows.length > 0) {
      await pool.query(
        'DELETE FROM message_likes WHERE user_id = $1 AND message_id = $2',
        [req.user.id, messageId]
      );
      liked = false;
    } else {
      await pool.query(
        'INSERT INTO message_likes (user_id, message_id) VALUES ($1, $2)',
        [req.user.id, messageId]
      );
      liked = true;
    }

    const countRes = await pool.query(
      'SELECT COUNT(*)::int AS count FROM message_likes WHERE message_id = $1',
      [messageId]
    );
    const like_count = countRes.rows[0].count;
    const payload = {
      message_id: messageId,
      room_id: roomId,
      like_count,
      user_id: req.user.id,
      liked,
    };
    io.to(roomId).emit('message_like_updated', payload);
    res.json({ liked, like_count });
  } catch (err) {
    console.error('Message like error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/rooms/:roomId/messages/:messageId', authenticate, async (req, res) => {
  try {
    const { roomId, messageId } = req.params;
    const result = await updateMessageContent(req.user.id, roomId, messageId, req.body.content);
    if (result.error) return res.status(result.status).json({ error: result.error });

    io.to(roomId).emit('message_edited', result.message);
    res.json({ message: result.message });
  } catch (err) {
    console.error('Edit message error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Socket.IO auth middleware
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('No token'));
  try {
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

// Track online users per room
const onlineUsers = new Map(); // roomId -> Set of usernames

async function joinSocketToUserRooms(socket) {
  const userId = socket.user.id;
  socket.join(`user:${userId}`);

  const memberships = await pool.query(
    'SELECT room_id FROM room_members WHERE user_id = $1',
    [userId]
  );
  for (const row of memberships.rows) {
    socket.join(row.room_id);
  }

  const publicRoomIds = await getParticipatedPublicRoomIds(userId);
  for (const roomId of publicRoomIds) {
    socket.join(roomId);
  }
}

function notifyRoomAdded(roomId, userIds) {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  uniqueIds.forEach((userId) => {
    io.to(`user:${userId}`).emit('room_added', { roomId });
  });
}

io.on('connection', async (socket) => {
  console.log(`🔌 ${socket.user.username} connected`);
  await joinSocketToUserRooms(socket);

  // Join a room to receive messages (can join multiple rooms)
  socket.on('join_room', async (roomId) => {
    if (!(await canAccessRoom(socket.user.id, roomId))) return;
    socket.join(roomId);
  });

  // Track online presence for the room the user is actively viewing
  socket.on('presence_room', async (roomId) => {
    if (!(await canAccessRoom(socket.user.id, roomId))) return;

    const prev = socket.data.presenceRoom;
    if (prev && prev !== roomId && onlineUsers.has(prev)) {
      onlineUsers.get(prev).delete(socket.user.username);
      io.to(prev).emit('online_users', { roomId: prev, users: [...onlineUsers.get(prev)] });
    }

    socket.data.presenceRoom = roomId;
    if (!onlineUsers.has(roomId)) onlineUsers.set(roomId, new Set());
    onlineUsers.get(roomId).add(socket.user.username);
    io.to(roomId).emit('online_users', { roomId, users: [...onlineUsers.get(roomId)] });
  });

  socket.on('send_message', async ({ roomId, content, replyToId }) => {
    if (!content?.trim()) return;
    if (!(await canAccessRoom(socket.user.id, roomId))) return;
    try {
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

      await ensureChannelMembership(socket.user.id, roomId);

      const result = await pool.query(
        `INSERT INTO messages (room_id, user_id, content, reply_to_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id, content, created_at, attachment_url, attachment_name, attachment_mime`,
        [roomId, socket.user.id, content.trim(), replyTo?.id || null]
      );
      const msg = buildLiveMessage(result.rows[0], socket.user, roomId, replyTo);
      io.to(roomId).emit('new_message', msg);
      notifyRoomMessage(msg, socket.user.id).catch(() => {});
    } catch (err) {
      console.error('Message error:', err);
    }
  });

  socket.on('mark_read', async ({ roomId, messageId }) => {
    if (!roomId || !messageId) return;
    try {
      const result = await markRoomRead(socket.user.id, roomId, messageId);
      if (result.error || !result.receipt) return;
      io.to(roomId).emit('read_receipt', result.receipt);
    } catch (err) {
      console.error('Mark read error:', err);
    }
  });

  socket.on('edit_message', async ({ roomId, messageId, content }) => {
    if (!roomId || !messageId) return;
    try {
      const result = await updateMessageContent(socket.user.id, roomId, messageId, content);
      if (result.error) return;
      io.to(roomId).emit('message_edited', result.message);
    } catch (err) {
      console.error('Edit message error:', err);
    }
  });

  socket.on('typing', async ({ roomId, isTyping }) => {
    if (!roomId || !(await canAccessRoom(socket.user.id, roomId))) return;
    socket.to(roomId).emit('user_typing', {
      username: socket.user.username,
      isTyping,
      roomId,
    });
  });

  socket.on('call_invite', async ({ toUserId, callId, callType, sdp }) => {
    if (!toUserId || !callId || !sdp) return;
    if (toUserId === socket.user.id) return;
    const target = await pool.query(
      'SELECT id, username, avatar_color, avatar_url FROM users WHERE id = $1',
      [toUserId]
    );
    if (!target.rows[0]) return;

    const caller = await pool.query(
      'SELECT id, username, avatar_color, avatar_url FROM users WHERE id = $1',
      [socket.user.id]
    );
    const fromUser = caller.rows[0] || {
      id: socket.user.id,
      username: socket.user.username,
      avatar_color: socket.user.avatar_color,
      avatar_url: socket.user.avatar_url || null,
    };

    io.to(`user:${toUserId}`).emit('call_invite', {
      callId,
      callType: callType || 'audio',
      sdp,
      from: {
        id: fromUser.id,
        username: fromUser.username,
        avatar_color: fromUser.avatar_color,
        avatar_url: fromUser.avatar_url || null,
      },
    });

    notifyIncomingCall(toUserId, fromUser, callId, callType || 'audio').catch(() => {});

    socket.emit('call_delivered', { callId, toUserId });
  });

  socket.on('call_ringing', ({ toUserId, callId }) => {
    if (!toUserId || !callId) return;
    io.to(`user:${toUserId}`).emit('call_ringing', { callId, fromUserId: socket.user.id });
  });

  socket.on('call_answer', ({ toUserId, callId, sdp }) => {
    if (!toUserId || !callId || !sdp) return;
    io.to(`user:${toUserId}`).emit('call_answer', {
      callId,
      sdp,
      fromUserId: socket.user.id,
    });
  });

  socket.on('call_ice', ({ toUserId, callId, candidate }) => {
    if (!toUserId || !callId || !candidate) return;
    io.to(`user:${toUserId}`).emit('call_ice', {
      callId,
      candidate,
      fromUserId: socket.user.id,
    });
  });

  socket.on('call_reject', ({ toUserId, callId }) => {
    if (!toUserId || !callId) return;
    io.to(`user:${toUserId}`).emit('call_reject', { callId, fromUserId: socket.user.id });
  });

  socket.on('call_end', ({ toUserId, callId }) => {
    if (!toUserId || !callId) return;
    io.to(`user:${toUserId}`).emit('call_end', { callId, fromUserId: socket.user.id });
  });

  socket.on('disconnect', () => {
    const presenceRoom = socket.data.presenceRoom;
    if (presenceRoom && onlineUsers.has(presenceRoom)) {
      onlineUsers.get(presenceRoom).delete(socket.user.username);
      io.to(presenceRoom).emit('online_users', {
        roomId: presenceRoom,
        users: [...onlineUsers.get(presenceRoom)],
      });
    }
    console.log(`🔌 ${socket.user.username} disconnected`);
  });
});

const PORT = process.env.PORT || 4000;

initDB().then(() => {
  server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
