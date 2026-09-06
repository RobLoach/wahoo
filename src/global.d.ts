// Debug and test hooks the app exposes on the page (used by the Playwright
// suite and handy in the console).
import type { App } from './ui/app.ts';
import type { burrowPos, reservePos, trackPos } from './ui/board.ts';

declare global {
  interface Window {
    /** The running app plus the board geometry helpers. */
    __wahoo?: {
      app: App;
      trackPos: typeof trackPos;
      burrowPos: typeof burrowPos;
      reservePos: typeof reservePos;
    };
    /** Test override: ms between CPU turns in local games. */
    __wahooCpuDelay?: number;
    /** Test override: board canvas resolution (headless browsers software-render). */
    __wahooResolution?: number;
    webkitAudioContext?: typeof AudioContext;
  }
}

export {};
