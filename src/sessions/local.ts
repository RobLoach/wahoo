import { applyMove, createGame } from '../engine/game.ts';
import { chooseMove } from '../engine/ai.ts';
import { makeView } from '../net/protocol.ts';
import type { View } from '../net/protocol.ts';
import type { Difficulty, GameState, HouseRules, Move } from '../engine/types.ts';
import { PLAYER_NAMES } from '../engine/types.ts';

export type SeatKind = 'human' | 'cpu-easy' | 'cpu-medium' | 'cpu-hard' | 'cpu-insane';

const SAVE_KEY = 'wahoo-local-game';

export interface LocalSave {
  seats: SeatKind[];
  state: GameState;
}

/** The unfinished local game saved by the last session, if any. */
export function savedLocalGame(): LocalSave | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalSave;
    if (!parsed.state || parsed.state.winner !== null) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearLocalGame(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}

/** A relaxed pause between CPU turns so everyone sees what was played. */
const DEFAULT_CPU_DELAY_MS = 4000;

/** Runs a full game on this device: any mix of hot-seat humans and CPUs. */
export class LocalSession {
  private state;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cpuDelay: number;

  constructor(
    private seats: SeatKind[],
    private onView: (view: View) => void,
    cpuDelay?: number,
    resume?: GameState,
    rules?: Partial<HouseRules>,
  ) {
    this.cpuDelay = cpuDelay ?? DEFAULT_CPU_DELAY_MS;
    this.state = resume
      ? structuredClone(resume)
      : createGame(Math.floor(Math.random() * 2 ** 31), rules);
  }

  start() {
    this.push();
    this.maybeCpu();
  }

  private names() {
    return this.seats.map((kind, i) =>
      kind === 'human' ? PLAYER_NAMES[i] : `CPU ${PLAYER_NAMES[i]}`,
    );
  }

  /** Persist the game so an accidental tab close can be resumed. */
  private persist() {
    try {
      if (this.state.winner === null) {
        localStorage.setItem(SAVE_KEY, JSON.stringify({ seats: this.seats, state: this.state }));
      } else {
        clearLocalGame();
      }
    } catch {
      /* storage may be unavailable; saving is best-effort */
    }
  }

  private push() {
    this.persist();
    const humanTurn =
      this.state.winner === null && this.seats[this.state.current] === 'human';
    this.onView(
      makeView(this.state, humanTurn ? this.state.current : null, this.names(), humanTurn),
    );
  }

  submit(move: Move) {
    if (this.seats[this.state.current] !== 'human') return;
    applyMove(this.state, move);
    this.push();
    this.maybeCpu();
  }

  /** Rematch: fresh game, same seats. */
  restart() {
    if (this.timer) clearTimeout(this.timer);
    this.state = createGame(Math.floor(Math.random() * 2 ** 31), this.state.rules);
    this.push();
    this.maybeCpu();
  }

  private maybeCpu() {
    const kind = this.seats[this.state.current];
    if (this.state.winner !== null || kind === 'human') return;
    const difficulty = kind.slice(4) as Difficulty;
    this.timer = setTimeout(() => {
      if (this.state.winner !== null || this.seats[this.state.current] === 'human') return;
      applyMove(this.state, chooseMove(this.state, difficulty));
      this.push();
      this.maybeCpu();
    }, this.cpuDelay);
  }

  leave() {
    if (this.timer) clearTimeout(this.timer);
  }
}
