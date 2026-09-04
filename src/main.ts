import '@fontsource/fredoka/500.css';
import '@fontsource/fredoka/600.css';
import '@fontsource/fredoka/700.css';
import '@fontsource/nunito-sans/400.css';
import '@fontsource/nunito-sans/400-italic.css';
import '@fontsource/nunito-sans/600.css';
import '@fontsource/nunito-sans/700.css';
import './style.css';
import { $, esc } from './ui/dom.ts';
import { App } from './ui/app.ts';
import type { NetSession } from './ui/app.ts';
import type { RoomInfo } from './net/protocol.ts';
import { trackPos, burrowPos, reservePos } from './ui/board.ts';
import { emptySelection } from './ui/selection.ts';
import { LocalSession, savedLocalGame } from './sessions/local.ts';
import type { SeatKind } from './sessions/local.ts';
import { OnlineSession } from './net/client.ts';
import { HttpSession } from './net/http.ts';
import type { OnlineHandlers } from './net/client.ts';
import { P2PGuestSession, P2PHostSession, savedHostGame } from './net/p2p.ts';
import type { Difficulty, HouseRules } from './engine/types.ts';
import { DEFAULT_RULES } from './engine/types.ts';
import { EMOTES } from './net/protocol.ts';
import { EMOTE_LABELS, emoteHtml } from './ui/emotes.ts';
import { PLAYER_NAMES } from './engine/types.ts';
import { isMuted, setMuted } from './sounds.ts';
import { maybeStartTour } from './ui/tour.ts';

// ---------------------------------------------------------------------------
// Menu wiring
// ---------------------------------------------------------------------------

const app = new App();

function savedSeatNames(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem('wahoo-local-names') ?? '[]');
    return [0, 1, 2, 3].map(i => (typeof raw[i] === 'string' ? raw[i] : PLAYER_NAMES[i]));
  } catch {
    return [...PLAYER_NAMES];
  }
}

function buildSeatConfig() {
  const wrap = $('#seat-config');
  wrap.innerHTML = '';
  const defaults: SeatKind[] = ['human', 'cpu-medium', 'cpu-medium', 'cpu-medium'];
  const names = savedSeatNames();
  const kinds: [SeatKind, string][] = [
    ['human', 'Human'],
    ['cpu-easy', 'Easy'],
    ['cpu-medium', 'Medium'],
    ['cpu-hard', 'Hard'],
    ['cpu-insane', 'Insane'],
  ];
  // Rows are listed by team (partners sit at opposite corners): Red & Green,
  // then Blue & Yellow, with a solid rule between the two teams.
  for (const i of [0, 2, 1, 3]) {
    const row = document.createElement('div');
    row.className = 'seat-row' + (i === 2 ? ' team-break' : '');
    row.innerHTML =
      `<span class="seat-dot p${i}"></span>` +
      `<span class="seat-color">${PLAYER_NAMES[i]}</span>` +
      `<span class="seat-label" data-label-seat="${i}">CPU ${PLAYER_NAMES[i]}</span>` +
      `<input class="seat-name" data-name-seat="${i}" maxlength="12" value="${esc(names[i])}"` +
      ` aria-label="${PLAYER_NAMES[i]} player name" />` +
      `<select data-seat="${i}" aria-label="${PLAYER_NAMES[i]} seat">` +
      kinds
        .map(([v, label]) => `<option value="${v}"${defaults[i] === v ? ' selected' : ''}>${label}</option>`)
        .join('') +
      `</select>`;
    wrap.appendChild(row);
    // Humans get a name field; CPU seats just show the colour label.
    const sel = row.querySelector('select')!;
    const sync = () => {
      const human = sel.value === 'human';
      (row.querySelector('.seat-name') as HTMLElement).hidden = !human;
      (row.querySelector('.seat-label') as HTMLElement).hidden = human;
    };
    sel.addEventListener('change', sync);
    row.querySelector('.seat-name')!.addEventListener('change', () => {
      localStorage.setItem('wahoo-local-names', JSON.stringify(readSeatNames()));
    });
    sync();
  }
}

function readSeatNames(): string[] {
  const names = [...PLAYER_NAMES];
  for (const el of document.querySelectorAll<HTMLInputElement>('#seat-config .seat-name')) {
    const i = Number(el.dataset.nameSeat);
    names[i] = el.value.trim() || PLAYER_NAMES[i];
  }
  return names;
}
buildSeatConfig();

// ---- House rules controls (shared between the local menu and the lobby) ----

function savedRules(): HouseRules {
  try {
    return { ...DEFAULT_RULES, ...JSON.parse(localStorage.getItem('wahoo-rules') ?? '{}') };
  } catch {
    return { ...DEFAULT_RULES };
  }
}

function describeRules(r: HouseRules): string {
  const seven = { 1: '7 moves one bunny', 2: '7 splits up to two bunnies', 4: '7 splits freely' }[
    r.sevenMaxBunnies
  ];
  return [
    r.friendlyFire ? 'teammate stomping allowed' : 'no teammate stomping',
    seven,
    r.burrowJump ? 'burrow jumping allowed' : 'no burrow jumping',
  ].join(' · ');
}

function rulesControlsHtml(): string {
  const r = savedRules();
  return (
    `<label class="rule-row"><input type="checkbox" id="hr-ff" ${r.friendlyFire ? 'checked' : ''}/>` +
    `<span>Kings and landings can stomp teammates</span></label>` +
    `<label class="rule-row"><span>The 7</span><select id="hr-seven">` +
    `<option value="1" ${r.sevenMaxBunnies === 1 ? 'selected' : ''}>one bunny only</option>` +
    `<option value="2" ${r.sevenMaxBunnies === 2 ? 'selected' : ''}>up to two bunnies</option>` +
    `<option value="4" ${r.sevenMaxBunnies === 4 ? 'selected' : ''}>any split</option>` +
    `</select></label>` +
    `<label class="rule-row"><input type="checkbox" id="hr-jump" ${r.burrowJump ? 'checked' : ''}/>` +
    `<span>Bunnies may jump over occupied burrow slots</span></label>`
  );
}

function readRules(): HouseRules {
  const rules: HouseRules = {
    friendlyFire: ($('#hr-ff') as HTMLInputElement).checked,
    sevenMaxBunnies: Number(($('#hr-seven') as HTMLSelectElement).value) as 1 | 2 | 4,
    burrowJump: ($('#hr-jump') as HTMLInputElement).checked,
  };
  localStorage.setItem('wahoo-rules', JSON.stringify(rules));
  return rules;
}

$('#house-rules-body').innerHTML = rulesControlsHtml();
$('#house-rules-body')
  .querySelectorAll('input, select')
  .forEach(el =>
    el.addEventListener('change', () => {
      const rules = readRules(); // persist immediately
      // Hosting a lobby: publish the change so guests see the rules live.
      const session = pendingOnline ?? app.session;
      if (app.roomInfo?.youAreHost && !app.roomInfo.started && session && 'setRules' in session) {
        session.setRules(rules);
      }
    }),
  );

$('#start-local').onclick = async () => {
  const seats: SeatKind[] = ['cpu-medium', 'cpu-medium', 'cpu-medium', 'cpu-medium'];
  for (const sel of document.querySelectorAll<HTMLSelectElement>('#seat-config select')) {
    seats[Number(sel.dataset.seat)] = sel.value as SeatKind;
  }
  app.startLocalMeta(seats.filter(s => s === 'human').length);
  await app.showGame();
  const session = new LocalSession(
    seats,
    view => app.onView(view),
    (window as unknown as Record<string, number>).__wahooCpuDelay,
    undefined,
    readRules(),
    readSeatNames(),
  );
  app.session = session;
  app.online = false;
  session.start();
  if (seats.includes('human')) maybeStartTour();
};

/** Persistent identity so a reconnecting player can reclaim their seat. */
function clientToken(): string {
  let token = localStorage.getItem('wahoo-token');
  if (!token) {
    token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    localStorage.setItem('wahoo-token', token);
  }
  return token;
}

// ---- Online (browser-hosted P2P or dedicated server) ----

let pendingOnline: NetSession | null = null;

function defaultServerUrl(): string {
  return localStorage.getItem('wahoo-server') ?? 'https://wahoo.robloach.net';
}
($('#online-server') as HTMLInputElement).value = defaultServerUrl();

function selectOnlineTab(which: 'p2p' | 'server') {
  for (const t of ['p2p', 'server'] as const) {
    const active = t === which;
    $(`#tab-${t}`).classList.toggle('active', active);
    $(`#tab-${t}`).setAttribute('aria-selected', String(active));
    $(`#tab-panel-${t}`).hidden = !active;
  }
  localStorage.setItem('wahoo-online-tab', which);
}
$('#tab-p2p').onclick = () => selectOnlineTab('p2p');
$('#tab-server').onclick = () => selectOnlineTab('server');
if (localStorage.getItem('wahoo-online-tab') === 'server') selectOnlineTab('server');

function netHandlers(getSession: () => NetSession): OnlineHandlers {
  return {
    onView: async view => {
      const session = getSession();
      if (app.session !== session) {
        app.session = session;
        app.online = true;
        await app.showGame();
        if (view.mySeat !== null) maybeStartTour();
      }
      app.onView(view);
    },
    onRoom: room => {
      setNetPending(null);
      $('#join-note').hidden = true; // in the room now
      app.roomInfo = room;
      renderLobby(getSession(), room);
    },
    onEmote: (seat, emoji) => app.showEmote(seat, emoji),
    onError: msg => {
      setNetPending(null);
      alert(msg);
    },
    onClose: () => {
      if (lastGuestCode && confirm('Disconnected from the game. Try to rejoin?')) {
        joinP2P(lastGuestCode);
        return;
      }
      alert('Disconnected from the game.');
      app.showMenu();
    },
  };
}

let lastGuestCode: string | null = null;

/** Show a spinner on the Host/Join buttons while the P2P handshake runs. */
function setNetPending(which: 'host' | 'join' | 'resume' | null) {
  const host = $('#p2p-host') as HTMLButtonElement;
  const join = $('#p2p-join') as HTMLButtonElement;
  const resume = $('#p2p-resume') as HTMLButtonElement;
  host.disabled = join.disabled = which !== null;
  resume.disabled = which !== null;
  host.innerHTML = which === 'host' ? '<span class="spinner"></span> Connecting…' : 'Host a Game';
  join.innerHTML = which === 'join' ? '<span class="spinner"></span> Joining…' : 'Join';
  if (which === 'resume') resume.innerHTML = '<span class="spinner"></span> Resuming…';
  if (which === null) refreshResumeButton(); // restore the resume label
}

function joinP2P(code: string) {
  pendingOnline?.leave();
  lastGuestCode = code;
  setNetPending('join');
  let session: P2PGuestSession;
  session = new P2PGuestSession(code, playerName(), clientToken(), netHandlers(() => session));
  pendingOnline = session;
}

let activeDedicatedServer: string | null = null;

function connectOnline(afterOpen: (s: OnlineSession | HttpSession) => void) {
  const url =
    ($('#online-server') as HTMLInputElement).value.trim() || 'https://wahoo.robloach.net';
  localStorage.setItem('wahoo-server', url);
  activeDedicatedServer = url;
  pendingOnline?.leave();
  // http(s):// servers use the PHP polling relay; ws(s):// the Node WebSocket server.
  let session: OnlineSession | HttpSession;
  session = /^https?:/i.test(url)
    ? new HttpSession(url, netHandlers(() => session), () => afterOpen(session))
    : new OnlineSession(url, netHandlers(() => session), () => afterOpen(session));
  pendingOnline = session;
}

function playerName(): string {
  const name = ($('#online-name') as HTMLInputElement).value.trim();
  if (name) localStorage.setItem('wahoo-name', name);
  return name || localStorage.getItem('wahoo-name') || 'Player';
}
($('#online-name') as HTMLInputElement).value = localStorage.getItem('wahoo-name') ?? '';

// Renaming after joining (e.g. via an invite link) updates your seat for everyone.
$('#online-name').addEventListener('change', () => {
  const session = pendingOnline ?? app.session;
  if (session && 'rename' in session) session.rename(playerName());
});

$('#p2p-host').onclick = () => {
  pendingOnline?.leave();
  lastGuestCode = null;
  setNetPending('host');
  let session: P2PHostSession;
  session = new P2PHostSession(playerName(), clientToken(), netHandlers(() => session));
  pendingOnline = session;
};
$('#p2p-join').onclick = () => {
  const code = ($('#p2p-code') as HTMLInputElement).value.trim().toUpperCase();
  if (!code) return alert('Enter a room code.');
  joinP2P(code);
};

function refreshResumeButton() {
  const saved = savedHostGame();
  const btn = $('#p2p-resume') as HTMLButtonElement;
  btn.hidden = !saved;
  if (saved) btn.textContent = `Resume hosted game ${saved.code}`;
  const local = savedLocalGame();
  const localBtn = $('#local-resume') as HTMLButtonElement;
  localBtn.hidden = !local;
  if (local) localBtn.textContent = `Resume · round ${local.state.round}`;
}

$('#local-resume').onclick = async () => {
  const saved = savedLocalGame();
  if (!saved) return refreshResumeButton();
  app.startLocalMeta(saved.seats.filter(s => s === 'human').length);
  await app.showGame();
  const session = new LocalSession(
    saved.seats,
    view => app.onView(view),
    (window as unknown as Record<string, number>).__wahooCpuDelay,
    saved.state,
    undefined,
    saved.names,
  );
  app.session = session;
  app.online = false;
  session.start();
};
app.onMenuShown = () => {
  refreshResumeButton();
  setJoiningMode(false); // returning to the menu restores the full menu
};

/** Invite-link mode: only the name field and lobby, so joining is obvious. */
function setJoiningMode(on: boolean) {
  $('#local-panel').hidden = on;
  $('#house-rules').hidden = on; // guests play by the host's rules
  (document.querySelector('.tabs') as HTMLElement).hidden = on;
  $('#tab-panel-p2p').hidden = on;
  $('#tab-panel-server').hidden = on || !$('#tab-server').classList.contains('active');
  $('#join-note').hidden = !on;
}
refreshResumeButton();

$('#p2p-resume').onclick = () => {
  const saved = savedHostGame();
  if (!saved) return refreshResumeButton();
  pendingOnline?.leave();
  lastGuestCode = null;
  setNetPending('resume');
  let session: P2PHostSession;
  session = new P2PHostSession(saved.name, clientToken(), netHandlers(() => session), saved);
  pendingOnline = session;
};

$('#online-create').onclick = () => connectOnline(s => s.create(playerName(), clientToken()));
$('#online-join').onclick = () => {
  const code = ($('#online-code') as HTMLInputElement).value.trim().toUpperCase();
  if (!code) return alert('Enter a room code.');
  connectOnline(s => s.join(code, playerName(), clientToken()));
};

function renderLobby(session: NetSession, room: RoomInfo) {
  const lobby = $('#lobby');
  lobby.hidden = false;
  lobby.innerHTML =
    `<h3>${room.started ? 'Game in progress' : 'Room open'}</h3>` +
    `<p class="panel-sub">${
      room.started
        ? 'Take a seat to play, or watch along.'
        : 'Waiting for players. CPUs cover empty seats.'
    }</p>` +
    `<div class="code-box"><div class="eyebrow">Room code</div>` +
    `<span class="code">${esc(room.code)}</span></div>`;
  if (room.yourSeat === null) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = "You're spectating — take a seat to play.";
    lobby.appendChild(note);
  }
  if (room.youAreHost && !room.started) {
    const diffRow = document.createElement('label');
    diffRow.className = 'hint';
    diffRow.innerHTML =
      '<span>CPU difficulty for added seats</span><select id="lobby-diff">' +
      '<option value="easy">Easy</option>' +
      '<option value="medium" selected>Medium</option>' +
      '<option value="hard">Hard</option>' +
      '<option value="insane">Insane</option></select>';
    lobby.appendChild(diffRow);
  }
  const seats = document.createElement('div');
  seats.className = 'seats';
  room.seats.forEach((seat, i) => {
    const row = document.createElement('div');
    row.className = 'seat-row';
    let controls = '';
    let status = '';
    if (seat === null) {
      controls = `<button data-sit="${i}">Sit here</button>`;
      if (room.youAreHost) controls += ` <button data-cpu="${i}">Add CPU</button>`;
    } else if (seat.cpu) {
      status = `<span class="seat-status">${esc(seat.difficulty ?? 'medium')}</span>`;
      if (room.youAreHost) controls = `<button data-uncpu="${i}">Remove CPU</button>`;
    } else {
      status = `<span class="seat-status ready">${room.started ? 'Playing' : 'Ready'}</span>`;
    }
    const name = seat
      ? seat.cpu
        ? `<span class="seat-name-text open">CPU ${PLAYER_NAMES[i]}</span>`
        : `<span class="seat-name-text">${esc(seat.name)}${
            room.yourSeat === i ? '<span class="tag">you</span>' : ''
          }</span>`
      : `<span class="seat-name-text open">Open seat<span class="tag">${PLAYER_NAMES[i]}</span></span>`;
    row.innerHTML = `<span class="seat-dot p${i}"></span>${name}${status}${controls}`;
    seats.appendChild(row);
  });
  lobby.appendChild(seats);
  {
    const dedicated = session instanceof OnlineSession || session instanceof HttpSession;
    const serverParam =
      dedicated && activeDedicatedServer
        ? `&server=${encodeURIComponent(activeDedicatedServer)}`
        : '';
    const url = `${location.origin}${location.pathname}?join=${room.code}${serverParam}`;
    const invite = document.createElement('div');
    invite.className = 'invite';
    const codeEl = document.createElement('code');
    codeEl.textContent = url;
    invite.appendChild(codeEl);
    lobby.appendChild(invite);
    const actions = document.createElement('div');
    actions.className = 'lobby-actions';
    if (room.youAreHost) {
      const start = document.createElement('button');
      start.className = 'primary';
      start.textContent = room.started ? 'Start again' : 'Start';
      start.title = 'Empty seats become CPUs';
      // Rules come from the shared House Rules card below the panels.
      start.onclick = () => session.startGame(readRules());
      actions.appendChild(start);
    }
    const copy = document.createElement('button');
    copy.textContent = 'Copy link';
    copy.onclick = () => {
      navigator.clipboard?.writeText(url);
      copy.textContent = 'Copied!';
    };
    actions.appendChild(copy);
    lobby.appendChild(actions);
  }
  if (room.rules && !room.started) {
    const line = document.createElement('p');
    line.className = 'hint';
    line.textContent = `House rules: ${describeRules(room.rules)}`;
    lobby.appendChild(line);
  }
  if (room.youAreHost) {
    if (!room.started) {
      // A joining-mode guest can inherit hosting: give them the rules card.
      $('#house-rules').hidden = false;
      // Publish the card's rules so every lobby shows them (loop-safe: only
      // when the room doesn't already carry the same values).
      const current = readRules();
      if (JSON.stringify(room.rules ?? null) !== JSON.stringify(current) && 'setRules' in session) {
        session.setRules(current);
      }
    }
  } else {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Waiting for the host to start…';
    lobby.appendChild(p);
  }
  lobby.querySelectorAll<HTMLButtonElement>('[data-sit]').forEach(b => {
    b.onclick = () => session.sit(Number(b.dataset.sit));
  });
  lobby.querySelectorAll<HTMLButtonElement>('[data-cpu]').forEach(b => {
    b.onclick = () => {
      const diff = (document.querySelector('#lobby-diff') as HTMLSelectElement | null)?.value;
      session.cpu(Number(b.dataset.cpu), true, (diff ?? 'medium') as Difficulty);
    };
  });
  lobby.querySelectorAll<HTMLButtonElement>('[data-uncpu]').forEach(b => {
    b.onclick = () => session.cpu(Number(b.dataset.uncpu), false);
  });
}

// ---- In-game buttons ----

$('#btn-fold').onclick = () => app.submit({ type: 'discardHand' });
$('#btn-cancel').onclick = () => {
  const keepFlip = app.view?.pendingFlip && app.view.canAct;
  app.sel = emptySelection();
  if (keepFlip) app.sel.cardId = 'flip';
  app.refresh();
};
$('#btn-menu').onclick = () => {
  pendingOnline?.leave();
  pendingOnline = null;
  app.showMenu();
};
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('#rules-modal').hidden) {
    $('#rules-modal').hidden = true;
    return;
  }
  ($('#btn-cancel') as HTMLButtonElement).click();
});

function refreshMuteButton() {
  $('#btn-mute').textContent = isMuted() ? 'Muted' : 'Sound';
}
refreshMuteButton();
$('#btn-mute').onclick = () => {
  setMuted(!isMuted());
  refreshMuteButton();
};

$('#victory-menu').onclick = () => ($('#btn-menu') as HTMLButtonElement).click();

/** The in-game modal shows the rules THIS game is using (guests see the host's). */
function renderModalHouseRules() {
  const r = app.view?.rules ?? savedRules();
  const seven = { 1: 'one bunny only', 2: 'may split across two bunnies', 4: 'may split freely' };
  $('#rules-modal-house').innerHTML =
    `<li>Stomping teammates: <b>${r.friendlyFire ? 'allowed' : 'not allowed'}</b></li>` +
    `<li>The 7: <b>${seven[r.sevenMaxBunnies]}</b></li>` +
    `<li>Jumping over occupied burrow slots: <b>${r.burrowJump ? 'allowed' : 'not allowed'}</b></li>`;
}

$('#btn-rules').onclick = () => {
  renderModalHouseRules();
  $('#rules-modal').hidden = false;
};
$('#rules-close').onclick = () => {
  $('#rules-modal').hidden = true;
};
$('#rules-modal').onclick = e => {
  if (e.target === $('#rules-modal')) $('#rules-modal').hidden = true;
};

$('#btn-fullscreen').onclick = () => {
  if (document.fullscreenElement) {
    void document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen?.().catch(() => {});
  }
};

// Emote bar: online-only reactions.
{
  const bar = $('#emote-bar .emotes');
  for (const emoji of EMOTES) {
    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.dataset.emote = emoji;
    btn.innerHTML = emoteHtml(emoji);
    btn.title = EMOTE_LABELS[emoji] ?? emoji;
    btn.setAttribute('aria-label', `React: ${EMOTE_LABELS[emoji] ?? emoji}`);
    btn.onclick = () => {
      const session = app.session;
      if (session && 'emote' in session) session.emote(emoji);
    };
    bar.appendChild(btn);
  }
}

$('#btn-again').onclick = () => {
  const session = app.session;
  if (!session) return;
  if (session instanceof LocalSession) session.restart();
  else session.playAgain();
};

// ?join=CODE deep link joins a browser-hosted room; with &server=… it joins
// that dedicated server instead.
{
  const params = new URLSearchParams(location.search);
  const joinCode = params.get('join')?.toUpperCase();
  const server = params.get('server');
  const dedicated = joinCode !== undefined && !!server && /^(https?|wss?):\/\//i.test(server);
  if (joinCode) {
    if (dedicated) {
      // Remember the tab BEFORE entering joining mode: joining mode hides the
      // whole Server section (Create Room etc.) so the guest only sees the lobby.
      selectOnlineTab('server');
      ($('#online-server') as HTMLInputElement).value = server!;
      ($('#online-code') as HTMLInputElement).value = joinCode;
      setTimeout(() => connectOnline(s => s.join(joinCode, playerName(), clientToken())), 50);
    } else {
      ($('#p2p-code') as HTMLInputElement).value = joinCode;
      setTimeout(() => joinP2P(joinCode), 50);
    }
    setJoiningMode(true);
    $('#join-note').textContent = `Joining room ${joinCode}…`;
  }
}

// Keyboard play: 1-4 pick a card, arrows cycle board targets, Enter moves,
// Escape cancels, F folds.
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
    const cancel = $('#btn-cancel') as HTMLButtonElement;
    if (!cancel.hidden) cancel.click();
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

// Offline/installable support (skipped during local development).
if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`)
    .catch(() => { /* offline support is best-effort */ });
}

// Exposed for end-to-end tests and console debugging.
(window as unknown as Record<string, unknown>).__wahoo = {
  app, trackPos, burrowPos, reservePos,
};

