// ---------------------------------------------------------------------------
// One-time tips: the first time a player meets something (a card that does
// more than move, a stomp, a bunny getting home…) a small card explains it,
// in every mode. Each tip shows once per device and never nags again.
// ---------------------------------------------------------------------------

const KEY = 'wahoo-tips-seen';

/** A tip is anchored to an element or to a rectangle on the page. */
export type TipAnchor = Element | DOMRect | null;

export interface Tip {
  /** Headline: the card or event this explains. */
  title: string;
  text: string;
}

let seen: Set<string> | null = null;
let current: HTMLElement | null = null;
let currentKey: string | null = null;

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
  // Only now does the tip count as seen: a tip nobody acknowledged will
  // offer itself again next time.
  if (currentKey) {
    load().add(currentKey);
    save();
    currentKey = null;
  }
  current?.remove();
  current = null;
}

/**
 * Show a tip once. Returns true if it was shown now. Only one tip is on
 * screen at a time; a second request waits for the next refresh. The tip
 * stays up until the player acknowledges it.
 */
export function showTip(key: string, anchor: TipAnchor, tip: Tip): boolean {
  if (tipSeen(key) || current) return false;
  if (document.getElementById('tour-card')) return false; // the tour has the floor
  currentKey = key;

  const card = document.createElement('div');
  card.id = 'tip-card';
  card.setAttribute('role', 'note');
  card.innerHTML = `<div class="tip-tail"></div><div class="eyebrow"></div><p></p>`;
  card.querySelector('.eyebrow')!.textContent = tip.title;
  card.querySelector('p')!.textContent = tip.text;
  const ok = document.createElement('button');
  ok.className = 'primary';
  ok.textContent = 'Got it';
  ok.onclick = dismissTip;
  card.appendChild(ok);
  document.body.appendChild(card);
  current = card;

  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
  const tail = card.querySelector<HTMLElement>('.tip-tail')!;
  if (r && (r.width > 0 || r.height > 0)) {
    const h = card.offsetHeight + 12;
    let below = false;
    if (r.bottom + h < innerHeight) {
      card.style.top = `${r.bottom + 10}px`;
      below = true; // tail on top, pointing up at the anchor
    } else if (r.top > h) {
      card.style.top = `${r.top - h}px`;
    } else {
      card.style.bottom = '20px';
    }
    const w = card.offsetWidth;
    const left = Math.max(10, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 10));
    card.style.left = `${left}px`;
    // Aim the tail at the anchor's centre.
    tail.classList.add(below ? 'up' : 'down');
    const tailX = Math.max(14, Math.min(r.left + r.width / 2 - left, w - 14));
    tail.style.left = `${tailX}px`;
  } else {
    tail.remove();
    card.style.top = '30%';
    card.style.left = `${Math.max(10, innerWidth / 2 - card.offsetWidth / 2)}px`;
  }
  return true;
}

/** Tips keyed by what was met for the first time. */
export const TIPS: Record<string, Tip> = {
  'card:A': {
    title: 'The Ace — spawn or move 1',
    text: 'An Ace brings a new bunny out of your reserve (the fenced hutch) onto your corner space, or moves a bunny 1.',
  },
  'card:2': {
    title: 'The 2 — spawn, then flip',
    text: 'A 2 spawns or moves 2 — then flips a bonus card from the draw pile that you play as well.',
  },
  'card:4': {
    title: 'The 4 — move backward',
    text: 'A 4 moves a bunny backward 4 spaces. Handy for lining up an exact hop into the burrow.',
  },
  'card:7': {
    title: 'The 7 — split move',
    text: 'A 7 can be split between two bunnies — tap the first bunny, choose its steps, then the second.',
  },
  'card:J': {
    title: 'The Jack — swap',
    text: 'A Jack swaps one of your bunnies with any other bunny on the track. Even an opponent far ahead.',
  },
  'card:Q': {
    title: 'The Queen — move 12',
    text: 'A Queen moves a bunny forward 12 spaces.',
  },
  'card:K': {
    title: 'The King — stomp-spawn or 13',
    text: 'A King moves 13 — or spawns a bunny straight onto another player’s bunny, stomping it home.',
  },
  flip: {
    title: 'Bonus flip',
    text: 'Bonus card! Your 2 flipped this from the draw pile. Play it now as an extra move.',
  },
  stomp: {
    title: 'Stomped!',
    text: 'Landing exactly on a bunny sends it back to its owner’s reserve. Hopping over it is safe.',
  },
  home: {
    title: 'Home safe',
    text: 'A bunny in its burrow can’t be stomped or moved. The first team with all 8 home wins.',
  },
  fold: {
    title: 'Nothing playable — fold',
    text: 'Fold your hand and sit out the rest of this round. A fresh hand comes next round.',
  },
  teammate: {
    title: 'Moving for your teammate',
    text: 'All your bunnies are home, so from now on you move your teammate’s bunnies on your turn.',
  },
};
