'use strict';
/* OnlineSession 테스트: 서버 시뮬(고정 지연 + 프레임 1개/틱 + 3틱마다 스냅샷)을 Node에서 돌려
   예측·보간·이벤트·dev 필터를 검증한다. 실행: node test/session_online.test.js */
const path = require('path'), fs = require('fs'), assert = require('assert');
const Core = require('../shared/core.js');
const P = require('../shared/protocol.js');
Core.setMap(JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/walk_rle.json'), 'utf8')));
global.Core = Core; global.Protocol = P;
const OnlineSession = require('../client/session_online.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 0.01);

function makeNet() {
  const sent = [], handlers = {};
  return {
    sent, rtt: 0,
    send(o) { sent.push(o); return true; },
    on(t, f) { (handlers[t] = handlers[t] || []).push(f); },
    emit(t, m) { for (const f of handlers[t] || []) f(m); },
    onClose() {}
  };
}

/* ---------- 서버 시뮬 ---------- */
const TICK = Core.TICK, LAT = 6, SNAP = P.SNAP_EVERY;
const players = [{ id: 'p1', key: 'darius', team: 0 }, { id: 'p2', key: 'yi', team: 1 }];
const server = Core.createWorld({ players, dummy: false, devMode: false });
const startWorld = P.slimWorld(server);
const startP1 = { x: server.champs[0].x, y: server.champs[0].y };

const net = makeNet();
let clockMs = 0;
const now = () => clockMs;
const session = new OnlineSession(net, { t: 'start', tick: 0, you: 'p1', world: startWorld }, { predict: true, test: false, now });

let serverTick = 0, lastApplied = 0;
let inflight = [], squeue = [], pendingEv = [];
const snapEvLog = [], clientEvLog = [];
const p2Frame = P.sanitizeFrame({ s: 1, mx: -0.5, my: 0.5, a: 0 }, false);   // 상대는 일정한 입력으로 움직임

function sendSnap() {
  const ev = P.eventsFor(pendingEv, 'p1', false); pendingEv = [];
  snapEvLog.push(...ev);
  net.emit('snap', { t: 'snap', tick: serverTick, ack: lastApplied, w: P.slimWorld(server), ev });
}

// 클라 틱(옵션) → 프레임 지연 전달 → 서버 1틱 진행. 프레임을 적용했으면 true
function tickOnce(clientTick) {
  if (clientTick) { clockMs += TICK * 1000; session.update(TICK); }
  for (const m of net.sent.splice(0)) if (m.t === 'f') inflight.push({ at: serverTick + LAT, f: m });
  serverTick++;
  while (inflight.length && inflight[0].at <= serverTick) squeue.push(inflight.shift().f);
  let applied = false, cmds = P.frameToCmds('p2', p2Frame);
  if (squeue.length) {
    const f = P.sanitizeFrame(squeue.shift(), false);
    lastApplied = f.s; applied = true;
    cmds = P.frameToCmds('p1', f).concat(cmds);
  }
  if (serverTick === 60) server.events.push({ type: 'text', x: 10, y: 10, txt: 'SRV', color: '#fff' });
  Core.step(server, cmds);
  pendingEv.push(...Core.drainEvents(server));
  if (serverTick % SNAP === 0) sendSnap();
  return applied && !inflight.length && !squeue.length;
}

/* ---------- 시나리오 A: 이동 중 (지연 6틱) ---------- */
console.log('scenario A: moving with latency');
session.send({ type: 'input', id: 'p1', mx: 0, my: -1, atk: false });   // 위쪽(벽 없음)
let interpSamples = 0, interpBad = null, rawCount = 0, otherMoved = 0;
for (let t = 0; t < 120; t++) {   // 120틱: 위로 가는 길이 막히기 전 구간(벽에 붙으면 예측=서버가 되어 검증 무의미)
  tickOnce(true);
  clientEvLog.push(...session.drainEvents());
  // 상대(p2) 보간 검증: pos()가 두 스냅샷 사이 선형 보간과 일치하는지
  const buf = session.buf, R = session.renderTick();
  if (buf.length >= 2 && R >= buf[0].tick && R < buf[buf.length - 1].tick) {
    let i = buf.length - 2; while (i > 0 && buf[i].tick > R) i--;
    const a = buf[i], b = buf[i + 1];
    const ua = a.w.champs.find(c => c.id === 'p2'), ub = b.w.champs.find(c => c.id === 'p2');
    const u = session.world.champs.find(c => c.id === 'p2');
    const tt = (R - a.tick) / (b.tick - a.tick);
    const want = [ua.x + (ub.x - ua.x) * tt, ua.y + (ub.y - ua.y) * tt];
    const got = session.pos(u);
    if (tt > 0 && tt < 1) interpSamples++;
    if (ua.x !== ub.x || ua.y !== ub.y) otherMoved++;
    if (!near(got[0], want[0]) || !near(got[1], want[1])) interpBad = { t, R, got, want };
    rawCount++;
  }
}
// 프레임 번호 연속성: 보낸 프레임의 seq는 1부터 1씩 증가
const seqSet = session.seq;
ok('one frame per tick (seq == ticks)', seqSet === 120, seqSet);
ok('latency: frames still pending (not all acked)', session.pending.length >= 1, session.pending.length);

const snapP1 = session.latest.w.champs.find(c => c.id === 'p1');
ok('server actually moved up', snapP1.y < startP1.y - 5, [snapP1.y, startP1.y]);
const myPos = session.pos(session.me());
ok('own predicted position is ahead of latest snapshot (moving up)', myPos[1] < snapP1.y - 1, [myPos[1], snapP1.y]);
ok('own predicted x has no drift (pure vertical input)', near(myPos[0], snapP1.x, 2), [myPos[0], snapP1.x]);
ok('interpolation: other champion matches linear blend of snapshots', rawCount > 0 && interpBad === null, interpBad);
ok('interpolation: fractional blends were exercised', interpSamples > 10, interpSamples);
ok('interpolation: other champion really moves between snapshots', otherMoved > 5, otherMoved);

/* ---------- 시나리오 A 계속: 전부 ack되면 예측 == 서버 ---------- */
console.log('scenario A2: drain until all frames acked');
let guard = 0;
while (!tickOnce(false) && guard++ < 200) { /* 남은 프레임을 서버가 모두 적용할 때까지 */ }
// 마지막 프레임이 적용된 직후 스냅샷 (그 사이에 서버가 빈 틱을 더 돌지 않도록 바로 보냄)
lastApplied = session.seq;
sendSnap();
ok('after all frames acked: pending is empty', session.pending.length === 0, session.pending.length);
const pm = session.world.champs.find(c => c.id === 'p1'), sm = server.champs.find(c => c.id === 'p1');
ok('predicted champion == server champion (x,y within 0.01)', near(pm.x, sm.x) && near(pm.y, sm.y), [pm.x, pm.y, sm.x, sm.y]);

/* ---------- 이벤트: 서버 이벤트만 ---------- */
console.log('events');
clientEvLog.push(...session.drainEvents());
ok('drainEvents returns exactly the server events sent in snapshots', JSON.stringify(clientEvLog) === JSON.stringify(snapEvLog),
   { got: clientEvLog.length, sent: snapEvLog.length });
ok('injected server text event delivered', clientEvLog.some(e => e.txt === 'SRV'), clientEvLog.length);
ok('drainEvents empties the queue', session.drainEvents().length === 0);

/* ---------- 시나리오 B: 시작 직후 world, 허수아비 없음 ---------- */
console.log('start world / ping');
const s0 = new OnlineSession(makeNet(), { t: 'start', tick: 0, you: 'p1', world: P.slimWorld(Core.createWorld({ players, dummy: false, devMode: false })) }, { predict: true, now });
ok('before first snapshot world is the start world', s0.world.champs.length === 2 && s0.me().id === 'p1');
ok('online flag and ping from net.rtt', s0.online === true && s0.ping === 0);

/* ---------- dev 필터 ---------- */
console.log('dev acts');
const nF = makeNet(), sF = new OnlineSession(nF, { t: 'start', tick: 0, you: 'p1', world: P.slimWorld(Core.createWorld({ players, dummy: false, devMode: false })) }, { test: false, now });
sF.send({ type: 'dev', id: 'p1', op: 'air' });
sF.send({ type: 'cast', id: 'p1', skill: 'q', ang: 0 });
sF.update(TICK);
const fF = nF.sent.find(m => m.t === 'f');
ok('test=false: dev act dropped, cast kept', fF && fF.acts && fF.acts.length === 1 && fF.acts[0].k === 'cast', fF);
const nT = makeNet(), sT = new OnlineSession(nT, { t: 'start', tick: 0, you: 'p1', world: P.slimWorld(Core.createWorld({ players, dummy: false, devMode: false })) }, { test: true, now });
sT.send({ type: 'dev', id: 'p1', op: 'air' });
sT.update(TICK);
const fT = nT.sent.find(m => m.t === 'f');
ok('test=true: dev act kept', fT && fT.acts && fT.acts[0].k === 'dev' && fT.acts[0].op === 'air', fT);

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
