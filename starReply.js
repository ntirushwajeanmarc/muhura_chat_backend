const { pool } = require('./db');
const { viewerFollowsAuthor } = require('./followVisibility');

function formatStarReplyRow(row) {
  if (!row?.star_reply_id) return null;
  return {
    id: row.star_reply_id,
    user_id: row.star_reply_user_id,
    username: row.star_reply_username,
    content: row.star_reply_content || null,
    background_color: row.star_reply_background_color || null,
    image_url: row.star_reply_has_image ? `/stars/db/${row.star_reply_id}` : null,
    image_mime: row.star_reply_image_mime || null,
  };
}

async function resolveStarReply(starId, senderId) {
  const result = await pool.query(
    `SELECT s.id, s.user_id, s.content, s.background_color, s.image_mime,
            CASE WHEN s.image_data IS NOT NULL THEN true ELSE false END AS has_image,
            u.username
     FROM stars s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1`,
    [starId]
  );
  const row = result.rows[0];
  if (!row) return { error: 'Star not found' };
  if (row.user_id === senderId) return { error: 'Cannot reply to your own star' };

  const canView = await viewerFollowsAuthor(senderId, row.user_id);
  if (!canView) return { error: 'Cannot reply to this star' };

  return {
    starReply: {
      id: row.id,
      user_id: row.user_id,
      username: row.username,
      content: row.content || null,
      background_color: row.background_color || null,
      image_url: row.has_image ? `/stars/db/${row.id}` : null,
      image_mime: row.image_mime || null,
    },
  };
}

module.exports = { resolveStarReply, formatStarReplyRow };
