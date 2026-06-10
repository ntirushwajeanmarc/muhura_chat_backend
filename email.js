const nodemailer = require('nodemailer');

let transporter = null;

function smtpConfigured() {
  return Boolean(
    process.env.SMTP_HOST
    && process.env.SMTP_USER
    && process.env.SMTP_PASS
  );
}

function getTransporter() {
  if (!smtpConfigured()) return null;
  if (transporter) return transporter;

  const port = parseInt(process.env.SMTP_PORT, 10) || 465;
  const secure = process.env.SMTP_SECURE !== 'false' && port === 465;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    ...(port === 587 ? { requireTLS: true } : {}),
  });

  return transporter;
}

function getFromAddress() {
  const from = process.env.SMTP_FROM?.trim();
  if (from) return from;
  const user = process.env.SMTP_USER?.trim();
  return user ? `"EganirA" <${user}>` : '"EganirA" <noreply@localhost>';
}

function getAppUrl() {
  const explicit = process.env.APP_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const client = process.env.CLIENT_URL?.split(',')[0]?.trim();
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

  await transport.sendMail({
    from: getFromAddress(),
    to,
    replyTo: process.env.SMTP_REPLY_TO || process.env.SMTP_USER,
    subject,
    text,
    html,
  });
}

module.exports = {
  smtpConfigured,
  getAppUrl,
  sendPasswordResetEmail,
};
