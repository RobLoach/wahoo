// ---------------------------------------------------------------------------
// The in-game application: board, hand, status, and click handling.
// ---------------------------------------------------------------------------
import { $, esc } from './dom.ts';
import { BoardView, burrowPos, emptyHighlights, reservePos, trackPos } from './board.ts';
import { PLAYER_COLORS_CSS, PLAYER_COLORS_LIT_CSS } from './palette.ts';
import type { Highlights } from './board.ts';
import {
  ctrlPlayer, emptySelection, selectedActions, sevenCandidates, simBunnies, wrapAction,
} from './selection.ts';
import type { Selection } from './selection.ts';
import { LocalSession } from '../sessions/local.ts';
import type { OnlineSession } from '../net/client.ts';
import type { HttpSession } from '../net/http.ts';
import type { P2PGuestSession, P2PHostSession } from '../net/p2p.ts';
import type { RoomInfo, View } from '../net/protocol.ts';
import { backwardDest, forwardDest } from '../engine/game.ts';
import type { Bunny, CardAction, Move, MoveEffect } from '../engine/types.ts';
import { PLAYER_NAMES, SPAWN_INDEX } from '../engine/types.ts';
import { playMoveSound } from '../sounds.ts';
import { TIPS, dismissTip, showTip, tipSeen } from './tips.ts';
import { emoteHtml } from './emotes.ts';

export const CARD_HINTS: Record<string, string> = {
  A: 'spawn / +1', '2': 'spawn / flip', '3': '+3', '4': 'back 4',
  '5': '+5', '6': '+6', '7': 'split 7', '8': '+8', '9': '+9', '10': '+10',
  J: 'swap', Q: '+12', K: 'stomp / +13',
};

const SUIT_NAMES: Record<string, string> = {
  '♠': 'spades', '♥': 'hearts', '♦': 'diamonds', '♣': 'clubs',
};

const isRed = (card: { suit: string }) => card.suit === '♥' || card.suit === '♦';

/** A playing-card face: corner indices, a big pip, and an optional note. */
function cardFaceHtml(card: { rank: string; suit: string }, note = ''): string {
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
const roundWord = (n: number) => NUMBER_WORDS[n] ?? String(n);

/** A short player name: custom names as given, CPUs without the "CPU " prefix. */
const shortName = (view: View, seat: number) =>
  (view.seatNames[seat] ?? PLAYER_NAMES[seat]).replace(/^CPU /, '');
/** A player's name in their ink colour (paper) or lit colour (dark felt). */
const inked = (view: View, seat: number, lit = false) =>
  `<b style="color:${(lit ? PLAYER_COLORS_LIT_CSS : PLAYER_COLORS_CSS)[seat]}">${esc(
    shortName(view, seat),
  )}</b>`;

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

export type NetSession = OnlineSession | HttpSession | P2PHostSession | P2PGuestSession;

export class App {
  board = new BoardView();
  boardReady = false;
  session: LocalSession | NetSession | null = null;
  online = false;
  view: View | null = null;
  sel: Selection = emptySelection();
  roomInfo: RoomInfo | null = null;
  onMenuShown: (() => void) | null = null;
  private lastAnnounced = '';
  private pendingEffects: MoveEffect[] | undefined;
  private recentBunnies = new Set<number>();
  /** Hot-seat pass-the-device privacy. */
  localHumans = 1;
  private lastHumanSeat: number | null = null;
  private curtain = false;

  /** Float a reaction bubble over the seat's corner of the board. */
  showEmote(seat: number, emoji: string) {
    if (seat < 0 || seat > 3) return;
    const bubble = document.createElement('span');
    bubble.className = `emote-bubble seat-${seat}`;
    bubble.innerHTML = emoteHtml(emoji, PLAYER_COLORS_CSS[seat]);
    $('#board-wrap').appendChild(bubble);
    setTimeout(() => bubble.remove(), 2600);
  }

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
      await this.board.init($('#board-frame'), {
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
    dismissTip();
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
    if (view.lastPlay && (view.effects.length > 0 || view.lastPlay.fold)) {
      this.showMoveCallout(view);
    }
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
    const sim = simBunnies(view.bunnies, this.sel.sevenParts, view.rules);
    const field = { bunnies: sim, rules: view.rules };
    const bunny = sim.find(b => b.id === bunnyId)!;

    const matches = (place: Bunny['place'] | null) => {
      if (!place) return false;
      if (dest.kind === 'track') return place.kind === 'track' && place.index === dest.index;
      return place.kind === 'burrow' && place.slot === dest.slot && bunny.player === dest.player;
    };

    // Plain forward / queen / king-13 etc.
    for (const a of actions) {
      if (a.kind === 'forward' && a.bunny === bunnyId) {
        if (matches(forwardDest(field, bunny, a.steps))) return this.submitAction(a);
      }
      if (a.kind === 'backward' && a.bunny === bunnyId) {
        if (matches(backwardDest(field, bunny))) return this.submitAction(a);
      }
    }

    // Seven: pick the step count whose destination was clicked.
    for (const candidate of sevenCandidates(actions, this.sel.sevenParts)) {
      for (const part of candidate.parts) {
        if (part.bunny !== bunnyId) continue;
        if (matches(forwardDest(field, bunny, part.steps))) {
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

  /** Plain-text status (errors): shown as the hint line of the status card. */
  setStatus(text: string, winner = false) {
    const el = $('#status');
    el.innerHTML = `<div class="status-hint">${esc(text)}</div>`;
    el.classList.toggle('winner', winner);
  }

  /** The status card: eyebrow, headline (trusted markup: player names), hint. */
  private setStatusCard(eyebrow: string, line: string, hint: string, winner = false) {
    const el = $('#status');
    el.innerHTML =
      `<div class="eyebrow">${esc(eyebrow)}</div><div class="status-line">${line}</div>` +
      (hint ? `<div class="status-hint">${hint}</div>` : '');
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
      const sim = simBunnies(view.bunnies, this.sel.sevenParts, view.rules);
    const field = { bunnies: sim, rules: view.rules };
      const bunny = sim.find(b => b.id === bunnyId)!;
      const mark = (place: Bunny['place'] | null, player: number, label = '') => {
        if (!place) return;
        if (place.kind === 'track') hi.track.set(place.index, label);
        if (place.kind === 'burrow') hi.burrows.set(`${player}:${place.slot}`, label);
      };
      for (const a of actions) {
        if (a.kind === 'forward' && a.bunny === bunnyId) {
          mark(forwardDest(field, bunny, a.steps), bunny.player);
          hint = 'Choose the highlighted destination.';
        }
        if (a.kind === 'backward' && a.bunny === bunnyId) {
          mark(backwardDest(field, bunny), bunny.player);
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
            mark(forwardDest(field, bunny, p.steps), bunny.player, String(p.steps));
            hint = 'Choose how far this bunny hops.';
          }
        }
      }
    }
    return { hi, hint };
  }

  private calloutTimer: ReturnType<typeof setTimeout> | null = null;

  /** Board-space point -> pixel offset inside #board-wrap, following the canvas scale. */
  private boardPoint(pt: { x: number; y: number }) {
    const wrap = $('#board-wrap').getBoundingClientRect();
    const canvas = $('#board-frame .board-canvas').getBoundingClientRect();
    const k = canvas.width / 820;
    return { x: canvas.left - wrap.left + pt.x * k, y: canvas.top - wrap.top + pt.y * k };
  }

  /**
   * "Green moved a bunny 8 spaces" as a speech bubble on the board, pointing
   * at the space where the move ended (or at the folder's corner).
   */
  private showMoveCallout(view: View) {
    const play = view.lastPlay;
    if (!play) return;
    const el = $('#move-callout');
    const seatOf = (id: number) => view.bunnies.find(b => b.id === id)?.player ?? play.seat;
    const mover = view.effects.find(e => e.kind !== 'stomped') ?? view.effects[0];
    let pt: { x: number; y: number };
    if (!mover) {
      pt = trackPos(SPAWN_INDEX(play.seat));
    } else if (mover.to.kind === 'track') {
      pt = trackPos(mover.to.index);
    } else if (mover.to.kind === 'burrow') {
      pt = burrowPos(seatOf(mover.bunny), mover.to.slot);
    } else {
      pt = reservePos(seatOf(mover.bunny), 0);
    }
    const who = inked(view, play.seat);
    const card = play.card;
    const cardHtml = play.fold || !card
      ? '<span class="mini-card fold">✕</span>'
      : `<span class="mini-card${isRed(card) ? ' red' : ''}">${esc(card.rank + card.suit)}</span>`;
    const text = play.fold || !card
      ? `${who} folded — no playable cards.`
      : `${who} ${esc(play.desc || 'played')}${play.bonus ? ' <i>(bonus flip)</i>' : ''}`;
    el.innerHTML = `<div class="callout-box">${cardHtml}<span>${text}</span></div><div class="callout-tail"></div>`;
    el.hidden = false;
    el.classList.remove('show');
    // The bubble sits at the middle of the board; its tail aims at the space
    // where the action landed.
    const centre = this.boardPoint({ x: 410, y: 410 });
    const target = this.boardPoint(pt);
    el.style.left = `${centre.x}px`;
    el.style.top = `${centre.y}px`;
    const box = el.querySelector<HTMLElement>('.callout-box')!;
    const tail = el.querySelector<HTMLElement>('.callout-tail')!;
    const ang = Math.atan2(target.y - centre.y, target.x - centre.x);
    // Push the tail's base just past the box edge along the aim direction.
    const w2 = box.offsetWidth / 2;
    const h2 = box.offsetHeight / 2;
    const reach = Math.min(
      w2 / Math.max(Math.abs(Math.cos(ang)), 1e-6),
      h2 / Math.max(Math.abs(Math.sin(ang)), 1e-6),
    ) - 2;
    tail.style.transform = `rotate(${ang}rad) translate(${reach}px, 0)`;
    void el.offsetWidth; // restart the animation
    el.classList.add('show');
    if (this.calloutTimer) clearTimeout(this.calloutTimer);
    this.calloutTimer = setTimeout(() => {
      el.hidden = true;
    }, 5200);
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
    $('#victory-rule').className = `paper-rule rule-team${view.winner}`;
    $('#victory-title').innerHTML = `${inked(view, seats[0])} &amp; ${inked(view, seats[1])} win`;
    const teamStomps = seats.reduce((s, i) => s + view.stats.stomps[i], 0);
    const totalFolds = view.stats.folds.reduce((a, b) => a + b, 0);
    const most = view.stats.stomps.indexOf(Math.max(...view.stats.stomps));
    const stat = (value: string, label: string) =>
      `<div><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`;
    $('#victory-stats').innerHTML =
      stat(String(view.round), view.round === 1 ? 'Round' : 'Rounds') +
      stat(String(teamStomps), 'Stomps') +
      stat(String(totalFolds), totalFolds === 1 ? 'Fold' : 'Folds') +
      (view.stats.stomps[most] > 0 ? stat(esc(shortName(view, most)), 'Most stomps') : '');
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

  /** Offer at most one unseen tip that the current view has just made relevant. */
  private maybeTips(view: View, curtainUp: boolean) {
    if (curtainUp) return;
    const boardRect = () => $('#board-frame').getBoundingClientRect();
    const owner = (id: number) => view.bunnies.find(b => b.id === id)?.player;
    // Things that just happened on the board come first: they are fleeting.
    if (view.effects.some(e => e.kind === 'stomped') && !tipSeen('stomp')) {
      const e = view.effects.find(x => x.kind === 'stomped')!;
      const p = owner(e.bunny);
      if (showTip('stomp', p === undefined ? boardRect() : this.pointRect(reservePos(p, 1)), TIPS.stomp)) return;
    }
    if (view.effects.some(e => e.to.kind === 'burrow') && !tipSeen('home')) {
      const e = view.effects.find(x => x.to.kind === 'burrow')!;
      const p = owner(e.bunny);
      const to = e.to.kind === 'burrow' ? e.to : null;
      if (
        showTip('home', p === undefined || !to ? boardRect() : this.pointRect(burrowPos(p, to.slot)), TIPS.home)
      ) return;
    }
    if (!view.canAct) return;
    if (view.pendingFlip && !tipSeen('flip')) {
      if (showTip('flip', $('#flip-area'), TIPS.flip)) return;
    }
    if (view.legal.length === 1 && view.legal[0].type === 'discardHand' && !tipSeen('fold')) {
      if (showTip('fold', $('#btn-fold'), TIPS.fold)) return;
    }
    if (view.mySeat !== null && ctrlPlayer(view) !== view.mySeat && !tipSeen('teammate')) {
      if (showTip('teammate', $('#status'), TIPS.teammate)) return;
    }
    const cards = $('#hand').querySelectorAll<HTMLElement>('.card');
    view.myHand.forEach((card, i) => {
      const key = `card:${card.rank}`;
      if (TIPS[key] && !tipSeen(key)) showTip(key, cards[i] ?? $('#hand'), TIPS[key]);
    });
  }

  /** A board-space point as a small page rectangle, for anchoring a tip. */
  private pointRect(pt: { x: number; y: number }) {
    const wrap = $('#board-wrap').getBoundingClientRect();
    const { x, y } = this.boardPoint(pt);
    return new DOMRect(wrap.left + x - 16, wrap.top + y - 16, 32, 32);
  }

  refresh() {
    const view = this.view;
    if (!view || !this.boardReady) return;

    const name = shortName(view, view.current);
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

    // Status card: an eyebrow with the round, then whose turn it is and a hint.
    const who = inked(view, view.current);
    if (view.winner !== null) {
      const seats = view.winner === 0 ? [0, 2] : [1, 3];
      this.setStatusCard(
        'All eight bunnies home',
        `${inked(view, seats[0])} &amp; ${inked(view, seats[1])} win the game!`,
        '',
        true,
      );
    } else if (curtainUp) {
      this.setStatusCard(`Round ${view.round} · pass the device`, `${who}'s turn`, 'Hand the device over, then tap to see the cards.');
    } else {
      const ctrl = ctrlPlayer(view);
      const controlling =
        view.mySeat !== null && ctrl !== view.mySeat
          ? ` — moving ${inked(view, ctrl)}'s bunnies`
          : '';
      const spectating = this.online && view.mySeat === null;
      if (view.canAct) {
        this.setStatusCard(`Round ${view.round} · your turn`, `${who}'s turn${controlling}`, hint);
      } else if (spectating) {
        this.setStatusCard(`Round ${view.round} · spectating`, `${who}'s turn`, 'Take a seat from the menu to play.');
      } else {
        this.setStatusCard(`Round ${view.round} · waiting`, `${who}'s turn`, `Waiting for ${esc(name)}…`);
      }
    }

    // Victory overlay with stats + rematch once a winner is decided.
    this.renderVictory(view);

    // Reactions are online-only (hot seat players can heckle in person);
    // spectators have no seat to react from.
    const emoteBar = $('#emote-bar');
    emoteBar.hidden = !this.online || view.winner !== null || view.mySeat === null;
    // The host can ban the finger via house rules.
    emoteBar.querySelectorAll<HTMLElement>('button[data-emote="finger"]').forEach(btn => {
      btn.hidden = view.rules.finger === false;
    });
    // The reaction buttons wear your own seat colour; redraw when the seat changes.
    if (view.mySeat !== null && emoteBar.dataset.seat !== String(view.mySeat)) {
      emoteBar.dataset.seat = String(view.mySeat);
      emoteBar.querySelectorAll<HTMLElement>('button[data-emote]').forEach(btn => {
        btn.innerHTML = emoteHtml(btn.dataset.emote!, PLAYER_COLORS_CSS[view.mySeat!]);
      });
    }

    // Screen readers hear each play and turn change through the live region.
    const announcement = `${view.log[0] ?? ''}${view.canAct ? ' Your turn.' : ''}`;
    if (announcement !== this.lastAnnounced) {
      this.lastAnnounced = announcement;
      $('#announcer').textContent = announcement;
    }

    // Pass-the-device curtain over the board: fanned card backs and a reveal button.
    const curtainEl = $('#curtain');
    if (curtainUp) {
      curtainEl.hidden = false;
      curtainEl.innerHTML =
        '<div class="curtain-fan" aria-hidden="true"><div class="card-back"></div>' +
        '<div class="card-back"></div><div class="card-back"></div></div>' +
        '<div><div class="eyebrow">Pass the device</div>' +
        `<div class="curtain-title">${esc(name)}'s turn</div>` +
        '<p>Hand it over, then tap to see your cards.</p></div>';
      const reveal = document.createElement('button');
      reveal.className = 'curtain-btn primary';
      reveal.textContent = "I'm ready";
      reveal.setAttribute('aria-label', `Show ${name}'s hand`);
      reveal.onclick = () => {
        this.curtain = false;
        this.refresh();
      };
      curtainEl.appendChild(reveal);
    } else {
      curtainEl.hidden = true;
      curtainEl.innerHTML = '';
    }

    // Hand
    const handEl = $('#hand');
    handEl.innerHTML = '';
    const playable = new Set(
      view.legal.filter(m => m.type === 'play').map(m => (m as any).card as number),
    );
    for (const card of curtainUp ? [] : view.myHand) {
      const el = document.createElement('button');
      el.className = 'card';
      if (isRed(card)) el.classList.add('red');
      if (this.sel.cardId === card.id) el.classList.add('selected');
      const canPlay = view.canAct && !view.pendingFlip && playable.has(card.id);
      if (!canPlay) el.classList.add('disabled');
      el.innerHTML = cardFaceHtml(card, CARD_HINTS[card.rank] ?? '');
      el.title = CARD_TOOLTIPS[card.rank] ?? '';
      el.setAttribute(
        'aria-label',
        `${card.rank} of ${SUIT_NAMES[card.suit] ?? card.suit}` +
          `${canPlay ? '' : ', not playable'}. ${CARD_TOOLTIPS[card.rank] ?? ''}`,
      );
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

    // First-time tips: explain a special card, the bonus flip, a stomp, a
    // bunny getting home, folding, and moving for a teammate — once each.
    if (!curtainUp && view.winner === null) this.maybeTips(view, curtainUp);

    // Description of the selected card, always visible (tooltips need hover).
    const helpEl = $('#card-help');
    const selRank =
      this.sel.cardId === 'flip'
        ? view.pendingFlip?.rank
        : typeof this.sel.cardId === 'number'
          ? view.myHand.find(c => c.id === this.sel.cardId)?.rank
          : undefined;
    if (selRank && !curtainUp && this.sel.cardId !== 'flip') {
      helpEl.hidden = false;
      helpEl.textContent = CARD_TOOLTIPS[selRank] ?? '';
    } else {
      helpEl.hidden = true;
    }

    // Bonus flip: the card a 2 turned over, waiting to be played.
    const flipEl = $('#flip-area');
    if (view.pendingFlip && !curtainUp) {
      flipEl.hidden = false;
      const c = view.pendingFlip;
      flipEl.innerHTML =
        `<div class="eyebrow">Bonus flip</div><div class="flip-body">` +
        `<div class="flip-card${isRed(c) ? ' red' : ''}">${cardFaceHtml(c)}</div>` +
        `<div class="flip-text">The 2 flipped a <b>${esc(c.rank + c.suit)}</b> — ${
          view.canAct
            ? `play it now. ${esc(CARD_TOOLTIPS[c.rank] ?? '')}`
            : 'being resolved…'
        }</div></div>`;
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

    // Piles: the draw pile as a card back, with counts beside it.
    $('#piles').innerHTML =
      `<div class="card-back small" aria-hidden="true"></div>` +
      `<div>Draw ${view.drawCount} · Discard ${
        view.discardTop ? esc(view.discardTop.rank + view.discardTop.suit) : '—'
      }<br/><span class="hands">Hands ` +
      view.handCounts
        .map((n, i) => `<span style="color:${PLAYER_COLORS_LIT_CSS[i]}">${n}</span>`)
        .join(' · ') +
      `</span></div>`;

    // Log, newest first, with player names tinted for scanning.
    const colorizeLog = (line: string) =>
      line.replace(/\b(Red|Blue|Green|Yellow)\b/g, match => {
        const i = PLAYER_NAMES.indexOf(match);
        return `<b style="color:${PLAYER_COLORS_LIT_CSS[i]}">${match}</b>`;
      });
    const logEl = $('#log');
    logEl.innerHTML =
      `<div class="eyebrow">Round ${roundWord(view.round)} — ${esc(shortName(view, view.dealer))} deals</div>` +
      [...view.log]
        .reverse()
        .map(line => `<div class="entry">${colorizeLog(esc(line))}</div>`)
        .join('');
    logEl.scrollTop = 0;
  }
}

