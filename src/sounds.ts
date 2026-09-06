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
/** Each reaction gets its own little synthesized voice — no assets needed. */
export function playEmoteSound(id = ''): void {
  if (muted) return;
  try {
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctor) return;
    popCtx ??= new Ctor();
    const ctx = popCtx;
    const t0 = ctx.currentTime;
    const blip = (
      at: number,
      from: number,
      to: number,
      dur: number,
      type: OscillatorType = 'sine',
      vol = 0.16,
    ) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(from, t0 + at);
      osc.frequency.exponentialRampToValueAtTime(to, t0 + at + dur);
      gain.gain.setValueAtTime(vol, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + at + dur + 0.03);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + dur + 0.05);
    };
    switch (id) {
      case 'wahoo': // two rising cheers
        blip(0, 420, 880, 0.12);
        blip(0.11, 620, 1240, 0.16);
        break;
      case 'lol': // a pair of chuckles
        blip(0, 500, 380, 0.09);
        blip(0.12, 560, 420, 0.09);
        break;
      case 'gasp': // sharp intake
        blip(0, 300, 950, 0.14, 'triangle');
        break;
      case 'smug': // smooth slide down
        blip(0, 520, 240, 0.22, 'sine', 0.13);
        break;
      case 'finger': // flat little buzz
        blip(0, 180, 140, 0.16, 'square', 0.07);
        break;
      default:
        blip(0, 520, 180, 0.12);
    }
  } catch {
    /* audio may be blocked before the first gesture */
  }
}

let popCtx: AudioContext | null = null;

/** A soft two-note ding when the device should change hands (hot seat). */
export function playTurnChime(): void {
  if (muted) return;
  try {
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctor) return;
    popCtx ??= new Ctor();
    const ctx = popCtx;
    const t0 = ctx.currentTime;
    for (const [at, freq] of [[0, 659], [0.14, 784]] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t0 + at);
      gain.gain.setValueAtTime(0.001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.12, t0 + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + at + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.4);
    }
  } catch {
    /* audio may be blocked before the first gesture */
  }
}

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
