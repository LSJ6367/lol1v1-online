'use strict';
/* 브라우저 e2e (Playwright, 로컬 Chromium). 실행: node test/p2p_e2e.js   (npm run test:e2e)
   - gas/game.html 을 이 프로세스의 HTTP 서버가 내려준다(build_gas 로 먼저 생성).
   - 페이지 스크립트 전에 가짜 google.script.run 을 넣는다. 호출은 /sig/<이름> 으로 가고,
     여기서 sig* 함수 6개(test/sig_mem.js, DESIGN_GAS.md §4 와 같은 상태 규칙)를 실행한다.
   - 방장 페이지(A): 방 만들기 → 코드 → 참가자 페이지(B): 코드로 참가 → WebRTC 연결 → 준비 → 시작
     → 두 사람 다 키 입력으로 이동 → B 닫기 → A 에 결과(승리) 표시 확인. B 의 핑을 출력한다.
   - 페이지 오류(pageerror)가 있으면 실패. */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');
const { build } = require('../tools/build_gas.js');
const { makeSigMem } = require('./sig_mem.js');

const GAME_HTML = build();                       // 최신 gas/game.html
const SIG_FUNCS = ['sigCreate', 'sigJoin', 'sigHostPoll', 'sigAnswer', 'sigGuestPoll', 'sigClose'];
const SIG_LAG_MS = 120;                          // Apps Script 호출처럼 조금 늦게 응답
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 페이지 스크립트보다 먼저 실행되는 google.script.run 흉내. withSuccessHandler/withFailureHandler 체인 지원 */
const GAS_STUB = `(function () {
  var names = ${JSON.stringify(SIG_FUNCS)};
  function runner(ok, fail) {
    var r = {
      withSuccessHandler: function (f) { return runner(f, fail); },
      withFailureHandler: function (f) { return runner(ok, f); }
    };
    names.forEach(function (n) {
      r[n] = function () {
        var args = Array.prototype.slice.call(arguments);
        fetch('/sig/' + n, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
          .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
          .then(function (x) {
            if (!x.ok) { if (fail) fail(new Error(x.body.error || 'server')); return; }
            if (ok) ok(x.body);
          }, function (err) { if (fail) fail(err); });
      };
    });
    return r;
  }
  window.google = { script: { run: runner(null, null) } };
})();`;

/* 테스트용 Apps Script 서버: 페이지 + sig* 엔드포인트 */
function startServer(sig) {
  const html = fs.readFileSync(GAME_HTML);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.method === 'POST' && url.pathname.startsWith('/sig/')) {
      const name = url.pathname.slice('/sig/'.length);
      if (!SIG_FUNCS.includes(name)) return json(404, { error: 'no such function' });
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let args = [];
        try { args = JSON.parse(body || '[]'); } catch (e) { return json(400, { error: 'bad json' }); }
        setTimeout(() => {
          try { json(200, sig[name](...args)); }
          catch (e) { json(500, { error: String(e && e.message) }); }
        }, SIG_LAG_MS);
      });
      return;
    }
    res.writeHead(404); res.end('Not Found');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function newPage(browser, base, label) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 480 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    // 구글 폰트 차단으로 생기는 리소스 실패는 노이즈로 보고, 나머지 콘솔 오류는 그대로 기록
    if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED/.test(m.text())) errors.push('console: ' + m.text());
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.addInitScript(GAS_STUB);
  await page.goto(base + '/', { waitUntil: 'commit' });
  await sleep(2000);
  return { label, ctx, page, errors };
}

const readState = page => page.evaluate(() => {
  const s = Game.session;
  if (!s) return null;
  return {
    myId: s.myId,
    online: s.online,
    ping: s.ping,
    champs: s.world.champs.map(c => ({ id: c.id, x: Math.round(c.x), y: Math.round(c.y), team: c.team, key: c.key })),
  };
});

const check = (results, name, ok, extra) => {
  results.push(ok);
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra !== undefined ? '  → ' + extra : ''));
};

async function main() {
  const sig = makeSigMem();
  const server = await startServer(sig);
  const base = 'http://127.0.0.1:' + server.address().port;
  const results = [];
  let browser = null, A = null, B = null;
  const t0 = Date.now();
  try {
    browser = await chromium.launch();
    console.log('chromium ' + browser.version() + ' · ' + base);
    A = await newPage(browser, base, 'A(방장)');
    B = await newPage(browser, base, 'B(참가자)');

    /* 1. 방장: 방 만들기 */
    await A.page.waitForSelector('#btnCreate:not([disabled])', { timeout: 10000 });
    const status = await A.page.textContent('#connStatus');
    check(results, '로비 상태 문구(구글 스크립트 모드)', status.includes('구글 스크립트 모드'), status);

    /* 0. 혼자 연습(오프라인)은 네트워크와 상관없이 된다 */
    await B.page.waitForSelector('#btnOffline:not([hidden])', { timeout: 5000 });
    await B.page.click('#btnOffline');
    await B.page.waitForSelector('#select:not([hidden])', { timeout: 5000 });
    await B.page.click('#btnBackLobby');
    await B.page.waitForSelector('#lobby:not([hidden])', { timeout: 5000 });
    check(results, '혼자 연습(오프라인) 화면 열고 로비로 돌아옴', true);
    await A.page.click('#btnCreate');
    await A.page.waitForSelector('#room:not([hidden])', { timeout: 10000 });
    const code = (await A.page.textContent('#roomCode')).trim();
    check(results, '방장: 방 만들기 → 4자리 코드', /^[A-Z2-9]{4}$/.test(code), code);

    /* 2. 참가자: 코드로 참가 → WebRTC 연결 → 대기실 */
    await B.page.waitForSelector('#btnJoin:not([disabled])', { timeout: 10000 });
    const joinT0 = Date.now();
    await B.page.fill('#codeIn', code.toLowerCase());
    await B.page.click('#btnJoin');
    await B.page.waitForSelector('#room:not([hidden])', { timeout: 25000 });
    await A.page.waitForFunction(() => document.querySelectorAll('#players li').length === 2, null, { timeout: 10000 });
    check(results, '참가자: 코드로 참가 → 직접 연결(DataChannel) 후 대기실', true, (Date.now() - joinT0) + ' ms');
    check(results, '두 화면 모두 두 명 표시', (await B.page.locator('#players li').count()) === 2);

    /* 3. 준비 → 카운트다운 → 시작 */
    await A.page.click('#btnReady');
    await B.page.click('#btnReady');
    await A.page.waitForFunction(() => window.Game && Game.session && Game.session.online, null, { timeout: 15000 });
    await B.page.waitForFunction(() => window.Game && Game.session && Game.session.online, null, { timeout: 15000 });
    const a0 = await readState(A.page), b0 = await readState(B.page);
    check(results, '게임 시작: 두 쪽 모두 챔피언 두 명을 봄', a0.champs.length === 2 && b0.champs.length === 2,
      a0.champs.map(c => c.id + '@' + c.x + ',' + c.y).join(' ') + ' | ' + b0.champs.map(c => c.id + '@' + c.x + ',' + c.y).join(' '));
    check(results, '내 id: 방장 p1, 참가자 p2', a0.myId === 'p1' && b0.myId === 'p2', a0.myId + ' / ' + b0.myId);

    /* 4. 둘 다 키로 이동 (A: 오른쪽, B: 왼쪽) 1.5초 */
    await A.page.bringToFront();
    await Promise.all([A.page.keyboard.down('KeyD'), B.page.keyboard.down('KeyA')]);
    await sleep(1500);
    await Promise.all([A.page.keyboard.up('KeyD'), B.page.keyboard.up('KeyA')]);
    await sleep(400);
    const a1 = await readState(A.page), b1 = await readState(B.page);
    const pos = (s, id) => s.champs.find(c => c.id === id);
    const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
    const aSelfMoved = dist(pos(a0, 'p1'), pos(a1, 'p1'));
    const bSelfMoved = dist(pos(b0, 'p2'), pos(b1, 'p2'));
    const aSeesB = dist(pos(a0, 'p2'), pos(a1, 'p2'));
    const bSeesA = dist(pos(b0, 'p1'), pos(b1, 'p1'));
    check(results, '방장: 내 챔피언이 움직임', aSelfMoved > 30, Math.round(aSelfMoved) + ' px');
    check(results, '참가자: 내 챔피언이 움직임', bSelfMoved > 30, Math.round(bSelfMoved) + ' px');
    check(results, '방장 화면에서 상대(참가자) 위치가 변함', aSeesB > 30, Math.round(aSeesB) + ' px');
    check(results, '참가자 화면에서 상대(방장) 위치가 변함', bSeesA > 30, Math.round(bSeesA) + ' px');

    /* 5. 참가자 핑 (DataChannel ping/pong, 2초마다) */
    await sleep(2500);
    const bPing = (await readState(B.page)).ping, aPing = (await readState(A.page)).ping;
    check(results, '참가자 핑 측정됨', typeof bPing === 'number' && bPing >= 0, bPing == null ? 'null' : bPing.toFixed(1) + ' ms');
    console.log('  ping: 참가자 ' + (bPing == null ? '-- ' : Math.round(bPing) + ' ms') + ' · 방장 ' + (aPing == null ? '-- ' : Math.round(aPing) + ' ms'));

    /* 6. 참가자가 창을 닫는다 → 방장 쪽에서 상대 연결 끊김으로 승리 */
    const closeT0 = Date.now();
    await B.ctx.close();
    B = null;
    await A.page.waitForSelector('#result:not([hidden])', { timeout: 60000 });
    const title = await A.page.textContent('#resTitle');
    const reason = await A.page.textContent('#resReason');
    check(results, '방장: 참가자 종료 → 결과 화면, 승리', title.trim() === '승리!' && reason.includes('연결이 끊겼'), title.trim() + ' / ' + reason.trim() + ' (' + Math.round((Date.now() - closeT0) / 1000) + ' s)');

    /* 7. 페이지 오류 없음 */
    const errs = A.errors.concat(B ? B.errors : []);
    check(results, '페이지 오류 없음', errs.length === 0, errs.length ? errs.join(' | ').slice(0, 300) : '');
  } catch (e) {
    check(results, '실행 중 오류: ' + String(e && e.message).split('\n')[0], false);
    if (A) console.log('  A errors: ' + JSON.stringify(A.errors).slice(0, 400));
    if (B) console.log('  B errors: ' + JSON.stringify(B.errors).slice(0, 400));
  } finally {
    try { if (A) await A.ctx.close(); } catch (e) { /* 닫는 중 오류는 무시 */ }
    try { if (B) await B.ctx.close(); } catch (e) { /* 무시 */ }
    try { if (browser) await browser.close(); } catch (e) { /* 무시 */ }
    await new Promise(r => server.close(() => r()));
    sig.rooms.clear();
  }
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass} passed, ${results.length - pass} failed  (${Math.round((Date.now() - t0) / 1000)} s)`);
  process.exit(results.every(Boolean) && results.length > 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
