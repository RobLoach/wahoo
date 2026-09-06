// ---------------------------------------------------------------------------
// Tabletop palette: felt, wood, laid paper and letterpress ink.
// Player order is seat order: 0 Red, 1 Blue, 2 Green, 3 Yellow.
// ---------------------------------------------------------------------------

/** Team ink — names and labels printed on paper, and the Pixi text colour. */
export const PLAYER_COLORS = [0xa83a30, 0x2f5187, 0x4f7a3a, 0xa37a12];
export const PLAYER_COLORS_CSS = ['#a83a30', '#2f5187', '#4f7a3a', '#a37a12'];

/** Lit variants for names printed on the dark felt (log, last play). */
export const PLAYER_COLORS_LIT_CSS = ['#e08a80', '#8fb0e0', '#9ec684', '#e8c268'];

/** Glossy token gradient per player: [highlight, base]. */
export const PIECE_GRADIENT: [number, number][] = [
  [0xe08a7e, 0x9e3227],
  [0x7fa0d0, 0x2b4a7d],
  [0x93bc78, 0x3f6a2c],
  [0xf7d47f, 0xbf8a15],
];

/** The big coloured corner (spawn) space per player: [highlight, base]. */
export const CORNER_GRADIENT: [number, number][] = [
  [0xcf6055, 0x9e3227],
  [0x5a7fb5, 0x2b4a7d],
  [0x6d9a52, 0x3f6a2c],
  [0xf0bd4d, 0xbf8a15],
];

/** Bunny token details: ear lining, nose, eyes. */
export const EAR_PINK = 0xffd2d8;
export const NOSE_PINK = 0xe8869a;
export const EYE_INK = 0x25313c;

/** Burrow earth: the dug tunnel and the dark holes along it. */
export const EARTH = 0x8a6647;
export const EARTH_DARK = 0x4e3521;
export const HOLE = 0x2c1d12;

/** Burrow slot tint per player: [light, dark, shadow ink]. */
export const BURROW_TINT: [number, number, number][] = [
  [0xf3d3cc, 0xe0b3aa, 0x82322a],
  [0xccd9ee, 0xadc0de, 0x233c6e],
  [0xd7e6c8, 0xb9cfa4, 0x345226],
  [0xf6e6bb, 0xe3cd93, 0x826216],
];

/** Board materials. */
export const PAPER = 0xeddcb9;
export const PAPER_LIGHT = 0xfdf7e8;
export const PAPER_DARK = 0xefe2c6;
export const INK = 0x30231a;
/** Engraving ink: rgba(92,62,38, …) in the design. */
export const ENGRAVE = 0x5c3e26;
export const CREAM = 0xf6ecd6;
export const RED_INK = 0xb8443a;
export const GOLD = 0xd9a327;

/** Shared mark per team so partners are recognizable at a glance. */
export const TEAM_MARKS = ['✦', '●'];
