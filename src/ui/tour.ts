const KEY = 'wahoo-tour-done';

interface Step {
  sel: string;
  text: string;
}

const STEPS: Step[] = [
  {
    sel: '#hand',
    text:
      'This is your hand — play one card each turn. There is no drawing back ' +
      'up: when everyone runs out, a fresh round of 4 cards is dealt.',
  },
  {
    sel: '#board-wrap',
    text:
      'Play an A, 2, or K to bring a bunny out of your reserve, then race it ' +
      'clockwise around the track. Landing on any bunny stomps it back home — ' +
      'passing through is safe.',
  },
  {
    sel: '#board-wrap',
    text:
      'Your burrow is the diagonal at your corner. Entering needs an exact ' +
      'count, and you cannot jump over bunnies already inside. Bunnies in ' +
      'burrows are safe from everything.',
  },
  {
    sel: '#status',
    text:
      'This bar tells you whose turn it is and what to do next. Your teammate ' +
      'sits at the opposite corner with the matching ✦ or ● mark — the first ' +
      'team to tuck all 8 bunnies into their burrows wins. Have fun!',
  },
];

/** Show the walkthrough on the first local game only. */
export function maybeStartTour() {
  try {
    if (localStorage.getItem(KEY)) return;
  } catch {
    return;
  }
  startTour();
}

export function startTour() {
  let i = 0;
  let spot: HTMLElement | null = null;
  const dim = document.createElement('div');
  dim.id = 'tour-dim';
  const card = document.createElement('div');
  card.id = 'tour-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'How to play walkthrough');
  document.body.append(dim, card);

  const done = () => {
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* storage may be unavailable */
    }
    spot?.classList.remove('tour-spot');
    dim.remove();
    card.remove();
  };

  const show = () => {
    spot?.classList.remove('tour-spot');
    const step = STEPS[i];
    spot = document.querySelector(step.sel);
    spot?.classList.add('tour-spot');

    card.innerHTML = `<p>${step.text}</p>`;
    const row = document.createElement('div');
    row.className = 'row';
    const skip = document.createElement('button');
    skip.textContent = 'Skip';
    skip.onclick = done;
    const next = document.createElement('button');
    next.className = 'primary';
    next.textContent = i === STEPS.length - 1 ? 'Got it!' : `Next (${i + 1}/${STEPS.length})`;
    next.onclick = () => {
      i++;
      if (i < STEPS.length) show();
      else done();
    };
    row.append(skip, next);
    card.appendChild(row);

    // Sit just below the highlighted element (or above when out of room),
    // clamped to the viewport.
    const r = spot?.getBoundingClientRect();
    card.style.top = '';
    card.style.bottom = '';
    if (r) {
      if (r.bottom + 190 < innerHeight) card.style.top = `${r.bottom + 10}px`;
      else if (r.top > 200) card.style.bottom = `${innerHeight - r.top + 10}px`;
      else card.style.bottom = '20px'; // target fills the screen: pin low
      card.style.left = `${Math.max(10, Math.min(r.left, innerWidth - 340))}px`;
    } else {
      card.style.top = '30%';
      card.style.left = `${Math.max(10, innerWidth / 2 - 165)}px`;
    }
    next.focus();
  };

  // Wait a beat so the board has laid out before we measure it.
  setTimeout(show, 300);
}
