const { pool } = require('./db');

/** True if viewer follows author (or is the author). Required to view stars/posts. */
async function viewerFollowsAuthor(viewerId, authorId) {
  if (!viewerId || !authorId || viewerId === authorId) return viewerId === authorId;
  const result = await pool.query(
    'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2 LIMIT 1',
    [viewerId, authorId]
  );
  return result.rows.length > 0;
}

/** True if either user follows the other (mutual or one-way). Used for online status. */
async function hasFollowConnection(userA, userB) {
  if (!userA || !userB || userA === userB) return userA === userB;
  const result = await pool.query(
    `SELECT 1 FROM follows
     WHERE (follower_id = $1 AND following_id = $2)
        OR (follower_id = $2 AND following_id = $1)
     LIMIT 1`,
    [userA, userB]
  );
  return result.rows.length > 0;
}

/** User ids who should receive presence updates about userId going online/offline. */
async function getPresenceAudience(userId) {
  const result = await pool.query(
    `SELECT DISTINCT u.id
     FROM users u
     WHERE u.id != $1
       AND (
         EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.following_id = u.id)
         OR EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = u.id AND f.following_id = $1)
       )`,
    [userId]
  );
  return result.rows.map((r) => r.id);
}

/** Filter a list of online user ids to those the viewer is allowed to see. */
async function filterVisibleOnlineIds(viewerId, onlineUserIds) {
  const visible = [];
  for (const id of onlineUserIds) {
    if (await hasFollowConnection(viewerId, id)) visible.push(id);
  }
  return visible;
}

module.exports = {
  viewerFollowsAuthor,
  hasFollowConnection,
  getPresenceAudience,
  filterVisibleOnlineIds,
};
