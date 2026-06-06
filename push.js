const express = require('express');
const webpush = require('web-push');
const { pool } = require('./db');
const { authenticate } = require('./auth');

const router = express.Router();

let configured = false;

function configureVapid() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@eganira.com';
  if (!publicKey || !privateKey) {
    console.warn('⚠️ VAPID keys not set — background push notifications disabled');
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

function isConfigured() {
  return configured;
}

function messagePreview(msg) {
  if (msg.attachment) {
    const mime = msg.attachment.mime || '';
    const name = msg.attachment.name || '';
    const isImg = mime.startsWith('image/') || /\.(jpe?g|png|gif|webp)$/i.test(name);
    return isImg ? '📷 Photo' : `📎 ${name || 'File'}`;
  }
  const text = (msg.content || '').trim();
  if (!text) return 'New message';
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

async function getRoomMembers(roomId, excludeUserId) {
  const result = await pool.query(
    'SELECT user_id FROM room_members WHERE room_id = $1 AND user_id <> $2',
    [roomId, excludeUserId]
  );
  return result.rows.map((row) => row.user_id);
}

async function getRoomInfo(roomId) {
  const result = await pool.query(
    'SELECT id, name, type FROM rooms WHERE id = $1',
    [roomId]
  );
  return result.rows[0] || null;
}

async function getSubscriptionsForUser(userId) {
  const result = await pool.query(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId]
  );
  return result.rows;
}

async function sendToUser(userId, payload) {
  if (!configured) return;
  const subs = await getSubscriptionsForUser(userId);
  if (!subs.length) return;

  const payloadStr = JSON.stringify(payload);
  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payloadStr
        );
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pool.query(
            'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
            [userId, sub.endpoint]
          );
        }
      }
    })
  );
}

async function notifyRoomMessage(msg, senderUserId) {
  if (!configured || !msg?.room_id) return;

  const memberIds = await getRoomMembers(msg.room_id, senderUserId);
  if (!memberIds.length) return;

  const room = await getRoomInfo(msg.room_id);
  const body = messagePreview(msg);
  const title = room?.type === 'direct'
    ? msg.username
    : `${msg.username} in ${room?.name || 'chat'}`;

  await Promise.allSettled(
    memberIds.map((userId) =>
      sendToUser(userId, {
        title,
        body,
        type: 'message',
        roomId: msg.room_id,
        url: `/?room=${msg.room_id}`,
        silent: false,
      })
    )
  );
}

async function notifyIncomingCall(toUserId, fromUser, callId, callType) {
  if (!configured || !toUserId || !callId) return;

  const label = callType === 'video' ? 'video' : 'voice';
  await sendToUser(toUserId, {
    title: `Incoming ${label} call`,
    body: `${fromUser.username} is calling you`,
    type: 'call',
    callId,
    fromUserId: fromUser.id,
    url: '/',
    silent: false,
    requireInteraction: true,
    vibrate: [300, 100, 300, 100, 300, 100, 600],
  });
}

router.get('/vapid-public-key', (_req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: 'Push not configured' });
  res.json({ publicKey: key });
});

router.post('/subscribe', authenticate, async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, endpoint) DO UPDATE
       SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
      [req.user.id, endpoint, keys.p256dh, keys.auth, req.headers['user-agent'] || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Push subscribe error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/subscribe', authenticate, async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  try {
    await pool.query(
      'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
      [req.user.id, endpoint]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = {
  router,
  configureVapid,
  isConfigured,
  notifyRoomMessage,
  notifyIncomingCall,
};
