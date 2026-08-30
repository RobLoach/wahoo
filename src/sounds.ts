// Move sounds. To swap in different audio, replace the files in
// src/assets/ (any browser-supported format works — update the imports).
import hopUrl from './assets/hop.wav';
import squashUrl from './assets/squash.wav';
import burrowUrl from './assets/burrow.wav';
import type { MoveEffect } from './engine/types.ts';

const hop = new Audio(hopUrl);
const squash = new Audio(squashUrl);
const burrow = new Audio(burrowUrl);
hop.volume = 0.5;
squash.volume = 0.7;
burrow.volume = 0.65;

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
 * a celebratory fanfare when a bunny reaches its burrow, a squash when one is
 * stomped, and a hop when one comes out of reserve or is swapped.
 */
export function playMoveSound(effects: MoveEffect[]): void {
  if (muted) return;
  const reachedHome = effects.some(
    e => e.to.kind === 'burrow' && e.from.kind !== 'burrow',
  );
  const squashed = effects.some(e => e.kind === 'stomped');
  const special = effects.some(
    e =>
      (e.from.kind === 'reserve' && e.to.kind === 'track') || // came out
      (e.kind === 'jump' && e.from.kind === 'track' && e.to.kind === 'track'), // swapped
  );
  if (squashed) {
    try {
      navigator.vibrate?.(60); // a little haptic thump on phones
    } catch {
      /* ignore */
    }
  }
  // Reaching home outranks everything — it deserves the fanfare.
  const sound = reachedHome ? burrow : squashed ? squash : special ? hop : null;
  if (!sound) return;
  try {
    sound.currentTime = 0;
    // Browsers block audio before the first user gesture; fail silently.
    void sound.play().catch(() => {});
  } catch {
    /* ignore */
  }
}
