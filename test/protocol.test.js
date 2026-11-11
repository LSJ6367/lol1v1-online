const path = require('path'), fs = require('fs'), assert = require('assert');
const Core = require('../shared/core.js'), P = require('../shared/protocol.js');
Core.setMap(JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/walk_rle.json'), 'utf8')));
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; };
// sanitize
ok(P.sanitizeFrame({ s: 0 }) === null, 'seq>=1');
const f = P.sanitizeFrame({ s: 1, mx: 3, my: 4, a: 1, acts: [{ k: 'cast', skill: 'q', ang: 1.23456 }, { k: 'dev', op: 'air' }, { k: 'x' }] }, false);
ok(f.mx === 0.6 && f.my === 0.8 && f.a === 1 && f.acts.length === 1 && f.acts[0].ang === 1.235, 'sanitize');
// 서버 시뮬과 클라 재시뮬 동등성
const players = [{ id: 'p1', key: 'darius', team: 0 }, { id: 'p2', key: 'yi', team: 1 }];
const server = Core.createWorld({ players, dummy: false, devMode: false });
const frames = [];
for (let s = 1; s <= 240; s++) {
  const raw = { s, mx: Math.cos(s / 20), my: Math.sin(s / 33), a: s % 50 < 10 ? 1 : 0 };
  if (s === 2) raw.acts = [{ k: 'lv', skill: 'q' }, { k: 'lv', skill: 'e' }];
  if (s === 100) raw.acts = [{ k: 'cast', skill: 'q', ang: 0 }];
  frames.push(P.sanitizeFrame(raw, false));
}
let snap = null, ack = 0;
for (let i = 0; i < 240; i++) {
  Core.step(server, P.frameToCmds('p1', frames[i]).concat(P.frameToCmds('p2', P.sanitizeFrame({ s: i + 1, mx: -0.5, my: 0.5 }))));
  Core.drainEvents(server);
  if (i === 150) { snap = P.slimWorld(server); ack = frames[i].s; }
}
// 클라: 스냅샷(ack=151) + 나머지 프레임 재시뮬. 상대(p2)는 마지막 입력 유지로 같은 입력이므로 완전 일치해야 함
const pred = P.restoreWorld(structuredClone(snap));
for (const fr of frames.filter(x => x.s > ack)) Core.step(pred, P.frameToCmds('p1', fr));
Core.drainEvents(pred);
ok(JSON.stringify(P.slimWorld(pred)) === JSON.stringify(P.slimWorld(server)), 'replay == server');
ok(JSON.stringify(snap).length < 20000, 'snapshot size ' + JSON.stringify(snap).length);
ok(P.eventsFor([{ type: 'text', to: 'p2' }, { type: 'text' }, { type: 'banner' }], 'p1', false).length === 1, 'eventsFor');
ok(P.mergeDropped({ acts: [{ k: 'lv', skill: 'q' }] }, { s: 5, mx: 0, my: 0, a: 0 }).acts.length === 1, 'merge');
console.log(pass + ' passed, 0 failed  (snapshot ' + JSON.stringify(snap).length + ' bytes)');
