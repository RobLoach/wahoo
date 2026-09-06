// ---------------------------------------------------------------------------
// Card faces and player-name markup shared by the in-game views.
// ---------------------------------------------------------------------------
import { esc } from './dom.ts';
import { PLAYER_COLORS_CSS, PLAYER_COLORS_LIT_CSS } from './palette.ts';
import { PLAYER_NAMES } from '../engine/types.ts';
import type { View } from '../net/protocol.ts';

export const CARD_HINTS: Record<string, string> = {
  A: 'spawn / +1', '2': 'spawn / flip', '3': '+3', '4': 'back 4',
  '5': '+5', '6': '+6', '7': 'split 7', '8': '+8', '9': '+9', '10': '+10',
  J: 'swap', Q: '+12', K: 'stomp / +13',
};

export const CARD_TOOLTIPS: Record<string, string> = {
  A: 'Ace: spawn a bunny onto your corner space, or move one bunny forward 1.',
  '2': 'Two: spawn a bunny or move one bunny forward 2 — then flip the top card of the draw pile and play it too.',
  '3': 'Move one bunny forward 3 spaces.',
  '4': 'Four: move one bunny backward 4 spaces (stays on the track).',
  '5': 'Move one bunny forward 5 spaces.',
  '6': 'Move one bunny forward 6 spaces.',
  '7': 'Seven: move one bunny 7 spaces, or split the 7 between two bunnies.',
  '8': 'Move one bunny forward 8 spaces.',
  '9': 'Move one bunny forward 9 spaces.',
  '10': 'Move one bunny forward 10 spaces.',
  J: 'Jack: swap one of your bunnies with any other bunny on the track.',
  Q: 'Queen: move one bunny forward 12 spaces.',
  K: "King: move one bunny forward 13, or spawn from your reserve onto another player's bunny, stomping it.",
};

export const SUIT_NAMES: Record<string, string> = {
  '♠': 'spades', '♥': 'hearts', '♦': 'diamonds', '♣': 'clubs',
};

export const isRed = (card: { suit: string }) => card.suit === '♥' || card.suit === '♦';

/** A playing-card face: corner indices, a big pip, and an optional note. */
export function cardFaceHtml(card: { rank: string; suit: string }, note = ''): string {
  const idx = `<span class="index"><span>${esc(card.rank)}</span><span class="suit">${esc(card.suit)}</span></span>`;
  return (
    idx +
    idx.replace('class="index"', 'class="index flip" aria-hidden="true"') +
    `<span class="pip" aria-hidden="true">${esc(card.suit)}</span>` +
    (note ? `<span class="hintline">${esc(note)}</span>` : '')
  );
}

const NUMBER_WORDS = [
  '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve',
];
export const roundWord = (n: number) => NUMBER_WORDS[n] ?? String(n);

/** A short player name: custom names as given, CPUs without the "CPU " prefix. */
export const shortName = (view: View, seat: number) =>
  (view.seatNames[seat] ?? PLAYER_NAMES[seat]).replace(/^CPU /, '');

/** A player's name in their ink colour (paper) or lit colour (dark felt). */
export const inked = (view: View, seat: number, lit = false) =>
  `<b style="color:${(lit ? PLAYER_COLORS_LIT_CSS : PLAYER_COLORS_CSS)[seat]}">${esc(
    shortName(view, seat),
  )}</b>`;
