// Move sounds. To swap in different audio, replace the two files in
// src/assets/ (any browser-supported format works — update the imports).
import hopUrl from './assets/hop.wav';
import squashUrl from './assets/squash.wav';
import type { MoveEffect } from './engine/types.ts';

const hop = new Audio(hopUrl);
const squash = new Audio(squashUrl);
hop.volume = 0.5;
squash.volume = 0.7;

/** Squash when any bunny got stomped, otherwise a hop for any movement. */
export function playMoveSound(effects: MoveEffect[]): void {
  if (effects.length === 0) return;
  const sound = effects.some(e => e.kind === 'stomped') ? squash : hop;
  try {
    sound.currentTime = 0;
    // Browsers block audio before the first user gesture; fail silently.
    void sound.play().catch(() => {});
  } catch {
    /* ignore */
  }
}
