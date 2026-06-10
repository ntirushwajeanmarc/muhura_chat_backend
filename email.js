const dns = require('dns').promises;
const nodemailer = require('nodemailer');

let transporter = null;
let resolvedSmtpEndpoint = null;

function env(key) {
  return (process.env[key] || '').trim();
}

function envInt(key, fallback) {
  const parsed = parseInt(env(key), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function getSmtpRetryAttempts() {
  return Math.max(1, envInt('SMTP_RETRY_ATTEMPTS', 3));
}

function getSmtpRetryDelayMs() {
  return Math.max(250, envInt('SMTP_RETRY_DELAY_MS', 1500));
}

/** Hostinger is picky — resolve IPv4 up front so the TCP handshake starts immediately. */
async function resolveSmtpEndpoint() {
  if (resolvedSmtpEndpoint) return resolvedSmtpEndpoint;

  const hostname = env('SMTP_HOST');
  try {
    const { address } = await dns.lookup(hostname, { family: 4 });
    resolvedSmtpEndpoint = { hostname, address };
  } catch {
    resolvedSmtpEndpoint = { hostname, address: hostname };
  }
  return resolvedSmtpEndpoint;
}

function buildTransportOptions(endpoint) {
  const port = getSmtpPort();
  const secure = getSmtpSecure();

  return {
    host: endpoint.address,
    port,
    secure,
    // EHLO identity must stay the real hostname, not the resolved IP
    name: endpoint.hostname,
    family: 4,
    auth: {
      user: env('SMTP_USER'),
      pass: getSmtpPass(),
    },
    tls: {
      servername: endpoint.hostname,
      minVersion: 'TLSv1.2',
    },
    // Hostinger drops slow clients — fail fast, then retry quickly
    connectionTimeout: envInt('SMTP_CONNECTION_TIMEOUT_MS', 12_000),
    greetingTimeout: envInt('SMTP_GREETING_TIMEOUT_MS', 8_000),
    socketTimeout: envInt('SMTP_SOCKET_TIMEOUT_MS', 15_000),
    ...(port === 587 && !secure ? { requireTLS: true } : {}),
  };
}

async function createTransporter() {
  const endpoint = await resolveSmtpEndpoint();
  return nodemailer.createTransport(buildTransportOptions(endpoint));
}

async function getTransporter() {
  if (!smtpConfigured()) return null;
  if (transporter) return transporter;
  transporter = await createTransporter();
  return transporter;
}

function resetTransporter() {
  if (transporter) {
    try {
      transporter.close();
    } catch {
      // ignore close errors between retries
    }
  }
  transporter = null;
}

async function withSmtpRetry(label, operation) {
  const attempts = getSmtpRetryAttempts();
  const delayMs = getSmtpRetryDelayMs();
  let lastErr;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      resetTransporter();
      return await operation(await createTransporter());
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        console.warn(`⚠️  SMTP ${label} attempt ${attempt}/${attempts} failed (${err.message}), retrying in ${delayMs}ms…`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastErr;
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
    retry_attempts: getSmtpRetryAttempts(),
  };
}

function logSmtpConfig() {
  const cfg = getSmtpConfigForLog();
  if (!smtpConfigured()) {
    console.warn('⚠️  SMTP not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS in environment');
    return;
  }
  console.log(`📬 SMTP mail server: ${cfg.host}:${cfg.port} secure=${cfg.secure} user=${cfg.user} (IPv4, ${cfg.retry_attempts} attempts)`);
  console.log(`🌐 HTTP web server will use PORT=${cfg.http_port} (separate from SMTP_PORT)`);
}

function logSmtpFailure(err) {
  console.error('❌ SMTP verification failed:', err.message);
  const msg = String(err.message || '').toLowerCase();
  if (msg.includes('enetunreach')) {
    console.error('   IPv6 route unavailable — using IPv4 lookup + family: 4.');
  }
  if (msg.includes('timeout') || msg.includes('timed out') || err.code === 'ETIMEDOUT') {
    console.error('   All retry attempts timed out — TCP to the SMTP port never opened.');
    console.error('   HTTP/WebSocket work but SMTP does not → Render free tier blocks outbound ports 465/587.');
    console.error('   Fix: upgrade to a paid Render instance, or host the API on Hostinger/VPS where SMTP works.');
    console.error('   Quick test: set SMTP_PORT=587 SMTP_SECURE=false — if it still times out, egress is blocked.');
  }
}

async function verifySmtpConnection() {
  if (env('SMTP_SKIP_VERIFY').toLowerCase() === 'true') {
    logSmtpConfig();
    console.log('⏭️  SMTP startup verify skipped (SMTP_SKIP_VERIFY=true)');
    return true;
  }

  logSmtpConfig();
  if (!smtpConfigured()) return false;

  try {
    await withSmtpRetry('verify', (transport) => transport.verify());
    transporter = await createTransporter();
    const cfg = getSmtpConfigForLog();
    console.log(`✅ SMTP verified (${cfg.host}:${cfg.port} as ${cfg.user})`);
    return true;
  } catch (err) {
    logSmtpFailure(err);
    resetTransporter();
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
  if (!smtpConfigured()) {
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
  const mailOptions = {
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
  };

  const info = await withSmtpRetry('send', (transport) => transport.sendMail(mailOptions));
  transporter = await createTransporter();

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
