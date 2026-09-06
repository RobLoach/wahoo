// ---------------------------------------------------------------------------
// Reaction bunnies: the board's bunny token (shaded body, slender ears, tiny
// features) wearing five expressions, drawn as inline SVG in the reacting
// seat's colour.
// ---------------------------------------------------------------------------

export const EMOTE_LABELS: Record<string, string> = {
  wahoo: 'Wahoo!',
  lol: 'Ha ha!',
  gasp: 'Oh no!',
  smug: 'Heh heh…',
  finger: 'The finger',
};

const INK = '#25313c';
const EAR = '#ffd2d8';
const NOSE = '#e8869a';
const MOUTH = '#4a2530';
const TEAR = '#9ecbe6';
const GOLD = '#d9a327';

/** Lighten a #rrggbb toward white (0..1). */
function mix(hex: string, white: number) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) + (255 - ((n >> shift) & 255)) * white);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
/** Darken a #rrggbb (0..1). */
function darken(hex: string, k: number) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * (1 - k));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

const thin = (d: string, w = 1.5) =>
  `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const drop = (x: number, y: number) =>
  `<path transform="translate(${x} ${y})" d="M0,-3.4 q3.2,4 0,6.2 q-3.2,-2.2 0,-6.2" fill="${TEAR}"/>`;
const star = (x: number, y: number, s: number) =>
  `<path transform="translate(${x} ${y}) scale(${s})" d="M0,-4 L1.1,-1.1 L4,0 L1.1,1.1 L0,4 L-1.1,1.1 L-4,0 L-1.1,-1.1 Z" fill="${GOLD}"/>`;

interface Look {
  /** Ear rotation in degrees for [left, right]; the neutral bunny is [-8, 8]. */
  ears?: [number, number];
  /** Drawn behind the head (arms, paws). */
  behind?: (g: string, dark: string, color: string) => string;
  /** Eyes and brows; replaces the neutral dot eyes. */
  eyes: string;
  /** Mouth, drawn on the muzzle. */
  mouth: string;
  /** Drawn on top of everything (tears, sparkles, a raised paw). */
  front?: (g: string, dark: string, color: string) => string;
}

/** An arm as an outlined stroke ending in a round paw. */
const arm = (g: string, dark: string, x1: number, y1: number, x2: number, y2: number) =>
  `<path d="M${x1},${y1} L${x2},${y2}" stroke="${dark}" stroke-width="5.6" stroke-linecap="round"/>` +
  `<path d="M${x1},${y1} L${x2},${y2}" stroke="${g}" stroke-width="3.4" stroke-linecap="round"/>` +
  `<circle cx="${x2}" cy="${y2}" r="3.6" fill="${g}" stroke="${dark}" stroke-width="1.2"/>`;

const LOOKS: Record<string, Look> = {
  // Neutral face: used for seat markers in the menus, not as a reaction.
  plain: {
    eyes: '',
    mouth: thin('M-2.4,6.6 q2.4,1.8 4.8,0', 1.4),
  },
  // Arms up, eyes squeezed happy, a small open grin, sparkles in the air.
  wahoo: {
    ears: [-14, 14],
    behind: (g, dark) => arm(g, dark, -10, 4, -17.5, -8.5) + arm(g, dark, 10, 4, 17.5, -8.5),
    eyes: thin('M-7.6,-1.6 q2.4,-3.2 4.8,0') + thin('M2.8,-1.6 q2.4,-3.2 4.8,0'),
    mouth:
      `<path d="M-3.4,5.6 Q0,10.4 3.4,5.6 Z" fill="${MOUTH}"/>` +
      `<ellipse cx="-9" cy="2.4" rx="2" ry="1.1" fill="${NOSE}" opacity="0.45"/>` +
      `<ellipse cx="9" cy="2.4" rx="2" ry="1.1" fill="${NOSE}" opacity="0.45"/>`,
    front: () => star(-21, -21, 1) + star(21.5, -24, 0.8) + star(23, -6, 0.55),
  },
  // Laughing: eyes shut tight, wide grin with a tongue, tears flying off.
  lol: {
    ears: [-18, 18],
    eyes: thin('M-8,-3.6 l3.2,1.9 l-3.2,1.9') + thin('M8,-3.6 l-3.2,1.9 l3.2,1.9'),
    mouth:
      `<path d="M-4.6,5.2 Q0,11.6 4.6,5.2 Z" fill="${MOUTH}"/>` +
      `<ellipse cy="8.8" rx="2.1" ry="1.3" fill="${NOSE}"/>`,
    front: () => drop(-16, -3) + drop(16, -3),
  },
  // Shocked: ears bolt upright, saucer eyes, a little round mouth, sweat drop.
  gasp: {
    ears: [-1, 1],
    eyes:
      thin('M-8.2,-7.4 q3,-1.8 6.2,-0.6', 1.3) + thin('M2,-8 q3.2,-1.2 6.2,0.6', 1.3) +
      `<circle cx="-5.2" cy="-1.6" r="3.4" fill="#fff" stroke="${INK}" stroke-width="0.8"/>` +
      `<circle cx="5.2" cy="-1.6" r="3.4" fill="#fff" stroke="${INK}" stroke-width="0.8"/>` +
      `<circle cx="-5" cy="-1.2" r="1.7" fill="${INK}"/><circle cx="5.4" cy="-1.2" r="1.7" fill="${INK}"/>`,
    mouth: `<ellipse cy="6.8" rx="1.8" ry="2.3" fill="${MOUTH}"/>`,
    front: () => drop(17.5, -12),
  },
  // Smug: one ear flopped, heavy lids, a raised brow, sideways smirk.
  smug: {
    ears: [-8, 36],
    eyes:
      thin('M-8.4,-7.2 l5.8,2.2') + thin('M2.6,-9 l5.8,-0.4') +
      `<ellipse cx="-5.2" cy="-1.4" rx="2.4" ry="1.25" fill="${INK}"/>` +
      `<ellipse cx="5.2" cy="-1.4" rx="2.4" ry="1.25" fill="${INK}"/>`,
    mouth: thin('M-2.8,7.2 q3.6,2.6 5.8,-1.6', 1.5),
  },
  // Fed up: flat glare, a frown, and one paw raised with a single clear digit.
  finger: {
    eyes:
      thin('M-8.2,-6.4 l6,1.7') + thin('M8.2,-6.4 l-6,1.7') +
      `<circle cx="-5.2" cy="-1.4" r="1.9" fill="${INK}"/><circle cx="5.2" cy="-1.4" r="1.9" fill="${INK}"/>`,
    mouth: thin('M-2.8,8.4 q2.8,-2.4 5.6,0'),
    front: (g, dark, color) =>
      `<path d="M10,3 L19,-10" stroke="${dark}" stroke-width="5.8" stroke-linecap="round"/>` +
      `<path d="M10,3 L19,-10" stroke="${g}" stroke-width="3.6" stroke-linecap="round"/>` +
      `<rect x="17.5" y="-24.5" width="3" height="15" rx="1.5" fill="${color}" stroke="${dark}" stroke-width="1"/>` +
      `<circle cx="19" cy="-10.5" r="4.3" fill="${g}" stroke="${dark}" stroke-width="1.2"/>`,
  },
};

const NEUTRAL_EYES =
  `<circle cx="-5.2" cy="-2" r="2.3" fill="${INK}"/><circle cx="5.2" cy="-2" r="2.3" fill="${INK}"/>` +
  `<circle cx="-4.4" cy="-3" r="0.8" fill="#fff"/><circle cx="6" cy="-3" r="0.8" fill="#fff"/>`;

/**
 * Inline SVG of a bunny reaction in the given seat colour. Unknown ids
 * (older clients still sending emoji) fall back to plain text.
 */
let gradientN = 0;

export function emoteHtml(id: string, color = '#b89a6a'): string {
  const look = LOOKS[id];
  if (!look) return `<span>${id.replace(/[<>&"]/g, '')}</span>`;
  // Unique per render: two bubbles of the same colour must not share DOM ids.
  const gid = `bg${color.replace(/[^0-9a-f]/gi, '')}-${gradientN++}`;
  const g = `url(#${gid})`;
  const dark = darken(color, 0.45);
  const [lr, rr] = look.ears ?? [-8, 8];
  const ear = (x: number, rot: number) =>
    `<g transform="translate(${x} -8) rotate(${rot})">` +
    `<ellipse cy="-9.6" rx="4.6" ry="11.2" fill="${g}" stroke="${dark}" stroke-width="1.2"/>` +
    `<ellipse cy="-8.8" rx="2.2" ry="7.2" fill="${EAR}"/></g>`;
  return (
    `<svg class="emote" viewBox="-27 -31 54 58" role="img" aria-label="${EMOTE_LABELS[id] ?? id}">` +
    `<defs><radialGradient id="${gid}" cx="35%" cy="28%" r="75%">` +
    `<stop offset="0" stop-color="${mix(color, 0.35)}"/><stop offset="1" stop-color="${color}"/>` +
    `</radialGradient></defs>` +
    `<ellipse cy="15.2" rx="12" ry="3.6" fill="#000" opacity="0.2"/>` +
    (look.behind?.(g, dark, color) ?? '') +
    ear(-6.8, lr) + ear(6.8, rr) +
    `<circle r="14" fill="${g}" stroke="${dark}" stroke-width="1.4"/>` +
    `<ellipse cy="4.8" rx="7.6" ry="5.6" fill="#fff" opacity="0.9"/>` +
    (look.eyes || NEUTRAL_EYES) +
    `<ellipse cy="2.8" rx="1.8" ry="1.2" fill="${NOSE}"/>` +
    look.mouth +
    (look.front?.(g, dark, color) ?? '') +
    '</svg>'
  );
}
