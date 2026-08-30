// Move sounds. To swap in different audio, replace the two files in
// src/assets/ (any browser-supported format works — update the imports).
import hopUrl from './assets/hop.wav';
import squashUrl from './assets/squash.wav';
import type { MoveEffect } from './engine/types.ts';

const hop = new Audio(hopUrl);
const squash = new Audio(squashUrl);
hop.volume = 0.5;
squash.volume = 0.7;

let muted = false;
try {
  muted = localStorage.getItem('wahoo-muted') === '1';
} catch {
  /* storage unavailable */
}

export const isMuted = () => muted;

export function setMuted(value: boolean) {
  muted = value;
  try {
    localStorage.setItem('wahoo-muted', value ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

/**
 * Plain movement is silent. Sounds mark the special moments only:
 * squash when a bunny is stomped; otherwise a hop when a bunny reaches its
 * burrow, comes out of reserve, or is swapped.
 */
export function playMoveSound(effects: MoveEffect[]): void {
  if (muted) return;
  const squashed = effects.some(e => e.kind === 'stomped');
  const special = effects.some(
    e =>
      (e.to.kind === 'burrow' && e.from.kind !== 'burrow') || // reached home
      (e.from.kind === 'reserve' && e.to.kind === 'track') || // came out
      (e.kind === 'jump' && e.from.kind === 'track' && e.to.kind === 'track'), // swapped
  );
  const sound = squashed ? squash : special ? hop : null;
  if (!sound) return;
  try {
    sound.currentTime = 0;
    // Browsers block audio before the first user gesture; fail silently.
    void sound.play().catch(() => {});
  } catch {
    /* ignore */
  }
}
