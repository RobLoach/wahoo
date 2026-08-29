import { Application, Circle, Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { View } from '../net/protocol.ts';
import type { Bunny } from '../engine/types.ts';
import { PLAYER_NAMES, SPAWN_INDEX, TRACK_LEN } from '../engine/types.ts';

export const PLAYER_COLORS = [0xe0484d, 0x3f8fde, 0x43b649, 0xe8b53a];
export const PLAYER_COLORS_CSS = ['#e0484d', '#3f8fde', '#43b649', '#e8b53a'];

const SIZE = 820;
const CELLS = 26.6; // 20 track cells + outward room for reserves and labels
const CELL = SIZE / CELLS;
const PAD = ((CELLS - 20) / 2) * CELL;

/** Outward-facing unit vector for each player's side (0=bottom,1=left,2=top,3=right). */
const OUTWARD = [
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
  { x: 1, y: 0 },
];
/** Direction from each spawn toward the burrow entrance (previous track space). */
const ENTRANCE_DIR = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
];

function cellPos(cx: number, cy: number) {
  return { x: PAD + cx * CELL, y: PAD + cy * CELL };
}

/** Track index -> pixel position. Index 0 is Red's spawn at bottom center. */
export function trackPos(index: number) {
  const i = ((index % TRACK_LEN) + TRACK_LEN) % TRACK_LEN;
  let cx: number;
  let cy: number;
  if (i <= 10) { cx = 10 - i; cy = 20; }
  else if (i <= 30) { cx = 0; cy = 20 - (i - 10); }
  else if (i <= 50) { cx = i - 30; cy = 0; }
  else if (i <= 70) { cx = 20; cy = i - 50; }
  else { cx = 20 - (i - 70); cy = 20; }
  return cellPos(cx, cy);
}

/** Burrow slots sit on the board, stretching inward from each edge's spawn. */
export function burrowPos(player: number, slot: number) {
  const spawn = trackPos(SPAWN_INDEX(player));
  const o = OUTWARD[player];
  const e = ENTRANCE_DIR[player];
  const r = (1.15 + slot * 0.95) * CELL;
  return {
    x: spawn.x - o.x * r + e.x * 0.62 * CELL,
    y: spawn.y - o.y * r + e.y * 0.62 * CELL,
  };
}

export function reservePos(player: number, n: number) {
  const spawn = trackPos(SPAWN_INDEX(player));
  const o = OUTWARD[player];
  const e = ENTRANCE_DIR[player];
  const along = -(1.6 + n * 0.95) * CELL; // opposite side from the burrow
  return {
    x: spawn.x + o.x * 1.5 * CELL + e.x * along,
    y: spawn.y + o.y * 1.5 * CELL + e.y * along,
  };
}

export interface Highlights {
  bunnies: Set<number>;
  track: Set<number>;
  burrows: Set<string>; // `${player}:${slot}`
  reserves: Set<number>; // player
}

export const emptyHighlights = (): Highlights => ({
  bunnies: new Set(),
  track: new Set(),
  burrows: new Set(),
  reserves: new Set(),
});

export interface BoardCallbacks {
  onBunny(id: number): void;
  onTrack(index: number): void;
  onBurrow(player: number, slot: number): void;
  onReserve(player: number): void;
}

interface Piece {
  root: Container;
  tx: number;
  ty: number;
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
      background: 0x2a5d34,
      antialias: true,
    });
    this.app.canvas.classList.add('board-canvas');
    parent.appendChild(this.app.canvas);
    this.app.stage.addChild(this.staticLayer, this.highlightLayer, this.labelLayer, this.pieceLayer);
    this.drawStatic();
    this.app.ticker.add(() => this.animate());
  }

  private circle(x: number, y: number, r: number, fill: number, stroke = 0x1e4426) {
    const g = new Graphics();
    g.circle(x, y, r).fill(fill).stroke({ color: stroke, width: 2 });
    return g;
  }

  private drawStatic() {
    const bg = new Graphics();
    bg.roundRect(6, 6, SIZE - 12, SIZE - 12, 24).fill(0x337140);
    this.staticLayer.addChild(bg);

    for (let i = 0; i < TRACK_LEN; i++) {
      const { x, y } = trackPos(i);
      const isSpawn = i % 20 === 0;
      const color = isSpawn ? PLAYER_COLORS[i / 20] : 0xd9cfa3;
      const g = this.circle(x, y, CELL * 0.42, color);
      if (isSpawn) {
        const ring = new Graphics();
        ring.circle(x, y, CELL * 0.52).stroke({ color: PLAYER_COLORS[i / 20], width: 3 });
        this.staticLayer.addChild(ring);
      }
      g.eventMode = 'static';
      g.cursor = 'pointer';
      g.hitArea = new Circle(x, y, CELL * 0.5);
      g.on('pointertap', () => this.cb.onTrack(i));
      this.staticLayer.addChild(g);
    }

    for (let p = 0; p < 4; p++) {
      for (let slot = 0; slot < 4; slot++) {
        const { x, y } = burrowPos(p, slot);
        const g = this.circle(x, y, CELL * 0.4, 0x24492c, PLAYER_COLORS[p]);
        g.eventMode = 'static';
        g.cursor = 'pointer';
        g.hitArea = new Circle(x, y, CELL * 0.5);
        g.on('pointertap', () => this.cb.onBurrow(p, slot));
        this.staticLayer.addChild(g);
      }
      for (let n = 0; n < 4; n++) {
        const { x, y } = reservePos(p, n);
        this.staticLayer.addChild(this.circle(x, y, CELL * 0.34, 0x2e6338, 0x244f2c));
      }
      // Seat label
      const spawn = trackPos(SPAWN_INDEX(p));
      const o = OUTWARD[p];
      const label = new Text({
        text: PLAYER_NAMES[p],
        style: new TextStyle({
          fill: 0xffffff,
          fontSize: 20,
          fontFamily: 'system-ui, sans-serif',
          fontWeight: 'bold',
          stroke: { color: 0x1e3d24, width: 4 },
        }),
      });
      label.anchor.set(0.5);
      label.position.set(spawn.x + o.x * 2.55 * CELL, spawn.y + o.y * 2.55 * CELL);
      if (p === 1) label.rotation = -Math.PI / 2;
      if (p === 3) label.rotation = Math.PI / 2;
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
    g.circle(0, 0, CELL * 0.33).fill(color).stroke({ color: 0x223322, width: 2 });
    // eyes
    g.circle(-CELL * 0.11, -CELL * 0.06, CELL * 0.05).fill(0x222222);
    g.circle(CELL * 0.11, -CELL * 0.06, CELL * 0.05).fill(0x222222);
    root.addChild(g);
    root.eventMode = 'static';
    root.cursor = 'pointer';
    // A generous touch target: much larger than the drawn bunny.
    root.hitArea = new Circle(0, -CELL * 0.1, CELL * 0.75);
    root.on('pointertap', e => {
      e.stopPropagation();
      const b = this.currentBunnies.find(x => x.id === bunny.id);
      if (b && b.place.kind === 'reserve') this.cb.onReserve(b.player);
      else this.cb.onBunny(bunny.id);
    });
    return { root, tx: 0, ty: 0 };
  }

  private currentBunnies: Bunny[] = [];

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

  render(view: View, hi: Highlights) {
    this.currentBunnies = view.bunnies;

    // Pieces
    const idle =
      hi.bunnies.size === 0 && hi.track.size === 0 &&
      hi.burrows.size === 0 && hi.reserves.size === 0;
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
      piece.root.scale.set(bunny.place.kind === 'reserve' ? 0.8 : 1);
      piece.root.alpha = bunny.place.kind === 'burrow' ? 0.95 : 1;
      // Only clickable pieces intercept taps, so their large hit areas never
      // block a highlighted destination space during destination picking.
      const clickable =
        idle ||
        hi.bunnies.has(bunny.id) ||
        (bunny.place.kind === 'reserve' && hi.reserves.has(bunny.player));
      piece.root.eventMode = clickable ? 'static' : 'none';
    }

    // Highlights
    this.highlightLayer.removeChildren().forEach(c => c.destroy());
    const ring = (x: number, y: number, r: number) => {
      const g = new Graphics();
      g.circle(x, y, r).stroke({ color: 0xffe97a, width: 4 });
      g.circle(x, y, r).fill({ color: 0xffe97a, alpha: 0.22 });
      this.highlightLayer.addChild(g);
    };
    for (const i of hi.track) {
      const { x, y } = trackPos(i);
      ring(x, y, CELL * 0.5);
    }
    for (const key of hi.burrows) {
      const [p, s] = key.split(':').map(Number);
      const { x, y } = burrowPos(p, s);
      ring(x, y, CELL * 0.48);
    }
    for (const p of hi.reserves) {
      const { x, y } = reservePos(p, 0);
      ring(x, y, CELL * 0.45);
    }
    const reserveIdx = [0, 0, 0, 0];
    for (const bunny of view.bunnies) {
      const order = bunny.place.kind === 'reserve' ? reserveIdx[bunny.player]++ : 0;
      if (hi.bunnies.has(bunny.id)) {
        const { x, y } = this.targetFor(bunny, order);
        ring(x, y, CELL * 0.55);
      }
    }

    // Current player indicator
    this.seatLabels.forEach((label, p) => {
      label.style.fill = p === view.current ? 0xffe97a : 0xffffff;
      const cpu = view.seatNames[p]?.includes('CPU');
      label.text = `${PLAYER_NAMES[p]}${cpu ? ' 🤖' : ''}${view.folded[p] ? ' (folded)' : ''}`;
    });
  }

  private animate() {
    for (const piece of this.pieces.values()) {
      const dx = piece.tx - piece.root.x;
      const dy = piece.ty - piece.root.y;
      if (Math.abs(dx) + Math.abs(dy) < 0.5) {
        piece.root.position.set(piece.tx, piece.ty);
      } else {
        piece.root.x += dx * 0.18;
        piece.root.y += dy * 0.18;
      }
    }
  }
}
