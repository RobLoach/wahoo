// ---------------------------------------------------------------------------
// Board callouts: the speech bubble that narrates each play, anchored in the
// acting player's quadrant with a tail that follows the moving bunny.
// ---------------------------------------------------------------------------
import { $, esc } from './dom.ts';
import type { BoardView } from './board.ts';
import { burrowPos, reservePos, trackPos } from './board.ts';
import { SPAWN_INDEX } from '../engine/types.ts';
import type { View } from '../net/protocol.ts';
import { inked, isRed } from './cards.ts';

/** Board-space point -> pixel offset inside #board-wrap, following the canvas scale. */
export function boardPoint(pt: { x: number; y: number }) {
  const wrap = $('#board-wrap').getBoundingClientRect();
  const canvas = $('#board-frame .board-canvas').getBoundingClientRect();
  const k = canvas.width / 820;
  return { x: canvas.left - wrap.left + pt.x * k, y: canvas.top - wrap.top + pt.y * k };
}

export class Callouts {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private track: number | null = null;

  constructor(private board: BoardView) {}

  /** "Green moved a bunny 8 spaces" — aimed at the bunny while it hops. */
  showMove(view: View) {
    const play = view.lastPlay;
    if (!play) return;
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
    // Aim at the bunny itself while it hops; fall back to the destination.
    const ptOf = mover ? () => this.board.piecePos(mover.bunny) ?? pt : () => pt;
    const who = inked(view, play.seat);
    const card = play.card;
    const cardHtml = play.fold || !card
      ? '<span class="mini-card fold">✕</span>'
      : `<span class="mini-card${isRed(card) ? ' red' : ''}">${esc(card.rank + card.suit)}</span>`;
    const text = play.fold || !card
      ? `${who} folded — no playable cards.`
      : `${who} ${esc(play.desc || 'played')}${play.bonus ? ' <i>(bonus flip)</i>' : ''}`;
    this.show(ptOf, cardHtml, text, play.seat);
  }

  /** "Green flipped a bonus card!" — aimed at the flipper's corner. */
  showFlip(view: View) {
    const c = view.pendingFlip;
    if (!c) return;
    const corner = trackPos(SPAWN_INDEX(view.current));
    this.show(
      () => corner,
      `<span class="mini-card${isRed(c) ? ' red' : ''}">${esc(c.rank + c.suit)}</span>`,
      `${inked(view, view.current)} flipped a bonus card!`,
      view.current,
    );
  }

  /**
   * A speech bubble in the acting player's quadrant of the board — kept off
   * the track ring and burrows — its tail following `ptOf()` live.
   */
  private show(
    ptOf: () => { x: number; y: number },
    cardHtml: string,
    text: string,
    seat: number,
  ) {
    const el = $('#move-callout');
    el.innerHTML = `<div class="callout-box">${cardHtml}<span>${text}</span></div><div class="callout-tail"></div>`;
    el.hidden = false;
    el.classList.remove('show');
    // Board geometry in logical space: ring corners and the safe inner field
    // (2.3 cells in from the ring clears the tiles and the burrow tunnels).
    const tl = trackPos(SPAWN_INDEX(2));
    const br = trackPos(SPAWN_INDEX(0));
    const cell = (br.x - tl.x) / 20;
    const corner = trackPos(SPAWN_INDEX(seat));
    const mid = { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 };
    const anchor = boardPoint({
      x: corner.x + (mid.x - corner.x) * 0.34,
      y: corner.y + (mid.y - corner.y) * 0.34,
    });
    const safeMin = boardPoint({ x: tl.x + 2.3 * cell, y: tl.y + 2.3 * cell });
    const safeMax = boardPoint({ x: br.x - 2.3 * cell, y: br.y - 2.3 * cell });
    const box = el.querySelector<HTMLElement>('.callout-box')!;
    const bx = Math.max(
      safeMin.x + box.offsetWidth / 2,
      Math.min(anchor.x, safeMax.x - box.offsetWidth / 2),
    );
    const by = Math.max(
      safeMin.y + box.offsetHeight / 2,
      Math.min(anchor.y, safeMax.y - box.offsetHeight / 2),
    );
    el.style.left = `${bx}px`;
    el.style.top = `${by}px`;
    const tail = el.querySelector<HTMLElement>('.callout-tail')!;
    // The tail starts just past the box edge and stretches to the action —
    // re-aimed every frame so it follows the bunny mid-hop.
    const w2 = box.offsetWidth / 2;
    const h2 = box.offsetHeight / 2;
    const aim = () => {
      const t = boardPoint(ptOf());
      const ang = Math.atan2(t.y - by, t.x - bx);
      const reach = Math.min(
        w2 / Math.max(Math.abs(Math.cos(ang)), 1e-6),
        h2 / Math.max(Math.abs(Math.sin(ang)), 1e-6),
      ) - 2;
      const tailLen = Math.hypot(t.x - bx, t.y - by);
      tail.style.width = `${Math.max(14, tailLen - reach - 22)}px`;
      tail.style.transform = `rotate(${ang}rad) translate(${reach}px, 0)`;
    };
    aim();
    if (this.track !== null) cancelAnimationFrame(this.track);
    const follow = () => {
      if (el.hidden || !tail.isConnected) {
        this.track = null;
        return;
      }
      aim();
      this.track = requestAnimationFrame(follow);
    };
    this.track = requestAnimationFrame(follow);
    void el.offsetWidth; // restart the animation
    el.classList.add('show');
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      el.hidden = true;
    }, 5200);
  }
}
