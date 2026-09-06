// ---------------------------------------------------------------------------
// Keyboard play: 1-4 pick a card, arrows cycle board targets, Enter moves,
// Escape cancels (or closes the rules modal), F folds.
// ---------------------------------------------------------------------------
import { $ } from './dom.ts';
import type { App } from './app.ts';

export function installKeyboard(app: App) {
  document.addEventListener('keydown', e => {
    if (!$('#rules-modal').hidden) {
      if (e.key === 'Escape') $('#rules-modal').hidden = true;
      return;
    }
    if ($('#game').hidden) return;
    const t = e.target;
    if (
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      t instanceof HTMLSelectElement
    ) {
      return;
    }
    if (e.key >= '1' && e.key <= '4') {
      const cards = document.querySelectorAll<HTMLButtonElement>('#hand .card');
      cards[Number(e.key) - 1]?.click();
    } else if (e.key === 'Escape') {
      app.cancelSelection();
    } else if (e.key.toLowerCase() === 'f') {
      const fold = $('#btn-fold') as HTMLButtonElement;
      if (!fold.hidden) fold.click();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      app.board.cycleFocus(-1);
      e.preventDefault();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      app.board.cycleFocus(1);
      e.preventDefault();
    } else if (e.key === 'Enter' && app.board.hasFocus()) {
      app.board.activateFocus();
      e.preventDefault();
    }
  });
}
