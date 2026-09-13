// ---------------------------------------------------------------------------
// The in-game application: board, hand, status, and click handling.
// ---------------------------------------------------------------------------
import { $, esc } from './dom.ts';
import { BoardView, burrowPos, emptyHighlights, reservePos } from './board.ts';
import { PLAYER_COLORS_CSS, PLAYER_COLORS_LIT_CSS } from './palette.ts';
import type { Highlights } from './board.ts';
import {
  CARD_HINTS, CARD_TOOLTIPS, SUIT_NAMES, cardFaceHtml, inked, isRed, roundWord, shortName,
} from './cards.ts';
import { Callouts, boardPoint } from './callouts.ts';
import { VictoryView } from './victory.ts';
import { renderRecord } from './stats.ts';
import {
  ctrlPlayer, emptySelection, playableSevenParts, selectedActions, sevenCandidates, simBunnies,
  wrapAction,
} from './selection.ts';
import type { Selection } from './selection.ts';
import { LocalSession } from '../sessions/local.ts';
import type { OnlineSession } from '../net/client.ts';
import type { HttpSession } from '../net/http.ts';
import type { P2PGuestSession, P2PHostSession } from '../net/p2p.ts';
import type { RoomInfo, View } from '../net/protocol.ts';
import { backwardDest, distOf, forwardDest } from '../engine/game.ts';
import type { Bunny, CardAction, Move, MoveEffect } from '../engine/types.ts';
import { PLAYER_NAMES, SPAWN_INDEX, TRACK_LEN } from '../engine/types.ts';
import { announce } from './announce.ts';
import { playEmoteSound, playMoveSound, playTurnChime } from '../sounds.ts';
import { TIPS, dismissTip, showTip, tipSeen } from './tips.ts';
import { emoteHtml } from './emotes.ts';

export { CARD_HINTS, CARD_TOOLTIPS } from './cards.ts';

export type NetSession = OnlineSession | HttpSession | P2PHostSession | P2PGuestSession;

export class App {
  board = new BoardView();
  private callouts = new Callouts(this.board);
  private victory = new VictoryView();
  boardReady = false;
  session: LocalSession | NetSession | null = null;
  online = false;
  view: View | null = null;
  sel: Selection = emptySelection();
  roomInfo: RoomInfo | null = null;
  onMenuShown: (() => void) | null = null;
  private lastAnnounced = '';
  private lastLogLen = 0;
  private pendingEffects: MoveEffect[] | undefined;
  private recentBunnies = new Set<number>();
  /** Hot-seat pass-the-device privacy. */
  localHumans = 1;
  private lastHumanSeat: number | null = null;
  private curtain = false;

  /** Seats with a reaction currently playing: one per player at a time. */
  private emoteBusySeats = new Set<number>();

  /** Turn-timer house rule: when the current turn started, by our clock. */
  private turnKey = '';
  private turnStart = 0;

  constructor() {
    setInterval(() => this.updateTurnClock(), 500);
  }

  /** The little countdown chip beside the status card (online turn timer). */
  private updateTurnClock() {
    const el = document.getElementById('turn-clock');
    const v = this.view;
    if (!el) return;
    const timer = v?.rules?.turnTimer ?? 0;
    const cpuTurn = this.roomInfo?.seats?.[v?.current ?? -1]?.cpu ?? false;
    const show =
      !!v && this.online && timer > 0 && v.winner === null && !cpuTurn && !$('#game').hidden;
    el.hidden = !show;
    if (!show) return;
    const left = Math.max(0, timer - Math.floor((Date.now() - this.turnStart) / 1000));
    el.textContent = `⏱ ${left}s`;
    el.classList.toggle('urgent', left <= 10);
  }

  /** Is OUR seat's reaction still playing? (Others emote independently.) */
  myEmoteBusy(): boolean {
    const seat = this.view?.mySeat;
    return seat !== null && seat !== undefined && this.emoteBusySeats.has(seat);
  }

  /** Float a reaction bubble over the seat's corner of the board. */
  showEmote(seat: number, emoji: string) {
    if (seat < 0 || seat > 3) return;
    if (this.emoteBusySeats.has(seat)) return; // that player's is still playing
    this.emoteBusySeats.add(seat);
    const mine = seat === this.view?.mySeat;
    const bubble = document.createElement('span');
    bubble.className = `emote-bubble seat-${seat}`;
    bubble.innerHTML = emoteHtml(emoji, PLAYER_COLORS_CSS[seat]);
    $('#board-wrap').appendChild(bubble);
    playEmoteSound(emoji);
    if (mine) {
      $('#emote-bar').classList.add('cooling');
      document
        .querySelectorAll<HTMLButtonElement>('#emote-bar button[data-emote]')
        .forEach(b => (b.disabled = true));
    }
    setTimeout(() => {
      bubble.remove();
      this.emoteBusySeats.delete(seat);
      if (mine) {
        $('#emote-bar').classList.remove('cooling');
        document
          .querySelectorAll<HTMLButtonElement>('#emote-bar button[data-emote]')
          .forEach(b => (b.disabled = false));
      }
    }, 4200);
  }

  startLocalMeta(humans: number) {
    this.localHumans = humans;
    this.lastHumanSeat = null;
    this.curtain = false;
    this.roomInfo = null;
  }

  async showGame() {
    this.victory.reset();
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

  /** Clear any in-progress selection (re-clicking the card does this too). */
  cancelSelection() {
    const keepFlip = this.view?.pendingFlip && this.view.canAct;
    this.sel = emptySelection();
    if (keepFlip) this.sel.cardId = 'flip';
    this.refresh();
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
    renderRecord();
    this.onMenuShown?.();
  }

  /** Where each bunny stands, in words, for screen readers. */
  private renderBoardSummary(view: View) {
    const lines = [0, 1, 2, 3].map(p => {
      const mine = view.bunnies.filter(b => b.player === p);
      const onTrack = mine
        .filter(b => b.place.kind === 'track')
        .map(b => `${distOf(b)} of ${TRACK_LEN} spaces along`);
      const home = mine.filter(b => b.place.kind === 'burrow').length;
      const reserve = mine.filter(b => b.place.kind === 'reserve').length;
      const bits = [
        onTrack.length
          ? `${onTrack.length} on the track (${onTrack.join(', ')})`
          : null,
        home ? `${home} home` : null,
        reserve ? `${reserve} in reserve` : null,
      ].filter(Boolean);
      return `${shortName(view, p)}: ${bits.join(', ')}.`;
    });
    $('#board-summary').textContent = `Board positions. ${lines.join(' ')}`;
  }

  onView(view: View) {
    this.view = view;
    // A new turn (any move advances the log) restarts the local turn clock.
    const turnKey = `${view.current}:${view.log.length}:${view.round}`;
    if (turnKey !== this.turnKey) {
      this.turnKey = turnKey;
      this.turnStart = Date.now();
      this.updateTurnClock();
    }
    this.pendingEffects = view.effects;
    this.recentBunnies = new Set(view.effects.map(e => e.bunny));
    playMoveSound(view.effects);
    if (view.lastPlay && (view.effects.length > 0 || view.lastPlay.fold)) {
      this.callouts.showMove(view);
    }
    // Another player's bonus flip is board news, not a sidebar box (yours
    // stays in the sidebar: you have to choose how to play it).
    if (view.pendingFlip && !view.canAct) {
      if (this.lastFlipId !== view.pendingFlip.id) {
        this.lastFlipId = view.pendingFlip.id;
        this.callouts.showFlip(view);
      }
    } else if (!view.pendingFlip) {
      this.lastFlipId = null;
    }
    // A new decision point invalidates any in-progress selection.
    this.sel = emptySelection();
    // Hot-seat privacy: hide the hand while the device changes hands, with
    // a chime and a corner pulse so the next player looks up.
    if (!this.online && view.canAct && this.localHumans > 1 && view.mySeat !== this.lastHumanSeat) {
      this.curtain = true;
      playTurnChime();
      if (view.mySeat !== null) this.board.pulseSeat(view.mySeat);
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

    // Re-clicking the picked bunny puts it back down.
    if (this.sel.bunny === id) {
      this.sel.bunny = null;
      return this.refresh();
    }

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
    return playableSevenParts(this.view!, actions, this.sel.sevenParts).some(
      p => p.bunny === bunny.id,
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
        if (a.kind === 'spawn') {
          hi.reserves.add(ctrlPlayer(view));
          // Spawning stomps whoever is parked on the corner space.
          const victim = view.bunnies.find(
            b => b.place.kind === 'track' && b.place.index === SPAWN_INDEX(ctrlPlayer(view)),
          );
          if (victim) hi.danger.add(victim.id);
        }
        if (a.kind === 'forward' || a.kind === 'backward' || a.kind === 'swap') hi.bunnies.add(a.bunny);
        if (a.kind === 'kingSpawn') {
          hi.bunnies.add(a.target);
          hi.danger.add(a.target); // a stomp-spawn sends the target home
        }
      }
      for (const p of playableSevenParts(view, actions, this.sel.sevenParts)) {
        hi.bunnies.add(p.bunny);
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
        if (place.kind === 'track') {
          hi.track.set(place.index, label);
          // Preview the stomp: whoever sits on this landing space goes home.
          const victim = sim.find(
            b => b.id !== bunnyId && b.place.kind === 'track' && b.place.index === place.index,
          );
          if (victim) hi.danger.add(victim.id);
        }
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

  private lastFlipId: number | null = null;

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
    const { x, y } = boardPoint(pt);
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
    this.victory.render(view, this.online, this.roomInfo?.youAreHost === true);

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

    // Screen readers hear every new play plus whose turn it is now, as one
    // composed sentence (bursts would otherwise overwrite each other).
    if (view.log.length < this.lastLogLen) this.lastLogLen = 0; // new game
    const newLines = view.log.slice(this.lastLogLen);
    this.lastLogLen = view.log.length;
    const turn = view.winner !== null
      ? ''
      : view.canAct ? 'Your turn.' : `${shortName(view, view.current)}'s turn.`;
    const announcement = [...newLines, turn]
      .filter(Boolean)
      .join(' ')
      // "Q♥" reads badly aloud: spell the suits out for the live region.
      .replace(/(10|[A2-9JQK])([♠♥♦♣])/g, (_m, r, s) => `${r} of ${SUIT_NAMES[s] ?? s}`);
    if (announcement && announcement !== this.lastAnnounced) {
      this.lastAnnounced = announcement;
      announce(announcement);
    }

    // A parallel text description of the board for screen readers.
    this.renderBoardSummary(view);

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
    if (view.pendingFlip && !curtainUp && view.canAct) {
      flipEl.hidden = false;
      const c = view.pendingFlip;
      flipEl.innerHTML =
        `<div class="eyebrow">Bonus flip</div><div class="flip-body">` +
        `<div class="flip-card${isRed(c) ? ' red' : ''}">${cardFaceHtml(c)}</div>` +
        `<div class="flip-text">The 2 flipped a <b>${esc(c.rank + c.suit)}</b> — ` +
        `play it now. ${esc(CARD_TOOLTIPS[c.rank] ?? '')}</div></div>`;
    } else {
      flipEl.hidden = true;
      flipEl.innerHTML = '';
    }

    // Fold + cancel buttons
    const foldOnly =
      !curtainUp && view.canAct && view.legal.length === 1 && view.legal[0].type === 'discardHand';
    $('#btn-fold').hidden = !foldOnly;

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

    // First-time tips last: every anchor (fold button, flip box, cards) now
    // has its final visibility and position for the tip's pointer.
    if (!curtainUp && view.winner === null) this.maybeTips(view, curtainUp);
  }
}

