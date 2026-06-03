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

const clientUrls = (process.env.CLIENT_URL || 'http://localhost:3000').split(',').map(url => url.trim());

const io = new Server(server, {
  cors: { origin: clientUrls, methods: ['GET', 'POST'] }
});

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || clientUrls.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS not allowed'));
    }
  }
}));
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

// Get messages for a room (last 50)
app.get('/api/rooms/:roomId/messages', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.id, m.content, m.created_at, u.username, u.avatar_color
       FROM messages m JOIN users u ON m.user_id = u.id
       WHERE m.room_id = $1
       ORDER BY m.created_at DESC LIMIT 50`,
      [req.params.roomId]
    );
    res.json(result.rows.reverse());
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

  socket.on('send_message', async ({ roomId, content }) => {
    if (!content?.trim()) return;
    try {
      const result = await pool.query(
        'INSERT INTO messages (room_id, user_id, content) VALUES ($1, $2, $3) RETURNING id, created_at',
        [roomId, socket.user.id, content.trim()]
      );
      const msg = {
        id: result.rows[0].id,
        content: content.trim(),
        created_at: result.rows[0].created_at,
        username: socket.user.username,
        room_id: roomId,
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
