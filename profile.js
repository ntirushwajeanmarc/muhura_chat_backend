const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('./db');
const { authenticate } = require('./auth');
const { bufferToBase64 } = require('./fileStorage');

const router = express.Router();

const AVATAR_DIR = path.join(__dirname, 'uploads', 'avatars');
const AVATAR_COLORS = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#25d366'];
const MAX_AVATAR_SIZE = 3 * 1024 * 1024;

if (!fs.existsSync(AVATAR_DIR)) {
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
}

function normalizePhone(phone) {
  if (!phone) return null;
  const trimmed = String(phone).trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[^\d+]/g, '');
  if (cleaned.replace(/\D/g, '').length < 7) return null;
  return cleaned;
}

function formatUser(row) {
  const user = {
    id: row.id,
    username: row.username,
    surname: row.surname || null,
    email: row.email,
    phone: row.phone || null,
    bio: row.bio || null,
    avatar_color: row.avatar_color,
    avatar_url: row.avatar_url || null,
  };
  if (row.like_count !== undefined && row.like_count !== null) {
    user.like_count = parseInt(row.like_count, 10) || 0;
  }
  if (row.liked_by_me !== undefined) {
    user.liked_by_me = !!row.liked_by_me;
  }
  return user;
}

function validateUsername(username) {
  const trimmed = (username || '').trim();
  if (!/^[a-zA-Z0-9_]{3,50}$/.test(trimmed)) {
    return { error: 'Username must be 3–50 characters (letters, numbers, underscore only)' };
  }
  return { value: trimmed };
}

async function getProfileLikeCount(userId) {
  const result = await pool.query(
    'SELECT COUNT(*)::int AS count FROM profile_likes WHERE liked_user_id = $1',
    [userId]
  );
  return result.rows[0]?.count || 0;
}

function issueToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      avatar_color: user.avatar_color,
      avatar_url: user.avatar_url || null,
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function deleteLocalAvatar(avatarUrl) {
  if (!avatarUrl || !avatarUrl.startsWith('/uploads/avatars/')) return;
  const filePath = path.join(__dirname, avatarUrl.replace('/uploads/', 'uploads/'));
  fs.unlink(filePath, () => {});
}

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: AVATAR_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `${uuidv4()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_AVATAR_SIZE },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed for profile photo'));
    }
  },
});

router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.surname, u.email, u.phone, u.bio, u.avatar_color, u.avatar_url,
              (SELECT COUNT(*)::int FROM profile_likes pl WHERE pl.liked_user_id = u.id) AS like_count
       FROM users u WHERE u.id = $1`,
      [req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(formatUser(result.rows[0]));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/user/:userId', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      `SELECT u.id, u.username, u.surname, u.phone, u.bio, u.avatar_color, u.avatar_url,
              (SELECT COUNT(*)::int FROM profile_likes pl WHERE pl.liked_user_id = u.id) AS like_count,
              EXISTS(
                SELECT 1 FROM profile_likes pl2
                WHERE pl2.liked_user_id = u.id AND pl2.liker_id = $2
              ) AS liked_by_me
       FROM users u WHERE u.id = $1`,
      [userId, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    const row = result.rows[0];
    res.json({
      user: {
        id: row.id,
        username: row.username,
        surname: row.surname || null,
        phone: row.phone || null,
        bio: row.bio || null,
        avatar_color: row.avatar_color,
        avatar_url: row.avatar_url || null,
        like_count: parseInt(row.like_count, 10) || 0,
        liked_by_me: !!row.liked_by_me,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/user/:userId/like', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'You cannot like your own profile' });
    }

    const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (!userCheck.rows[0]) return res.status(404).json({ error: 'User not found' });

    const existing = await pool.query(
      'SELECT 1 FROM profile_likes WHERE liker_id = $1 AND liked_user_id = $2',
      [req.user.id, userId]
    );

    let liked;
    if (existing.rows.length > 0) {
      await pool.query(
        'DELETE FROM profile_likes WHERE liker_id = $1 AND liked_user_id = $2',
        [req.user.id, userId]
      );
      liked = false;
    } else {
      await pool.query(
        'INSERT INTO profile_likes (liker_id, liked_user_id) VALUES ($1, $2)',
        [req.user.id, userId]
      );
      liked = true;
    }

    const likeCount = await getProfileLikeCount(userId);
    res.json({ liked, like_count: likeCount, user_id: userId });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/', authenticate, async (req, res) => {
  try {
    const { username, surname, phone, avatar_color, bio } = req.body;
    const updates = [];
    const values = [];
    let i = 1;

    if (username !== undefined) {
      const parsed = validateUsername(username);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      updates.push(`username = $${i++}`);
      values.push(parsed.value);
    }
    if (surname !== undefined) {
      updates.push(`surname = $${i++}`);
      values.push(surname?.trim() || null);
    }
    if (phone !== undefined) {
      const normalized = phone ? normalizePhone(phone) : null;
      if (phone && phone.trim() && !normalized) {
        return res.status(400).json({ error: 'Invalid phone number' });
      }
      updates.push(`phone = $${i++}`);
      values.push(normalized);
    }
    if (avatar_color !== undefined) {
      if (!AVATAR_COLORS.includes(avatar_color)) {
        return res.status(400).json({ error: 'Invalid avatar color' });
      }
      updates.push(`avatar_color = $${i++}`);
      values.push(avatar_color);
    }
    if (bio !== undefined) {
      const trimmed = (bio || '').trim().slice(0, 200);
      updates.push(`bio = $${i++}`);
      values.push(trimmed || null);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.user.id);
    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${i}
       RETURNING id, username, surname, email, phone, bio, avatar_color, avatar_url`,
      values
    );
    const user = formatUser(result.rows[0]);
    const token = issueToken(user);
    res.json({ user, token });
  } catch (err) {
    if (err.code === '23505') {
      if (err.constraint?.includes('phone')) {
        return res.status(409).json({ error: 'Phone number already registered' });
      }
      if (err.constraint?.includes('username')) {
        return res.status(409).json({ error: 'Username already taken' });
      }
    }
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/avatar', authenticate, (req, res) => {
  avatarUpload.single('photo')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Photo too large (max 3 MB)' });
      }
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    if (!req.file) return res.status(400).json({ error: 'No photo provided' });

    try {
      const current = await pool.query('SELECT avatar_url FROM users WHERE id = $1', [req.user.id]);
      const oldUrl = current.rows[0]?.avatar_url;
      const base64 = bufferToBase64(fs.readFileSync(req.file.path));
      const mime = req.file.mimetype || 'image/jpeg';
      const avatarUrl = `/avatars/user/${req.user.id}`;

      const result = await pool.query(
        `UPDATE users SET avatar_url = $1, avatar_data = $2, avatar_mime = $3, avatar_image = NULL WHERE id = $4
         RETURNING id, username, surname, email, phone, bio, avatar_color, avatar_url`,
        [avatarUrl, base64, mime, req.user.id]
      );

      deleteLocalAvatar(oldUrl);
      fs.unlink(req.file.path, () => {});
      const user = formatUser(result.rows[0]);
      const token = issueToken(user);
      res.json({ user, token });
    } catch (uploadErr) {
      fs.unlink(req.file.path, () => {});
      console.error('Avatar upload error:', uploadErr);
      res.status(500).json({ error: 'Server error' });
    }
  });
});

router.delete('/avatar', authenticate, async (req, res) => {
  try {
    const current = await pool.query('SELECT avatar_url FROM users WHERE id = $1', [req.user.id]);
    const oldUrl = current.rows[0]?.avatar_url;

    const result = await pool.query(
      `UPDATE users SET avatar_url = NULL, avatar_data = NULL, avatar_image = NULL, avatar_mime = NULL WHERE id = $1
       RETURNING id, username, surname, email, phone, bio, avatar_color, avatar_url`,
      [req.user.id]
    );

    deleteLocalAvatar(oldUrl);
    const user = formatUser(result.rows[0]);
    const token = issueToken(user);
    res.json({ user, token });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = { router, formatUser, issueToken, AVATAR_COLORS };
