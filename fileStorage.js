function bufferToBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function base64ToBuffer(base64) {
  if (!base64) return null;
  return Buffer.from(base64, 'base64');
}

/** Resolve stored bytes from base64 TEXT and/or legacy BYTEA column. */
function resolveStoredBytes(row, { dataKey = 'data', binaryKey = 'image' } = {}) {
  if (!row) return null;
  const b64 = row[dataKey] || row.attachment_data || row.avatar_data;
  if (b64) return base64ToBuffer(b64);
  const binary = row[binaryKey] || row.avatar_image;
  if (binary) return Buffer.from(binary);
  return null;
}

module.exports = { bufferToBase64, base64ToBuffer, resolveStoredBytes };
