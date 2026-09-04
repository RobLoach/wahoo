// ---------------------------------------------------------------------------
// One-time tips: the first time a player meets something (a card that does
// more than move, a stomp, a bunny getting home…) a small card explains it,
// in every mode. Each tip shows once per device and never nags again.
// ---------------------------------------------------------------------------

const KEY = 'wahoo-tips-seen';

/** A tip is anchored to an element or to a rectangle on the page. */
export type TipAnchor = Element | DOMRect | null;

let seen: Set<string> | null = null;
let current: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function load(): Set<string> {
  if (seen) return seen;
  try {
    seen = new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]'));
  } catch {
    seen = new Set(['*']); // no storage: never show tips rather than show them every time
  }
  return seen;
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify([...load()]));
  } catch {
    /* storage may be unavailable */
  }
}

/** Has this tip (or every tip, via "*") been shown already? */
export function tipSeen(key: string): boolean {
  const s = load();
  return s.has('*') || s.has(key);
}

export function tipShowing(): boolean {
  return current !== null;
}

export function dismissTip() {
  if (timer) clearTimeout(timer);
  timer = null;
  current?.remove();
  current = null;
}

/**
 * Show a tip once. Returns true if it was shown now. Only one tip is on
 * screen at a time; a second request waits for the next refresh.
 */
export function showTip(key: string, anchor: TipAnchor, text: string): boolean {
  if (tipSeen(key) || current) return false;
  if (document.getElementById('tour-card')) return false; // the tour has the floor
  load().add(key);
  save();

  const card = document.createElement('div');
  card.id = 'tip-card';
  card.setAttribute('role', 'note');
  card.innerHTML = `<div class="eyebrow">First time</div><p></p>`;
  card.querySelector('p')!.textContent = text;
  const ok = document.createElement('button');
  ok.className = 'primary';
  ok.textContent = 'Got it';
  ok.onclick = dismissTip;
  card.appendChild(ok);
  document.body.appendChild(card);
  current = card;

  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
  if (r) {
    const h = card.offsetHeight + 12;
    if (r.bottom + h < innerHeight) card.style.top = `${r.bottom + 10}px`;
    else if (r.top > h) card.style.top = `${r.top - h}px`;
    else card.style.bottom = '20px';
    const w = card.offsetWidth;
    card.style.left = `${Math.max(10, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 10))}px`;
  } else {
    card.style.top = '30%';
    card.style.left = `${Math.max(10, innerWidth / 2 - card.offsetWidth / 2)}px`;
  }
  timer = setTimeout(dismissTip, 16_000);
  return true;
}

/** Texts keyed by what was met for the first time. */
export const TIPS: Record<string, string> = {
  'card:A': 'An Ace brings a new bunny out of your reserve (the fenced hutch) onto your corner space, or moves a bunny 1.',
  'card:2': 'A 2 spawns or moves 2 — then flips a bonus card from the draw pile that you play as well.',
  'card:4': 'A 4 moves a bunny backward 4 spaces. Handy for lining up an exact hop into the burrow.',
  'card:7': 'A 7 can be split between two bunnies — tap the first bunny, choose its steps, then the second.',
  'card:J': 'A Jack swaps one of your bunnies with any other bunny on the track. Even an opponent far ahead.',
  'card:Q': 'A Queen moves a bunny forward 12 spaces.',
  'card:K': 'A King moves 13 — or spawns a bunny straight onto another player’s bunny, stomping it home.',
  flip: 'Bonus card! Your 2 flipped this from the draw pile. Play it now as an extra move.',
  stomp: 'Stomped! Landing exactly on a bunny sends it back to its owner’s reserve. Hopping over it is safe.',
  home: 'Home safe! A bunny in its burrow can’t be stomped or moved. The first team with all 8 home wins.',
  fold: 'Nothing playable? Fold your hand and sit out the rest of this round. A fresh hand comes next round.',
  teammate: 'All your bunnies are home, so from now on you move your teammate’s bunnies on your turn.',
};
