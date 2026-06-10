/** Preset ids for text-only stars (WhatsApp-style status backgrounds). */
const STAR_BACKGROUND_IDS = [
  'slate',
  'forest',
  'teal',
  'ocean',
  'indigo',
  'grape',
  'berry',
  'sunset',
  'amber',
  'rose',
  'midnight',
  'charcoal',
];

const DEFAULT_STAR_BACKGROUND = 'teal';

function isValidStarBackground(id) {
  return typeof id === 'string' && STAR_BACKGROUND_IDS.includes(id);
}

module.exports = {
  STAR_BACKGROUND_IDS,
  DEFAULT_STAR_BACKGROUND,
  isValidStarBackground,
};
