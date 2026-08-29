import './style.css';
import { BoardView, emptyHighlights, PLAYER_COLORS_CSS, trackPos, burrowPos, reservePos } from './ui/board.ts';
import type { Highlights } from './ui/board.ts';
import { LocalSession } from './sessions/local.ts';
import type { SeatKind } from './sessions/local.ts';
import { OnlineSession } from './net/client.ts';
import type { RoomInfo, View } from './net/protocol.ts';
import { backwardDests, forwardDest } from './engine/game.ts';
import type { Bunny, Card, CardAction, Move } from './engine/types.ts';
import { PLAYER_NAMES, TEAMMATE_OF } from './engine/types.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

// ---------------------------------------------------------------------------
// Selection state machine: card -> (bunny) -> destination
// ---------------------------------------------------------------------------

interface SevenPart { bunny: number; steps: number }

interface Selection {
  cardId: number | 'flip' | null;
  bunny: number | null;
  sevenParts: SevenPart[];
}

const emptySelection = (): Selection => ({ cardId: null, bunny: null, sevenParts: [] });

function ctrlPlayer(view: View): number {
  const seat = view.mySeat;
  if (seat === null) return -1;
  const mine = view.bunnies.filter(b => b.player === seat);
  return mine.every(b => b.place.kind === 'burrow') ? TEAMMATE_OF(seat) : seat;
}

/** Actions available for the currently selected card (or pending flip). */
function selectedActions(view: View, sel: Selection): CardAction[] {
  if (sel.cardId === 'flip') {
    return view.legal.filter(m => m.type === 'flip').map(m => (m as any).action);
  }
  return view.legal
    .filter(m => m.type === 'play' && m.card === sel.cardId)
    .map(m => (m as any).action);
}

function wrapAction(view: View, sel: Selection, action: CardAction): Move {
  return sel.cardId === 'flip'
    ? { type: 'flip', action }
    : { type: 'play', card: sel.cardId as number, action };
}

/** Apply chosen 7-split parts to a copy of the bunny list (mirrors engine stomps). */
function simBunnies(bunnies: Bunny[], parts: SevenPart[]): Bunny[] {
  const sim: Bunny[] = structuredClone(bunnies);
  for (const part of parts) {
    const bunny = sim.find(b => b.id === part.bunny)!;
    const dest = forwardDest({ bunnies: sim }, bunny, part.steps);
    if (!dest) continue;
    if (dest.kind === 'track') {
      const victim = sim.find(
        b => b.id !== bunny.id && b.place.kind === 'track' && b.place.index === dest.index,
      );
      if (victim) victim.place = { kind: 'reserve' };
    }
    bunny.place = dest;
  }
  return sim;
}

function partsMatch(chosen: SevenPart[], all: SevenPart[]): boolean {
  return chosen.every(c => all.some(p => p.bunny === c.bunny && p.steps === c.steps));
}

function sevenCandidates(actions: CardAction[], chosen: SevenPart[]) {
  return actions.filter(
    (a): a is Extract<CardAction, { kind: 'seven' }> =>
      a.kind === 'seven' && partsMatch(chosen, a.parts),
  );
}

// ---------------------------------------------------------------------------
// UI application
// ---------------------------------------------------------------------------

const CARD_HINTS: Record<string, string> = {
  A: 'spawn / +1', '2': 'spawn / +2 & flip', '3': '+3', '4': '−4 (can enter burrow)',
  '5': '+5', '6': '+6', '7': 'split 7', '8': '+8', '9': '+9', '10': '+10',
  J: 'swap', Q: '+12', K: 'stomp-spawn / +13',
};

class App {
  board = new BoardView();
  boardReady = false;
  session: LocalSession | OnlineSession | null = null;
  online = false;
  view: View | null = null;
  sel: Selection = emptySelection();

  async showGame() {
    $('#menu').hidden = true;
    $('#game').hidden = false;
    if (!this.boardReady) {
      await this.board.init($('#board-wrap'), {
        onBunny: id => this.clickBunny(id),
        onTrack: index => this.clickTrack(index),
        onBurrow: (p, s) => this.clickBurrow(p, s),
        onReserve: p => this.clickReserve(p),
      });
      this.boardReady = true;
    }
    this.board.resetPieces();
  }

  showMenu() {
    this.session?.leave();
    this.session = null;
    this.view = null;
    this.sel = emptySelection();
    $('#game').hidden = true;
    $('#menu').hidden = false;
    $('#lobby').hidden = true;
  }

  onView(view: View) {
    this.view = view;
    // A new decision point invalidates any in-progress selection.
    this.sel = emptySelection();
    if (view.pendingFlip && view.canAct) this.sel.cardId = 'flip';
    this.refresh();
  }

  submit(move: Move) {
    if (!this.session) return;
    try {
      this.session.submit(move);
    } catch (err) {
      this.setStatus(`Illegal move: ${(err as Error).message}`);
      this.sel = emptySelection();
      this.refresh();
    }
  }

  // ---- click handlers ----

  private submitAction(action: CardAction) {
    if (!this.view) return;
    this.submit(wrapAction(this.view, this.sel, action));
  }

  clickReserve(player: number) {
    const view = this.view;
    if (!view || !view.canAct || this.sel.cardId === null) return;
    const actions = selectedActions(view, this.sel);
    if (player === ctrlPlayer(view) && actions.some(a => a.kind === 'spawn')) {
      this.submitAction({ kind: 'spawn' });
    }
  }

  clickBunny(id: number) {
    const view = this.view;
    if (!view || !view.canAct || this.sel.cardId === null) return;
    const actions = selectedActions(view, this.sel);
    const bunny = view.bunnies.find(b => b.id === id)!;

    if (this.sel.bunny !== null) {
      // A swap target?
      const swap = actions.find(
        a => a.kind === 'swap' && a.bunny === this.sel.bunny && a.other === id,
      );
      if (swap) return this.submitAction(swap);
    }

    // King stomp-spawn straight onto an opponent.
    const king = actions.find(a => a.kind === 'kingSpawn' && a.target === id);
    if (king && this.sel.bunny === null) return this.submitAction(king);

    // Select as a source bunny.
    if (this.isSource(actions, bunny)) {
      this.sel.bunny = id;
      this.refresh();
    }
  }

  private isSource(actions: CardAction[], bunny: Bunny): boolean {
    for (const a of actions) {
      if ((a.kind === 'forward' || a.kind === 'backward' || a.kind === 'swap') && a.bunny === bunny.id) {
        return true;
      }
    }
    const chosenIds = this.sel.sevenParts.map(p => p.bunny);
    if (chosenIds.includes(bunny.id)) return false;
    return sevenCandidates(actions, this.sel.sevenParts).some(a =>
      a.parts.some(p => p.bunny === bunny.id),
    );
  }

  clickTrack(index: number) {
    this.clickDestination({ kind: 'track', index });
  }

  clickBurrow(player: number, slot: number) {
    this.clickDestination({ kind: 'burrow', slot, player });
  }

  private clickDestination(dest: { kind: 'track'; index: number } | { kind: 'burrow'; slot: number; player: number }) {
    const view = this.view;
    if (!view || !view.canAct || this.sel.bunny === null) return;
    const actions = selectedActions(view, this.sel);
    const bunnyId = this.sel.bunny;
    const sim = simBunnies(view.bunnies, this.sel.sevenParts);
    const bunny = sim.find(b => b.id === bunnyId)!;

    const matches = (place: Bunny['place'] | null) => {
      if (!place) return false;
      if (dest.kind === 'track') return place.kind === 'track' && place.index === dest.index;
      return place.kind === 'burrow' && place.slot === dest.slot && bunny.player === dest.player;
    };

    // Plain forward / queen / king-13 etc.
    for (const a of actions) {
      if (a.kind === 'forward' && a.bunny === bunnyId) {
        if (matches(forwardDest({ bunnies: sim }, bunny, a.steps))) return this.submitAction(a);
      }
      if (a.kind === 'backward' && a.bunny === bunnyId) {
        for (const opt of backwardDests({ bunnies: sim }, bunny)) {
          if (opt.toBurrow === a.toBurrow && matches(opt.place)) return this.submitAction(a);
        }
      }
    }

    // Seven: pick the step count whose destination was clicked.
    for (const candidate of sevenCandidates(actions, this.sel.sevenParts)) {
      for (const part of candidate.parts) {
        if (part.bunny !== bunnyId) continue;
        if (matches(forwardDest({ bunnies: sim }, bunny, part.steps))) {
          const parts = [...this.sel.sevenParts, { bunny: bunnyId, steps: part.steps }];
          const total = parts.reduce((s, p) => s + p.steps, 0);
          if (total === 7) return this.submitAction({ kind: 'seven', parts });
          this.sel.sevenParts = parts;
          this.sel.bunny = null;
          return this.refresh();
        }
      }
    }
  }

  // ---- rendering ----

  setStatus(text: string, winner = false) {
    const el = $('#status');
    el.textContent = text;
    el.classList.toggle('winner', winner);
  }

  private highlightsAndHint(): { hi: Highlights; hint: string } {
    const hi = emptyHighlights();
    const view = this.view!;
    if (!view.canAct) return { hi, hint: '' };

    if (this.sel.cardId === null) return { hi, hint: 'Play a card from your hand.' };
    const actions = selectedActions(view, this.sel);
    let hint = 'Choose a bunny.';

    if (this.sel.bunny === null) {
      for (const a of actions) {
        if (a.kind === 'spawn') hi.reserves.add(ctrlPlayer(view));
        if (a.kind === 'forward' || a.kind === 'backward' || a.kind === 'swap') hi.bunnies.add(a.bunny);
        if (a.kind === 'kingSpawn') hi.bunnies.add(a.target);
      }
      const chosenIds = this.sel.sevenParts.map(p => p.bunny);
      for (const c of sevenCandidates(actions, this.sel.sevenParts)) {
        for (const p of c.parts) if (!chosenIds.includes(p.bunny)) hi.bunnies.add(p.bunny);
      }
      if (this.sel.sevenParts.length) {
        const used = this.sel.sevenParts.reduce((s, p) => s + p.steps, 0);
        hint = `7-split: ${7 - used} step${7 - used === 1 ? '' : 's'} left — choose another bunny.`;
      } else if (actions.some(a => a.kind === 'spawn')) {
        hint = 'Click a reserve bunny to spawn, or an active bunny to move.';
      } else if (actions.some(a => a.kind === 'kingSpawn')) {
        hint = 'Click an opponent to stomp-spawn, or your bunny to move 13.';
      } else if (actions.every(a => a.kind === 'swap')) {
        hint = 'Choose one of your bunnies to swap.';
      }
    } else {
      const bunnyId = this.sel.bunny;
      const sim = simBunnies(view.bunnies, this.sel.sevenParts);
      const bunny = sim.find(b => b.id === bunnyId)!;
      const mark = (place: Bunny['place'] | null, player: number) => {
        if (!place) return;
        if (place.kind === 'track') hi.track.add(place.index);
        if (place.kind === 'burrow') hi.burrows.add(`${player}:${place.slot}`);
      };
      for (const a of actions) {
        if (a.kind === 'forward' && a.bunny === bunnyId) {
          mark(forwardDest({ bunnies: sim }, bunny, a.steps), bunny.player);
          hint = 'Choose the highlighted destination.';
        }
        if (a.kind === 'backward' && a.bunny === bunnyId) {
          for (const opt of backwardDests({ bunnies: sim }, bunny)) mark(opt.place, bunny.player);
          hint = 'Choose where to move backward.';
        }
        if (a.kind === 'swap' && a.bunny === bunnyId) {
          hi.bunnies.add(a.other);
          hint = 'Choose a bunny to swap with.';
        }
      }
      for (const c of sevenCandidates(actions, this.sel.sevenParts)) {
        for (const p of c.parts) {
          if (p.bunny === bunnyId) {
            mark(forwardDest({ bunnies: sim }, bunny, p.steps), bunny.player);
            hint = 'Choose how far this bunny hops.';
          }
        }
      }
    }
    return { hi, hint };
  }

  refresh() {
    const view = this.view;
    if (!view || !this.boardReady) return;

    const { hi, hint } = this.highlightsAndHint();
    this.board.render(view, hi);

    // Status line
    if (view.winner !== null) {
      const teams = view.winner === 0 ? 'Red & Green' : 'Blue & Yellow';
      this.setStatus(`🏆 Team ${teams} wins!`, true);
    } else {
      const name = view.seatNames[view.current] ?? PLAYER_NAMES[view.current];
      const controlling =
        view.mySeat !== null && ctrlPlayer(view) !== view.mySeat
          ? ` (moving ${PLAYER_NAMES[ctrlPlayer(view)]}'s bunnies)`
          : '';
      this.setStatus(
        view.canAct
          ? `Round ${view.round} — ${name}'s turn${controlling}. ${hint}`
          : `Round ${view.round} — waiting for ${name}…`,
      );
    }

    // Hand
    const handEl = $('#hand');
    handEl.innerHTML = '';
    const playable = new Set(
      view.legal.filter(m => m.type === 'play').map(m => (m as any).card as number),
    );
    for (const card of view.myHand) {
      const el = document.createElement('button');
      el.className = 'card';
      if (card.suit === '♥' || card.suit === '♦') el.classList.add('red');
      if (this.sel.cardId === card.id) el.classList.add('selected');
      const canPlay = view.canAct && !view.pendingFlip && playable.has(card.id);
      if (!canPlay) el.classList.add('disabled');
      el.innerHTML = `<span>${card.rank}</span><span class="suit">${card.suit}</span>` +
        `<span class="hintline">${CARD_HINTS[card.rank] ?? ''}</span>`;
      el.onclick = () => {
        if (!canPlay) return;
        const wasSelected = this.sel.cardId === card.id;
        this.sel = emptySelection();
        if (!wasSelected) this.sel.cardId = card.id;
        this.refresh();
      };
      handEl.appendChild(el);
    }

    // Pending flip display
    const flipEl = $('#flip-area');
    if (view.pendingFlip) {
      flipEl.hidden = false;
      const c = view.pendingFlip;
      const red = c.suit === '♥' || c.suit === '♦' ? ' red' : '';
      flipEl.innerHTML =
        `<div class="card selected${red}" style="cursor:default"><span>${c.rank}</span>` +
        `<span class="suit">${c.suit}</span></div>` +
        `<div><b>Bonus card!</b><br/>The 2 flipped this card — ${
          view.canAct ? 'you choose how to play it.' : 'being resolved…'
        }</div>`;
    } else {
      flipEl.hidden = true;
      flipEl.innerHTML = '';
    }

    // Fold + cancel buttons
    const foldOnly = view.canAct && view.legal.length === 1 && view.legal[0].type === 'discardHand';
    $('#btn-fold').hidden = !foldOnly;
    const hasSelection =
      (this.sel.cardId !== null && this.sel.cardId !== 'flip') ||
      this.sel.bunny !== null ||
      this.sel.sevenParts.length > 0;
    $('#btn-cancel').hidden = !hasSelection;

    // Piles
    $('#piles').innerHTML =
      `Draw pile: ${view.drawCount} · Discard: ${
        view.discardTop ? view.discardTop.rank + view.discardTop.suit : '—'
      } · Hands: ` +
      view.handCounts
        .map(
          (n, i) =>
            `<span style="color:${PLAYER_COLORS_CSS[i]}">${PLAYER_NAMES[i]} ${n}</span>`,
        )
        .join(' ');

    // Log
    const logEl = $('#log');
    logEl.innerHTML = view.log.map(line => `<div>${line}</div>`).join('');
    logEl.scrollTop = logEl.scrollHeight;
  }
}

// ---------------------------------------------------------------------------
// Menu wiring
// ---------------------------------------------------------------------------

const app = new App();

function buildSeatConfig() {
  const wrap = $('#seat-config');
  wrap.innerHTML = '';
  const defaults: SeatKind[] = ['human', 'cpu', 'cpu', 'cpu'];
  for (let i = 0; i < 4; i++) {
    const row = document.createElement('div');
    row.className = 'seat-row';
    row.innerHTML =
      `<span class="seat-dot" style="background:${PLAYER_COLORS_CSS[i]}"></span>` +
      `<span style="width:64px">${PLAYER_NAMES[i]}</span>` +
      `<select data-seat="${i}">` +
      `<option value="human"${defaults[i] === 'human' ? ' selected' : ''}>Human</option>` +
      `<option value="cpu"${defaults[i] === 'cpu' ? ' selected' : ''}>CPU</option>` +
      `</select>` +
      `<span style="opacity:.6;font-size:.8rem">Team ${i % 2 === 0 ? 'Red/Green' : 'Blue/Yellow'}</span>`;
    wrap.appendChild(row);
  }
}
buildSeatConfig();

$('#start-local').onclick = async () => {
  const seats = Array.from(document.querySelectorAll<HTMLSelectElement>('#seat-config select'))
    .map(sel => sel.value as SeatKind);
  await app.showGame();
  const session = new LocalSession(seats, view => app.onView(view));
  app.session = session;
  app.online = false;
  session.start();
};

// ---- Online ----

let pendingOnline: OnlineSession | null = null;

function defaultServerUrl(): string {
  return localStorage.getItem('wahoo-server') ?? 'ws://localhost:8787';
}
($('#online-server') as HTMLInputElement).value = defaultServerUrl();

function connectOnline(afterOpen: (s: OnlineSession) => void) {
  const url = ($('#online-server') as HTMLInputElement).value.trim() || 'ws://localhost:8787';
  localStorage.setItem('wahoo-server', url);
  pendingOnline?.leave();
  const session: OnlineSession = new OnlineSession(
    url,
    {
      onView: async view => {
        if (app.session !== session) {
          app.session = session;
          app.online = true;
          await app.showGame();
        }
        app.onView(view);
      },
      onRoom: room => renderLobby(session, room),
      onError: msg => alert(msg),
      onClose: () => {
        alert('Disconnected from server.');
        app.showMenu();
      },
    },
    () => afterOpen(session),
  );
  pendingOnline = session;
}

function playerName(): string {
  return ($('#online-name') as HTMLInputElement).value.trim() || 'Player';
}

$('#online-create').onclick = () => connectOnline(s => s.create(playerName()));
$('#online-join').onclick = () => {
  const code = ($('#online-code') as HTMLInputElement).value.trim().toUpperCase();
  if (!code) return alert('Enter a room code.');
  connectOnline(s => s.join(code, playerName()));
};

function renderLobby(session: OnlineSession, room: RoomInfo) {
  const lobby = $('#lobby');
  lobby.hidden = false;
  lobby.innerHTML =
    `<p>Room code: <span class="code">${room.code}</span> — share it with friends.</p>`;
  room.seats.forEach((seat, i) => {
    const row = document.createElement('div');
    row.className = 'seat-row';
    let controls = '';
    if (seat === null) {
      controls = `<button data-sit="${i}">Sit here</button>`;
      if (room.youAreHost) controls += ` <button data-cpu="${i}">Add CPU</button>`;
    } else if (seat.cpu && room.youAreHost) {
      controls = `<button data-uncpu="${i}">Remove CPU</button>`;
    }
    row.innerHTML =
      `<span class="seat-dot" style="background:${PLAYER_COLORS_CSS[i]}"></span>` +
      `<span style="width:64px">${PLAYER_NAMES[i]}</span>` +
      `<span style="flex:1">${seat ? (seat.cpu ? '🤖 CPU' : seat.name) : '—'}${
        room.yourSeat === i ? ' (you)' : ''
      }</span>${controls}`;
    lobby.appendChild(row);
  });
  if (room.youAreHost) {
    const start = document.createElement('button');
    start.className = 'primary';
    start.textContent = 'Start Game (empty seats become CPUs)';
    start.onclick = () => session.startGame();
    lobby.appendChild(start);
  } else {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Waiting for the host to start…';
    lobby.appendChild(p);
  }
  lobby.querySelectorAll<HTMLButtonElement>('[data-sit]').forEach(b => {
    b.onclick = () => session.sit(Number(b.dataset.sit));
  });
  lobby.querySelectorAll<HTMLButtonElement>('[data-cpu]').forEach(b => {
    b.onclick = () => session.cpu(Number(b.dataset.cpu), true);
  });
  lobby.querySelectorAll<HTMLButtonElement>('[data-uncpu]').forEach(b => {
    b.onclick = () => session.cpu(Number(b.dataset.uncpu), false);
  });
}

// ---- In-game buttons ----

$('#btn-fold').onclick = () => app.submit({ type: 'discardHand' });
$('#btn-cancel').onclick = () => {
  const keepFlip = app.view?.pendingFlip && app.view.canAct;
  app.sel = emptySelection();
  if (keepFlip) app.sel.cardId = 'flip';
  app.refresh();
};
$('#btn-menu').onclick = () => {
  pendingOnline?.leave();
  pendingOnline = null;
  app.showMenu();
};
window.addEventListener('keydown', e => {
  if (e.key === 'Escape') ($('#btn-cancel') as HTMLButtonElement).click();
});

// Exposed for end-to-end tests and console debugging.
(window as unknown as Record<string, unknown>).__wahoo = {
  app, trackPos, burrowPos, reservePos,
};
