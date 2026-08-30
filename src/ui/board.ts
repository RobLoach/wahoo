import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { View } from '../net/protocol.ts';
import type { Bunny, MoveEffect } from '../engine/types.ts';
import { PLAYER_NAMES, SPAWN_INDEX, TRACK_LEN } from '../engine/types.ts';

export const PLAYER_COLORS = [0xd95d5d, 0x4a7fd4, 0x57a15e, 0xe0a83f];
export const PLAYER_COLORS_CSS = ['#d95d5d', '#4a7fd4', '#57a15e', '#e0a83f'];

const SIZE = 820;
const CELLS = 26.6; // 20 track cells + outward room for reserves and labels
const CELL = SIZE / CELLS;
const PAD = ((CELLS - 20) / 2) * CELL;

/** Shared mark per team so partners are recognizable at a glance. */
export const TEAM_MARKS = ['✦', '●'];

/**
 * Outward-facing diagonal for each player's corner
 * (0 = bottom-right, 1 = bottom-left, 2 = top-left, 3 = top-right).
 */
const OUTWARD = [
  { x: 1, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: -1 },
  { x: 1, y: -1 },
];

function cellPos(cx: number, cy: number) {
  return { x: PAD + cx * CELL, y: PAD + cy * CELL };
}

/** Track index -> pixel position. Index 0 is Red's spawn at the bottom-right corner. */
export function trackPos(index: number) {
  const i = ((index % TRACK_LEN) + TRACK_LEN) % TRACK_LEN;
  let cx: number;
  let cy: number;
  if (i < 20) { cx = 20 - i; cy = 20; }
  else if (i < 40) { cx = 0; cy = 20 - (i - 20); }
  else if (i < 60) { cx = i - 40; cy = 0; }
  else { cx = 20; cy = i - 60; }
  return cellPos(cx, cy);
}

/** Burrow slots run diagonally inward from each player's corner. */
export function burrowPos(player: number, slot: number) {
  const corner = trackPos(SPAWN_INDEX(player));
  const o = OUTWARD[player];
  const r = (1.0 + slot * 0.72) * CELL;
  return { x: corner.x - o.x * r, y: corner.y - o.y * r };
}

/** Reserve bunnies wait in a 2x2 cluster just outside their corner. */
export function reservePos(player: number, n: number) {
  const corner = trackPos(SPAWN_INDEX(player));
  const o = OUTWARD[player];
  const ax = (0.95 + (n % 2) * 0.85) * CELL;
  const ay = (0.95 + Math.floor(n / 2) * 0.85) * CELL;
  return { x: corner.x + o.x * ax, y: corner.y + o.y * ay };
}

export interface Highlights {
  bunnies: Set<number>;
  /** The bunny currently picked up to move (shown with a white ring). */
  selected: number | null;
  /** Bunnies that moved in the last play (shown with a soft blue ring). */
  recent: Set<number>;
  track: Map<number, string>; // index -> optional label (e.g. step count)
  burrows: Map<string, string>; // `${player}:${slot}` -> optional label
  reserves: Set<number>; // player
}

export const emptyHighlights = (): Highlights => ({
  bunnies: new Set(),
  selected: null,
  recent: new Set(),
  track: new Map(),
  burrows: new Map(),
  reserves: new Set(),
});

export interface BoardCallbacks {
  onBunny(id: number): void;
  onTrack(index: number): void;
  onBurrow(player: number, slot: number): void;
  onReserve(player: number): void;
}

interface MovePath {
  pts: { x: number; y: number }[];
  segLens: number[];
  total: number;
  elapsed: number;
  duration: number;
}

interface Piece {
  root: Container;
  tx: number;
  ty: number;
  /** Eased path (accelerate, then slow into position) for the current move. */
  path: MovePath | null;
}

export class BoardView {
  app = new Application();
  private staticLayer = new Container();
  private highlightLayer = new Container();
  private pieceLayer = new Container();
  private labelLayer = new Container();
  private pieces = new Map<number, Piece>();
  private cb!: BoardCallbacks;
  private seatLabels: Text[] = [];

  async init(parent: HTMLElement, cb: BoardCallbacks) {
    this.cb = cb;
    await this.app.init({
      width: SIZE,
      height: SIZE,
      background: 0xa9c6dd,
      antialias: true,
    });
    this.app.canvas.classList.add('board-canvas');
    parent.appendChild(this.app.canvas);
    this.app.stage.addChild(this.staticLayer, this.highlightLayer, this.labelLayer, this.pieceLayer);
    this.drawStatic();
    // One stage-level tap handler: every tap snaps to the nearest legal
    // target, so touches don't need to land exactly on a piece or space.
    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on('pointertap', e => {
      const p = e.getLocalPosition(this.app.stage);
      this.resolveTap(p.x, p.y);
    });
    this.app.ticker.add(ticker => this.animate(ticker.deltaTime));
  }

  private circle(x: number, y: number, r: number, fill: number, stroke = 0xbfae8d) {
    const g = new Graphics();
    g.circle(x, y, r).fill(fill).stroke({ color: stroke, width: 2 });
    return g;
  }

  private drawStatic() {
    const bg = new Graphics();
    bg.roundRect(6, 6, SIZE - 12, SIZE - 12, 24).fill(0xecdfc3);
    this.staticLayer.addChild(bg);

    for (let i = 0; i < TRACK_LEN; i++) {
      const { x, y } = trackPos(i);
      const isSpawn = i % 20 === 0;
      const color = isSpawn ? PLAYER_COLORS[i / 20] : 0xf7f0dd;
      const g = this.circle(x, y, CELL * 0.42, color);
      if (isSpawn) {
        const ring = new Graphics();
        ring.circle(x, y, CELL * 0.52).stroke({ color: PLAYER_COLORS[i / 20], width: 3 });
        this.staticLayer.addChild(ring);
      }
      this.staticLayer.addChild(g);
    }

    for (let p = 0; p < 4; p++) {
      for (let slot = 0; slot < 4; slot++) {
        const { x, y } = burrowPos(p, slot);
        this.staticLayer.addChild(this.circle(x, y, CELL * 0.4, 0xb59b71, PLAYER_COLORS[p]));
      }
      for (let n = 0; n < 4; n++) {
        const { x, y } = reservePos(p, n);
        this.staticLayer.addChild(this.circle(x, y, CELL * 0.34, 0xd9c9a3, 0xbfae8d));
      }
      // Seat label below/above the reserve cluster, growing toward the board
      // center so long names never clip at the canvas edge.
      const corner = trackPos(SPAWN_INDEX(p));
      const o = OUTWARD[p];
      const label = new Text({
        text: `${TEAM_MARKS[p % 2]} ${PLAYER_NAMES[p]}`,
        style: new TextStyle({
          fill: 0x2f3d4f,
          fontSize: 20,
          fontFamily: 'system-ui, sans-serif',
          fontWeight: 'bold',
          stroke: { color: 0xdceaf5, width: 4 },
        }),
      });
      label.anchor.set(o.x > 0 ? 1 : 0, 0.5);
      label.position.set(corner.x + o.x * 2.8 * CELL, corner.y + o.y * 2.7 * CELL);
      this.labelLayer.addChild(label);
      this.seatLabels.push(label);
    }
  }

  private makePiece(bunny: Bunny): Piece {
    const root = new Container();
    const color = PLAYER_COLORS[bunny.player];
    const g = new Graphics();
    // ears
    g.ellipse(-CELL * 0.16, -CELL * 0.42, CELL * 0.1, CELL * 0.26).fill(color);
    g.ellipse(CELL * 0.16, -CELL * 0.42, CELL * 0.1, CELL * 0.26).fill(color);
    g.ellipse(-CELL * 0.16, -CELL * 0.4, CELL * 0.045, CELL * 0.16).fill(0xffffff);
    g.ellipse(CELL * 0.16, -CELL * 0.4, CELL * 0.045, CELL * 0.16).fill(0xffffff);
    // body
    g.circle(0, 0, CELL * 0.33).fill(color).stroke({ color: 0x33404f, width: 2 });
    // eyes
    g.circle(-CELL * 0.11, -CELL * 0.06, CELL * 0.05).fill(0x33404f);
    g.circle(CELL * 0.11, -CELL * 0.06, CELL * 0.05).fill(0x33404f);
    root.addChild(g);
    return { root, tx: 0, ty: 0, path: null };
  }

  private lastHi: Highlights | null = null;

  /**
   * Snap a tap to the nearest actionable target (highlighted bunny, space,
   * burrow slot, or reserve) within a generous radius.
   */
  private resolveTap(x: number, y: number) {
    const hi = this.lastHi;
    if (!hi) return;
    type Candidate = { x: number; y: number; act: () => void };
    const candidates: Candidate[] = [];
    for (const id of hi.bunnies) {
      const piece = this.pieces.get(id);
      if (piece) candidates.push({ x: piece.tx, y: piece.ty, act: () => this.cb.onBunny(id) });
    }
    for (const i of hi.track.keys()) {
      const p = trackPos(i);
      candidates.push({ x: p.x, y: p.y, act: () => this.cb.onTrack(i) });
    }
    for (const key of hi.burrows.keys()) {
      const [player, slot] = key.split(':').map(Number);
      const p = burrowPos(player, slot);
      candidates.push({ x: p.x, y: p.y, act: () => this.cb.onBurrow(player, slot) });
    }
    for (const player of hi.reserves) {
      for (let n = 0; n < 4; n++) {
        const p = reservePos(player, n);
        candidates.push({ x: p.x, y: p.y, act: () => this.cb.onReserve(player) });
      }
    }
    let best: Candidate | null = null;
    let bestDist = CELL * 1.9; // snap radius
    for (const c of candidates) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    best?.act();
  }

  private targetFor(bunny: Bunny, reserveOrder: number): { x: number; y: number } {
    if (bunny.place.kind === 'track') return trackPos(bunny.place.index);
    if (bunny.place.kind === 'burrow') return burrowPos(bunny.player, bunny.place.slot);
    return reservePos(bunny.player, reserveOrder);
  }

  /** Remove all pieces so a new game starts clean. */
  resetPieces() {
    for (const piece of this.pieces.values()) piece.root.destroy({ children: true });
    this.pieces.clear();
    this.pieceLayer.removeChildren();
    this.highlightLayer.removeChildren().forEach(c => c.destroy());
  }

  /** Track-space waypoints for a hop-style move effect (empty = straight glide). */
  private waypointsFor(effect: MoveEffect, player: number): { x: number; y: number }[] {
    if (effect.kind === 'forward' && effect.from.kind !== 'reserve') {
      const spawn = SPAWN_INDEX(player);
      const start = effect.from.kind === 'track'
        ? (effect.from.index - spawn + TRACK_LEN) % TRACK_LEN
        : TRACK_LEN + effect.from.slot;
      const end = effect.to.kind === 'track'
        ? (effect.to.index - spawn + TRACK_LEN) % TRACK_LEN
        : effect.to.kind === 'burrow' ? TRACK_LEN + effect.to.slot : start;
      const pts: { x: number; y: number }[] = [];
      for (let d = start + 1; d <= end; d++) {
        pts.push(d < TRACK_LEN ? trackPos((spawn + d) % TRACK_LEN) : burrowPos(player, d - TRACK_LEN));
      }
      return pts;
    }
    if (effect.kind === 'backward' && effect.from.kind === 'track') {
      const pts: { x: number; y: number }[] = [];
      for (let i = 1; i <= 4; i++) {
        pts.push(trackPos((effect.from.index - i + TRACK_LEN) % TRACK_LEN));
      }
      return pts;
    }
    return [];
  }

  /** Begin an eased movement along the effect's path to the piece's target. */
  private startPath(piece: Piece, effect: MoveEffect, player: number) {
    const pts = [
      { x: piece.root.x, y: piece.root.y },
      ...this.waypointsFor(effect, player),
      { x: piece.tx, y: piece.ty },
    ].filter((p, i, arr) => i === 0 || Math.hypot(p.x - arr[i - 1].x, p.y - arr[i - 1].y) > 0.5);
    if (pts.length < 2) {
      piece.path = null;
      return;
    }
    const segLens = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      segLens.push(len);
      total += len;
    }
    const duration = Math.min(2200, 350 + (total / CELL) * 110);
    piece.path = { pts, segLens, total, elapsed: 0, duration };
  }

  render(view: View, hi: Highlights, effects?: MoveEffect[]) {
    this.lastHi = hi;
    const effectFor = effects && new Map(effects.map(e => [e.bunny, e]));

    // Pieces
    const reserveCount = [0, 0, 0, 0];
    for (const bunny of view.bunnies) {
      let piece = this.pieces.get(bunny.id);
      if (!piece) {
        piece = this.makePiece(bunny);
        this.pieces.set(bunny.id, piece);
        this.pieceLayer.addChild(piece.root);
        const start = this.targetFor(bunny, reserveCount[bunny.player]);
        piece.root.position.set(start.x, start.y);
      }
      const order = bunny.place.kind === 'reserve' ? reserveCount[bunny.player]++ : 0;
      const target = this.targetFor(bunny, order);
      piece.tx = target.x;
      piece.ty = target.y;
      const effect = effectFor?.get(bunny.id);
      if (effect) this.startPath(piece, effect, bunny.player);
      piece.root.scale.set(
        hi.selected === bunny.id ? 1.18 : bunny.place.kind === 'reserve' ? 0.8 : 1,
      );
      piece.root.alpha = bunny.place.kind === 'burrow' ? 0.95 : 1;
    }

    // Highlights
    this.highlightLayer.removeChildren().forEach(c => c.destroy());
    const ring = (x: number, y: number, r: number, color = 0xf26d4f, width = 4) => {
      const g = new Graphics();
      g.circle(x, y, r).stroke({ color, width });
      g.circle(x, y, r).fill({ color, alpha: 0.22 });
      this.highlightLayer.addChild(g);
    };
    const stepLabel = (x: number, y: number, text: string) => {
      const t = new Text({
        text,
        style: new TextStyle({
          fill: 0x2f3d4f,
          fontSize: CELL * 0.52,
          fontFamily: 'system-ui, sans-serif',
          fontWeight: 'bold',
          stroke: { color: 0xf7f0dd, width: 4 },
        }),
      });
      t.anchor.set(0.5);
      t.position.set(x, y);
      this.highlightLayer.addChild(t);
    };
    for (const [i, label] of hi.track) {
      const { x, y } = trackPos(i);
      ring(x, y, CELL * 0.5);
      if (label) stepLabel(x, y, label);
    }
    for (const [key, label] of hi.burrows) {
      const [p, s] = key.split(':').map(Number);
      const { x, y } = burrowPos(p, s);
      ring(x, y, CELL * 0.48);
      if (label) stepLabel(x, y, label);
    }
    for (const p of hi.reserves) {
      const { x, y } = reservePos(p, 0);
      ring(x, y, CELL * 0.45);
    }
    const reserveIdx = [0, 0, 0, 0];
    for (const bunny of view.bunnies) {
      const order = bunny.place.kind === 'reserve' ? reserveIdx[bunny.player]++ : 0;
      if (hi.selected === bunny.id) {
        const { x, y } = this.targetFor(bunny, order);
        ring(x, y, CELL * 0.62, 0x7f5bd4, 5);
      } else if (hi.bunnies.has(bunny.id)) {
        const { x, y } = this.targetFor(bunny, order);
        ring(x, y, CELL * 0.55);
      } else if (hi.recent.has(bunny.id)) {
        const { x, y } = this.targetFor(bunny, order);
        ring(x, y, CELL * 0.58, 0x2aa4a8, 3);
      }
    }

    // Current player indicator
    this.seatLabels.forEach((label, p) => {
      label.style.fill = p === view.current ? 0xf26d4f : 0x2f3d4f;
      const raw = view.seatNames[p] ?? PLAYER_NAMES[p];
      const cpu = raw.includes('CPU');
      label.text =
        `${TEAM_MARKS[p % 2]} ${raw.replace(/^CPU /, '')}` +
        `${cpu ? ' 🤖' : ''}${view.folded[p] ? ' (folded)' : ''}`;
    });
  }

  /** dt is in 60fps-normalized frames, so motion speed is frame-rate independent. */
  private animate(dt: number) {
    const dtMs = dt * (1000 / 60);
    const ease = 1 - Math.pow(0.9, dt);
    const easeInOut = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    for (const piece of this.pieces.values()) {
      const path = piece.path;
      if (path) {
        // Follow the move path with ease-in-out: build up speed, then
        // slow gently into the final position.
        path.elapsed += dtMs;
        const t = Math.min(1, path.elapsed / path.duration);
        let remaining = easeInOut(t) * path.total;
        let seg = 0;
        while (seg < path.segLens.length - 1 && remaining > path.segLens[seg]) {
          remaining -= path.segLens[seg];
          seg++;
        }
        const a = path.pts[seg];
        const b = path.pts[seg + 1];
        const f = path.segLens[seg] > 0 ? Math.min(1, remaining / path.segLens[seg]) : 1;
        piece.root.position.set(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
        if (t >= 1) {
          const end = path.pts[path.pts.length - 1];
          piece.root.position.set(end.x, end.y);
          piece.path = null;
        }
        continue;
      }
      const dx = piece.tx - piece.root.x;
      const dy = piece.ty - piece.root.y;
      if (Math.abs(dx) + Math.abs(dy) < 0.5) {
        piece.root.position.set(piece.tx, piece.ty);
      } else {
        piece.root.x += dx * ease;
        piece.root.y += dy * ease;
      }
    }
  }
}
