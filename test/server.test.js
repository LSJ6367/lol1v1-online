'use strict';
/* 서버 테스트: 실제 소켓(Node 22 전역 WebSocket + 원시 TCP)으로 서버 전체를 검증하고,
   승패 판정은 Room을 직접 불러 가짜 연결(send만 있는 객체)로 검증한다. 외부 패키지 없음. */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const Core = require('../shared/core.js');
const P = require('../shared/protocol.js');
const ws = require('../server/ws.js');
const { Room } = require('../server/room.js');
const { start } = require('../server/server.js');

Core.setMap(JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/walk_rle.json'), 'utf8')));
const px = n => n * Core.U;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + String(e && e.message).split('\n').slice(0, 4).join('\n     ')); }
}
async function waitUntil(pred, ms, label) {
  const end = Date.now() + (ms || 3000);
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout: ' + label);
    await sleep(3);
  }
}

/* ── 전역 WebSocket 클라이언트 도우미 ───────────────────────────── */
const allClients = [];
function connect(port) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    const c = { sock, queue: [], closed: false, closeEvt: null };
    allClients.push(c);
    sock.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { m = { t: '__raw', raw: String(ev.data) }; }
      c.queue.push(m);
    };
    sock.onopen = () => resolve(c);
    sock.onerror = () => reject(new Error('WebSocket 연결 실패'));
    sock.onclose = ev => { c.closed = true; c.closeEvt = ev; };
  });
}
const send = (c, obj) => c.sock.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
async function wait(c, pred, label, ms) {
  const end = Date.now() + (ms || 3000);
  for (;;) {
    const i = c.queue.findIndex(pred);
    if (i >= 0) return c.queue.splice(i, 1)[0];
    if (Date.now() > end) throw new Error('timeout: ' + label);
    await sleep(3);
  }
}
const snapsOf = c => c.queue.filter(m => m.t === 'snap');
async function hello(c, name) {
  send(c, { t: 'hello', v: P.VERSION, name });
  const w = await wait(c, m => m.t === 'welcome', 'welcome');
  assert.ok(/^p\d+$/.test(w.pid), 'pid 형식 ' + w.pid);
  return w.pid;
}
const roomWith = (pid, n) => m => m.t === 'room' && m.players.length === n && (pid === undefined || m.players.some(p => p.pid === pid));
function httpGet(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    }).on('error', reject);
  });
}

/* ── 원시 TCP 도우미 (RFC 6455 프레임을 직접 만들고 해석) ─────────── */
function maskedFrame(op, payload, fin) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const mask = crypto.randomBytes(4);
  let hdr;
  const b0 = (fin === false ? 0 : 0x80) | op;
  if (p.length < 126) { hdr = Buffer.from([b0, 0x80 | p.length]); }
  else if (p.length < 65536) { hdr = Buffer.alloc(4); hdr[0] = b0; hdr[1] = 0x80 | 126; hdr.writeUInt16BE(p.length, 2); }
  else { hdr = Buffer.alloc(10); hdr[0] = b0; hdr[1] = 0x80 | 127; hdr.writeUInt32BE(0, 2); hdr.writeUInt32BE(p.length, 6); }
  const body = Buffer.alloc(p.length);
  for (let i = 0; i < p.length; i++) body[i] = p[i] ^ mask[i & 3];
  return Buffer.concat([hdr, mask, body]);
}
function parseServerFrames(buf) {   // 서버 프레임은 마스크가 없어야 함
  const out = [];
  let o = 0;
  while (buf.length - o >= 2) {
    const b0 = buf[o], b1 = buf[o + 1];
    assert.ok(!(b1 & 0x80), '서버 프레임이 마스크됨');
    let len = b1 & 0x7f, off = o + 2;
    if (len === 126) { if (buf.length - o < 4) break; len = buf.readUInt16BE(o + 2); off = o + 4; }
    else if (len === 127) { if (buf.length - o < 10) break; len = buf.readUInt32BE(o + 2) * 4294967296 + buf.readUInt32BE(o + 6); off = o + 10; }
    if (buf.length < off + len) break;
    out.push({ fin: !!(b0 & 0x80), op: b0 & 0x0f, len, payload: buf.subarray(off, off + len) });
    o = off + len;
  }
  return { frames: out, rest: buf.subarray(o) };
}
function rawConnect(port, reqPath, key) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const c = { sock, buf: Buffer.alloc(0), head: null, frames: [], closed: false };
    sock.on('connect', () => sock.write(
      'GET ' + (reqPath || '/ws') + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + (key || 'dGhlIHNhbXBsZSBub25jZQ==') + '\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    sock.on('data', d => {
      c.buf = Buffer.concat([c.buf, d]);
      if (c.head === null) {
        const i = c.buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        c.head = c.buf.subarray(0, i).toString('latin1');
        c.buf = c.buf.subarray(i + 4);
        resolve(c);
      }
      const r = parseServerFrames(c.buf);
      c.frames.push(...r.frames);
      c.buf = r.rest;
    });
    sock.on('close', () => { c.closed = true; });
    sock.on('error', () => {});
    setTimeout(() => { if (c.head === null) reject(new Error('핸드셰이크 응답 없음')); }, 2000).unref();
  });
}
async function waitFrame(c, pred, label, ms) {
  const end = Date.now() + (ms || 2000);
  for (;;) {
    const i = c.frames.findIndex(pred);
    if (i >= 0) return c.frames.splice(i, 1)[0];
    if (Date.now() > end) throw new Error('timeout: ' + label);
    await sleep(3);
  }
}
async function writeSlowly(sock, buf) {   // 한 바이트씩 보내서 TCP 읽기 경계를 깨뜨린다
  for (const b of buf) { sock.write(Buffer.from([b])); await sleep(1); }
}

/* ── 승패 판정 검증용 가짜 연결 ─────────────────────────────────── */
function fakeConn() {
  return { msgs: [], send(s) { this.msgs.push(JSON.parse(s)); return true; }, close() {} };
}
function roomPair(opts) {
  const room = new Room(Object.assign({ code: 'TEST', countdownSec: 0 }, opts || {}));
  const c1 = fakeConn(), c2 = fakeConn();
  room.addPlayer({ pid: 'p1', name: 'a', conn: c1 });
  room.addPlayer({ pid: 'p2', name: 'b', conn: c2 });
  return { room, c1, c2 };
}
function runUntilSelect(room, maxTicks) {
  let n = 0;
  while (room.state === 'playing' && n < maxTicks) { room.tick(); n++; }
  return n;
}

(async function main() {
  const guard = setTimeout(() => { console.log('FAIL 전체 20초 제한 초과'); process.exit(1); }, 20000);
  const srv = await start({ port: 0, host: '127.0.0.1', countdownSec: 0, build: false });
  const port = srv.port;
  const ctx = {};

  await test('HTTP: / 와 /index.html 은 페이지(또는 빌드 안내), /healthz 는 ok, 그 외 404', async () => {
    const r = await httpGet(port, '/');
    assert.strictEqual(r.status, 200);
    assert.ok(/text\/html/.test(r.type), r.type);
    assert.ok(r.body.length > 0);
    const i = await httpGet(port, '/index.html');
    assert.strictEqual(i.status, 200);
    const h = await httpGet(port, '/healthz');
    assert.strictEqual(h.body, 'ok');
    assert.strictEqual((await httpGet(port, '/nope')).status, 404);
  });

  await test('hello → welcome, 잘못된 버전은 bad_version 후 연결 종료', async () => {
    const A = await connect(port);
    ctx.A = A; ctx.pidA = await hello(A, '에이');
    const bad = await connect(port);
    send(bad, { t: 'hello', v: 999, name: 'x' });
    const e = await wait(bad, m => m.t === 'error', 'bad_version');
    assert.strictEqual(e.code, 'bad_version');
    await waitUntil(() => bad.closed, 2000, '버전 오류 후 종료');
  });

  await test('create → 4자리 코드, 소문자 join 성공, 없는 코드 room_not_found, 가득 차면 room_full', async () => {
    const { A, pidA } = ctx;
    const B = await connect(port); ctx.B = B; ctx.pidB = await hello(B, '비');
    const C = await connect(port); ctx.C = C; await hello(C, '씨');
    send(A, { t: 'create', test: false });
    const r1 = await wait(A, m => m.t === 'room', 'room after create');
    assert.ok(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(r1.code), '코드 ' + r1.code);
    assert.strictEqual(r1.state, 'select');
    assert.strictEqual(r1.players[0].team, 0);
    ctx.code = r1.code;
    send(C, { t: 'join', code: r1.code === 'AAAA' ? 'BBBB' : 'AAAA' });   // 존재하지 않는 코드
    const nf = await wait(C, m => m.t === 'error', 'room_not_found');
    assert.strictEqual(nf.code, 'room_not_found');
    send(B, { t: 'join', code: r1.code.toLowerCase() });
    await wait(B, roomWith(ctx.pidB, 2), 'B 입장');
    const rA = await wait(A, roomWith(undefined, 2), 'A 가 2명 확인');
    const pB = rA.players.find(p => p.pid === ctx.pidB);
    assert.strictEqual(pB.team, 1, 'B 는 팀 1');
    send(C, { t: 'join', code: r1.code });
    const full = await wait(C, m => m.t === 'error', 'room_full');
    assert.strictEqual(full.code, 'room_full');
  });

  await test('잘못된 메시지(JSON 아님/알 수 없는 종류/잘못된 챔피언)는 bad_msg, 연결은 유지', async () => {
    const { A } = ctx;
    A.queue.length = 0;
    A.sock.send('not json{');
    assert.strictEqual((await wait(A, m => m.t === 'error', 'bad json')).code, 'bad_msg');
    send(A, { t: 'nope' });
    assert.strictEqual((await wait(A, m => m.t === 'error', 'unknown')).code, 'bad_msg');
    send(A, { t: 'pick', champ: 'zed' });
    assert.strictEqual((await wait(A, m => m.t === 'error', 'bad champ')).code, 'bad_msg');
    send(A, { t: 'ping', c: 42 });
    const pong = await wait(A, m => m.t === 'pong', 'pong');
    assert.strictEqual(pong.c, 42);
  });

  await test('챔피언 선택과 준비 → 두 명 모두 준비하면 start(you = 각자의 pid)', async () => {
    const { A, B, pidA, pidB } = ctx;
    send(A, { t: 'ready', on: true });
    await wait(A, m => m.t === 'room' && m.players.find(p => p.pid === pidA).ready === true, 'A 준비');
    send(A, { t: 'pick', champ: 'yi' });
    assert.strictEqual((await wait(A, m => m.t === 'error', 'pick 중 준비')).code, 'bad_state');
    send(A, { t: 'ready', on: false });
    await wait(A, m => m.t === 'room' && m.players.find(p => p.pid === pidA).ready === false, 'A 준비 취소');
    send(A, { t: 'pick', champ: 'yi' });
    await wait(A, m => m.t === 'room' && m.players.find(p => p.pid === pidA).champ === 'yi', 'A 챔피언 yi');
    send(B, { t: 'pick', champ: 'darius' });
    send(A, { t: 'ready', on: true });
    send(B, { t: 'ready', on: true });
    const sA = await wait(A, m => m.t === 'start', 'start A');
    const sB = await wait(B, m => m.t === 'start', 'start B');
    assert.strictEqual(sA.you, pidA);
    assert.strictEqual(sB.you, pidB);
    assert.strictEqual(sA.tick, 0);
    assert.strictEqual(sA.world.champs.length, 2);
    assert.strictEqual(sA.world.champs.find(c => c.id === pidA).key, 'yi');
    assert.strictEqual(sA.world.champs.find(c => c.id === pidB).key, 'darius');
    assert.ok(!('events' in sA.world), 'slimWorld 은 events 를 뺀다');
  });

  await test('게임: 프레임으로 이동하면 스냅샷 ack 가 늘고 내 챔피언 x 가 증가, 상대 ack 도 단조 증가', async () => {
    const { A, B, pidA, pidB } = ctx;
    A.queue.length = 0; B.queue.length = 0;
    for (let i = 1; i <= 60; i++) {
      send(A, { t: 'f', s: i, mx: 1, my: 0, a: 0 });
      send(B, { t: 'f', s: i, mx: 0, my: 0, a: 0 });
      await sleep(16);
    }
    await waitUntil(() => A.queue.some(m => m.t === 'snap' && m.ack >= 60), 3000, 'ack 60 도달');
    await waitUntil(() => B.queue.some(m => m.t === 'snap' && m.ack >= 60), 3000, 'B ack 60 도달');
    const sa = snapsOf(A), sb = snapsOf(B);
    assert.ok(sa.length >= 5, '스냅샷 수 ' + sa.length);
    for (let i = 1; i < sa.length; i++) {
      assert.ok(sa[i].ack >= sa[i - 1].ack, 'A ack 단조 증가');
      assert.ok(sa[i].tick > sa[i - 1].tick, 'tick 증가');
    }
    assert.ok(sa.every(s => s.tick % P.SNAP_EVERY === 0), '스냅샷은 3틱마다');
    for (let i = 1; i < sb.length; i++) assert.ok(sb[i].ack >= sb[i - 1].ack, 'B ack 단조 증가');
    const xs = sa.map(s => s.w.champs.find(c => c.id === pidA).x);
    assert.ok(xs[xs.length - 1] > xs[0] + 10, 'A x 증가 ' + xs[0].toFixed(1) + ' → ' + xs[xs.length - 1].toFixed(1));
  });

  await test('일반 방에서는 dev 행동이 무시되고, 잘못된 프레임은 조용히 무시됨', async () => {
    const { A, pidA } = ctx;
    A.queue.length = 0;
    send(A, { t: 'f', s: 'x' });                                   // 잘못된 프레임: 무시
    send(A, { t: 'f', s: 61, mx: 0, my: 0, a: 0, acts: [{ k: 'dev', op: 'time', sec: 30 }] });
    await waitUntil(() => A.queue.some(m => m.t === 'snap' && m.ack >= 61), 3000, 'ack 61');
    await sleep(100);
    const last = snapsOf(A).pop();
    assert.strictEqual(last.w.devT, 0, 'dev 무시');
    assert.ok(!A.queue.some(m => m.t === 'error'), '잘못된 프레임에 오류 응답 없음');
    assert.ok(last.w.champs.some(c => c.id === pidA));
  });

  await test('상대가 나가면(연결 끊김) 남은 쪽이 disconnect 로 승리, 방은 선택 단계로, 비우면 방 삭제', async () => {
    const { A, B, C, code } = ctx;
    A.sock.close();
    const end = await wait(B, m => m.t === 'end', 'end disconnect', 3000);
    assert.strictEqual(end.reason, 'disconnect');
    assert.strictEqual(end.winner, 1, 'B(팀 1) 승리');
    assert.strictEqual(end.kills['0'], 0);
    assert.strictEqual(end.kills['1'], 0);
    const room = await wait(B, m => m.t === 'room' && m.state === 'select', 'select 복귀');
    assert.strictEqual(room.players.length, 1);
    assert.strictEqual(room.players[0].ready, false, '준비 해제');
    send(B, { t: 'leave' });
    send(C, { t: 'join', code });
    assert.strictEqual((await wait(C, m => m.t === 'error', 'room gone')).code, 'room_not_found');
  });

  await test('테스트 방: 한 명으로 시작, 허수아비 존재, dev 행동(time) 적용', async () => {
    const D = await connect(port);
    const pidD = await hello(D, '디');
    send(D, { t: 'create', test: true });
    const rD = await wait(D, m => m.t === 'room', 'test room');
    assert.strictEqual(rD.test, true);
    send(D, { t: 'ready', on: true });
    const sD = await wait(D, m => m.t === 'start', 'test start');
    assert.strictEqual(sD.you, pidD);
    assert.strictEqual(sD.world.dummies.length, 1);
    assert.strictEqual(sD.world.devMode, true);
    send(D, { t: 'f', s: 1, mx: 0, my: 0, a: 0, acts: [{ k: 'dev', op: 'time', sec: 30 }] });
    await waitUntil(() => D.queue.some(m => m.t === 'snap' && m.w.devT >= 30), 3000, 'dev time 적용');
    send(D, { t: 'leave' });
    const C = ctx.C;
    send(C, { t: 'join', code: rD.code });
    assert.strictEqual((await wait(C, m => m.t === 'error', 'test room gone')).code, 'room_not_found');
  });

  await test('Room: 프레임 큐 상한과 병합(버린 프레임의 acts 보존), 초당 한도', async () => {
    const { room } = roomPair();
    room.setReady('p1', true); room.setReady('p2', true);
    assert.strictEqual(room.state, 'playing');
    room.onFrame('p1', { s: 1, mx: 0, my: 0, a: 0, acts: [{ k: 'lv', skill: 'q' }] });
    for (let s = 2; s <= 11; s++) room.onFrame('p1', { s, mx: 0, my: 0, a: 0 });
    const p = room.find('p1');
    assert.strictEqual(p.queue.length, P.MAX_QUEUE);
    assert.strictEqual(p.queue[0].s, 2, '가장 오래된 프레임(1)은 버려짐');
    assert.ok(p.queue[0].acts && p.queue[0].acts[0].k === 'lv', '버린 프레임의 레벨업 보존');
    room.tick();
    assert.strictEqual(room.world.champs.find(c => c.id === 'p1').sk.q, 1, '병합된 레벨업이 적용됨');
    for (let s = 12; s <= 211; s++) room.onFrame('p1', { s, mx: 0, my: 0, a: 0 });
    assert.strictEqual(p.lastRecv, P.MAX_FRAMES_PER_SEC, '초당 ' + P.MAX_FRAMES_PER_SEC + '개까지만 받음');
  });

  // 방법: 적 챔피언을 포탑 사거리 안에 두고 체력 1로 만든 뒤 포탑이 실제 규칙으로 처치하게 한다.
  await test('승리(처치): 적 챔피언이 아군 포탑에 처치되면 kill 로 승리', async () => {
    const { room, c1, c2 } = roomPair();
    room.setReady('p1', true); room.setReady('p2', true);
    const w = room.world;
    const t0 = w.turrets.find(t => t.team === 0);
    const victim = w.champs.find(c => c.id === 'p2');
    victim.x = t0.x + 100; victim.y = t0.y; victim.hp = 1;     // 사거리 안, 체력 1
    const n = runUntilSelect(room, 600);
    assert.strictEqual(room.state, 'select', '600틱 안에 끝나야 함');
    assert.ok(n < 600);
    for (const c of [c1, c2]) {
      const e = c.msgs.find(m => m.t === 'end');
      assert.ok(e, 'end 전송');
      assert.strictEqual(e.winner, 0);
      assert.strictEqual(e.reason, 'kill');
      assert.strictEqual(e.kills['0'], 1);
    }
    assert.ok(c1.msgs.some(m => m.t === 'room' && m.state === 'select'), '선택 단계 복귀');
    assert.strictEqual(room.find('p1').ready, false);
  });

  await test('승리(포탑): 상대 포탑을 내 챔피언이 공격해 파괴하면 turret 으로 승리', async () => {
    const { room, c1, c2 } = roomPair();
    room.setReady('p1', true); room.setReady('p2', true);
    const w = room.world;
    const t1 = w.turrets.find(t => t.team === 1);
    const attacker = w.champs.find(c => c.id === 'p1');
    attacker.x = t1.x - 70; attacker.y = t1.y; t1.hp = 1;      // 평타 사거리 안, 포탑 체력 1
    room.onFrame('p1', { s: 1, mx: 0, my: 0, a: 1 });          // 공격 버튼 누름(유지됨)
    runUntilSelect(room, 600);
    assert.strictEqual(room.state, 'select');
    assert.ok(t1.dead, '포탑 파괴');
    const e = c1.msgs.find(m => m.t === 'end');
    assert.strictEqual(e.winner, 0);
    assert.strictEqual(e.reason, 'turret');
    assert.ok(c2.msgs.some(m => m.t === 'end' && m.reason === 'turret'));
  });

  await test('Room 카운트다운: 진행 숫자 전송, 준비 취소 시 선택 단계로 복귀, 다시 준비하면 시작', async () => {
    const { room, c1, c2 } = roomPair({ countdownSec: 2 });
    room.setReady('p1', true); room.setReady('p2', true);
    assert.strictEqual(room.state, 'countdown');
    const first = c1.msgs[c1.msgs.length - 1];
    assert.strictEqual(first.state, 'countdown');
    assert.strictEqual(first.countdown, 2);
    room.update(0.5);
    assert.strictEqual(room.state, 'countdown');
    room.update(1.0);
    assert.strictEqual(c1.msgs[c1.msgs.length - 1].countdown, 1, '남은 숫자 1');
    room.setReady('p2', false);
    assert.strictEqual(room.state, 'select');
    assert.strictEqual(c1.msgs[c1.msgs.length - 1].players.find(p => p.pid === 'p2').ready, false);
    room.setReady('p2', true);
    assert.strictEqual(room.state, 'countdown');
    room.update(2.1);
    assert.strictEqual(room.state, 'playing');
    assert.ok(c2.msgs.some(m => m.t === 'start'));
  });

  /* ── WebSocket 프로토콜 세부(원시 TCP) ───────────────────────── */
  const echoCount = { closed: 0 };
  const h1 = http.createServer((req, res) => res.end('x'));
  ws.attach(h1, {
    path: '/ws',
    onConnection(conn) {
      conn.on('message', t => {
        if (t === 'close') conn.close(1000, 'bye');
        else conn.send('echo:' + t);
      });
      conn.on('close', () => { echoCount.closed++; });
    }
  });
  await new Promise(r => h1.listen(0, '127.0.0.1', r));
  const p1 = h1.address().port;

  await test('ws: 핸드셰이크 Sec-WebSocket-Accept 값이 RFC 예시와 일치, 다른 경로는 400', async () => {
    const c = await rawConnect(p1);
    assert.ok(c.head.startsWith('HTTP/1.1 101'), c.head.split('\r\n')[0]);
    assert.ok(c.head.includes('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo='));
    c.sock.destroy();
    const bad = await rawConnect(p1, '/other');
    assert.ok(bad.head.startsWith('HTTP/1.1 400'), bad.head.split('\r\n')[0]);
    bad.sock.destroy();
  });

  await test('ws: 마스크된 텍스트 프레임 → 서버가 비마스크 텍스트로 응답', async () => {
    const c = await rawConnect(p1);
    c.sock.write(maskedFrame(1, 'hi'));
    const f = await waitFrame(c, f => f.op === 1, 'echo');
    assert.strictEqual(f.payload.toString('utf8'), 'echo:hi');
    assert.ok(f.fin);
    c.sock.destroy();
  });

  await test('ws: 분할 메시지(continuation) + 중간 ping + 한 바이트씩 도착해도 정확히 처리', async () => {
    const c = await rawConnect(p1);
    const bytes = Buffer.concat([maskedFrame(1, 'hel', false), maskedFrame(9, 'p'), maskedFrame(0, 'lo')]);
    await writeSlowly(c.sock, bytes);
    const pong = await waitFrame(c, f => f.op === 10, 'pong');
    assert.strictEqual(pong.payload.toString(), 'p', 'pong 은 ping 페이로드를 그대로');
    const txt = await waitFrame(c, f => f.op === 1, 'text');
    assert.strictEqual(txt.payload.toString('utf8'), 'echo:hello');
    c.sock.destroy();
  });

  await test('ws: 65536 바이트 메시지는 허용(64bit 길이 응답 포함), 65537 바이트는 1009', async () => {
    const c = await rawConnect(p1);
    const big = 'a'.repeat(65536);
    c.sock.write(maskedFrame(1, big));
    const f = await waitFrame(c, f => f.op === 1, 'big echo', 3000);
    assert.strictEqual(f.len, 'echo:'.length + 65536);
    c.sock.destroy();
    const d = await rawConnect(p1);
    d.sock.write(Buffer.concat([Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0, 1, 0x00, 0x01]), Buffer.from([1, 2, 3, 4])]));  // 헤더만(65537)
    const cl = await waitFrame(d, f => f.op === 8, 'close 1009');
    assert.strictEqual(cl.payload.readUInt16BE(0), 1009);
    d.sock.destroy();
  });

  await test('ws: 마스크 없는 클라이언트 프레임은 1002 로 닫힘', async () => {
    const c = await rawConnect(p1);
    c.sock.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
    const cl = await waitFrame(c, f => f.op === 8, 'close 1002');
    assert.strictEqual(cl.payload.readUInt16BE(0), 1002);
    await waitUntil(() => c.closed, 2000, '소켓 종료');
  });

  await test('ws: 클라이언트 close 는 close 로 응답하고 서버 conn 의 close 이벤트 발생', async () => {
    const before = echoCount.closed;
    const c = await rawConnect(p1);
    c.sock.write(maskedFrame(8, Buffer.from([0x03, 0xe8])));   // 1000
    const cl = await waitFrame(c, f => f.op === 8, 'close reply');
    assert.strictEqual(cl.payload.readUInt16BE(0), 1000);
    await waitUntil(() => echoCount.closed > before, 2000, '서버 close 이벤트');
  });

  await test('ws: close 프레임 없이 FIN 만 보내고 끊어도 서버 conn 이 즉시 close (하트비트 시간을 기다리지 않음)', async () => {
    const before = echoCount.closed;
    const c = await rawConnect(p1);
    const t0 = Date.now();
    c.sock.destroy();
    await waitUntil(() => echoCount.closed > before, 1000, 'FIN 후 서버 close');
    assert.ok(Date.now() - t0 < 1000);
  });

  await test('ws: 서버가 close(1000,"bye") 하면 코드와 사유가 전달됨', async () => {
    const c = await rawConnect(p1);
    c.sock.write(maskedFrame(1, 'close'));
    const cl = await waitFrame(c, f => f.op === 8, 'server close');
    assert.strictEqual(cl.payload.readUInt16BE(0), 1000);
    assert.strictEqual(cl.payload.subarray(2).toString('utf8'), 'bye');
    c.sock.destroy();
  });

  const h2 = http.createServer((req, res) => res.end('x'));
  ws.attach(h2, { path: '/ws', pingMs: 100, timeoutMs: 400, onConnection() {} });
  await new Promise(r => h2.listen(0, '127.0.0.1', r));
  await test('ws: 하트비트 — 주기적으로 ping 을 보내고, 무응답이면 종료', async () => {
    const t0 = Date.now();
    const c = await rawConnect(h2.address().port);
    await waitFrame(c, f => f.op === 9, 'ping', 1000);
    await waitUntil(() => c.closed, 2000, '무응답 종료');
    assert.ok(Date.now() - t0 < 1500, '종료 시각 ' + (Date.now() - t0) + 'ms');
  });

  // ── 정리 ────────────────────────────────────────────────────────
  for (const c of allClients) { try { c.sock.close(); } catch (e) { /* 이미 닫힘 */ } }
  await srv.close();
  await new Promise(r => h1.close(r));
  await new Promise(r => h2.close(r));
  clearTimeout(guard);
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('FAIL 테스트 실행 오류: ' + (e && e.stack));
  process.exit(1);
});
