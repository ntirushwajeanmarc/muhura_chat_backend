#!/usr/bin/env node
/**
 * Test SMTP from the server environment.
 * Usage: node scripts/test-smtp.js you@example.com
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { verifySmtpConnection, sendPasswordResetEmail, smtpConfigured, getAppUrl } = require('../email');

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error('Usage: node scripts/test-smtp.js <recipient-email>');
    process.exit(1);
  }

  if (!smtpConfigured()) {
    console.error('SMTP_HOST, SMTP_USER, and SMTP_PASS must be set in backend/.env');
    process.exit(1);
  }

  console.log('Verifying SMTP connection…');
  const ok = await verifySmtpConnection();
  if (!ok) process.exit(1);

  const resetUrl = `${getAppUrl()}/?reset_token=test-token-not-valid`;
  console.log(`Sending test email to ${to}…`);
  await sendPasswordResetEmail({ to, username: 'Test', resetUrl });
  console.log('Done — check inbox and spam folder.');
}

main().catch((err) => {
  console.error('Test failed:', err.message);
  if (err.response) console.error(err.response);
  process.exit(1);
});
