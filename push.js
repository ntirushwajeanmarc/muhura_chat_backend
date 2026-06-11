const express = require('express');
const webpush = require('web-push');
const { pool } = require('./db');
const { authenticate } = require('./auth');
const { sendFcmToUser } = require('./fcm');
const { parseMentionUsernames } = require('./mentions');

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
  if (msg.deleted_at) return 'Message deleted';
  if (msg.attachment) {
    const mime = msg.attachment.mime || '';
    const name = msg.attachment.name || '';
    const isImg = mime.startsWith('image/') || /\.(jpe?g|png|gif|webp)$/i.test(name);
    return isImg ? 'Sent a photo' : `Sent a file: ${name || 'attachment'}`;
  }
  const text = (msg.content || '').trim();
  if (!text) return 'Sent a message';
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
  const tasks = [sendFcmToUser(userId, payload)];

  if (configured) {
    const subs = await getSubscriptionsForUser(userId);
    const payloadStr = JSON.stringify(payload);
    tasks.push(
      ...subs.map(async (sub) => {
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

  await Promise.allSettled(tasks);
}

async function getUserIdsByUsernames(usernames, roomId) {
  if (!usernames.length) return new Map();
  const result = await pool.query(
    `SELECT u.id, LOWER(u.username) AS username
     FROM users u
     INNER JOIN room_members rm ON rm.user_id = u.id AND rm.room_id = $1
     WHERE LOWER(u.username) = ANY($2::text[])`,
    [roomId, usernames]
  );
  return new Map(result.rows.map((row) => [row.username, row.id]));
}

async function notifyRoomMessage(msg, senderUserId) {
  if (!msg?.room_id) return;

  const memberIds = await getRoomMembers(msg.room_id, senderUserId);
  if (!memberIds.length) return;

  const room = await getRoomInfo(msg.room_id);
  const preview = messagePreview(msg);
  const sender = msg.username || 'Someone';
  const mentionedNames = parseMentionUsernames(msg.content);
  const mentionedIds = await getUserIdsByUsernames(mentionedNames, msg.room_id);

  await Promise.allSettled(
    memberIds.map((userId) => {
      const isMentioned = [...mentionedIds.values()].includes(userId);
      let body;
      if (isMentioned) {
        body = room?.type === 'direct'
          ? `${sender} mentioned you: ${preview}`
          : `${sender} mentioned you in #${room?.name || 'chat'}: ${preview}`;
      } else {
        body = room?.type === 'direct'
          ? `${sender}: ${preview}`
          : `${sender} in #${room?.name || 'chat'}: ${preview}`;
      }
      return sendToUser(userId, {
        title: 'EganirA',
        body,
        type: 'message',
        roomId: msg.room_id,
        url: `/?room=${msg.room_id}`,
        silent: false,
      });
    })
  );
}

async function notifyNewFollow(toUserId, follower) {
  if (!toUserId || !follower?.username) return;

  await sendToUser(toUserId, {
    title: 'EganirA',
    body: `${follower.username} started following you`,
    type: 'follow',
    fromUserId: follower.id,
    url: '/',
    silent: false,
  });
}

async function notifyIncomingCall(toUserId, fromUser, callId, callType) {
  if (!toUserId || !callId) return;

  const label = callType === 'video' ? 'Video' : 'Voice';
  await sendToUser(toUserId, {
    title: 'EganirA',
    body: `${label} call from ${fromUser.username}`,
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

router.post('/fcm-register', authenticate, async (req, res) => {
  const { token, platform } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token required' });
  }
  try {
    await pool.query(
      `INSERT INTO fcm_tokens (user_id, token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, token) DO UPDATE SET platform = EXCLUDED.platform`,
      [req.user.id, token.trim(), platform || 'android']
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('FCM register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/fcm-register', authenticate, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    await pool.query(
      'DELETE FROM fcm_tokens WHERE user_id = $1 AND token = $2',
      [req.user.id, token]
    );
    res.json({ ok: true });
  } catch (err) {
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
  notifyNewFollow,
};
