// ---------------------------------------------------------------------------
// The lifetime record: every finished game on this device, across sessions.
// ---------------------------------------------------------------------------
import { $ } from './dom.ts';

const KEY = 'wahoo-record';

export interface LifetimeRecord {
  games: number;
  /** Wins per team: [Red & Green, Blue & Yellow]. */
  wins: [number, number];
  stomps: number;
  rounds: number;
}

export function lifetimeRecord(): LifetimeRecord {
  const empty: LifetimeRecord = { games: 0, wins: [0, 0], stomps: 0, rounds: 0 };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return {
      games: Number(raw.games) || 0,
      wins: [Number(raw.wins?.[0]) || 0, Number(raw.wins?.[1]) || 0],
      stomps: Number(raw.stomps) || 0,
      rounds: Number(raw.rounds) || 0,
    };
  } catch {
    return empty;
  }
}

/** Tally a finished game (called once per win, from the victory overlay). */
export function recordGame(winner: 0 | 1, stomps: number, rounds: number) {
  const r = lifetimeRecord();
  r.games++;
  r.wins[winner]++;
  r.stomps += stomps;
  r.rounds += rounds;
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    /* storage may be unavailable; the record is best-effort */
  }
}

/** The one-line scoreboard under the menu; hidden until a game has finished. */
export function renderRecord() {
  const el = $('#family-record');
  const r = lifetimeRecord();
  el.hidden = r.games === 0;
  if (r.games === 0) return;
  el.innerHTML =
    `The record so far — <b class="c-red">Red</b> &amp; <b class="c-green">Green</b> ` +
    `<b>${r.wins[0]}</b> · <b>${r.wins[1]}</b> ` +
    `<b class="c-blue">Blue</b> &amp; <b class="c-yellow">Yellow</b> — ` +
    `${r.games} ${r.games === 1 ? 'game' : 'games'}, ${r.stomps} stomps`;
}
