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
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

function formatMessageRow(row) {
  const msg = {
    id: row.id,
    content: row.content,
    created_at: row.created_at,
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
  return msg;
}

function buildLiveMessage(row, socketUser, roomId, replyTo = null) {
  const msg = {
    id: row.id,
    content: row.content,
    created_at: row.created_at,
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
  return room;
}

const allowedOrigins = process.env.CLIENT_URL
  ? process.env.CLIENT_URL.split(',').map((o) => o.trim()).filter(Boolean)
  : defaultOrigins;

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

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());
// Files served only via authenticated /api/files (see below)

// Routes
app.use('/api/auth', authRouter);
app.use('/api/profile', profileRouter);

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
    if (!urlPath || typeof urlPath !== 'string' || !urlPath.startsWith('/uploads/') || urlPath.includes('..')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const diskPath = resolveUploadPath(urlPath);
    if (!diskPath || !fs.existsSync(diskPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const forceDownload = req.query.download === '1' || req.query.download === 'true';

    if (urlPath.includes('/avatars/')) {
      const owner = await pool.query('SELECT id FROM users WHERE avatar_url = $1', [urlPath]);
      if (owner.rows[0]) {
        return sendStoredFile(res, diskPath, { mime: mimeFromPath(diskPath), forceDownload: false });
      }
    }

    const msg = await pool.query(
      'SELECT room_id, attachment_name, attachment_mime FROM messages WHERE attachment_url = $1 LIMIT 1',
      [urlPath]
    );
    if (msg.rows[0] && (await canAccessRoom(req.user.id, msg.rows[0].room_id))) {
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

// Public channels (global rooms)
app.get('/api/rooms', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (name) id, name, description, type, created_by, created_at
       FROM rooms
       WHERE type = 'public'
       ORDER BY name, created_at ASC`
    );
    const rooms = result.rows.map((r) => ({
      ...r,
      type: 'public',
      display_name: r.name,
    }));
    res.json(rooms);
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
              lm.content AS last_message, lm.created_at AS last_message_at
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
              lm.content AS last_message, lm.created_at AS last_message_at
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

const MESSAGE_PAGE_SIZE = 50;
const MESSAGE_PAGE_MAX = 100;

const MESSAGE_SELECT = `
  SELECT m.id, m.content, m.created_at, m.edited_at, m.reply_to_id,
         m.attachment_url, m.attachment_name, m.attachment_mime,
         u.username, u.avatar_color, u.avatar_url,
         ru.username AS reply_username,
         rm.content AS reply_content
  FROM messages m
  JOIN users u ON m.user_id = u.id
  LEFT JOIN messages rm ON m.reply_to_id = rm.id
  LEFT JOIN users ru ON rm.user_id = ru.id
`;

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

      const attachmentUrl = `/uploads/${req.file.filename}`;
      const fileMime = resolveStoredMime(
        req.file.mimetype,
        path.join(UPLOAD_DIR, req.file.filename)
      );
      const result = await pool.query(
        `INSERT INTO messages (room_id, user_id, content, reply_to_id, attachment_url, attachment_name, attachment_mime)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, content, created_at, attachment_url, attachment_name, attachment_mime`,
        [
          roomId,
          req.user.id,
          caption,
          replyTo?.id || null,
          attachmentUrl,
          req.file.originalname,
          fileMime,
        ]
      );

      const row = result.rows[0];
      const msg = buildLiveMessage(row, req.user, roomId, replyTo);
      io.to(roomId).emit('new_message', msg);
      res.json({ message: formatMessageRow({ ...row, username: req.user.username, avatar_color: req.user.avatar_color, reply_to_id: replyTo?.id, reply_username: replyTo?.username, reply_content: replyTo?.content }) });
    } catch (uploadErr) {
      fs.unlink(req.file.path, () => {});
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
        `${MESSAGE_SELECT}
         WHERE m.room_id = $1
           AND m.created_at < (
             SELECT created_at FROM messages WHERE id = $2 AND room_id = $1
           )
         ORDER BY m.created_at DESC
         LIMIT $3`,
        [roomId, beforeId, limit]
      );
    } else {
      result = await pool.query(
        `${MESSAGE_SELECT}
         WHERE m.room_id = $1
         ORDER BY m.created_at DESC
         LIMIT $2`,
        [roomId, limit]
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

  const full = await pool.query(`${MESSAGE_SELECT} WHERE m.id = $1`, [messageId]);
  const msg = formatMessageRow(full.rows[0]);
  msg.room_id = roomId;
  return { message: msg };
}

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

  const publicRooms = await pool.query("SELECT id FROM rooms WHERE type = 'public'");
  for (const row of publicRooms.rows) {
    socket.join(row.id);
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

      const result = await pool.query(
        `INSERT INTO messages (room_id, user_id, content, reply_to_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id, content, created_at, attachment_url, attachment_name, attachment_mime`,
        [roomId, socket.user.id, content.trim(), replyTo?.id || null]
      );
      const msg = buildLiveMessage(result.rows[0], socket.user, roomId, replyTo);
      io.to(roomId).emit('new_message', msg);
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
