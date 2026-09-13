// ---------------------------------------------------------------------------
// Screen-reader announcements. Two permanent live regions: polite for turn
// flow, assertive for the rare interruption (a timer about to run out).
// Setting identical text twice is a no-op to screen readers, so the region
// is cleared and refilled a frame later — repeats are heard again.
// ---------------------------------------------------------------------------
import { $ } from './dom.ts';

function write(id: string, text: string) {
  const el = $(id);
  el.textContent = '';
  requestAnimationFrame(() => {
    el.textContent = text;
  });
}

export function announce(text: string) {
  write('#announcer', text);
}

export function announceUrgent(text: string) {
  write('#announcer-urgent', text);
}
