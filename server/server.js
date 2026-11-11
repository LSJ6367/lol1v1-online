'use strict';
/* =====================================================================
   server.js — HTTP(페이지 제공) + /ws(게임 연결) + 방 관리 + 전역 틱 루프
   실행: node server/server.js   (PORT 환경변수, 기본 8080, 0.0.0.0)
   테스트: const { start } = require('./server/server.js'); const s = await start({port:0, host:'127.0.0.1'})
   ===================================================================== */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Core = require('../shared/core.js');
const P = require('../shared/protocol.js');
const ws = require('./ws.js');
const { Room } = require('./room.js');

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'public', 'index.html');
const MISSING_PAGE = '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>빌드 필요</title><body style="font-family:sans-serif;padding:24px">먼저 node tools/build.js 를 실행하세요.</body></html>';
const ERR_MSG = {
  bad_version: '버전이 맞지 않습니다. 페이지를 새로고침하세요.',
  room_not_found: '방을 찾을 수 없습니다.',
  room_full: '방이 가득 찼습니다.',
  bad_state: '지금은 할 수 없는 동작입니다.',
  bad_msg: '잘못된 메시지입니다.'
};
const MAX_CATCHUP = 5;

let mapLoaded = false;
function ensureMap() {
  if (mapLoaded) return;
  Core.setMap(JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'walk_rle.json'), 'utf8')));
  mapLoaded = true;
}

function runBuild() {
  try {
    const b = require('../tools/build.js');
    if (!b || typeof b.build !== 'function') { console.warn('[server] tools/build.js 에 build() 가 없습니다. 건너뜁니다.'); return; }
    const r = b.build();
    if (r && typeof r.then === 'function') r.then(() => {}, e => console.warn('[server] 빌드 실패: ' + (e && e.message)));
  } catch (e) {
    const why = e && e.code === 'MODULE_NOT_FOUND' ? '파일이 없습니다' : String(e && e.message).split('\n')[0];
    console.warn('[server] 빌드 건너뜀(tools/build.js: ' + why + ')');
  }
}

function sendJson(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
}

function onRequest(req, res) {
  let pathname = '';
  try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch (e) { /* 잘못된 URL → 404 */ }
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    fs.readFile(PAGE, (err, buf) => {
      if (err) return sendJson(res, 200, 'text/html; charset=utf-8', MISSING_PAGE);
      sendJson(res, 200, 'text/html; charset=utf-8', buf);
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/healthz') return sendJson(res, 200, 'text/plain; charset=utf-8', 'ok');
  sendJson(res, 404, 'text/plain; charset=utf-8', 'Not Found');
}

function start(opts) {
  opts = opts || {};
  ensureMap();
  if (opts.build !== false) runBuild();

  const rooms = new Map();          // code → Room
  const sessions = new Set();       // 연결된 세션 {conn, pid, name, room}
  let pidSeq = 0;
  let stopped = false;

  function reply(sess, code) {
    sess.conn.send(P.encode({ t: 'error', code, msg: ERR_MSG[code] || ERR_MSG.bad_msg }));
  }

  function leaveRoom(sess) {
    const room = sess.room;
    if (!room) return;
    sess.room = null;
    room.removePlayer(sess.pid);
    if (room.isEmpty()) rooms.delete(room.code);
  }

  function onCreate(sess, m) {
    if (sess.room) return reply(sess, 'bad_state');
    let code = null;
    for (let i = 0; i < 200 && !code; i++) {
      const c = P.makeRoomCode();
      if (!rooms.has(c)) code = c;
    }
    if (!code) return reply(sess, 'bad_state');
    const room = new Room({ code, test: m.test === true, countdownSec: opts.countdownSec });
    rooms.set(code, room);
    room.addPlayer({ pid: sess.pid, name: sess.name, conn: sess.conn });
    sess.room = room;
    room.broadcastRoom();
  }

  function onJoin(sess, m) {
    if (sess.room) return reply(sess, 'bad_state');
    const code = typeof m.code === 'string' ? m.code.trim().toUpperCase() : '';
    const room = rooms.get(code);
    if (!room) return reply(sess, 'room_not_found');
    const err = room.addPlayer({ pid: sess.pid, name: sess.name, conn: sess.conn });
    if (err) return reply(sess, err);
    sess.room = room;
    room.broadcastRoom();
  }

  function onMessage(sess, text) {
    const m = P.decode(text);
    if (!m) return reply(sess, 'bad_msg');

    if (!sess.pid) {   // 첫 메시지는 반드시 hello
      if (m.t !== 'hello') { reply(sess, 'bad_msg'); return sess.conn.close(1008, 'hello first'); }
      if (m.v !== P.VERSION) {
        sess.conn.send(P.encode({ t: 'error', code: 'bad_version', msg: ERR_MSG.bad_version }));
        return sess.conn.close(1008, 'bad_version');
      }
      pidSeq++;
      sess.pid = 'p' + pidSeq;
      sess.name = P.normName(m.name, '플레이어' + pidSeq);
      sess.conn.send(P.encode({ t: 'welcome', v: P.VERSION, pid: sess.pid }));
      return;
    }

    switch (m.t) {
      case 'create': return onCreate(sess, m);
      case 'join': return onJoin(sess, m);
      case 'leave': return leaveRoom(sess);
      case 'pick': {
        if (!sess.room) return reply(sess, 'bad_state');
        const err = sess.room.pick(sess.pid, m.champ);
        if (err) reply(sess, err);
        return;
      }
      case 'ready': {
        if (typeof m.on !== 'boolean') return reply(sess, 'bad_msg');
        if (!sess.room) return reply(sess, 'bad_state');
        const err = sess.room.setReady(sess.pid, m.on);
        if (err) reply(sess, err);
        return;
      }
      case 'f': {
        if (sess.room) sess.room.onFrame(sess.pid, m);   // 게임 중이 아니면 조용히 무시
        return;
      }
      case 'ping': return sess.conn.send(P.encode({ t: 'pong', c: m.c }));
      default: return reply(sess, 'bad_msg');
    }
  }

  function onConnection(conn) {
    const sess = { conn, pid: null, name: null, room: null };
    sessions.add(sess);
    conn.on('message', text => {
      try { onMessage(sess, text); }
      catch (e) { console.error('[server] 메시지 처리 오류', e && e.stack); }
    });
    conn.on('close', () => {
      sessions.delete(sess);
      if (stopped) return;
      try { leaveRoom(sess); }
      catch (e) { console.error('[server] 연결 종료 처리 오류', e && e.stack); }
    });
  }

  const httpServer = http.createServer((req, res) => {
    try { onRequest(req, res); }
    catch (e) { console.error('[server] 요청 오류', e && e.stack); if (!res.headersSent) sendJson(res, 500, 'text/plain; charset=utf-8', 'Error'); }
  });
  ws.attach(httpServer, { path: '/ws', onConnection });

  /* 전역 게임 루프: 실제 경과 시간을 모아 1/60초 틱을 돌리고, 카운트다운을 진행 */
  const STEP = 1 / P.TICK_HZ;
  let last = process.hrtime.bigint(), acc = 0;
  const loop = setInterval(() => {
    const now = process.hrtime.bigint();
    const dt = Number(now - last) / 1e9;
    last = now;
    acc += dt;
    let n = 0;
    while (acc >= STEP && n < MAX_CATCHUP) { acc -= STEP; n++; }
    if (acc >= STEP) acc = 0;                 // 너무 밀리면 따라잡기를 포기하고 시간을 버림
    for (const room of Array.from(rooms.values())) room.update(dt);
    for (const room of Array.from(rooms.values())) for (let i = 0; i < n; i++) room.tick();
  }, 4);

  function close() {
    if (stopped) return Promise.resolve();
    stopped = true;
    clearInterval(loop);
    rooms.clear();
    for (const s of Array.from(sessions)) s.conn.terminate();
    sessions.clear();
    return new Promise(resolve => {
      httpServer.close(() => resolve());
      if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections();
    });
  }

  return new Promise((resolve, reject) => {
    const onErr = e => { clearInterval(loop); reject(e); };
    httpServer.once('error', onErr);
    httpServer.listen(opts.port ?? 8080, opts.host ?? '0.0.0.0', () => {
      httpServer.removeListener('error', onErr);
      resolve({ port: httpServer.address().port, close });
    });
  });
}

function lanUrls(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const e of list || []) {
      if ((e.family === 'IPv4' || e.family === 4) && !e.internal) out.push('http://' + e.address + ':' + port);
    }
  }
  return out;
}

module.exports = { start };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  start({ port, host: '0.0.0.0' }).then(srv => {
    console.log('1v1 서버 실행 중');
    console.log('  이 컴퓨터:  http://localhost:' + srv.port);
    for (const u of lanUrls(srv.port)) console.log('  같은 네트워크: ' + u);
    const stop = () => srv.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }, e => {
    console.error('서버를 시작하지 못했습니다: ' + (e && e.message));
    process.exit(1);
  });
}
