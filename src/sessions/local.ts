import { applyMove, createGame } from '../engine/game.ts';
import { chooseMove } from '../engine/ai.ts';
import { makeView } from '../net/protocol.ts';
import type { View } from '../net/protocol.ts';
import type { Move } from '../engine/types.ts';
import { PLAYER_NAMES } from '../engine/types.ts';

export type SeatKind = 'human' | 'cpu';

const CPU_DELAY_MS = 650;

/** Runs a full game on this device: any mix of hot-seat humans and CPUs. */
export class LocalSession {
  private state;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private seats: SeatKind[],
    private onView: (view: View) => void,
  ) {
    this.state = createGame(Math.floor(Math.random() * 2 ** 31));
  }

  start() {
    this.push();
    this.maybeCpu();
  }

  private names() {
    return this.seats.map((kind, i) =>
      kind === 'cpu' ? `CPU ${PLAYER_NAMES[i]}` : PLAYER_NAMES[i],
    );
  }

  private push() {
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

  private maybeCpu() {
    if (this.state.winner !== null || this.seats[this.state.current] !== 'cpu') return;
    this.timer = setTimeout(() => {
      if (this.state.winner !== null) return;
      applyMove(this.state, chooseMove(this.state));
      this.push();
      this.maybeCpu();
    }, CPU_DELAY_MS);
  }

  leave() {
    if (this.timer) clearTimeout(this.timer);
  }
}
