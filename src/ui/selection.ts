// ---------------------------------------------------------------------------
// Selection state machine helpers: card -> (bunny) -> destination
// ---------------------------------------------------------------------------
import { forwardDest } from '../engine/game.ts';
import type { Bunny, CardAction, HouseRules, Move } from '../engine/types.ts';
import { TEAMMATE_OF } from '../engine/types.ts';
import type { View } from '../net/protocol.ts';

export interface SevenPart { bunny: number; steps: number }

export interface Selection {
  cardId: number | 'flip' | null;
  bunny: number | null;
  sevenParts: SevenPart[];
}

export const emptySelection = (): Selection => ({ cardId: null, bunny: null, sevenParts: [] });

export function ctrlPlayer(view: View): number {
  const seat = view.mySeat;
  if (seat === null) return -1;
  const mine = view.bunnies.filter(b => b.player === seat);
  return mine.every(b => b.place.kind === 'burrow') ? TEAMMATE_OF(seat) : seat;
}

/** Actions available for the currently selected card (or pending flip). */
export function selectedActions(view: View, sel: Selection): CardAction[] {
  if (sel.cardId === 'flip') {
    return view.legal.filter(m => m.type === 'flip').map(m => (m as any).action);
  }
  return view.legal
    .filter(m => m.type === 'play' && m.card === sel.cardId)
    .map(m => (m as any).action);
}

export function wrapAction(view: View, sel: Selection, action: CardAction): Move {
  return sel.cardId === 'flip'
    ? { type: 'flip', action }
    : { type: 'play', card: sel.cardId as number, action };
}

/** Apply chosen 7-split parts to a copy of the bunny list (mirrors engine stomps). */
export function simBunnies(bunnies: Bunny[], parts: SevenPart[], rules?: HouseRules): Bunny[] {
  const sim: Bunny[] = structuredClone(bunnies);
  for (const part of parts) {
    const bunny = sim.find(b => b.id === part.bunny)!;
    const dest = forwardDest({ bunnies: sim, rules }, bunny, part.steps);
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

export function partsMatch(chosen: SevenPart[], all: SevenPart[]): boolean {
  return chosen.every(c => all.some(p => p.bunny === c.bunny && p.steps === c.steps));
}

export function sevenCandidates(actions: CardAction[], chosen: SevenPart[]) {
  return actions.filter(
    (a): a is Extract<CardAction, { kind: 'seven' }> =>
      a.kind === 'seven' && partsMatch(chosen, a.parts),
  );
}

