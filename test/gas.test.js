'use strict';
/* gas/Code.gs 테스트 (Apps Script 에뮬레이터 사용). 실행: node test/gas.test.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { load } = require('./gas_emulator.js');
const Protocol = require('../shared/protocol.js');

const VIEWPORT = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
const GAME_URL = 'https://raw.githubusercontent.com/LSJ6367/lol1v1-online/main/gas/game.html';
const CHARSET_RE = new RegExp('^[' + Protocol.ROOM_CODE_CHARS + ']{' + Protocol.ROOM_CODE_LEN + '}$');
const CODE_SRC = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8');

const okPage = html => () => ({ code: 200, body: html });

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok   ' + name);
  } catch (err) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n     ') : err));
  }
}

/* ── 정적 검사: Apps Script(V8)에서 쓸 수 없는 것이 없는지, 실제 서비스 메서드 이름이 맞는지 ── */
test('정적: require/import/export/async 없음, 쓰는 서비스 메서드는 공식 이름뿐', () => {
  assert.ok(!/\brequire\s*\(/.test(CODE_SRC), 'require 사용');
  assert.ok(!/^\s*(import|export)\s/m.test(CODE_SRC), 'ES module 문법');
  assert.ok(!/\basync\b/.test(CODE_SRC), 'async 사용');
  const allowed = {
    CacheService: ['getScriptCache'],
    LockService: ['getScriptLock'],
    UrlFetchApp: ['fetch'],
    HtmlService: ['createHtmlOutput', 'XFrameOptionsMode'],
  };
  const re = /\b(CacheService|LockService|UrlFetchApp|HtmlService)\.(\w+)/g;
  let m;
  while ((m = re.exec(CODE_SRC))) {
    assert.ok(allowed[m[1]].includes(m[2]), '없는 API: ' + m[1] + '.' + m[2]);
  }
});

/* ── 에뮬레이터 자체 검사: 여기서 틀리면 아래 결과를 믿을 수 없음 ── */
test('에뮬레이터: 캐시 값 한도는 UTF-8 바이트 기준 100KB', () => {
  const { run } = load();
  const cache = run('CacheService').getScriptCache();
  cache.put('ok', 'x'.repeat(102400), 600);
  assert.throws(() => cache.put('big', 'x'.repeat(102401), 600), /too large/);
  // 한글 34,134자 = 102,402바이트: 글자 수는 한도 안이지만 바이트로는 넘음
  assert.throws(() => cache.put('kr', '가'.repeat(34134), 600), /too large/);
  cache.put('kr2', '가'.repeat(34133), 600);   // 102,399바이트: 통과
});

test('에뮬레이터: 캐시 TTL 만료와 잠금 기본 동작', () => {
  const { run, clock, fakes } = load();
  const cache = run('CacheService').getScriptCache();
  cache.put('k', 'v', 10);
  clock.advance(9);
  assert.strictEqual(cache.get('k'), 'v');
  clock.advance(1);
  assert.strictEqual(cache.get('k'), null);
  const lock = run('LockService').getScriptLock();
  lock.waitLock(5000);
  assert.strictEqual(fakes.LockService.isHeld(), true);
  assert.throws(() => lock.waitLock(5000), /Timed out/);
  lock.releaseLock();
  assert.strictEqual(fakes.LockService.isHeld(), false);
});

/* ── 신호 교환 (DESIGN_GAS.md §4) ── */
test('신호 흐름: create → join → hostPoll → answer → guestPoll → close', () => {
  const { gas } = load();
  const { code } = gas.sigCreate();
  assert.match(code, CHARSET_RE);
  assert.deepStrictEqual(gas.sigHostPoll(code), { offer: null });
  assert.deepStrictEqual(gas.sigGuestPoll(code), { answer: null });
  assert.deepStrictEqual(gas.sigJoin(code, 'OFFER-SDP'), { ok: true });
  assert.deepStrictEqual(gas.sigHostPoll(code), { offer: 'OFFER-SDP' });
  assert.deepStrictEqual(gas.sigGuestPoll(code), { answer: null });
  assert.deepStrictEqual(gas.sigAnswer(code, 'ANSWER-SDP'), { ok: true });
  assert.deepStrictEqual(gas.sigGuestPoll(code), { answer: 'ANSWER-SDP' });
  assert.deepStrictEqual(gas.sigClose(code), { ok: true });
  assert.deepStrictEqual(gas.sigHostPoll(code), { error: 'room_not_found' });
});

test('방 코드: 소문자와 앞뒤 공백도 같은 방으로 인식', () => {
  const { gas } = load();
  const { code } = gas.sigCreate();
  assert.deepStrictEqual(gas.sigJoin('  ' + code.toLowerCase() + ' ', 'O'), { ok: true });
  assert.deepStrictEqual(gas.sigHostPoll(code.toLowerCase()), { offer: 'O' });
});

test('두 번째 참가자는 room_full (offered 상태와 answered 상태 모두)', () => {
  const { gas } = load();
  const { code } = gas.sigCreate();
  assert.deepStrictEqual(gas.sigJoin(code, 'O1'), { ok: true });
  assert.deepStrictEqual(gas.sigJoin(code, 'O2'), { error: 'room_full' });
  assert.deepStrictEqual(gas.sigAnswer(code, 'A1'), { ok: true });
  assert.deepStrictEqual(gas.sigJoin(code, 'O3'), { error: 'room_full' });
  assert.deepStrictEqual(gas.sigHostPoll(code), { offer: 'O1' });   // 첫 참가자의 offer 그대로
});

test('없는 방이나 잘못된 코드는 모든 함수에서 room_not_found', () => {
  const { gas } = load();
  const bad = ['', '    ', 'AB', 'ABCDE', 'A0CD', 'AICD', 'AB-D', 'ZZZZ', null, undefined, 1234];
  for (const c of bad) {
    const label = JSON.stringify(c);
    assert.deepStrictEqual(gas.sigJoin(c, 'sdp'), { error: 'room_not_found' }, 'sigJoin ' + label);
    assert.deepStrictEqual(gas.sigHostPoll(c), { error: 'room_not_found' }, 'sigHostPoll ' + label);
    assert.deepStrictEqual(gas.sigAnswer(c, 'sdp'), { error: 'room_not_found' }, 'sigAnswer ' + label);
    assert.deepStrictEqual(gas.sigGuestPoll(c), { error: 'room_not_found' }, 'sigGuestPoll ' + label);
  }
});

test('상태가 맞지 않는 answer는 bad_state (대기 중 방, 두 번째 answer)', () => {
  const { gas } = load();
  const { code } = gas.sigCreate();
  assert.deepStrictEqual(gas.sigAnswer(code, 'A0'), { error: 'bad_state' });
  gas.sigJoin(code, 'O');
  assert.deepStrictEqual(gas.sigAnswer(code, 'A1'), { ok: true });
  assert.deepStrictEqual(gas.sigAnswer(code, 'A2'), { error: 'bad_state' });
  assert.deepStrictEqual(gas.sigGuestPoll(code), { answer: 'A1' });   // 덮어써지지 않음
});

test('TTL: 대기 중인 방은 만든 지 600초 뒤 사라짐', () => {
  const { gas, clock } = load();
  const { code } = gas.sigCreate();
  clock.advance(601);
  assert.deepStrictEqual(gas.sigJoin(code, 'O'), { error: 'room_not_found' });
});

test('TTL: 쓰기마다 600초가 다시 시작됨 (599초 간격 쓰기는 방을 살림)', () => {
  const { gas, clock } = load();
  const { code } = gas.sigCreate();
  clock.advance(599);
  assert.deepStrictEqual(gas.sigJoin(code, 'O'), { ok: true });
  clock.advance(599);
  assert.deepStrictEqual(gas.sigHostPoll(code), { offer: 'O' });
  clock.advance(2);   // 쓰기 뒤 601초
  assert.deepStrictEqual(gas.sigHostPoll(code), { error: 'room_not_found' });
});

test('SDP 검사: 20,000자 초과·빈 문자열·문자열 아님은 bad_msg, 20,000자는 허용', () => {
  const { gas } = load();
  const { code } = gas.sigCreate();
  assert.deepStrictEqual(gas.sigJoin(code, 'x'.repeat(20001)), { error: 'bad_msg' });
  assert.deepStrictEqual(gas.sigJoin(code, ''), { error: 'bad_msg' });
  assert.deepStrictEqual(gas.sigJoin(code, 12), { error: 'bad_msg' });
  assert.deepStrictEqual(gas.sigJoin(code, undefined), { error: 'bad_msg' });
  assert.deepStrictEqual(gas.sigJoin(code, 'x'.repeat(20000)), { ok: true });
  assert.deepStrictEqual(gas.sigAnswer(code, 'y'.repeat(20001)), { error: 'bad_msg' });
  assert.deepStrictEqual(gas.sigAnswer(code, 'y'.repeat(20000)), { ok: true });
});

test('방 기록 형식: room:CODE 키에 {state, offer, answer, t} JSON이 문자열로 저장됨', () => {
  const { gas, fakes, clock } = load();
  const { code } = gas.sigCreate();
  let rec = JSON.parse(fakes.CacheService.raw('room:' + code));
  assert.deepStrictEqual(Object.keys(rec).sort(), ['answer', 'offer', 'state', 't']);
  assert.strictEqual(rec.state, 'waiting');
  assert.strictEqual(rec.offer, null);
  gas.sigJoin(code, 'OFFER');
  rec = JSON.parse(fakes.CacheService.raw('room:' + code));
  assert.strictEqual(rec.state, 'offered');
  assert.strictEqual(rec.offer, 'OFFER');
  assert.strictEqual(rec.answer, null);
  assert.strictEqual(rec.t, clock.now());
});

test('sigClose는 없는 방이나 잘못된 코드도 {ok:true} (멱등)', () => {
  const { gas } = load();
  const { code } = gas.sigCreate();
  assert.deepStrictEqual(gas.sigClose(code), { ok: true });
  assert.deepStrictEqual(gas.sigClose(code), { ok: true });
  assert.deepStrictEqual(gas.sigClose('no!!'), { ok: true });
});

/* ── 방 코드 생성 (ROOM_CODE_CHARS는 shared/protocol.js와 같아야 함) ── */
test('방 코드: 글자 집합·길이가 shared/protocol.js와 같고, 300개가 모두 유효하고 유일', () => {
  const { gas, run } = load();
  assert.strictEqual(run('ROOM_CODE_CHARS'), Protocol.ROOM_CODE_CHARS);
  assert.strictEqual(run('ROOM_CODE_LEN'), Protocol.ROOM_CODE_LEN);
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const { code } = gas.sigCreate();
    assert.match(code, CHARSET_RE);
    assert.ok(!seen.has(code), '중복 코드 ' + code);
    seen.add(code);
  }
});

test('방 코드 충돌: 사용 중인 코드는 건너뛰고, 20번 모두 겹치면 busy', () => {
  const { gas, setRandom } = load();
  setRandom(() => 0);                                    // 항상 'AAAA'
  assert.deepStrictEqual(gas.sigCreate(), { code: 'AAAA' });
  let calls = 0;
  setRandom(() => { calls++; return 0; });
  assert.deepStrictEqual(gas.sigCreate(), { error: 'busy' });
  assert.strictEqual(calls, 80, '20회 시도 x 4글자');
});

test('방 코드 충돌: 한 번 겹친 뒤 다른 코드를 찾으면 그 코드로 생성', () => {
  const { gas, setRandom } = load();
  setRandom(() => 0);
  assert.deepStrictEqual(gas.sigCreate(), { code: 'AAAA' });
  const seq = [0, 0, 0, 0, 1 / 32, 1 / 32, 1 / 32, 1 / 32];   // 첫 시도 AAAA(사용 중), 다음 시도 BBBB
  let i = 0;
  setRandom(() => seq[i++]);
  assert.deepStrictEqual(gas.sigCreate(), { code: 'BBBB' });
  assert.strictEqual(i, 8);
});

/* ── 잠금 (LockService) ── */
test('잠금: 쓰기 함수는 waitLock(5000)을 쓰고, 끝나면 항상 해제', () => {
  const { gas, fakes } = load();
  const { code } = gas.sigCreate();
  gas.sigJoin(code, 'O');
  gas.sigAnswer(code, 'A');
  gas.sigClose(code);
  assert.ok(fakes.LockService.waits.length >= 4);
  assert.ok(fakes.LockService.waits.every(ms => ms === 5000), 'waitLock(5000)');
  assert.strictEqual(fakes.LockService.isHeld(), false);
  assert.strictEqual(fakes.LockService.spuriousReleases, 0);
});

test('잠금: 쓰기 중 예외가 나도 finally에서 해제 (다음 호출이 막히지 않음)', () => {
  const { gas, fakes } = load();
  const { code } = gas.sigCreate();
  fakes.CacheService.fail = op => op === 'put';
  assert.throws(() => gas.sigJoin(code, 'O'), /Service error/);
  assert.strictEqual(fakes.LockService.isHeld(), false);
  fakes.CacheService.fail = null;
  assert.deepStrictEqual(gas.sigJoin(code, 'O'), { ok: true });
});

test('잠금: 다른 실행이 쥐고 있으면 busy이고, 남의 잠금은 풀지 않음. 읽기는 잠금 없이 동작', () => {
  const { gas, fakes } = load();
  const { code } = gas.sigCreate();
  fakes.LockService.force(true);
  assert.deepStrictEqual(gas.sigJoin(code, 'O'), { error: 'busy' });
  assert.deepStrictEqual(gas.sigClose(code), { error: 'busy' });
  assert.deepStrictEqual(gas.sigHostPoll(code), { offer: null });
  assert.strictEqual(fakes.LockService.isHeld(), true);
  assert.strictEqual(fakes.LockService.spuriousReleases, 0);
  fakes.LockService.force(false);
  assert.deepStrictEqual(gas.sigJoin(code, 'O'), { ok: true });
});

/* ── 게임 페이지 (doGet) ── */
test('doGet: 300초 안의 두 번째 요청은 캐시에서 제공 (fetch 1회), 요청 형식도 확인', () => {
  const page = '<html>hello</html>';
  const { gas, fakes } = load({ fetch: okPage(page) });
  const a = gas.doGet({});
  const b = gas.doGet({ parameter: {} });
  assert.strictEqual(fakes.UrlFetchApp.calls.length, 1);
  assert.strictEqual(a.content, page);
  assert.strictEqual(b.content, page);
  assert.strictEqual(fakes.UrlFetchApp.calls[0].url, GAME_URL);
  assert.strictEqual(fakes.UrlFetchApp.calls[0].params.muteHttpExceptions, true);
});

test('doGet: e가 없어도(편집기에서 실행) 동작', () => {
  const { gas } = load({ fetch: okPage('<html>x</html>') });
  assert.strictEqual(gas.doGet().content, '<html>x</html>');
});

test('doGet: 캐시 300초가 지나면 다시 받아옴 (그 전에는 캐시)', () => {
  let n = 0;
  const { gas, fakes, clock } = load({ fetch: () => ({ code: 200, body: 'PAGE' + (++n) }) });
  gas.doGet({});
  clock.advance(299);
  assert.strictEqual(gas.doGet({}).content, 'PAGE1');
  clock.advance(2);
  assert.strictEqual(gas.doGet({}).content, 'PAGE2');
  assert.strictEqual(fakes.UrlFetchApp.calls.length, 2);
});

test('doGet: 650,000자 한글 많은 페이지도 조각내서 캐시하고 정확히 복원 (100KB 한도 준수)', () => {
  // 한글은 글자당 3바이트라 90,000자 조각은 100KB를 넘음 → 바이트 기준으로도 잘라야 캐시에 들어감
  const unit = '가나다라마바사아자차카타파하 ABCDEFGHIJKLMNOPQRSTUVWXYZ 😀 <p class="x">ㄱㄴ</p>\n';
  let html = '';
  while (html.length < 650000) html += unit;
  const { gas, fakes } = load({ fetch: okPage(html) });
  assert.strictEqual(gas.doGet({}).content, html);
  assert.strictEqual(gas.doGet({}).content, html, '복원 결과가 원본과 같아야 함');
  assert.strictEqual(fakes.UrlFetchApp.calls.length, 1, '두 번째는 캐시에서 (모든 조각이 저장되어 있어야 함)');

  const count = Number(fakes.CacheService.raw('game:count'));
  assert.ok(count >= 8, '여러 조각으로 나뉨: ' + count);
  let joined = '';
  for (let i = 0; i < count; i++) {
    const v = fakes.CacheService.raw('game:' + i);
    assert.ok(v.length <= 90000, '조각 글자 수 ≤ 90,000');
    assert.ok(Buffer.byteLength(v, 'utf8') <= 100 * 1024, '조각 바이트 ≤ 100KB');
    assert.ok(!/[\uD800-\uDBFF]$/.test(v) && !/^[\uDC00-\uDFFF]/.test(v), '서로게이트 쌍이 갈리지 않음');
    joined += v;
  }
  assert.strictEqual(joined, html);
});

test('doGet: 글자 수 한도(90,000자)도 지킴 (ASCII 페이지는 글자 수가 기준)', () => {
  const html = 'a'.repeat(250000);
  const { gas, fakes } = load({ fetch: okPage(html) });
  assert.strictEqual(gas.doGet({}).content, html);
  assert.strictEqual(gas.doGet({}).content, html);
  assert.strictEqual(fakes.UrlFetchApp.calls.length, 1);
  assert.strictEqual(fakes.CacheService.raw('game:count'), '3');
  assert.strictEqual(fakes.CacheService.raw('game:0').length, 90000);
});

test('doGet: 이모지(서로게이트 쌍)가 조각 경계에 걸려도 쪼개지지 않음', () => {
  // 90,000번째 글자가 이모지의 앞 절반이 되도록 배치: 자르면 쌍이 깨지는 위치
  const html = 'a'.repeat(89999) + '😀'.repeat(3) + 'b'.repeat(50000);
  const { gas, fakes } = load({ fetch: okPage(html) });
  assert.strictEqual(gas.doGet({}).content, html);
  assert.strictEqual(gas.doGet({}).content, html);
  assert.strictEqual(fakes.UrlFetchApp.calls.length, 1);
  const first = fakes.CacheService.raw('game:0');
  assert.ok(!/[\uD800-\uDBFF]$/.test(first), '첫 조각이 앞 절반만 남기면 안 됨');
  assert.strictEqual(first, 'a'.repeat(89999), '경계 앞에서 멈춤');
});

test('doGet: ?nocache=1은 캐시를 읽지 않고 새로 받아오며, 받은 결과로 캐시도 갱신', () => {
  let body = 'OLD';
  const { gas, fakes } = load({ fetch: () => ({ code: 200, body }) });
  assert.strictEqual(gas.doGet({}).content, 'OLD');
  body = 'NEW';
  assert.strictEqual(gas.doGet({ parameter: { nocache: '1' } }).content, 'NEW');
  assert.strictEqual(fakes.UrlFetchApp.calls.length, 2);
  assert.strictEqual(gas.doGet({ parameter: { nocache: '0' } }).content, 'NEW');   // 갱신된 캐시
  assert.strictEqual(fakes.UrlFetchApp.calls.length, 2);
});

test('doGet: 404이면 상태 코드가 보이는 오류 페이지, 실패는 캐시하지 않음', () => {
  let code = 404, body = 'Not Found';
  const { gas, fakes } = load({ fetch: () => ({ code, body }) });
  const bad = gas.doGet({});
  assert.match(bad.content, /HTTP 404/);
  assert.match(bad.content, /불러오지 못했어요/);
  assert.strictEqual(bad.title, '1대1 대전 - 오류');
  assert.strictEqual(fakes.CacheService.raw('game:count'), null);
  code = 200; body = '<html>fixed</html>';
  assert.strictEqual(gas.doGet({}).content, '<html>fixed</html>');
  assert.strictEqual(fakes.UrlFetchApp.calls.length, 2);
});

test('doGet: 네트워크 예외와 빈 응답도 오류 페이지 (예외 문구는 HTML 이스케이프)', () => {
  const env1 = load({ fetch: () => { throw new Error('<img src=x> down'); } });
  const out1 = env1.gas.doGet({});
  assert.match(out1.content, /불러오지 못했어요/);
  assert.match(out1.content, /&lt;img src=x&gt; down/);
  assert.ok(!out1.content.includes('<img src=x>'));

  const env2 = load({ fetch: () => ({ code: 200, body: '' }) });
  assert.match(env2.gas.doGet({}).content, /빈 응답/);
});

test('doGet: 캐시 저장이 실패해도 페이지는 그대로 제공', () => {
  const { gas, fakes } = load({ fetch: okPage('<html>ok</html>') });
  fakes.CacheService.fail = op => op === 'putAll';
  assert.strictEqual(gas.doGet({}).content, '<html>ok</html>');
});

test('doGet: 제목 "1대1 대전", viewport 메타, X-Frame ALLOWALL', () => {
  const { gas, run } = load({ fetch: okPage('<html></html>') });
  const out = gas.doGet({});
  assert.strictEqual(out.title, '1대1 대전');
  assert.deepStrictEqual(out.metas, [{ name: 'viewport', content: VIEWPORT }]);
  assert.strictEqual(out.xframe, 'ALLOWALL');
  assert.strictEqual(run('VIEWPORT'), VIEWPORT);
  assert.strictEqual(run('GAME_URL'), GAME_URL);
});

const pass = passed, fail = failed;
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
