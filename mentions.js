const MENTION_RE = /@([a-zA-Z0-9_]{1,50})/g;

function parseMentionUsernames(content) {
  if (!content) return [];
  const names = new Set();
  let match;
  const re = new RegExp(MENTION_RE.source, 'g');
  while ((match = re.exec(content)) !== null) {
    names.add(match[1].toLowerCase());
  }
  return [...names];
}

module.exports = { parseMentionUsernames, MENTION_RE };
