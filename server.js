require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { pool, initDB } = require('./db');
const { router: authRouter, authenticate } = require('./auth');

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
  };
  if (row.reply_to_id && row.reply_username) {
    msg.reply_to = {
      id: row.reply_to_id,
      username: row.reply_username,
      content: row.reply_content,
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

// Routes
app.use('/api/auth', authRouter);

// Search users (for starting DMs or adding to groups)
app.get('/api/users/search', authenticate, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 1) return res.json([]);
    const result = await pool.query(
      `SELECT id, username, avatar_color
       FROM users
       WHERE id <> $1 AND username ILIKE $2
       ORDER BY username
       LIMIT 20`,
      [req.user.id, `%${q}%`]
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
      'SELECT id, username, avatar_color FROM users WHERE id = $1',
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
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const room = await client.query(
          `INSERT INTO rooms (type, created_by) VALUES ('direct', $1) RETURNING id`,
          [userId]
        );
        roomId = room.rows[0].id;
        await client.query(
          `INSERT INTO room_members (room_id, user_id) VALUES ($1, $2), ($1, $3)`,
          [roomId, userId, peerId]
        );
        await client.query('COMMIT');
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
  SELECT m.id, m.content, m.created_at, m.reply_to_id,
         u.username, u.avatar_color,
         ru.username AS reply_username,
         rm.content AS reply_content
  FROM messages m
  JOIN users u ON m.user_id = u.id
  LEFT JOIN messages rm ON m.reply_to_id = rm.id
  LEFT JOIN users ru ON rm.user_id = ru.id
`;

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

io.on('connection', (socket) => {
  console.log(`🔌 ${socket.user.username} connected`);

  socket.on('join_room', async (roomId) => {
    if (!(await canAccessRoom(socket.user.id, roomId))) return;

    socket.rooms.forEach(r => {
      if (r !== socket.id) {
        socket.leave(r);
        if (onlineUsers.has(r)) {
          onlineUsers.get(r).delete(socket.user.username);
          io.to(r).emit('online_users', [...(onlineUsers.get(r) || [])]);
        }
      }
    });

    socket.join(roomId);
    if (!onlineUsers.has(roomId)) onlineUsers.set(roomId, new Set());
    onlineUsers.get(roomId).add(socket.user.username);
    io.to(roomId).emit('online_users', [...onlineUsers.get(roomId)]);
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
        'INSERT INTO messages (room_id, user_id, content, reply_to_id) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
        [roomId, socket.user.id, content.trim(), replyTo?.id || null]
      );
      const msg = {
        id: result.rows[0].id,
        content: content.trim(),
        created_at: result.rows[0].created_at,
        username: socket.user.username,
        avatar_color: socket.user.avatar_color,
        room_id: roomId,
        reply_to: replyTo,
      };
      io.to(roomId).emit('new_message', msg);
    } catch (err) {
      console.error('Message error:', err);
    }
  });

  socket.on('typing', ({ roomId, isTyping }) => {
    socket.to(roomId).emit('user_typing', { username: socket.user.username, isTyping });
  });

  socket.on('disconnect', () => {
    onlineUsers.forEach((users, roomId) => {
      if (users.has(socket.user.username)) {
        users.delete(socket.user.username);
        io.to(roomId).emit('online_users', [...users]);
      }
    });
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
