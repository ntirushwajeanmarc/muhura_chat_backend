const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { pool } = require('./db');
const {
  requestPasswordReset,
  resetPasswordWithToken,
  verifyResetToken,
} = require('./passwordReset');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in 15 minutes.' },
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reset requests. Please try again in an hour.' },
});

const COLORS = ['#6366f1','#ec4899','#14b8a6','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ef4444'];

function normalizePhone(phone) {
  if (!phone) return null;
  const trimmed = String(phone).trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[^\d+]/g, '');
  if (cleaned.replace(/\D/g, '').length < 7) return null;
  return cleaned;
}

function formatUser(row) {
  return {
    id: row.id,
    username: row.username,
    surname: row.surname || null,
    email: row.email,
    phone: row.phone || null,
    bio: row.bio || null,
    avatar_color: row.avatar_color,
    avatar_url: row.avatar_url || null,
    chat_wallpaper: row.chat_wallpaper || 'default',
  };
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

// Register
router.post('/register', authLimiter, async (req, res) => {
  const { username, surname, email, password, phone } = req.body;
  const normalizedSurname = surname?.trim() || null;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'Username, email and password are required' });

  const normalizedPhone = normalizePhone(phone);
  if (phone && phone.trim() && !normalizedPhone) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const result = await pool.query(
      'INSERT INTO users (username, surname, email, phone, password_hash, avatar_color) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, username, surname, email, phone, bio, avatar_color, avatar_url',
      [username, normalizedSurname, email, normalizedPhone, hash, color]
    );
    const user = formatUser(result.rows[0]);
    const token = issueToken(user);
    res.json({ token, user });
  } catch (err) {
    if (err.code === '23505') {
      if (err.constraint?.includes('phone')) {
        return res.status(409).json({ error: 'Phone number already registered' });
      }
      return res.status(409).json({ error: 'Username or email already taken' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'All fields required' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = issueToken(formatUser(user));
    res.json({ token, user: formatUser(user) });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Request password reset email
router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  try {
    const result = await requestPasswordReset(req.body?.email);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json({ message: result.message });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Check reset token (optional — used by frontend before showing form)
router.get('/reset-password/verify', async (req, res) => {
  try {
    const { valid } = await verifyResetToken(req.query.token);
    if (!valid) {
      return res.status(400).json({ valid: false, error: 'Invalid or expired reset link' });
    }
    res.json({ valid: true });
  } catch (err) {
    console.error('Verify reset token error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Set new password with reset token
router.post('/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, password } = req.body || {};
    const result = await resetPasswordWithToken(token, password);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json({ message: result.message });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Verify token middleware (exported)
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

module.exports = { router, authenticate };
