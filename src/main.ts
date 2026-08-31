import './style.css';
import { $ } from './ui/dom.ts';
import { App } from './ui/app.ts';
import type { NetSession } from './ui/app.ts';
import type { RoomInfo } from './net/protocol.ts';
import { PLAYER_COLORS_CSS, trackPos, burrowPos, reservePos } from './ui/board.ts';
import { emptySelection } from './ui/selection.ts';
import { LocalSession, savedLocalGame } from './sessions/local.ts';
import type { SeatKind } from './sessions/local.ts';
import { OnlineSession } from './net/client.ts';
import { HttpSession } from './net/http.ts';
import type { OnlineHandlers } from './net/client.ts';
import { P2PGuestSession, P2PHostSession, savedHostGame } from './net/p2p.ts';
import type { Difficulty } from './engine/types.ts';
import { PLAYER_NAMES } from './engine/types.ts';
import { isMuted, setMuted } from './sounds.ts';

// ---------------------------------------------------------------------------
// Menu wiring
// ---------------------------------------------------------------------------

const app = new App();

function buildSeatConfig() {
  const wrap = $('#seat-config');
  wrap.innerHTML = '';
  const defaults: SeatKind[] = ['human', 'cpu-medium', 'cpu-medium', 'cpu-medium'];
  const kinds: [SeatKind, string][] = [
    ['human', 'Human'],
    ['cpu-easy', 'CPU · Easy'],
    ['cpu-medium', 'CPU · Medium'],
    ['cpu-hard', 'CPU · Hard'],
    ['cpu-insane', 'CPU · Insane'],
  ];
  for (let i = 0; i < 4; i++) {
    const row = document.createElement('div');
    row.className = 'seat-row';
    row.innerHTML =
      `<span class="seat-dot" style="background:${PLAYER_COLORS_CSS[i]}"></span>` +
      `<span style="width:64px">${PLAYER_NAMES[i]}</span>` +
      `<select data-seat="${i}">` +
      kinds
        .map(([v, label]) => `<option value="${v}"${defaults[i] === v ? ' selected' : ''}>${label}</option>`)
        .join('') +
      `</select>` +
      `<span style="opacity:.6;font-size:.8rem">Team ${i % 2 === 0 ? 'Red/Green' : 'Blue/Yellow'}</span>`;
    wrap.appendChild(row);
  }
}
buildSeatConfig();

$('#start-local').onclick = async () => {
  const seats = Array.from(document.querySelectorAll<HTMLSelectElement>('#seat-config select'))
    .map(sel => sel.value as SeatKind);
  app.startLocalMeta(seats.filter(s => s === 'human').length);
  await app.showGame();
  const session = new LocalSession(
    seats,
    view => app.onView(view),
    (window as unknown as Record<string, number>).__wahooCpuDelay,
  );
  app.session = session;
  app.online = false;
  session.start();
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

function netHandlers(getSession: () => NetSession): OnlineHandlers {
  return {
    onView: async view => {
      const session = getSession();
      if (app.session !== session) {
        app.session = session;
        app.online = true;
        await app.showGame();
      }
      app.onView(view);
    },
    onRoom: room => {
      setNetPending(null);
      app.roomInfo = room;
      renderLobby(getSession(), room);
    },
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
  if (saved) btn.textContent = `▶ Resume hosted game ${saved.code}`;
  const local = savedLocalGame();
  const localBtn = $('#local-resume') as HTMLButtonElement;
  localBtn.hidden = !local;
  if (local) localBtn.textContent = `▶ Resume game (round ${local.state.round})`;
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
  );
  app.session = session;
  app.online = false;
  session.start();
};
app.onMenuShown = refreshResumeButton;
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
    `<p>Room code: <span class="code">${room.code}</span> — share it with friends.</p>`;
  if (room.youAreHost && !room.started) {
    const diffRow = document.createElement('label');
    diffRow.className = 'hint';
    diffRow.innerHTML =
      'CPU difficulty for added seats <select id="lobby-diff">' +
      '<option value="easy">Easy</option>' +
      '<option value="medium" selected>Medium</option>' +
      '<option value="hard">Hard</option>' +
      '<option value="insane">Insane</option></select>';
    lobby.appendChild(diffRow);
  }
  {
    const dedicated = session instanceof OnlineSession || session instanceof HttpSession;
    const serverParam =
      dedicated && activeDedicatedServer
        ? `&server=${encodeURIComponent(activeDedicatedServer)}`
        : '';
    const url = `${location.origin}${location.pathname}?join=${room.code}${serverParam}`;
    const invite = document.createElement('p');
    invite.className = 'hint invite';
    invite.textContent = 'Invite link: ';
    const codeEl = document.createElement('code');
    codeEl.textContent = url;
    invite.appendChild(codeEl);
    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    copy.style.marginLeft = '6px';
    copy.onclick = () => {
      navigator.clipboard?.writeText(url);
      copy.textContent = 'Copied!';
    };
    invite.appendChild(copy);
    lobby.appendChild(invite);
  }
  room.seats.forEach((seat, i) => {
    const row = document.createElement('div');
    row.className = 'seat-row';
    let controls = '';
    if (seat === null) {
      controls = `<button data-sit="${i}">Sit here</button>`;
      if (room.youAreHost) controls += ` <button data-cpu="${i}">Add CPU</button>`;
    } else if (seat.cpu && room.youAreHost) {
      controls = `<button data-uncpu="${i}">Remove CPU</button>`;
    }
    const seatLabel = seat
      ? seat.cpu
        ? `🤖 CPU (${seat.difficulty ?? 'medium'})`
        : seat.name
      : '—';
    row.innerHTML =
      `<span class="seat-dot" style="background:${PLAYER_COLORS_CSS[i]}"></span>` +
      `<span style="width:64px">${PLAYER_NAMES[i]}</span>` +
      `<span style="flex:1">${seatLabel}${
        room.yourSeat === i ? ' (you)' : ''
      }</span>${controls}`;
    lobby.appendChild(row);
  });
  if (room.youAreHost) {
    const start = document.createElement('button');
    start.className = 'primary';
    start.textContent = 'Start Game (empty seats become CPUs)';
    start.onclick = () => session.startGame();
    lobby.appendChild(start);
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
  $('#btn-mute').textContent = isMuted() ? '🔇 Muted' : '🔊 Sound';
}
refreshMuteButton();
$('#btn-mute').onclick = () => {
  setMuted(!isMuted());
  refreshMuteButton();
};

$('#victory-menu').onclick = () => ($('#btn-menu') as HTMLButtonElement).click();

$('#btn-rules').onclick = () => {
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
  if (joinCode && server && /^(https?|wss?):\/\//i.test(server)) {
    ($('#online-server') as HTMLInputElement).value = server;
    ($('#online-code') as HTMLInputElement).value = joinCode;
    setTimeout(() => connectOnline(s => s.join(joinCode, playerName(), clientToken())), 50);
  } else if (joinCode) {
    ($('#p2p-code') as HTMLInputElement).value = joinCode;
    setTimeout(() => joinP2P(joinCode), 50);
  }
}

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

