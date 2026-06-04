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

// Get all rooms
app.get('/api/rooms', authenticate, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM rooms ORDER BY created_at ASC');
    res.json(result.rows);
  } catch (err) {
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

  socket.on('join_room', (roomId) => {
    // Leave old rooms
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
