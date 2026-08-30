// ---------------------------------------------------------------------------
// The in-game application: board, hand, status, and click handling.
// ---------------------------------------------------------------------------
import { $ } from './dom.ts';
import { BoardView, emptyHighlights, PLAYER_COLORS_CSS, TEAM_MARKS } from './board.ts';
import type { Highlights } from './board.ts';
import {
  ctrlPlayer, emptySelection, selectedActions, sevenCandidates, simBunnies, wrapAction,
} from './selection.ts';
import type { Selection } from './selection.ts';
import { LocalSession } from '../sessions/local.ts';
import type { OnlineSession } from '../net/client.ts';
import type { P2PGuestSession, P2PHostSession } from '../net/p2p.ts';
import type { RoomInfo, View } from '../net/protocol.ts';
import { backwardDest, forwardDest } from '../engine/game.ts';
import type { Bunny, CardAction, Move, MoveEffect } from '../engine/types.ts';
import { PLAYER_NAMES } from '../engine/types.ts';
import { playMoveSound } from '../sounds.ts';

export const CARD_HINTS: Record<string, string> = {
  A: 'spawn / +1', '2': 'spawn / +2 & flip', '3': '+3', '4': '−4',
  '5': '+5', '6': '+6', '7': 'split 7', '8': '+8', '9': '+9', '10': '+10',
  J: 'swap', Q: '+12', K: 'stomp-spawn / +13',
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

export type NetSession = OnlineSession | P2PHostSession | P2PGuestSession;

export class App {
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
    if (view.lastPlay && (view.effects.length > 0 || view.lastPlay.fold)) {
      this.showPlayBanner(view);
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

  /** Like setStatus, but the fragments are trusted markup (player names only). */
  private setStatusHtml(html: string) {
    const el = $('#status');
    el.innerHTML = html;
    el.classList.remove('winner');
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

  private bannerTimer: ReturnType<typeof setTimeout> | null = null;

  /** Flash the played card and player name in the middle of the board. */
  private showPlayBanner(view: View) {
    const play = view.lastPlay;
    if (!play) return;
    const el = $('#play-banner');
    const name = (view.seatNames[play.seat] ?? PLAYER_NAMES[play.seat]).replace(/^CPU /, '');
    const card = play.card;
    const cardHtml = play.fold || !card
      ? '<div class="play-banner-card fold">✕</div>'
      : `<div class="play-banner-card${
          card.suit === '♥' || card.suit === '♦' ? ' red' : ''
        }">${card.rank}<span style="font-size:1.5rem">${card.suit}</span></div>`;
    el.innerHTML =
      cardHtml +
      `<div class="play-banner-name" style="color:${PLAYER_COLORS_CSS[play.seat]}">${name}${
        play.fold ? ' folded' : ''
      }</div>`;
    el.hidden = false;
    el.classList.remove('show');
    void el.offsetWidth; // restart the fade animation
    el.classList.add('show');
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => {
      el.hidden = true;
    }, 2700);
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
      const who = `<b style="color:${PLAYER_COLORS_CSS[view.current]}">${name}</b>`;
      this.setStatusHtml(
        view.canAct
          ? `Round ${view.round} — ${who}'s turn${controlling}. ${hint}`
          : `Round ${view.round} — waiting for ${who}…`,
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

    // Log, newest first, with player color names tinted for scanning.
    const colorizeLog = (line: string) =>
      line.replace(/\b(Red|Blue|Green|Yellow)\b/g, match => {
        const i = PLAYER_NAMES.indexOf(match);
        return `<span style="color:${PLAYER_COLORS_CSS[i]};font-weight:600">${match}</span>`;
      });
    const logEl = $('#log');
    logEl.innerHTML = [...view.log]
      .reverse()
      .map(line => `<div>${colorizeLog(line)}</div>`)
      .join('');
    logEl.scrollTop = 0;
  }
}

