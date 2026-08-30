import './style.css';
import { BoardView, emptyHighlights, PLAYER_COLORS_CSS, TEAM_MARKS, trackPos, burrowPos, reservePos } from './ui/board.ts';
import type { Highlights } from './ui/board.ts';
import { LocalSession, savedLocalGame } from './sessions/local.ts';
import type { SeatKind } from './sessions/local.ts';
import { OnlineSession } from './net/client.ts';
import type { OnlineHandlers } from './net/client.ts';
import { P2PGuestSession, P2PHostSession, savedHostGame } from './net/p2p.ts';
import type { RoomInfo, View } from './net/protocol.ts';
import { backwardDest, forwardDest } from './engine/game.ts';
import type { Bunny, Card, CardAction, Difficulty, Move, MoveEffect } from './engine/types.ts';
import { PLAYER_NAMES, TEAMMATE_OF } from './engine/types.ts';
import { isMuted, playMoveSound, setMuted } from './sounds.ts';

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
  A: 'spawn / +1', '2': 'spawn / +2 & flip', '3': '+3', '4': '−4',
  '5': '+5', '6': '+6', '7': 'split 7', '8': '+8', '9': '+9', '10': '+10',
  J: 'swap', Q: '+12', K: 'stomp-spawn / +13',
};

const CARD_TOOLTIPS: Record<string, string> = {
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

type NetSession = OnlineSession | P2PHostSession | P2PGuestSession;

class App {
  board = new BoardView();
  boardReady = false;
  session: LocalSession | NetSession | null = null;
  online = false;
  view: View | null = null;
  sel: Selection = emptySelection();
  roomInfo: RoomInfo | null = null;
  onMenuShown: (() => void) | null = null;
  private pendingEffects: MoveEffect[] | undefined;
  private recentBunnies = new Set<number>();
  /** Hot-seat pass-the-device privacy. */
  localHumans = 1;
  private lastHumanSeat: number | null = null;
  private curtain = false;

  startLocalMeta(humans: number) {
    this.localHumans = humans;
    this.lastHumanSeat = null;
    this.curtain = false;
    this.roomInfo = null;
  }

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
    this.roomInfo = null;
    this.onMenuShown?.();
  }

  onView(view: View) {
    this.view = view;
    this.pendingEffects = view.effects;
    this.recentBunnies = new Set(view.effects.map(e => e.bunny));
    playMoveSound(view.effects);
    // A new decision point invalidates any in-progress selection.
    this.sel = emptySelection();
    // Hot-seat privacy: hide the hand while the device changes hands.
    if (!this.online && view.canAct && this.localHumans > 1 && view.mySeat !== this.lastHumanSeat) {
      this.curtain = true;
    }
    if (view.canAct) this.lastHumanSeat = view.mySeat;
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

    // King stomp-spawn straight onto another player's bunny.
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
        if (matches(backwardDest(bunny))) return this.submitAction(a);
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
    hi.recent = this.recentBunnies;
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
        hint = 'Stomp-spawn onto a highlighted bunny, or move your own 13.';
      } else if (actions.every(a => a.kind === 'swap')) {
        hint = 'Choose one of your bunnies to swap.';
      }
    } else {
      const bunnyId = this.sel.bunny;
      hi.selected = bunnyId;
      const sim = simBunnies(view.bunnies, this.sel.sevenParts);
      const bunny = sim.find(b => b.id === bunnyId)!;
      const mark = (place: Bunny['place'] | null, player: number, label = '') => {
        if (!place) return;
        if (place.kind === 'track') hi.track.set(place.index, label);
        if (place.kind === 'burrow') hi.burrows.set(`${player}:${place.slot}`, label);
      };
      for (const a of actions) {
        if (a.kind === 'forward' && a.bunny === bunnyId) {
          mark(forwardDest({ bunnies: sim }, bunny, a.steps), bunny.player);
          hint = 'Choose the highlighted destination.';
        }
        if (a.kind === 'backward' && a.bunny === bunnyId) {
          mark(backwardDest(bunny), bunny.player);
          hint = 'Choose the highlighted destination.';
        }
        if (a.kind === 'swap' && a.bunny === bunnyId) {
          hi.bunnies.add(a.other);
          hint = 'Choose a bunny to swap with.';
        }
      }
      for (const c of sevenCandidates(actions, this.sel.sevenParts)) {
        for (const p of c.parts) {
          if (p.bunny === bunnyId) {
            mark(forwardDest({ bunnies: sim }, bunny, p.steps), bunny.player, String(p.steps));
            hint = 'Choose how far this bunny hops.';
          }
        }
      }
    }
    return { hi, hint };
  }

  private victoryShown = false;

  private renderVictory(view: View) {
    const overlay = $('#victory');
    if (view.winner === null) {
      overlay.hidden = true;
      this.victoryShown = false;
      overlay.querySelectorAll('.confetti').forEach(c => c.remove());
      return;
    }
    $('#btn-again').hidden = this.online && this.roomInfo?.youAreHost !== true;
    const seats = view.winner === 0 ? [0, 2] : [1, 3];
    const names = (pair: number[]) =>
      pair.map(i => (view.seatNames[i] ?? PLAYER_NAMES[i]).replace(/^CPU /, '')).join(' & ');
    $('#victory-title').textContent = `🏆 ${TEAM_MARKS[view.winner]} ${names(seats)} win!`;
    const teamStomps = (pair: number[]) => pair.reduce((s, i) => s + view.stats.stomps[i], 0);
    const totalFolds = view.stats.folds.reduce((a, b) => a + b, 0);
    $('#victory-stats').textContent =
      `${view.round} round${view.round === 1 ? '' : 's'} · ` +
      `stomps ${TEAM_MARKS[0]} ${teamStomps([0, 2])} — ${TEAM_MARKS[1]} ${teamStomps([1, 3])}` +
      (totalFolds ? ` · ${totalFolds} fold${totalFolds === 1 ? '' : 's'}` : '');
    overlay.hidden = false;
    if (!this.victoryShown) {
      this.victoryShown = true;
      const colors = view.winner === 0
        ? [PLAYER_COLORS_CSS[0], PLAYER_COLORS_CSS[2]]
        : [PLAYER_COLORS_CSS[1], PLAYER_COLORS_CSS[3]];
      for (let i = 0; i < 50; i++) {
        const bit = document.createElement('span');
        bit.className = 'confetti';
        bit.style.left = `${Math.random() * 100}%`;
        bit.style.background = colors[i % 2];
        bit.style.animationDuration = `${2.2 + Math.random() * 2.4}s`;
        bit.style.animationDelay = `${Math.random() * 1.6}s`;
        overlay.appendChild(bit);
      }
    }
  }

  refresh() {
    const view = this.view;
    if (!view || !this.boardReady) return;

    const name = view.seatNames[view.current] ?? PLAYER_NAMES[view.current];
    const curtainUp = this.curtain && view.canAct && view.winner === null;
    const { hi, hint } = curtainUp
      ? (() => {
          const h = emptyHighlights();
          h.recent = this.recentBunnies;
          return { hi: h, hint: '' };
        })()
      : this.highlightsAndHint();
    this.board.render(view, hi, this.pendingEffects);
    this.pendingEffects = undefined;

    // Status line
    if (view.winner !== null) {
      const teams = view.winner === 0 ? 'Red & Green' : 'Blue & Yellow';
      this.setStatus(`🏆 Team ${teams} wins!`, true);
    } else if (curtainUp) {
      this.setStatus(`Round ${view.round} — pass the device to ${name}.`);
    } else {
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

    // Victory overlay with stats + rematch once a winner is decided.
    this.renderVictory(view);

    // Hand (or the pass-the-device curtain)
    const handEl = $('#hand');
    handEl.innerHTML = '';
    if (curtainUp) {
      const reveal = document.createElement('button');
      reveal.className = 'curtain-btn';
      reveal.style.borderColor = PLAYER_COLORS_CSS[view.current];
      reveal.textContent = `👀 Tap to show ${name}'s hand`;
      reveal.onclick = () => {
        this.curtain = false;
        this.refresh();
      };
      handEl.appendChild(reveal);
    }
    const playable = new Set(
      view.legal.filter(m => m.type === 'play').map(m => (m as any).card as number),
    );
    for (const card of curtainUp ? [] : view.myHand) {
      const el = document.createElement('button');
      el.className = 'card';
      if (card.suit === '♥' || card.suit === '♦') el.classList.add('red');
      if (this.sel.cardId === card.id) el.classList.add('selected');
      const canPlay = view.canAct && !view.pendingFlip && playable.has(card.id);
      if (!canPlay) el.classList.add('disabled');
      el.innerHTML = `<span>${card.rank}</span><span class="suit">${card.suit}</span>` +
        `<span class="hintline">${CARD_HINTS[card.rank] ?? ''}</span>`;
      el.title = CARD_TOOLTIPS[card.rank] ?? '';
      el.onclick = () => {
        if (!canPlay) return;
        const wasSelected = this.sel.cardId === card.id;
        this.sel = emptySelection();
        if (!wasSelected) {
          this.sel.cardId = card.id;
          // With no bunny out, an A/2/K can only birth one from the reserve:
          // spawn straight away instead of asking for a redundant tap.
          const actions = selectedActions(view, this.sel);
          if (actions.length === 1 && actions[0].kind === 'spawn') {
            return this.submitAction(actions[0]);
          }
        }
        this.refresh();
      };
      handEl.appendChild(el);
    }

    // Last played card, so every turn is easy to follow.
    const lastEl = $('#last-play');
    if (view.lastPlay) {
      const { seat, card, bonus, fold } = view.lastPlay;
      const who = `<b style="color:${PLAYER_COLORS_CSS[seat]}">${
        view.seatNames[seat] ?? PLAYER_NAMES[seat]
      }</b>`;
      lastEl.hidden = false;
      if (fold || !card) {
        lastEl.innerHTML =
          `<span class="mini-card fold">✕</span>` +
          `<span>${who} folded — no playable cards.</span>`;
      } else {
        const red = card.suit === '♥' || card.suit === '♦' ? ' red' : '';
        const desc = view.lastPlay.desc || 'played';
        lastEl.innerHTML =
          `<span class="mini-card${red}">${card.rank}${card.suit}</span>` +
          `<span>${who} ${desc}${bonus ? ' <i>(flipped bonus card)</i>' : ''}</span>`;
      }
    } else {
      lastEl.hidden = true;
      lastEl.innerHTML = '';
    }

    // Description of the selected card, always visible (tooltips need hover).
    const helpEl = $('#card-help');
    const selRank =
      this.sel.cardId === 'flip'
        ? view.pendingFlip?.rank
        : typeof this.sel.cardId === 'number'
          ? view.myHand.find(c => c.id === this.sel.cardId)?.rank
          : undefined;
    if (selRank && !curtainUp) {
      helpEl.hidden = false;
      helpEl.textContent = CARD_TOOLTIPS[selRank] ?? '';
    } else {
      helpEl.hidden = true;
    }

    // Pending flip display
    const flipEl = $('#flip-area');
    if (view.pendingFlip && !curtainUp) {
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
    const foldOnly =
      !curtainUp && view.canAct && view.legal.length === 1 && view.legal[0].type === 'discardHand';
    $('#btn-fold').hidden = !foldOnly;
    const hasSelection =
      (this.sel.cardId !== null && this.sel.cardId !== 'flip') ||
      this.sel.bunny !== null ||
      this.sel.sevenParts.length > 0;
    $('#btn-cancel').hidden = !hasSelection;

    // Piles
    const shortName = (i: number) =>
      (view.seatNames[i] ?? PLAYER_NAMES[i]).replace(/^CPU /, '');
    const teamName = (i: number) =>
      `<span style="color:${PLAYER_COLORS_CSS[i]}">${shortName(i)}</span>`;
    $('#piles').innerHTML =
      `Teams: ${TEAM_MARKS[0]} ${teamName(0)} & ${teamName(2)} vs ` +
      `${TEAM_MARKS[1]} ${teamName(1)} & ${teamName(3)}<br/>` +
      `Draw pile: ${view.drawCount} · Discard: ${
        view.discardTop ? view.discardTop.rank + view.discardTop.suit : '—'
      } · Hands: ` +
      view.handCounts
        .map((n, i) => `<span style="color:${PLAYER_COLORS_CSS[i]}">${shortName(i)} ${n}</span>`)
        .join(' ');

    // Log
    const logEl = $('#log');
    logEl.innerHTML = [...view.log].reverse().map(line => `<div>${line}</div>`).join('');
    logEl.scrollTop = 0;
  }
}

// ---------------------------------------------------------------------------
// Menu wiring
// ---------------------------------------------------------------------------

const app = new App();

function buildSeatConfig() {
  const wrap = $('#seat-config');
  wrap.innerHTML = '';
  const defaults: SeatKind[] = ['human', 'cpu-medium', 'cpu-medium', 'cpu-medium'];
  const kinds: [SeatKind, string][] = [
    ['human', 'Human'],
    ['cpu-easy', 'CPU · Easy'],
    ['cpu-medium', 'CPU · Medium'],
    ['cpu-hard', 'CPU · Hard'],
    ['cpu-insane', 'CPU · Insane'],
  ];
  for (let i = 0; i < 4; i++) {
    const row = document.createElement('div');
    row.className = 'seat-row';
    row.innerHTML =
      `<span class="seat-dot" style="background:${PLAYER_COLORS_CSS[i]}"></span>` +
      `<span style="width:64px">${PLAYER_NAMES[i]}</span>` +
      `<select data-seat="${i}">` +
      kinds
        .map(([v, label]) => `<option value="${v}"${defaults[i] === v ? ' selected' : ''}>${label}</option>`)
        .join('') +
      `</select>` +
      `<span style="opacity:.6;font-size:.8rem">Team ${i % 2 === 0 ? 'Red/Green' : 'Blue/Yellow'}</span>`;
    wrap.appendChild(row);
  }
}
buildSeatConfig();

$('#start-local').onclick = async () => {
  const seats = Array.from(document.querySelectorAll<HTMLSelectElement>('#seat-config select'))
    .map(sel => sel.value as SeatKind);
  app.startLocalMeta(seats.filter(s => s === 'human').length);
  await app.showGame();
  const session = new LocalSession(
    seats,
    view => app.onView(view),
    (window as unknown as Record<string, number>).__wahooCpuDelay,
  );
  app.session = session;
  app.online = false;
  session.start();
};

/** Persistent identity so a reconnecting player can reclaim their seat. */
function clientToken(): string {
  let token = localStorage.getItem('wahoo-token');
  if (!token) {
    token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    localStorage.setItem('wahoo-token', token);
  }
  return token;
}

// ---- Online (browser-hosted P2P or dedicated server) ----

let pendingOnline: NetSession | null = null;

function defaultServerUrl(): string {
  return localStorage.getItem('wahoo-server') ?? 'ws://localhost:8787';
}
($('#online-server') as HTMLInputElement).value = defaultServerUrl();

function netHandlers(getSession: () => NetSession): OnlineHandlers {
  return {
    onView: async view => {
      const session = getSession();
      if (app.session !== session) {
        app.session = session;
        app.online = true;
        await app.showGame();
      }
      app.onView(view);
    },
    onRoom: room => {
      setNetPending(null);
      app.roomInfo = room;
      renderLobby(getSession(), room);
    },
    onError: msg => {
      setNetPending(null);
      alert(msg);
    },
    onClose: () => {
      if (lastGuestCode && confirm('Disconnected from the game. Try to rejoin?')) {
        joinP2P(lastGuestCode);
        return;
      }
      alert('Disconnected from the game.');
      app.showMenu();
    },
  };
}

let lastGuestCode: string | null = null;

/** Show a spinner on the Host/Join buttons while the P2P handshake runs. */
function setNetPending(which: 'host' | 'join' | 'resume' | null) {
  const host = $('#p2p-host') as HTMLButtonElement;
  const join = $('#p2p-join') as HTMLButtonElement;
  const resume = $('#p2p-resume') as HTMLButtonElement;
  host.disabled = join.disabled = which !== null;
  resume.disabled = which !== null;
  host.innerHTML = which === 'host' ? '<span class="spinner"></span> Connecting…' : 'Host a Game';
  join.innerHTML = which === 'join' ? '<span class="spinner"></span> Joining…' : 'Join';
  if (which === 'resume') resume.innerHTML = '<span class="spinner"></span> Resuming…';
  if (which === null) refreshResumeButton(); // restore the resume label
}

function joinP2P(code: string) {
  pendingOnline?.leave();
  lastGuestCode = code;
  setNetPending('join');
  let session: P2PGuestSession;
  session = new P2PGuestSession(code, playerName(), clientToken(), netHandlers(() => session));
  pendingOnline = session;
}

function connectOnline(afterOpen: (s: OnlineSession) => void) {
  const url = ($('#online-server') as HTMLInputElement).value.trim() || 'ws://localhost:8787';
  localStorage.setItem('wahoo-server', url);
  pendingOnline?.leave();
  let session: OnlineSession;
  session = new OnlineSession(url, netHandlers(() => session), () => afterOpen(session));
  pendingOnline = session;
}

function playerName(): string {
  const name = ($('#online-name') as HTMLInputElement).value.trim();
  if (name) localStorage.setItem('wahoo-name', name);
  return name || localStorage.getItem('wahoo-name') || 'Player';
}
($('#online-name') as HTMLInputElement).value = localStorage.getItem('wahoo-name') ?? '';

$('#p2p-host').onclick = () => {
  pendingOnline?.leave();
  lastGuestCode = null;
  setNetPending('host');
  let session: P2PHostSession;
  session = new P2PHostSession(playerName(), clientToken(), netHandlers(() => session));
  pendingOnline = session;
};
$('#p2p-join').onclick = () => {
  const code = ($('#p2p-code') as HTMLInputElement).value.trim().toUpperCase();
  if (!code) return alert('Enter a room code.');
  joinP2P(code);
};

function refreshResumeButton() {
  const saved = savedHostGame();
  const btn = $('#p2p-resume') as HTMLButtonElement;
  btn.hidden = !saved;
  if (saved) btn.textContent = `▶ Resume hosted game ${saved.code}`;
  const local = savedLocalGame();
  const localBtn = $('#local-resume') as HTMLButtonElement;
  localBtn.hidden = !local;
  if (local) localBtn.textContent = `▶ Resume game (round ${local.state.round})`;
}

$('#local-resume').onclick = async () => {
  const saved = savedLocalGame();
  if (!saved) return refreshResumeButton();
  app.startLocalMeta(saved.seats.filter(s => s === 'human').length);
  await app.showGame();
  const session = new LocalSession(
    saved.seats,
    view => app.onView(view),
    (window as unknown as Record<string, number>).__wahooCpuDelay,
    saved.state,
  );
  app.session = session;
  app.online = false;
  session.start();
};
app.onMenuShown = refreshResumeButton;
refreshResumeButton();

$('#p2p-resume').onclick = () => {
  const saved = savedHostGame();
  if (!saved) return refreshResumeButton();
  pendingOnline?.leave();
  lastGuestCode = null;
  setNetPending('resume');
  let session: P2PHostSession;
  session = new P2PHostSession(saved.name, clientToken(), netHandlers(() => session), saved);
  pendingOnline = session;
};

$('#online-create').onclick = () => connectOnline(s => s.create(playerName(), clientToken()));
$('#online-join').onclick = () => {
  const code = ($('#online-code') as HTMLInputElement).value.trim().toUpperCase();
  if (!code) return alert('Enter a room code.');
  connectOnline(s => s.join(code, playerName(), clientToken()));
};

function renderLobby(session: NetSession, room: RoomInfo) {
  const lobby = $('#lobby');
  lobby.hidden = false;
  lobby.innerHTML =
    `<p>Room code: <span class="code">${room.code}</span> — share it with friends.</p>`;
  if (room.youAreHost && !room.started) {
    const diffRow = document.createElement('label');
    diffRow.className = 'hint';
    diffRow.innerHTML =
      'CPU difficulty for added seats <select id="lobby-diff">' +
      '<option value="easy">Easy</option>' +
      '<option value="medium" selected>Medium</option>' +
      '<option value="hard">Hard</option>' +
      '<option value="insane">Insane</option></select>';
    lobby.appendChild(diffRow);
  }
  if (!(session instanceof OnlineSession)) {
    const url = `${location.origin}${location.pathname}?join=${room.code}`;
    const invite = document.createElement('p');
    invite.className = 'hint invite';
    invite.textContent = 'Invite link: ';
    const codeEl = document.createElement('code');
    codeEl.textContent = url;
    invite.appendChild(codeEl);
    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    copy.style.marginLeft = '6px';
    copy.onclick = () => {
      navigator.clipboard?.writeText(url);
      copy.textContent = 'Copied!';
    };
    invite.appendChild(copy);
    lobby.appendChild(invite);
  }
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
    const seatLabel = seat
      ? seat.cpu
        ? `🤖 CPU (${seat.difficulty ?? 'medium'})`
        : seat.name
      : '—';
    row.innerHTML =
      `<span class="seat-dot" style="background:${PLAYER_COLORS_CSS[i]}"></span>` +
      `<span style="width:64px">${PLAYER_NAMES[i]}</span>` +
      `<span style="flex:1">${seatLabel}${
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
    b.onclick = () => {
      const diff = (document.querySelector('#lobby-diff') as HTMLSelectElement | null)?.value;
      session.cpu(Number(b.dataset.cpu), true, (diff ?? 'medium') as Difficulty);
    };
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

function refreshMuteButton() {
  $('#btn-mute').textContent = isMuted() ? '🔇 Muted' : '🔊 Sound';
}
refreshMuteButton();
$('#btn-mute').onclick = () => {
  setMuted(!isMuted());
  refreshMuteButton();
};

$('#victory-menu').onclick = () => ($('#btn-menu') as HTMLButtonElement).click();

$('#btn-fullscreen').onclick = () => {
  if (document.fullscreenElement) {
    void document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen?.().catch(() => {});
  }
};

$('#btn-again').onclick = () => {
  const session = app.session;
  if (!session) return;
  if (session instanceof LocalSession) session.restart();
  else session.playAgain();
};

// ?join=CODE deep link: prefill and join the browser-hosted room right away.
{
  const joinCode = new URLSearchParams(location.search).get('join');
  if (joinCode) {
    ($('#p2p-code') as HTMLInputElement).value = joinCode.toUpperCase();
    setTimeout(() => joinP2P(joinCode.toUpperCase()), 50);
  }
}

// Offline/installable support (skipped during local development).
if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`)
    .catch(() => { /* offline support is best-effort */ });
}

// Exposed for end-to-end tests and console debugging.
(window as unknown as Record<string, unknown>).__wahoo = {
  app, trackPos, burrowPos, reservePos,
};
