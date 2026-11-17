'use strict';
/* 포탑 3:00 소멸 (사용자 요청 2026-11-17): 양쪽 포탑이 게임 시간 3:00에 사라지고, 승리 판정(포탑 파괴)으로 치지 않음 */
const fs = require('fs'), path = require('path'), assert = require('assert');
const Core = require('../shared/core.js');
const { Room } = require('../server/room.js');
Core.setMap(JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/walk_rle.json'), 'utf8')));
let pass = 0; const ok = (name, c, info) => { assert(c, name + (info ? ' ' + info : '')); pass++; console.log('  ok  ', name, info || ''); };

// 1) 엔진: 2:59.9엔 있고 3:00에 사라짐, 이벤트 1회
{
  const w = Core.createWorld({ players: [{ id: 'a', key: 'darius', team: 0 }], dummy: false });
  ok('시작 시 포탑 2개', w.turrets.length === 2);
  w.time = Core.TURRET_CFG.vanishAt - 0.05; Core.step(w, []);
  ok('3:00 직전에는 그대로', w.turrets.length === 2);
  Core.drainEvents(w);
  for (let i = 0; i < 10; i++) Core.step(w, []);
  ok('3:00에 사라짐', w.turrets.length === 0 && w.turretsGone === true);
  const ev = Core.drainEvents(w).filter(e => e.fx === 'turretsGone');
  ok('turretsGone 이벤트 한 번', ev.length === 1);
  for (let i = 0; i < 60; i++) Core.step(w, []);
  ok('그 뒤로 다시 생기지 않음 · 오류 없음', w.turrets.length === 0);
}
// 2) 테스트 도구 +1분/+5분으로 시간을 넘겨도 사라짐
{
  const w = Core.createWorld({ players: [{ id: 'a', key: 'garen', team: 0 }], dummy: true, devMode: true });
  Core.step(w, [{ type: 'dev', id: 'a', op: 'time', sec: 300 }]); Core.step(w, []);
  ok('시간 건너뛰기로 3:00을 넘기면 사라짐', w.turrets.length === 0);
}
// 3) 포탑을 치던 평타·고정 중이어도 오류 없이 해제
{
  const w = Core.createWorld({ players: [{ id: 'a', key: 'darius', team: 0 }], dummy: false });
  const c = w.champs[0], t = w.turrets.find(x => x.team === 1);
  c.x = t.x - 40; c.y = t.y + 10;
  w.time = Core.TURRET_CFG.vanishAt - 0.3;
  Core.step(w, [{ type: 'input', id: 'a', mx: 0, my: 0, atk: true }]);
  for (let i = 0; i < 40; i++) Core.step(w, [{ type: 'input', id: 'a', mx: 0, my: 0, atk: i < 2 }]);
  ok('포탑이 사라진 뒤 고정 해제', !c.lock || !Core.unitOf(w, c.lock.targetId));
}
// 4) 서버 방: 포탑 소멸은 승리(포탑 파괴)가 아님
{
  const fake = () => ({ msgs: [], send(s) { this.msgs.push(JSON.parse(s)); return true; }, close() {} });
  const room = new Room({ code: 'VANI', countdownSec: 0 });
  const c1 = fake(), c2 = fake();
  room.addPlayer({ pid: 'p1', name: 'a', conn: c1 }); room.addPlayer({ pid: 'p2', name: 'b', conn: c2 });
  room.setReady('p1', true); room.setReady('p2', true);
  ok('게임 시작', room.state === 'playing');
  room.world.time = Core.TURRET_CFG.vanishAt - 0.1;
  for (let i = 0; i < 30; i++) room.tick();
  ok('포탑이 사라져도 게임 계속', room.state === 'playing' && room.world.turrets.length === 0);
  ok('end 메시지 없음', !c1.msgs.some(m => m.t === 'end') && !c2.msgs.some(m => m.t === 'end'));
}
console.log(`\n${pass} passed, 0 failed`);
