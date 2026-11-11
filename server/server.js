'use strict';
/* =====================================================================
   server.js — HTTP(페이지 제공) + /ws(게임 연결) + 전역 틱 루프
   방·연결 규칙은 hub.js(Hub)가 맡는다. 여기서는 소켓을 Hub에 연결하고 루프에서 hub.update(dt)만 부른다.
   실행: node server/server.js   (PORT 환경변수, 기본 8080, 0.0.0.0)
   테스트: const { start } = require('./server/server.js'); const s = await start({port:0, host:'127.0.0.1'})
   ===================================================================== */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Core = require('../shared/core.js');
const ws = require('./ws.js');
const { Hub } = require('./hub.js');

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'public', 'index.html');
const MISSING_PAGE = '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>빌드 필요</title><body style="font-family:sans-serif;padding:24px">먼저 node tools/build.js 를 실행하세요.</body></html>';

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

  const hub = new Hub({ countdownSec: opts.countdownSec });
  let stopped = false;

  function onConnection(conn) {
    const sess = hub.connect(conn);
    conn.on('message', text => {
      try { hub.message(sess, text); }
      catch (e) { console.error('[server] 메시지 처리 오류', e && e.stack); }
    });
    conn.on('close', () => {
      if (stopped) return;
      try { hub.disconnect(sess); }
      catch (e) { console.error('[server] 연결 종료 처리 오류', e && e.stack); }
    });
  }

  const httpServer = http.createServer((req, res) => {
    try { onRequest(req, res); }
    catch (e) { console.error('[server] 요청 오류', e && e.stack); if (!res.headersSent) sendJson(res, 500, 'text/plain; charset=utf-8', 'Error'); }
  });
  ws.attach(httpServer, { path: '/ws', onConnection });

  /* 전역 게임 루프: 실제 경과 시간을 hub.update에 넘기고, 다음 틱 시각에 맞춰 깨어난다 */
  let last = process.hrtime.bigint();
  let loop = null;
  const run = () => {
    if (stopped) return;
    const now = process.hrtime.bigint();
    const dt = Number(now - last) / 1e9;
    last = now;
    loop = setTimeout(run, hub.update(dt));   // 약한 CPU에서도 가볍게. 최소 1ms
  };
  loop = setTimeout(run, 1);

  function close() {
    if (stopped) return Promise.resolve();
    stopped = true;
    clearTimeout(loop);
    for (const c of hub.close()) c.terminate();
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
