import { Application, Container, FillGradient, Graphics, Text, TextStyle } from 'pixi.js';
import type { View } from '../net/protocol.ts';
import type { Bunny, MoveEffect } from '../engine/types.ts';
import { PLAYER_NAMES, SPAWN_INDEX, TRACK_LEN } from '../engine/types.ts';
import {
  BURROW_TINT,
  CORNER_GRADIENT,
  CREAM,
  ENGRAVE,
  GOLD,
  INK,
  PAPER,
  PAPER_DARK,
  PAPER_LIGHT,
  PIECE_GRADIENT,
  PLAYER_COLORS,
  RED_INK,
} from './palette.ts';

export { PLAYER_COLORS, PLAYER_COLORS_CSS, TEAM_MARKS } from './palette.ts';

const SIZE = 820;
const CELLS = 23.6; // 20 track cells + a thin outer margin for the reserve rows
const CELL = SIZE / CELLS;
const PAD = ((CELLS - 20) / 2) * CELL;

/** Letterpress type: a serif for the plate and numbers, a grotesk for labels. */
const SERIF = "'Instrument Serif', serif";
const SANS = 'Karla, system-ui, sans-serif';

/** Space radii, in cells. */
const TRACK_R = 0.38 * CELL;
const CORNER_R = 0.5 * CELL;
const BURROW_R = 0.36 * CELL;
const RESERVE_R = 0.3 * CELL;
const PIECE_R = 0.4 * CELL;

const ROUND_WORDS = [
  '', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX',
  'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE',
];

/** CSS colour string, so gradient stops can carry an alpha. */
function rgba(hex: number, alpha: number) {
  return `rgba(${(hex >> 16) & 255},${(hex >> 8) & 255},${hex & 255},${alpha})`;
}

/**
 * A radial gradient in shape-local space: coordinates are 0..1 across each
 * shape's own bounds, so one gradient can be reused for every space.
 */
function radial(
  cx: number,
  cy: number,
  stops: { offset: number; color: number | string }[],
  outerRadius = 0.5,
) {
  return new FillGradient({
    type: 'radial',
    center: { x: cx, y: cy },
    innerRadius: 0,
    outerCenter: { x: 0.5, y: 0.5 },
    outerRadius,
    colorStops: stops,
    textureSpace: 'local',
  });
}

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
  const r = (1.05 + slot * 0.78) * CELL;
  return { x: corner.x - o.x * r, y: corner.y - o.y * r };
}

/**
 * Reserve bunnies wait on the paper margin just outside the track, in a short
 * row that starts at the player's corner and runs along the board edge.
 */
export function reservePos(player: number, n: number) {
  const corner = trackPos(SPAWN_INDEX(player));
  const o = OUTWARD[player];
  return {
    x: corner.x - o.x * (1.2 + n * 0.78) * CELL,
    y: corner.y + o.y * 1.05 * CELL,
  };
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

type Candidate = { x: number; y: number; act: () => void };

export interface BoardCallbacks {
  onBunny(id: number): void;
  onTrack(index: number): void;
  onBurrow(player: number, slot: number): void;
  onReserve(player: number): void;
}

/** Pause before a move starts animating, so the played card registers first. */
const MOVE_START_DELAY_MS = 500;

interface MovePath {
  pts: { x: number; y: number }[];
  segLens: number[];
  total: number;
  /** Starts negative: the delay counts up to zero before motion begins. */
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
  /** Honor the OS-level "reduce motion" preference: moves snap into place. */
  private staticLayer = new Container();
  private highlightLayer = new Container();
  private pieceLayer = new Container();
  private labelLayer = new Container();
  private focusLayer = new Container();
  private focusIdx = -1;
  private pieces = new Map<number, Piece>();
  private cb!: BoardCallbacks;
  private seatLabels: Text[] = [];
  private seatUnderlines: Graphics[] = [];
  private roundLabel: Text | null = null;
  /** One glossy token gradient per player, shared by all of that seat's pieces. */
  private pieceFills = PIECE_GRADIENT.map(([hi, base]) =>
    radial(0.34, 0.26, [
      { offset: 0, color: hi },
      { offset: 0.78, color: base },
      { offset: 1, color: base },
    ]),
  );

  async init(parent: HTMLElement, cb: BoardCallbacks) {
    this.cb = cb;
    // Let the self-hosted faces land before Pixi measures any text.
    try {
      await Promise.all([
        document.fonts.load("400 20px 'Instrument Serif'"),
        document.fonts.load('400 14px Karla'),
      ]);
    } catch { /* fall back to the generic families */ }
    await this.app.init({
      width: SIZE,
      height: SIZE,
      background: PAPER,
      antialias: true,
    });
    this.app.canvas.classList.add('board-canvas');
    parent.appendChild(this.app.canvas);
    this.app.stage.addChild(
      this.staticLayer, this.highlightLayer, this.labelLayer, this.pieceLayer, this.focusLayer,
    );
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

  /** The printed board: laid paper, engraved rules, and every empty space. */
  private drawStatic() {
    this.drawPaper();
    this.drawRules();
    this.drawSpaces();
    this.drawCentrePlate();
    this.drawSeatLabels();
  }

  /** Opaque laid-paper sheet with a woven grain and a raking highlight. */
  private drawPaper() {
    const sheet = new Graphics();
    sheet.roundRect(0, 0, SIZE, SIZE, 10).fill(PAPER);
    this.staticLayer.addChild(sheet);

    // Laid lines: chain lines every 4px, wire lines every 5px.
    const grain = new Graphics();
    for (let y = 0; y < SIZE; y += 4) grain.rect(0, y, SIZE, 1);
    grain.fill({ color: 0x785f3c, alpha: 0.05 });
    for (let x = 0; x < SIZE; x += 5) grain.rect(x, 0, 1, SIZE);
    grain.fill({ color: 0x785f3c, alpha: 0.035 });
    this.staticLayer.addChild(grain);

    const sheen = new Graphics();
    sheen.roundRect(0, 0, SIZE, SIZE, 10).fill(
      radial(0.28, 0.22, [
        { offset: 0, color: 'rgba(255,255,255,0.5)' },
        { offset: 1, color: 'rgba(255,255,255,0)' },
      ], 0.6),
    );
    sheen.roundRect(0, 0, SIZE, SIZE, 10).fill(
      radial(0.7, 1, [
        { offset: 0, color: rgba(0x785632, 0.25) },
        { offset: 1, color: rgba(0x785632, 0) },
      ], 0.6),
    );
    this.staticLayer.addChild(sheen);

    const edge = new Graphics();
    edge.roundRect(0.5, 0.5, SIZE - 1, SIZE - 1, 10)
      .stroke({ color: ENGRAVE, alpha: 0.4, width: 1 });
    this.staticLayer.addChild(edge);
  }

  /** The engraved single rule and the double rule just inside it. */
  private drawRules() {
    const g = new Graphics();
    g.roundRect(26, 26, SIZE - 52, SIZE - 52, 4)
      .stroke({ color: ENGRAVE, alpha: 0.22, width: 1 });
    g.roundRect(31, 31, SIZE - 62, SIZE - 62, 3)
      .stroke({ color: ENGRAVE, alpha: 0.16, width: 1 });
    g.roundRect(33, 33, SIZE - 66, SIZE - 66, 3)
      .stroke({ color: ENGRAVE, alpha: 0.16, width: 1 });
    this.staticLayer.addChild(g);
  }

  private drawSpaces() {
    // Reserve slots sit on the margin: faint printed circles, nothing more.
    const reserves = new Graphics();
    for (let p = 0; p < 4; p++) {
      for (let n = 0; n < 4; n++) {
        const { x, y } = reservePos(p, n);
        reserves.circle(x, y, RESERVE_R);
      }
    }
    reserves.fill({ color: ENGRAVE, alpha: 0.06 });
    for (let p = 0; p < 4; p++) {
      for (let n = 0; n < 4; n++) {
        const { x, y } = reservePos(p, n);
        reserves.circle(x, y, RESERVE_R);
      }
    }
    reserves.stroke({ color: ENGRAVE, alpha: 0.28, width: 1 });
    this.staticLayer.addChild(reserves);

    // Burrow slots: a tinted punched hole per seat.
    for (let p = 0; p < 4; p++) {
      const [light, dark, ink] = BURROW_TINT[p];
      const g = new Graphics();
      const slots = [0, 1, 2, 3].map(slot => burrowPos(p, slot));
      for (const s of slots) g.circle(s.x, s.y, BURROW_R);
      g.fill(radial(0.4, 0.3, [{ offset: 0, color: light }, { offset: 1, color: dark }]));
      for (const s of slots) g.circle(s.x, s.y, BURROW_R);
      g.stroke({ color: ink, alpha: 0.45, width: 1.5 });
      for (const s of slots) g.circle(s.x, s.y + 1, BURROW_R);
      g.stroke({ color: 0xffffff, alpha: 0.4, width: 1 });
      this.staticLayer.addChild(g);
    }

    // Plain track spaces: debossed paper discs.
    const track = new Graphics();
    const plain: { x: number; y: number }[] = [];
    for (let i = 0; i < TRACK_LEN; i++) {
      if (i % 20 === 0) continue;
      plain.push(trackPos(i));
    }
    for (const s of plain) track.circle(s.x, s.y, TRACK_R);
    track.fill(radial(0.4, 0.3, [
      { offset: 0, color: PAPER_LIGHT },
      { offset: 1, color: PAPER_DARK },
    ]));
    for (const s of plain) track.circle(s.x, s.y - 1, TRACK_R);
    track.stroke({ color: ENGRAVE, alpha: 0.15, width: 3 });
    for (const s of plain) track.circle(s.x, s.y, TRACK_R);
    track.stroke({ color: ENGRAVE, alpha: 0.35, width: 1.5 });
    for (const s of plain) track.circle(s.x, s.y + 1, TRACK_R);
    track.stroke({ color: 0xffffff, alpha: 0.6, width: 1 });
    this.staticLayer.addChild(track);

    // Corner spawns: raised glossy counters in the seat colour.
    for (let p = 0; p < 4; p++) {
      const { x, y } = trackPos(SPAWN_INDEX(p));
      const [hi, base] = CORNER_GRADIENT[p];
      const g = new Graphics();
      g.circle(x, y + 2, CORNER_R + 2).fill({ color: ENGRAVE, alpha: 0.25 });
      g.circle(x, y, CORNER_R).fill(
        radial(0.38, 0.3, [{ offset: 0, color: hi }, { offset: 1, color: base }]),
      );
      g.circle(x, y + 2, CORNER_R - 2).stroke({ color: 0x000000, alpha: 0.3, width: 4 });
      g.circle(x, y - 1, CORNER_R - 2).stroke({ color: 0xffffff, alpha: 0.3, width: 2 });
      this.staticLayer.addChild(g);
    }
  }

  /** The maker's plate at the middle of the sheet. */
  private drawCentrePlate() {
    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const hairline = new FillGradient({
      type: 'linear',
      start: { x: 0, y: 0 },
      end: { x: 1, y: 0 },
      colorStops: [
        { offset: 0, color: rgba(ENGRAVE, 0) },
        { offset: 0.5, color: rgba(ENGRAVE, 0.3) },
        { offset: 1, color: rgba(ENGRAVE, 0) },
      ],
      textureSpace: 'local',
    });
    const rules = new Graphics();
    rules.rect(cx - 115, cy - 55, 230, 1);
    rules.rect(cx - 115, cy + 62, 230, 1);
    rules.fill(hairline);
    this.staticLayer.addChild(rules);

    const titleStyle = (fill: string) =>
      new TextStyle({ fill, fontFamily: SERIF, fontSize: 68, letterSpacing: 3 });
    const emboss = new Text({ text: 'Wahoo', style: titleStyle(rgba(0xffffff, 0.6)) });
    emboss.anchor.set(0.5);
    emboss.position.set(cx, cy + 1);
    this.staticLayer.addChild(emboss);
    const title = new Text({ text: 'Wahoo', style: titleStyle(rgba(ENGRAVE, 0.32)) });
    title.anchor.set(0.5);
    title.position.set(cx, cy);
    this.staticLayer.addChild(title);

    const eyebrow = new Text({
      text: 'ROUND ONE',
      style: new TextStyle({
        fill: rgba(ENGRAVE, 0.34),
        fontFamily: SANS,
        fontSize: 13,
        letterSpacing: 5,
      }),
    });
    eyebrow.anchor.set(0.5);
    eyebrow.position.set(cx + 2.5, cy + 44); // +half a letter-space: trailing gap
    this.staticLayer.addChild(eyebrow);
    this.roundLabel = eyebrow;
  }

  /**
   * Seat labels are printed inside the ring, one row in from each corner and
   * clear of the burrow diagonal, growing toward the middle of the board.
   */
  private drawSeatLabels() {
    for (let p = 0; p < 4; p++) {
      const corner = trackPos(SPAWN_INDEX(p));
      const o = OUTWARD[p];
      const underline = new Graphics();
      this.labelLayer.addChild(underline);
      this.seatUnderlines.push(underline);
      const label = new Text({
        text: PLAYER_NAMES[p].toUpperCase(),
        style: new TextStyle({
          fill: PLAYER_COLORS[p],
          fontFamily: SANS,
          fontSize: 14,
          fontWeight: '400',
          letterSpacing: 3.5,
        }),
      });
      label.anchor.set(o.x > 0 ? 1 : 0, 0.5);
      label.position.set(corner.x - o.x * 3.5 * CELL, corner.y - o.y * 1.35 * CELL);
      this.labelLayer.addChild(label);
      this.seatLabels.push(label);
    }
  }

  /** A glossy round token: drop shadow, domed body, rim light. */
  private makePiece(bunny: Bunny): Piece {
    const root = new Container();
    const p = bunny.player;
    const R = PIECE_R;
    const g = new Graphics();
    g.circle(0, 4, R).fill({ color: 0x3c2d1c, alpha: 0.3 });
    g.circle(0, 2, R).fill({ color: 0x3c2d1c, alpha: 0.15 });
    g.circle(0, 0, R).fill(this.pieceFills[p]);
    g.circle(0, 2, R - 2).stroke({ color: 0x000000, alpha: 0.32, width: 4 });
    g.ellipse(-0.25 * R, -0.4 * R, 0.42 * R, 0.26 * R).fill({ color: 0xffffff, alpha: 0.35 });
    g.circle(0, 0, R).stroke({ color: PIECE_GRADIENT[p][1], alpha: 0.6, width: 1 });
    root.addChild(g);
    return { root, tx: 0, ty: 0, path: null };
  }

  private lastHi: Highlights | null = null;

  /** Every actionable target for the current highlights, in a stable order. */
  private candidates(): Candidate[] {
    const hi = this.lastHi;
    if (!hi) return [];
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
    return candidates;
  }

  /**
   * Snap a tap to the nearest actionable target (highlighted bunny, space,
   * burrow slot, or reserve) within a generous radius.
   */
  private resolveTap(x: number, y: number) {
    const candidates = this.candidates();
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

  // ---- Keyboard access: arrow keys cycle the tap targets, Enter activates ----

  hasFocus(): boolean {
    return this.focusIdx >= 0;
  }

  cycleFocus(dir: 1 | -1) {
    const c = this.candidates();
    if (c.length === 0) return;
    this.focusIdx =
      this.focusIdx === -1
        ? dir === 1 ? 0 : c.length - 1
        : (this.focusIdx + dir + c.length) % c.length;
    this.focusLayer.removeChildren().forEach(ch => ch.destroy());
    const t = c[this.focusIdx];
    const g = new Graphics();
    g.circle(t.x, t.y, CELL * 0.68).stroke({ color: CREAM, width: 5 });
    g.circle(t.x, t.y, CELL * 0.68).stroke({ color: INK, width: 2 });
    this.focusLayer.addChild(g);
  }

  activateFocus() {
    const target = this.focusIdx >= 0 ? this.candidates()[this.focusIdx] : undefined;
    this.clearFocus();
    target?.act();
  }

  clearFocus() {
    this.focusIdx = -1;
    this.focusLayer.removeChildren().forEach(ch => ch.destroy());
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
    piece.path = { pts, segLens, total, elapsed: -MOVE_START_DELAY_MS, duration };
  }

  render(view: View, hi: Highlights, effects?: MoveEffect[]) {
    this.lastHi = hi;
    this.clearFocus(); // targets changed; stale keyboard focus would mislead
    const effectFor = effects && new Map(effects.map(e => [e.bunny, e]));

    // Pieces
    const reserveCount = [0, 0, 0, 0];
    const homeCount = [0, 0, 0, 0];
    for (const bunny of view.bunnies) {
      if (bunny.place.kind === 'burrow') homeCount[bunny.player]++;
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
    const ring = (
      x: number, y: number, r: number,
      color: number, width: number, fillAlpha = 0, alpha = 1,
    ) => {
      const g = new Graphics();
      if (fillAlpha > 0) g.circle(x, y, r).fill({ color, alpha: fillAlpha });
      g.circle(x, y, r).stroke({ color, width });
      g.alpha = alpha;
      this.highlightLayer.addChild(g);
    };
    const stepLabel = (x: number, y: number, text: string) => {
      const t = new Text({
        text,
        style: new TextStyle({
          fill: INK,
          fontSize: CELL * 0.6,
          fontFamily: SERIF,
          stroke: { color: CREAM, width: 4 },
        }),
      });
      t.anchor.set(0.5);
      t.position.set(x, y);
      this.highlightLayer.addChild(t);
    };
    for (const [i, label] of hi.track) {
      const { x, y } = trackPos(i);
      const r = (i % 20 === 0 ? CORNER_R : TRACK_R) + 4;
      ring(x, y, r, RED_INK, 3, 0.16);
      if (label) stepLabel(x, y, label);
    }
    for (const [key, label] of hi.burrows) {
      const [p, s] = key.split(':').map(Number);
      const { x, y } = burrowPos(p, s);
      ring(x, y, BURROW_R + 4, RED_INK, 3, 0.16);
      if (label) stepLabel(x, y, label);
    }
    for (const p of hi.reserves) {
      const { x, y } = reservePos(p, 0);
      ring(x, y, RESERVE_R + 4, RED_INK, 3, 0.16);
    }
    const reserveIdx = [0, 0, 0, 0];
    for (const bunny of view.bunnies) {
      const order = bunny.place.kind === 'reserve' ? reserveIdx[bunny.player]++ : 0;
      if (hi.selected === bunny.id) {
        const { x, y } = this.targetFor(bunny, order);
        ring(x, y, PIECE_R + 7, CREAM, 4);
        ring(x, y, PIECE_R + 9, INK, 1.5, 0, 0.6);
      } else if (hi.bunnies.has(bunny.id)) {
        const { x, y } = this.targetFor(bunny, order);
        ring(x, y, PIECE_R + 5, RED_INK, 3, 0.12);
      } else if (hi.recent.has(bunny.id)) {
        const { x, y } = this.targetFor(bunny, order);
        ring(x, y, PIECE_R + 6, GOLD, 2.5, 0, 0.9);
      }
    }

    if (this.roundLabel) {
      this.roundLabel.text = `ROUND ${ROUND_WORDS[view.round] || view.round}`;
    }

    // Seat labels: printed in the seat's ink, the active seat a touch larger
    // and underscored.
    this.seatLabels.forEach((label, p) => {
      const active = p === view.current && view.winner === null;
      const raw = view.seatNames[p] ?? PLAYER_NAMES[p];
      const cpu = raw.includes('CPU');
      label.text = (
        `${raw.replace(/^CPU /, '')}${cpu ? ' · CPU' : ''} · ${homeCount[p]} HOME` +
        `${view.folded[p] ? ' · FOLDED' : ''}`
      ).toUpperCase();
      label.style.fill = PLAYER_COLORS[p];
      label.alpha = active ? 1 : 0.72;
      label.scale.set(active ? 1.08 : 1);
      // Never let a long name run past the middle of the board.
      const maxW = 6.5 * CELL;
      if (label.width > maxW) label.scale.set((label.scale.x * maxW) / label.width);
      const underline = this.seatUnderlines[p];
      underline.clear();
      if (active) {
        const x0 = label.anchor.x > 0.5 ? label.x - label.width : label.x;
        underline
          .rect(x0, label.y + label.height / 2 + 2, label.width, 2)
          .fill(PLAYER_COLORS[p]);
      }
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
        const t = Math.min(1, Math.max(0, path.elapsed / path.duration));
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
