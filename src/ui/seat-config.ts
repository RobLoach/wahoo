// ---------------------------------------------------------------------------
// The Local Game seat rows: bunny, colour, name field (humans) and kind.
// ---------------------------------------------------------------------------
import { $, esc } from './dom.ts';
import { emoteHtml } from './emotes.ts';
import { PLAYER_COLORS_CSS } from './palette.ts';
import { PLAYER_NAMES } from '../engine/types.ts';
import type { SeatKind } from '../sessions/local.ts';

export function savedSeatNames(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem('wahoo-local-names') ?? '[]');
    return [0, 1, 2, 3].map(i => (typeof raw[i] === 'string' ? raw[i] : PLAYER_NAMES[i]));
  } catch {
    return [...PLAYER_NAMES];
  }
}

export function buildSeatConfig() {
  const wrap = $('#seat-config');
  wrap.innerHTML = '';
  const defaults: SeatKind[] = ['human', 'cpu-medium', 'cpu-medium', 'cpu-medium'];
  const names = savedSeatNames();
  const kinds: [SeatKind, string][] = [
    ['human', 'Human'],
    ['cpu-easy', 'Easy'],
    ['cpu-medium', 'Medium'],
    ['cpu-hard', 'Hard'],
    ['cpu-insane', 'Insane'],
  ];
  // Rows are listed by team (partners sit at opposite corners): Red & Green,
  // then Blue & Yellow, with a solid rule between the two teams.
  for (const i of [0, 2, 1, 3]) {
    const row = document.createElement('div');
    row.className = 'seat-row' + (i === 2 ? ' team-break' : '');
    row.innerHTML =
      `<span class="seat-bunny" aria-hidden="true">${emoteHtml('plain', PLAYER_COLORS_CSS[i])}</span>` +
      `<span class="seat-color">${PLAYER_NAMES[i]}</span>` +
      `<span class="seat-label" data-label-seat="${i}">CPU ${PLAYER_NAMES[i]}</span>` +
      `<input class="seat-name" data-name-seat="${i}" maxlength="12" value="${esc(names[i])}"` +
      ` aria-label="${PLAYER_NAMES[i]} player name" />` +
      `<select data-seat="${i}" aria-label="${PLAYER_NAMES[i]} seat">` +
      kinds
        .map(([v, label]) => `<option value="${v}"${defaults[i] === v ? ' selected' : ''}>${label}</option>`)
        .join('') +
      `</select>`;
    wrap.appendChild(row);
    // Humans get a name field; CPU seats just show the colour label.
    const sel = row.querySelector('select')!;
    const sync = () => {
      const human = sel.value === 'human';
      (row.querySelector('.seat-name') as HTMLElement).hidden = !human;
      (row.querySelector('.seat-label') as HTMLElement).hidden = human;
    };
    sel.addEventListener('change', sync);
    row.querySelector('.seat-name')!.addEventListener('change', () => {
      localStorage.setItem('wahoo-local-names', JSON.stringify(readSeatNames()));
    });
    sync();
  }
}

export function readSeatNames(): string[] {
  const names = [...PLAYER_NAMES];
  for (const el of document.querySelectorAll<HTMLInputElement>('#seat-config .seat-name')) {
    const i = Number(el.dataset.nameSeat);
    names[i] = el.value.trim() || PLAYER_NAMES[i];
  }
  return names;
}

/** The chosen kind per seat, indexed by seat (rows are grouped by team). */
export function readSeatKinds(): SeatKind[] {
  const seats: SeatKind[] = ['cpu-medium', 'cpu-medium', 'cpu-medium', 'cpu-medium'];
  for (const sel of document.querySelectorAll<HTMLSelectElement>('#seat-config select')) {
    seats[Number(sel.dataset.seat)] = sel.value as SeatKind;
  }
  return seats;
}
