// ---------------------------------------------------------------------------
// Paper-card dialogs: in-theme replacements for alert() and confirm() that
// also never block the JS thread (polling keeps running behind them).
// ---------------------------------------------------------------------------

function open(text: string, buttons: { label: string; primary?: boolean; value: boolean }[]) {
  return new Promise<boolean>(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const card = document.createElement('div');
    card.className = 'paper dialog-card';
    const p = document.createElement('p');
    p.textContent = text;
    card.appendChild(p);
    const row = document.createElement('div');
    row.className = 'btn-row';
    const done = (value: boolean) => {
      overlay.remove();
      resolve(value);
    };
    for (const b of buttons) {
      const btn = document.createElement('button');
      if (b.primary) btn.className = 'primary';
      btn.textContent = b.label;
      btn.onclick = () => done(b.value);
      row.appendChild(btn);
    }
    card.appendChild(row);
    overlay.appendChild(card);
    overlay.addEventListener('keydown', e => {
      if (e.key === 'Escape') done(false);
    });
    document.body.appendChild(overlay);
    (row.querySelector('.primary') as HTMLButtonElement | null)?.focus();
  });
}

/** An in-theme alert(): resolves when acknowledged. */
export function notice(text: string): Promise<void> {
  return open(text, [{ label: 'OK', primary: true, value: true }]).then(() => undefined);
}

/** An in-theme confirm(): resolves true when accepted. */
export function confirmDialog(text: string, okLabel = 'Yes', cancelLabel = 'No'): Promise<boolean> {
  return open(text, [
    { label: cancelLabel, value: false },
    { label: okLabel, primary: true, value: true },
  ]);
}
