'use strict';
/* Hub 테스트: 네트워크 없이 가짜 연결(send/close만 있는 객체)로 Hub를 직접 구동한다.
   흐름: 방 만들기 → 코드로 참가 → 챔피언·준비 → 카운트다운 → 시작 → 입력 프레임 → 스냅샷 → 나가기/끊김 승리.
   그리고 고정 코드(fixedCodes) 방 만들기와 같은 코드 중복 오류. 실행: node test/hub.test.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Core = require('../shared/core.js');
const P = require('../shared/protocol.js');
const { Hub } = require('../server/hub.js');

Core.setMap(JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/walk_rle.json'), 'utf8')));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + String(e && e.message).split('\n').slice(0, 4).join('\n     ')); }
}

/* 가짜 연결: 보낸 메시지를 객체로 쌓는다 */
function fakeConn() {
  const c = {
    out: [], closed: null,
    send(s) { c.out.push(JSON.parse(s)); },
    close(code, reason) { c.closed = { code, reason }; },
  };
  return c;
}
const drain = c => { const o = c.out; c.out = []; return o; };
const lastOf = (c, t) => c.out.filter(m => m.t === t).pop() || null;
const enc = o => JSON.stringify(o);

/* 연결 + hello 까지 끝낸 클라이언트 */
function client(hub, name) {
  const c = fakeConn();
  const sess = hub.connect(c);
  hub.message(sess, enc({ t: 'hello', v: P.VERSION, name }));
  return { c, sess, pid: lastOf(c, 'welcome').pid };
}
function say(hub, cl, o) { hub.message(cl.sess, enc(o)); }

/* ---------- 연결 단계 ---------- */
test('hello 전에 다른 메시지 → bad_msg 후 연결 종료(1008)', () => {
  const hub = new Hub();
  const c = fakeConn(), s = hub.connect(c);
  hub.message(s, enc({ t: 'create', test: false }));
  assert.strictEqual(lastOf(c, 'error').code, 'bad_msg');
  assert.deepStrictEqual(c.closed, { code: 1008, reason: 'hello first' });
});

test('버전이 다르면 bad_version 후 종료, 맞으면 welcome(p1, p2 순서) 과 이름 정리', () => {
  const hub = new Hub();
  const c = fakeConn(), s = hub.connect(c);
  hub.message(s, enc({ t: 'hello', v: P.VERSION + 1, name: 'x' }));
  assert.strictEqual(lastOf(c, 'error').code, 'bad_version');
  assert.deepStrictEqual(c.closed, { code: 1008, reason: 'bad_version' });
  const a = client(hub, '  <아무개>  ');
  assert.strictEqual(a.pid, 'p1');   // 실패한 hello 는 pid 를 쓰지 않음
  assert.strictEqual(lastOf(a.c, 'welcome').v, P.VERSION);
  const b = client(hub, '');
  assert.strictEqual(b.pid, 'p2');
  assert.strictEqual(hub.sessions.size, 3);
});

test('ping → pong(c 그대로), 알 수 없는 종류 → bad_msg, 잘못된 JSON → bad_msg', () => {
  const hub = new Hub();
  const a = client(hub, 'a');
  say(hub, a, { t: 'ping', c: 123.5 });
  assert.deepStrictEqual(lastOf(a.c, 'pong'), { t: 'pong', c: 123.5 });
  say(hub, a, { t: 'nope' });
  assert.strictEqual(lastOf(a.c, 'error').code, 'bad_msg');
  hub.message(a.sess, '{not json');
  assert.strictEqual(lastOf(a.c, 'error').code, 'bad_msg');
});

/* ---------- 방 흐름 ---------- */
test('방 만들기 → 코드(4자리) 방송, 소문자 코드로 참가 → 두 명 방송, 없는 코드·가득 참 오류', () => {
  const hub = new Hub({ countdownSec: 3 });
  const A = client(hub, 'A'), B = client(hub, 'B'), C = client(hub, 'C');
  say(hub, A, { t: 'create', test: false });
  const r1 = lastOf(A.c, 'room');
  assert.strictEqual(r1.code.length, P.ROOM_CODE_LEN);
  assert.strictEqual(r1.state, 'select');
  assert.strictEqual(r1.players.length, 1);
  assert.strictEqual(r1.players[0].team, 0);
  say(hub, C, { t: 'join', code: 'ZZZZ' });
  assert.strictEqual(lastOf(C.c, 'error').code, 'room_not_found');
  say(hub, B, { t: 'join', code: r1.code.toLowerCase() });
  const r2 = lastOf(B.c, 'room');
  assert.strictEqual(r2.code, r1.code);
  assert.deepStrictEqual(r2.players.map(p => p.team), [0, 1]);
  assert.deepStrictEqual(lastOf(A.c, 'room').players.map(p => p.name), ['A', 'B']);
  say(hub, C, { t: 'join', code: r1.code });
  assert.strictEqual(lastOf(C.c, 'error').code, 'room_full');
});

test('챔피언 선택·준비 → 카운트다운 방송 → 시작(start: you=각자 pid, 챔피언 2명)', () => {
  const hub = new Hub({ countdownSec: 3 });
  const A = client(hub, 'A'), B = client(hub, 'B');
  say(hub, A, { t: 'create', test: false });
  say(hub, B, { t: 'join', code: lastOf(A.c, 'room').code });
  say(hub, A, { t: 'pick', champ: 'yi' });
  assert.strictEqual(lastOf(B.c, 'room').players[0].champ, 'yi');
  say(hub, A, { t: 'pick', champ: 'nope' });
  assert.strictEqual(lastOf(A.c, 'error').code, 'bad_msg');
  say(hub, A, { t: 'ready', on: 'yes' });
  assert.strictEqual(lastOf(A.c, 'error').code, 'bad_msg');
  say(hub, A, { t: 'ready', on: true });
  assert.strictEqual(lastOf(B.c, 'room').state, 'select');   // 한 명만 준비
  say(hub, B, { t: 'ready', on: true });
  assert.strictEqual(lastOf(A.c, 'room').state, 'countdown');
  assert.strictEqual(lastOf(A.c, 'room').countdown, 3);

  hub.update(1.0);
  assert.strictEqual(lastOf(A.c, 'room').countdown, 2);
  hub.update(2.5);
  assert.strictEqual(lastOf(A.c, 'room').state, 'playing');
  const sa = lastOf(A.c, 'start'), sb = lastOf(B.c, 'start');
  assert.strictEqual(sa.you, 'p1');
  assert.strictEqual(sb.you, 'p2');
  assert.strictEqual(sa.world.champs.length, 2);
  assert.ok(sa.world.champs.some(c => c.id === 'p1' && c.key === 'yi'));
});

test('게임: 입력 프레임 → 틱마다 진행, 스냅샷 ack 는 단조 증가하고 내 챔피언이 움직임', () => {
  const hub = new Hub({ countdownSec: 0 });
  const A = client(hub, 'A'), B = client(hub, 'B');
  say(hub, A, { t: 'create', test: false });
  const code = lastOf(A.c, 'room').code;
  say(hub, B, { t: 'join', code });
  say(hub, A, { t: 'ready', on: true });
  say(hub, B, { t: 'ready', on: true });
  hub.update(0.01);                       // countdownSec 0 → 준비 즉시 시작
  const start = lastOf(A.c, 'start');
  assert.ok(start, 'start 가 와야 함');
  const x0 = start.world.champs.find(c => c.id === 'p1').x;
  const room = hub.rooms.get(code);
  let seq = 0, lastAck = -1, snaps = 0;
  for (let i = 0; i < 60; i++) {
    say(hub, A, { t: 'f', s: ++seq, mx: 1, my: 0, a: 0 });
    say(hub, B, { t: 'f', s: i + 1, mx: 0, my: 0, a: 0 });
    hub.update(1 / 60);
    const sn = A.c.out.filter(m => m.t === 'snap');
    for (const m of sn) {
      assert.ok(m.ack >= lastAck, 'ack 는 줄지 않음');
      lastAck = m.ack; snaps++;
    }
    A.c.out = A.c.out.filter(m => m.t !== 'snap');
    B.c.out = B.c.out.filter(m => m.t !== 'snap');
  }
  assert.strictEqual(room.gameTick, 60);
  assert.ok(snaps >= 25 && snaps <= 35, '스냅샷 수 ' + snaps);
  assert.ok(lastAck >= 50, 'ack 가 따라옴 ' + lastAck);
  assert.ok(A.c.out.every(m => m.t !== 'error') && B.c.out.every(m => m.t !== 'error'), '오류 없이 진행');
  const x1 = room.world.champs.find(c => c.id === 'p1').x;
  assert.ok(x1 > x0 + 10, 'A 가 오른쪽으로 움직여야 함 ' + x0 + ' → ' + x1);
});

test('따라잡기 상한: 한 번의 update 에 최대 5틱, 밀린 시간은 버림', () => {
  const hub = new Hub({ countdownSec: 0 });
  const A = client(hub, 'A'), B = client(hub, 'B');
  say(hub, A, { t: 'create', test: false });
  const code = lastOf(A.c, 'room').code;
  say(hub, B, { t: 'join', code });
  say(hub, A, { t: 'ready', on: true });
  say(hub, B, { t: 'ready', on: true });
  hub.update(0.01);
  const room = hub.rooms.get(code);
  const before = room.gameTick;
  const wait = hub.update(10);            // 10초 밀림 → 5틱만 돌고 나머지는 버림
  assert.strictEqual(room.gameTick - before, 5);
  assert.ok(wait >= 1 && wait <= 17, '다음 틱까지 ms ' + wait);
});

test('나가기(leave): 게임 중 남은 쪽 승리(disconnect), 방은 선택 단계로, 나간 쪽은 방 없음', () => {
  const hub = new Hub({ countdownSec: 0 });
  const A = client(hub, 'A'), B = client(hub, 'B');
  say(hub, A, { t: 'create', test: false });
  const code = lastOf(A.c, 'room').code;
  say(hub, B, { t: 'join', code });
  say(hub, A, { t: 'ready', on: true });
  say(hub, B, { t: 'ready', on: true });
  hub.update(0.01);
  drain(A.c); drain(B.c);
  say(hub, B, { t: 'leave' });
  const end = lastOf(A.c, 'end');
  assert.deepStrictEqual({ w: end.winner, r: end.reason }, { w: 0, r: 'disconnect' });
  assert.strictEqual(lastOf(A.c, 'room').state, 'select');
  assert.strictEqual(lastOf(A.c, 'room').players.length, 1);
  assert.strictEqual(lastOf(A.c, 'room').players[0].ready, false);
  assert.strictEqual(lastOf(B.c, 'end'), null);
  say(hub, B, { t: 'ready', on: true });
  assert.strictEqual(lastOf(B.c, 'error').code, 'bad_state');
  assert.ok(hub.rooms.has(code));
});

test('연결 끊김(disconnect): 게임 중 상대 승리, 마지막 사람이 나가면 방 삭제', () => {
  const hub = new Hub({ countdownSec: 0 });
  const A = client(hub, 'A'), B = client(hub, 'B');
  say(hub, A, { t: 'create', test: false });
  const code = lastOf(A.c, 'room').code;
  say(hub, B, { t: 'join', code });
  say(hub, A, { t: 'ready', on: true });
  say(hub, B, { t: 'ready', on: true });
  hub.update(0.01);
  drain(A.c);
  hub.disconnect(B.sess);
  const end = lastOf(A.c, 'end');
  assert.deepStrictEqual({ w: end.winner, r: end.reason }, { w: 0, r: 'disconnect' });
  hub.disconnect(A.sess);
  assert.strictEqual(hub.rooms.size, 0, '비면 방 삭제');
  assert.strictEqual(hub.sessions.size, 0);
});

/* ---------- 고정 코드 ---------- */
test('fixedCodes: create 의 code 로 방을 만든다(소문자는 대문자로). 같은 코드면 bad_state', () => {
  const hub = new Hub({ fixedCodes: true });
  const A = client(hub, 'A'), B = client(hub, 'B');
  say(hub, A, { t: 'create', test: true, code: 'wxyz' });
  assert.strictEqual(lastOf(A.c, 'room').code, 'WXYZ');
  assert.ok(hub.rooms.has('WXYZ'));
  say(hub, B, { t: 'create', test: false, code: 'WXYZ' });
  assert.strictEqual(lastOf(B.c, 'error').code, 'bad_state');
  say(hub, B, { t: 'create', test: false, code: 'bad!' });
  assert.strictEqual(lastOf(B.c, 'error').code, 'bad_msg');
  say(hub, B, { t: 'join', code: 'WXYZ' });
  assert.strictEqual(lastOf(B.c, 'room').code, 'WXYZ');
});

test('fixedCodes 가 꺼져 있으면 create 의 code 는 무시(WebSocket 서버 동작과 같음)', () => {
  const hub = new Hub({ codeFn: () => 'ABCD' });
  const A = client(hub, 'A');
  say(hub, A, { t: 'create', test: false, code: 'ZZZZ' });
  assert.strictEqual(lastOf(A.c, 'room').code, 'ABCD');
  assert.ok(!hub.rooms.has('ZZZZ'));
});

test('codeFn 이 항상 같은 코드를 주면 두 번째 방은 만들지 못함(bad_state)', () => {
  const hub = new Hub({ codeFn: () => 'ABCD' });
  const A = client(hub, 'A'), B = client(hub, 'B');
  say(hub, A, { t: 'create', test: false });
  say(hub, B, { t: 'create', test: false });
  assert.strictEqual(lastOf(B.c, 'error').code, 'bad_state');
});

test('update 는 다음 틱까지 남은 밀리초(1 이상)를 돌려준다', () => {
  const hub = new Hub();
  const ms = hub.update(0.001);
  assert.ok(Number.isInteger(ms) && ms >= 1 && ms <= 17, 'ms=' + ms);
});

test('close(): 연결 목록을 돌려주고 방·세션을 비운다', () => {
  const hub = new Hub();
  const A = client(hub, 'A');
  say(hub, A, { t: 'create', test: false });
  const conns = hub.close();
  assert.deepStrictEqual(conns, [A.c]);
  assert.strictEqual(hub.rooms.size, 0);
  assert.strictEqual(hub.sessions.size, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
