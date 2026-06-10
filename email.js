const nodemailer = require('nodemailer');

let transporter = null;

function env(key) {
  return (process.env[key] || '').trim();
}

/** Strip accidental quotes if password was pasted with '...' in hosting UI */
function getSmtpPass() {
  const pass = process.env.SMTP_PASS || '';
  if (
    (pass.startsWith("'") && pass.endsWith("'"))
    || (pass.startsWith('"') && pass.endsWith('"'))
  ) {
    return pass.slice(1, -1);
  }
  return pass;
}

function smtpConfigured() {
  return Boolean(env('SMTP_HOST') && env('SMTP_USER') && getSmtpPass());
}

function getSmtpPort() {
  const parsed = parseInt(env('SMTP_PORT'), 10);
  return Number.isFinite(parsed) ? parsed : 465;
}

function getSmtpSecure() {
  const value = env('SMTP_SECURE').toLowerCase();
  if (value === 'false' || value === '0') return false;
  if (value === 'true' || value === '1') return true;
  return getSmtpPort() === 465;
}

function getTransporter() {
  if (!smtpConfigured()) return null;
  if (transporter) return transporter;

  const port = getSmtpPort();
  const secure = getSmtpSecure();

  transporter = nodemailer.createTransport({
    host: env('SMTP_HOST'),
    port,
    secure,
    // Render/cloud often has no IPv6 route — Hostinger resolves to IPv6 and fails with ENETUNREACH
    family: 4,
    auth: {
      user: env('SMTP_USER'),
      pass: getSmtpPass(),
    },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 25_000,
    ...(port === 587 && !secure ? { requireTLS: true } : {}),
  });

  return transporter;
}

function getFromAddress() {
  if (env('SMTP_FROM')) return env('SMTP_FROM');
  const user = env('SMTP_USER');
  return user ? `"EganirA" <${user}>` : '"EganirA" <noreply@localhost>';
}

function getSmtpConfigForLog() {
  return {
    host: env('SMTP_HOST') || null,
    port: getSmtpPort(),
    secure: getSmtpSecure(),
    user: env('SMTP_USER') || null,
    from: getFromAddress(),
    reply_to: env('SMTP_REPLY_TO') || env('SMTP_USER') || null,
    http_port: env('PORT') || '4000',
  };
}

function logSmtpConfig() {
  const cfg = getSmtpConfigForLog();
  if (!smtpConfigured()) {
    console.warn('⚠️  SMTP not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS in environment');
    return;
  }
  console.log(`📬 SMTP mail server: ${cfg.host}:${cfg.port} secure=${cfg.secure} user=${cfg.user} (IPv4)`);
  console.log(`🌐 HTTP web server will use PORT=${cfg.http_port} (separate from SMTP_PORT)`);
}

async function verifySmtpConnection() {
  logSmtpConfig();
  if (!smtpConfigured()) return false;

  try {
    await getTransporter().verify();
    const cfg = getSmtpConfigForLog();
    console.log(`✅ SMTP verified (${cfg.host}:${cfg.port} as ${cfg.user})`);
    return true;
  } catch (err) {
    console.error('❌ SMTP verification failed:', err.message);
    const msg = String(err.message || '').toLowerCase();
    if (msg.includes('enetunreach')) {
      console.error('   IPv6 route unavailable — connection forced to IPv4 (family: 4). Redeploy if this persists.');
    }
    if (msg.includes('timeout') || msg.includes('timed out') || err.code === 'ETIMEDOUT') {
      console.error('   Outbound SMTP to ports 465/587 is often blocked on free PaaS hosts (e.g. Render free tier).');
      console.error('   Your config looks correct — upgrade to a paid Render instance, or run the API on Hostinger/VPS where SMTP works.');
      console.error('   HTTP PORT and SMTP_PORT are unrelated; this is not a port mix-up.');
    }
    return false;
  }
}

function getAppUrl() {
  const explicit = env('APP_URL');
  if (explicit) return explicit.replace(/\/$/, '');
  const client = env('CLIENT_URL').split(',')[0];
  if (client) return client.replace(/\/$/, '');
  return 'http://localhost:5173';
}

async function sendPasswordResetEmail({ to, username, resetUrl }) {
  const transport = getTransporter();
  if (!transport) {
    throw new Error('Email is not configured on the server');
  }

  const displayName = username || 'there';
  const subject = 'Reset your EganirA password';
  const text = [
    `Hi ${displayName},`,
    '',
    'We received a request to reset your EganirA password.',
    'Open this link to choose a new password (valid for 1 hour):',
    resetUrl,
    '',
    'If you did not request this, you can ignore this email.',
    '',
    '— EganirA / CircuitNotion',
  ].join('\n');

  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#1e293b;">
      <p style="font-size:16px;">Hi ${displayName},</p>
      <p style="font-size:15px;line-height:1.5;">We received a request to reset your <strong>EganirA</strong> password.</p>
      <p style="margin:28px 0;">
        <a href="${resetUrl}" style="display:inline-block;background:#00a884;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:15px;">Reset password</a>
      </p>
      <p style="font-size:13px;color:#64748b;line-height:1.5;">This link expires in <strong>1 hour</strong>. If the button does not work, copy and paste this URL into your browser:</p>
      <p style="font-size:12px;word-break:break-all;color:#475569;">${resetUrl}</p>
      <p style="font-size:13px;color:#64748b;margin-top:28px;">If you did not request a password reset, you can safely ignore this email.</p>
      <p style="font-size:12px;color:#94a3b8;margin-top:32px;">— EganirA / CircuitNotion</p>
    </div>
  `;

  const smtpUser = env('SMTP_USER');
  const info = await transport.sendMail({
    from: getFromAddress(),
    to,
    replyTo: env('SMTP_REPLY_TO') || smtpUser,
    envelope: {
      from: smtpUser,
      to,
    },
    subject,
    text,
    html,
  });

  console.log(`📧 Password reset sent to ${to} (messageId: ${info.messageId || 'n/a'})`);
  return info;
}

module.exports = {
  smtpConfigured,
  getAppUrl,
  getSmtpConfigForLog,
  verifySmtpConnection,
  sendPasswordResetEmail,
};
