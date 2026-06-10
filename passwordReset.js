const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const { getAppUrl, sendPasswordResetEmail, smtpConfigured } = require('./email');

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const MIN_PASSWORD_LENGTH = 8;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

function validatePassword(password) {
  if (!password || String(password).length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

async function requestPasswordReset(email) {
  if (!smtpConfigured()) {
    return { ok: false, status: 503, error: 'Password reset email is not configured on the server.' };
  }

  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    return { ok: false, status: 400, error: 'Email is required' };
  }

  const userResult = await pool.query(
    'SELECT id, username, email FROM users WHERE LOWER(email) = $1',
    [normalizedEmail]
  );
  const user = userResult.rows[0];

  // Always return success to avoid email enumeration
  const generic = {
    ok: true,
    message: 'If an account exists for that email, we sent a password reset link.',
  };

  if (!user) return generic;

  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await pool.query(
    'UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL',
    [user.id]
  );

  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [user.id, tokenHash, expiresAt]
  );

  const resetUrl = `${getAppUrl()}/?reset_token=${rawToken}`;

  // Respond to the client immediately — do not block on SMTP (Hostinger can be slow/hang).
  const emailPayload = {
    to: user.email,
    username: user.username,
    resetUrl,
  };
  setImmediate(() => {
    sendPasswordResetEmail(emailPayload).catch((err) => {
      console.error('Password reset email error:', err.message);
    });
  });

  return generic;
}

async function resetPasswordWithToken(token, password) {
  const passwordError = validatePassword(password);
  if (passwordError) {
    return { ok: false, status: 400, error: passwordError };
  }

  const rawToken = String(token || '').trim();
  if (!rawToken) {
    return { ok: false, status: 400, error: 'Reset token is required' };
  }

  const tokenHash = hashToken(rawToken);

  const tokenResult = await pool.query(
    `SELECT prt.id, prt.user_id, prt.expires_at, prt.used_at
     FROM password_reset_tokens prt
     WHERE prt.token_hash = $1`,
    [tokenHash]
  );

  const row = tokenResult.rows[0];
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
    return { ok: false, status: 400, error: 'This reset link is invalid or has expired.' };
  }

  const hash = await bcrypt.hash(password, 10);

  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, row.user_id]);
  await pool.query(
    'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1',
    [row.id]
  );
  await pool.query(
    'UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL',
    [row.user_id]
  );

  return { ok: true, message: 'Password updated. You can sign in with your new password.' };
}

async function verifyResetToken(token) {
  const rawToken = String(token || '').trim();
  if (!rawToken) return { valid: false };

  const tokenHash = hashToken(rawToken);
  const tokenResult = await pool.query(
    `SELECT expires_at, used_at FROM password_reset_tokens WHERE token_hash = $1`,
    [tokenHash]
  );
  const row = tokenResult.rows[0];
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
    return { valid: false };
  }
  return { valid: true };
}

module.exports = {
  requestPasswordReset,
  resetPasswordWithToken,
  verifyResetToken,
  MIN_PASSWORD_LENGTH,
};
