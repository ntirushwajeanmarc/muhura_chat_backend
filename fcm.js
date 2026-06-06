const { pool } = require('./db');

const FCM_SERVER_KEY = process.env.FCM_SERVER_KEY;

function isFcmConfigured() {
  return !!FCM_SERVER_KEY;
}

async function getFcmTokensForUser(userId) {
  const result = await pool.query(
    'SELECT token FROM fcm_tokens WHERE user_id = $1',
    [userId]
  );
  return result.rows.map((r) => r.token);
}

async function sendFcmToTokens(tokens, payload) {
  if (!FCM_SERVER_KEY || !tokens.length) return;

  const body = {
    registration_ids: tokens,
    priority: 'high',
    notification: {
      title: payload.title || 'EganirA',
      body: payload.body || '',
      sound: 'default',
    },
    data: {
      type: payload.type || 'message',
      roomId: payload.roomId || '',
      callId: payload.callId || '',
      fromUserId: payload.fromUserId || '',
      url: payload.url || '/',
    },
  };

  try {
    const res = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `key=${FCM_SERVER_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn('FCM send failed:', res.status, await res.text());
      return;
    }
    const json = await res.json();
    const stale = [];
    if (json.results) {
      json.results.forEach((r, i) => {
        if (r.error === 'NotRegistered' || r.error === 'InvalidRegistration') {
          stale.push(tokens[i]);
        }
      });
    }
    for (const token of stale) {
      await pool.query('DELETE FROM fcm_tokens WHERE token = $1', [token]);
    }
  } catch (err) {
    console.warn('FCM error:', err.message);
  }
}

async function sendFcmToUser(userId, payload) {
  const tokens = await getFcmTokensForUser(userId);
  await sendFcmToTokens(tokens, payload);
}

module.exports = { isFcmConfigured, sendFcmToUser, getFcmTokensForUser };
