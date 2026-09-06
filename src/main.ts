import '@fontsource/fredoka/500.css';
import '@fontsource/fredoka/600.css';
import '@fontsource/nunito-sans/400.css';
import '@fontsource/nunito-sans/400-italic.css';
import '@fontsource/nunito-sans/600.css';
import '@fontsource/nunito-sans/700.css';
import './style.css';
import { $, esc } from './ui/dom.ts';
import { buildSeatConfig, readSeatKinds, readSeatNames } from './ui/seat-config.ts';
import {
  describeRules, initHouseRules, readRules, renderModalHouseRules, savedRules,
} from './ui/rules-controls.ts';
import { installKeyboard } from './ui/keyboard.ts';
import { confirmDialog, notice } from './ui/dialog.ts';
import { App } from './ui/app.ts';
import type { NetSession } from './ui/app.ts';
import type { RoomInfo } from './net/protocol.ts';
import { trackPos, burrowPos, reservePos } from './ui/board.ts';
import { LocalSession, savedLocalGame } from './sessions/local.ts';
import type { SeatKind } from './sessions/local.ts';
import { OnlineSession } from './net/client.ts';
import { HttpSession } from './net/http.ts';
import type { OnlineHandlers } from './net/client.ts';
import { P2PGuestSession, P2PHostSession, savedHostGame } from './net/p2p.ts';
import type { Difficulty } from './engine/types.ts';
import { EMOTES } from './net/protocol.ts';
import { EMOTE_LABELS, emoteHtml } from './ui/emotes.ts';
import { PLAYER_COLORS_CSS } from './ui/palette.ts';
import { PLAYER_NAMES } from './engine/types.ts';
import { isMuted, setMuted } from './sounds.ts';
import { maybeStartTour } from './ui/tour.ts';

// ---------------------------------------------------------------------------
// Menu wiring
// ---------------------------------------------------------------------------

const app = new App();

buildSeatConfig();

// House rules card: persist every change and, when hosting a lobby,
// publish it so guests see the rules live.
initHouseRules(rules => {
  const session = pendingOnline ?? app.session;
  if (app.roomInfo?.youAreHost && !app.roomInfo.started && session && 'setRules' in session) {
    session.setRules(rules);
  }
});

$('#start-local').onclick = async () => {
  const seats = readSeatKinds();
  app.startLocalMeta(seats.filter(s => s === 'human').length);
  await app.showGame();
  const session = new LocalSession(
    seats,
    view => app.onView(view),
    window.__wahooCpuDelay,
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
      void notice(msg);
    },
    onClose: () => {
      void (async () => {
        if (lastGuestCode && (await confirmDialog('Disconnected from the game. Try to rejoin?', 'Rejoin', 'Menu'))) {
          joinP2P(lastGuestCode);
          return;
        }
        await notice('Disconnected from the game.');
        app.showMenu();
      })();
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
  if (!code) return void notice('Enter a room code.');
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
    window.__wahooCpuDelay,
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
  if (!code) return void notice('Enter a room code.');
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
    row.innerHTML =
      `<span class="seat-bunny" aria-hidden="true">${emoteHtml('plain', PLAYER_COLORS_CSS[i])}</span>` +
      `${name}${status}${controls}`;
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
$('#btn-menu').onclick = () => {
  pendingOnline?.leave();
  pendingOnline = null;
  app.showMenu();
};

function refreshMuteButton() {
  $('#btn-mute').textContent = isMuted() ? 'Muted' : 'Sound';
}
refreshMuteButton();
$('#btn-mute').onclick = () => {
  setMuted(!isMuted());
  refreshMuteButton();
};

$('#victory-menu').onclick = () => ($('#btn-menu') as HTMLButtonElement).click();

$('#btn-rules').onclick = () => {
  // The modal shows the rules THIS game is using (guests see the host's).
  renderModalHouseRules(app.view?.rules ?? savedRules());
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
      if (app.myEmoteBusy()) return; // one reaction per player at a time
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

installKeyboard(app);

// Offline/installable support (skipped during local development).
if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`)
    .catch(() => { /* offline support is best-effort */ });
}

// Exposed for end-to-end tests and console debugging.
window.__wahoo = { app, trackPos, burrowPos, reservePos };

