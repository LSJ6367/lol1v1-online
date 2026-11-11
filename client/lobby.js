(() => {
'use strict';
/* =====================================================================
   lobby.js — 로비 · 대기실 · 결과 화면 흐름
   Net(연결) ↔ lobby(화면 전환) ↔ Game(client.js 화면·입력) / OnlineSession·LocalSession(진행)
   화면: lobby → room(대기실, 챔피언 선택·준비) → game(Game) → result(결과 오버레이, 같은 화면 위)
         offline: lobby → select(챔피언 선택, #goBtn) → game
   ===================================================================== */
const $ = s => document.querySelector(s);
const NICK_KEY = 'onev1.nick';
const TEAM_NAME = ['팀 파랑', '팀 빨강'];
const REASON_TEXT = {
  win: { kill: '상대를 처치했어요', turret: '상대 포탑을 파괴했어요', disconnect: '상대 연결이 끊겼어요' },
  lose: { kill: '처치당했어요', turret: '포탑이 파괴됐어요', disconnect: '연결이 끊겼어요' },
};
const ERR_TEXT = {
  room_not_found: '방을 찾을 수 없어요', room_full: '방이 가득 찼어요', bad_state: '이미 게임 중인 방이에요',
  bad_version: '클라이언트 버전이 맞지 않아요', bad_msg: '잘못된 요청이에요',
};
const CHAMP = id => (id && Core.CHAMPS[id]) ? Core.CHAMPS[id].name : '챔피언 미선택';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const scr = { lobby: $('#lobby'), room: $('#room'), select: $('#select') };
let connected = false;
let room = null;        // 마지막 room 메시지
let session = null;     // 진행 중인 OnlineSession
let connectedNick = null; // 서버에 알려준 닉네임

/* 'lobby' | 'room' | 'select' | 'game'(숨김 전체: Game 화면이 보임) */
function showScreen(name) {
  scr.lobby.hidden = name !== 'lobby';
  scr.room.hidden = name !== 'room';
  scr.select.hidden = name !== 'select';
}

let toastT = 0;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------- 닉네임 (localStorage는 실패할 수 있으므로 try/catch) ---------- */
function loadNick() { try { return localStorage.getItem(NICK_KEY) || ''; } catch (e) { return ''; } }
function saveNick(v) { try { localStorage.setItem(NICK_KEY, v); } catch (e) { /* 저장 불가 환경: 무시 */ } }
const nickVal = () => $('#nick').value.trim() || '소환사';

/* ---------- 연결 ---------- */
function setConn(state) {   // 'connecting' | 'ok' | 'off'
  const el = $('#connStatus');
  el.textContent = state === 'ok' ? '연결됨' : state === 'connecting' ? '서버 연결 중…' : '서버에 연결할 수 없음 — 오프라인 연습만 가능';
  el.className = 'sub' + (state === 'ok' ? ' ok' : state === 'off' ? ' bad' : '');
  for (const id of ['#btnCreate', '#btnTest', '#btnJoin']) $(id).disabled = state !== 'ok';
}
async function connect() {
  setConn('connecting');
  const nick = nickVal();
  try { await Net.connect(nick); connected = true; connectedNick = nick; setConn('ok'); }
  catch (e) { connected = false; setConn('off'); }
}
async function reconnect() {   // 닉네임은 연결 시 한 번 보내므로, 바꾸면 다시 연결
  if (connected) { connected = false; Net.close(); }
  await connect();
}
/* 방 만들기/참가 직전: 닉네임이 바뀌었으면 먼저 다시 연결하고 나서 보냄 */
let busy = false;
async function sendLobby(msg) {
  if (busy) return; busy = true;
  try {
    saveNick(nickVal());
    if (!connected || nickVal() !== connectedNick) await reconnect();
    if (connected) Net.send(msg); else toast('서버에 연결할 수 없어요');
  } finally { busy = false; }
}

/* ---------- 게임/방 정리 ---------- */
function leaveSession() {
  if (session) { session.destroy(); session = null; }
  Game.stop();
  $('#result').hidden = true;
}
function leaveRoom() {   // 방 나가기 → 로비
  Net.send({ t: 'leave' });
  leaveSession(); room = null;
  showScreen('lobby');
}

/* ---------- 대기실 ---------- */
const myPlayer = () => (room && room.players) ? room.players.find(p => p.pid === Net.pid) || null : null;
const roomCards = $('#roomCards');
roomCards.innerHTML = $('#cards').innerHTML;   // 챔피언 카드는 client.js 것과 같은 모양

function renderRoom() {
  if (!room) return;
  const me = myPlayer(), ready = !!(me && me.ready);
  $('#roomMode').textContent = room.test ? '테스트 방 · 허수아비 + 테스트 도구' : '1대1 대전';
  $('#roomCode').textContent = room.code;
  $('#players').innerHTML = (room.players || []).map(p => `<li>
      <span class="team t${p.team}">${TEAM_NAME[p.team] || ''}</span>
      <span class="nm">${esc(p.name)}${p.pid === Net.pid ? ' <span class="me">(나)</span>' : ''}</span>
      <span class="ch">${CHAMP(p.champ)}</span>
      <span class="rdy${p.ready ? ' on' : ''}">${p.ready ? '준비 완료' : '대기 중'}</span>
    </li>`).join('');
  roomCards.querySelectorAll('.card').forEach(c => {
    c.setAttribute('aria-pressed', String(!!me && c.dataset.key === me.champ));
    c.disabled = ready;   // 준비 상태에서는 챔피언 변경 불가
  });
  $('#btnReady').textContent = ready ? '준비 취소' : '준비';
  $('#btnReady').disabled = !me;
  const cd = $('#countdown');
  if (room.state === 'countdown') {
    const n = String(room.countdown);
    cd.innerHTML = ['3', '2', '1'].map(d => `<span class="${d === n ? 'on' : ''}">${d}</span>`).join('…');
    cd.hidden = false;
  } else {
    cd.hidden = true;
  }
}

roomCards.addEventListener('click', e => {
  const b = e.target.closest('.card');
  const me = myPlayer();
  if (!b || b.disabled || !me || me.ready) return;
  Net.send({ t: 'pick', champ: b.dataset.key });
});
$('#btnReady').addEventListener('click', () => {
  const me = myPlayer(); if (me) Net.send({ t: 'ready', on: !me.ready });
});
$('#btnLeave').addEventListener('click', leaveRoom);

/* ---------- 로비 버튼 ---------- */
function join() {
  const code = $('#codeIn').value.trim().toUpperCase();
  if (code.length !== 4) { toast('방 코드 4자리를 입력해 주세요'); return; }
  sendLobby({ t: 'join', code });
}
$('#btnCreate').addEventListener('click', () => sendLobby({ t: 'create', test: false }));
$('#btnTest').addEventListener('click', () => sendLobby({ t: 'create', test: true }));
$('#btnJoin').addEventListener('click', join);
$('#codeIn').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('#codeIn').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
$('#nick').addEventListener('change', e => { saveNick(e.target.value.trim()); });

/* ---------- 오프라인 ---------- */
$('#btnOffline').addEventListener('click', () => { showScreen('select'); });
$('#btnBackLobby').addEventListener('click', () => { Game.stop(); showScreen('lobby'); });
$('#goBtn').addEventListener('click', () => {
  const local = new LocalSession([{ id: 'p1', key: Game.selected(), team: 0 }], 'p1');
  showScreen('game');
  Game.start(local, { onExit: () => { Game.stop(); showScreen('select'); } });
});

/* ---------- 결과 ---------- */
function showResult(m) {
  const win = m.winner === (myPlayer() ? myPlayer().team : 0);
  const title = $('#resTitle');
  title.textContent = win ? '승리!' : '패배';
  title.className = 'resTitle' + (win ? '' : ' lose');
  $('#resReason').textContent = REASON_TEXT[win ? 'win' : 'lose'][m.reason] || '경기 종료';
  const k = m.kills || {};
  $('#resKills').innerHTML = [0, 1].map(t => `<span>${TEAM_NAME[t]} 처치 <b>${k[t] || 0}</b></span>`).join('');
  $('#result').hidden = false;
}
$('#btnAgain').addEventListener('click', () => {   // 같은 방 대기실로 (서버가 방을 select 상태로 돌려줌)
  leaveSession();
  if (room) { showScreen('room'); renderRoom(); } else showScreen('lobby');
});
$('#btnOut').addEventListener('click', leaveRoom);

/* ---------- 서버 메시지 ---------- */
Net.on('room', m => {
  room = m;
  if (session) return;          // 게임·결과 화면 중에는 화면을 바꾸지 않음(값만 갱신)
  showScreen('room'); renderRoom();
});
Net.on('start', m => {
  leaveSession();
  session = new OnlineSession(Net, m, { predict: true, test: !!(room && room.test), now: () => performance.now() });
  showScreen('game');
  Game.start(session, { onExit: leaveRoom });
});
Net.on('end', m => {
  if (!session) return;
  Game.pause(true);
  showResult(m);
});
Net.on('error', m => toast(ERR_TEXT[m.code] || m.msg || '오류가 났어요'));
Net.onClose(() => {
  if (!connected) return;       // 연결 시도 중 실패 등은 setConn으로 이미 처리
  connected = false; setConn('off');
  toast('서버 연결이 끊겼어요');
  leaveSession(); room = null;
  showScreen('lobby');
});

/* ---------- 시작 ---------- */
$('#nick').value = loadNick();
showScreen('lobby');
connect();

// 화면 점검용(스크린샷): 가짜 방 데이터로 대기실 / 결과 오버레이를 그린다
window.__lobbyDebug = {
  room(data) { room = data; leaveSession(); showScreen('room'); renderRoom(); },
  result(m) { leaveSession(); showScreen('game'); showResult(m); },
};
})();
