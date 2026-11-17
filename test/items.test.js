'use strict';
/* =====================================================================
   시작 아이템 테스트 (DESIGN_ITEMS.md §0 I1~I8, §1). 도란의 검 · 도란의 방패 · 체력 물약
   - 데이터·세트: ITEMS, START_SETS, startSetOrder(가렌은 방패 먼저), itemDefs(툴팁)
   - 도란의 검: 공격력 +10(평타 피해 정확), 체력 +80(최대 체력에 더해지고 시작은 가득), 모든 피해 흡혈 2.5%
   - 도란의 방패: 체력 +110, 재생 5초당 4(체력 재생 경로), 챔피언에게 피해를 입으면 8초 동안 20(초당 2.5, 다시 셈),
     포탑·허수아비 피해는 제외, 점화(챔피언이 건 것)는 포함
   - 체력 물약: 개수 2, 15초 동안 120(초당 8), 마시는 중 사용 불가('사용 중'), 침묵·공중에서도 사용, 죽으면 불가,
     점화 중 회복 ×0.6, 아트록스 세계의 종결자 중 회복 ×1.5
   - 부활: 아이템·물약 개수 유지(다시 채우지 않음), 개발 도구 쿨타임 초기화는 물약을 채우지 않음
   - 세트 선택: 방은 첫 번째 선택지가 기본, 직접 고른 세트는 챔피언을 바꿔도 유지, 준비 뒤에는 바꿀 수 없음.
     createWorld는 세트를 안 넘기면 빈 챔피언(아이템·물약 없음)
   - 프로토콜: 행동 it(물약)은 살아남고 모르는 아이템은 버림, 결정성
   자연 회복은 끄고(quiet), 포탑은 격리. 거리 단위는 유닛, 좌표는 px.
   ===================================================================== */
const Core = require('../shared/core.js');
const P = require('../shared/protocol.js');
const { Room } = require('../server/room.js');
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const REAL_MAP = JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/walk_rle.json'), 'utf8'));
Core.setMap(REAL_MAP);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  → ' + extra : '')); };
const near = (a, b, e = 0.01) => Math.abs(a - b) <= e;
const px = Core.px, TICK = Core.TICK;
const cmd = (type, id, extra) => Object.assign({ type, id }, extra || {});
const inp = (id, mx, my, atk) => cmd('input', id, { mx, my, atk: !!atk });
const item = (id) => cmd('item', id, { item: 'potion' });
const quiet = c => { c.stats.regen = c.items.includes('doranShield') ? Core.ITEMS.doranShield.regen5 : 0; c.stats.manaRegen = 0; };   // 기본 재생만 끔(도란의 방패 재생은 남김)
const lvl = (w, c, pts) => { for (const [k, n] of Object.entries(pts)) for (let i = 0; i < n; i++) Core.step(w, [cmd('levelup', c.id, { skill: k })]); };
const run = (w, sec, cmds) => { const n = Math.round(sec / TICK); for (let i = 0; i < n; i++) Core.step(w, i === 0 ? cmds : []); };
const fxOf = (w, name) => Core.drainEvents(w).filter(e => e.type === 'fx' && e.fx === name);
const hasText = (w, s) => w.events.some(e => e.type === 'text' && e.txt === s);
const AT = { x: 400, y: 700 };
const MAXHP = Core.calcStats('darius', 6).maxHp;                        // 6레벨 다리우스 기본 최대 체력(아이템 없음)
const at = (c, f, s, ang = 0) => ({ x: c.x + px(f) * Math.cos(ang) - px(s) * Math.sin(ang), y: c.y + px(f) * Math.sin(ang) + px(s) * Math.cos(ang) });
const put = (t, c, f, s, ang = 0) => { const p = at(c, f, s, ang); t.x = p.x; t.y = p.y; };   // 기준 c에서 (앞 f, 옆 s) 유닛
// p1(팀 0)은 AT에 둔다. set: 시작 세트(없으면 빈 챔피언). enemy: e1(팀 1). dummy: 허수아비(팀 1). 포탑 격리, 자연 회복 끔
const mk = (o) => {
  o = o || {};
  const players = [{ id: 'p1', key: o.key || 'darius', team: 0, set: o.set }];
  if (o.enemy) players.push({ id: 'e1', key: o.enemyKey || 'darius', team: 1 });
  const w = Core.createWorld({ players, dummy: o.dummy !== false, devMode: true, runes: o.runes });   // o.runes: 룬 끔 옵션 전달(없으면 기본 켜짐)
  w.turrets.forEach(t => { t.dead = true; });
  w.champs.forEach(quiet);
  const a = w.champs[0];
  a.x = AT.x; a.y = AT.y;
  return { w, a, d: w.dummies[0] || null, e: w.champs[1] || null };
};

// ---------------------------------------------------------------------
// 0. 데이터 · 세트 선택지 · 툴팁 정보
// ---------------------------------------------------------------------
ok('0 ITEMS 값: 검 공격력 10·체력 80·흡혈 2.5%', Core.ITEMS.doranBlade.ad === 10 && Core.ITEMS.doranBlade.hp === 80 && Core.ITEMS.doranBlade.omni === 0.025);
ok('0 ITEMS 값: 방패 체력 110·5초당 4·8초 동안 20', Core.ITEMS.doranShield.hp === 110 && Core.ITEMS.doranShield.regen5 === 4 && Core.ITEMS.doranShield.recover === 20 && Core.ITEMS.doranShield.recoverT === 8);
ok('0 ITEMS 값: 물약 120·15초·개수 2', Core.ITEMS.potion.heal === 120 && Core.ITEMS.potion.dur === 15 && Core.ITEMS.potion.start === 2);
ok('0 START_SETS: blade → 도란의 검, shield → 도란의 방패(물약은 세트 밖)', JSON.stringify(Core.START_SETS) === JSON.stringify({ blade: ['doranBlade'], shield: ['doranShield'] }));
ok('0 startSetOrder: 가렌 = shield, blade', JSON.stringify(Core.startSetOrder('garen')) === JSON.stringify(['shield', 'blade']));
ok('0 startSetOrder: 다리우스·마스터 이·아트록스 = blade, shield',
  ['darius', 'yi', 'aatrox'].every(k => JSON.stringify(Core.startSetOrder(k)) === JSON.stringify(['blade', 'shield'])));
{ const defs = Core.itemDefs();
  const blade = defs.find(d => d.key === 'doranBlade'), shield = defs.find(d => d.key === 'doranShield'), pot = defs.find(d => d.key === 'potion');
  ok('0 itemDefs: 3개, 이름·액티브 여부', defs.length === 3 && blade.name === '도란의 검' && !blade.active && pot.active && pot.name === '체력 물약');
  ok('0 itemDefs: 스탯은 있는 것만', JSON.stringify(blade.stats) === JSON.stringify({ ad: 10, hp: 80, omni: 0.025 }) && JSON.stringify(shield.stats) === JSON.stringify({ hp: 110 }) && Object.keys(pot.stats).length === 0);
  ok('0 itemDefs: 모르는 키는 뺌', Core.itemDefs(['nope', 'potion']).length === 1); }

// ---------------------------------------------------------------------
// 1. 도란의 검 (blade): 공격력 +10, 최대 체력 +80(시작 가득), 평타 피해 정확, 흡혈 2.5%
// ---------------------------------------------------------------------
{ const { w, a } = mk({ set: 'blade' });
  ok('1 검: 추가 공격력 10(bonus.ad)', a.bonus.ad === 10 && Core.bonusAD(a) === 10, a.bonus.ad);
  ok('1 검: 총 공격력 = 기본 + 10', Core.totalAD(a) === a.stats.ad + 10, Core.totalAD(a) + ' / ' + a.stats.ad);
  ok('1 검: 최대 체력 +80 (6레벨 다리우스 ' + MAXHP + ' → ' + a.stats.maxHp + ')', a.stats.maxHp === MAXHP + 80);
  ok('1 검: 시작 체력은 가득', a.hp === a.stats.maxHp, a.hp);
  ok('1 검: 흡혈 2.5%(bonus.omni)', a.bonus.omni === 0.025);
  ok('1 검: 아이템 목록 = [doranBlade], 물약 2개', JSON.stringify(a.items) === '["doranBlade"]' && a.potions === 2 && a.potion === null); }
{ // 평타 피해 정확: 허수아비(방어력 0)에게 총 공격력 그대로, 흡혈 × 2.5% 회복.
  // 가렌을 쓴다: 다리우스는 평타에 과다출혈이 붙어서 피해 합에 출혈 틱이 섞임(출혈은 평타 한 번의 피해가 아님)
  const { w, a, d } = mk({ key: 'garen', set: 'blade', runes: false });   // 룬 끔: 기존 수치 검사 (DESIGN_RUNES Q7). 정복자 중첩이 붙으면 총 공격력이 달라짐
  put(d, a, 130, 0);
  a.hp = a.stats.maxHp - 50;
  const expect = Core.calcStats('garen', 6).ad + 10;                 // 기본 공격력 91.5 + 검 10
  const hp0 = d.hp, me0 = a.hp;
  Core.step(w, [inp('p1', 0, 0, true)]);
  run(w, 0.6);
  Core.drainEvents(w);
  const dealt = hp0 - d.hp;
  ok('1 검: 평타 피해 = 총 공격력 정확(기본 91.5 + 검 10 = 101.5)', near(dealt, expect, 1e-9) && near(Core.totalAD(a), expect, 1e-9), dealt);
  ok('1 검: 흡혈 = 입힌 피해 × 2.5%', near(a.hp - me0, dealt * 0.025, 1e-9), (a.hp - me0).toFixed(6)); }

// ---------------------------------------------------------------------
// 2. 도란의 방패 (shield)
// ---------------------------------------------------------------------
{ const w0 = Core.createWorld({ players: [{ id: 'p1', key: 'darius', team: 0, set: 'shield' }], dummy: false });
  ok('2 방패: 재생 수치(stats.regen)에 5초당 4가 더해짐(표시와 재생 경로가 같은 값)', w0.champs[0].stats.regen === Core.calcStats('darius', 6).regen + 4, w0.champs[0].stats.regen); }
{ const { a } = mk({ set: 'shield' });
  ok('2 방패: 추가 체력 110, 최대 체력 +110', a.bonus.hp === 110 && a.stats.maxHp === MAXHP + 110, a.stats.maxHp);
  ok('2 방패: 시작 체력은 가득', a.hp === a.stats.maxHp);
  ok('2 방패: 추가 공격력·흡혈 없음', a.bonus.ad === 0 && a.bonus.omni === 0 && Core.totalAD(a) === a.stats.ad); }
{ // 재생: 5초당 4 (체력 재생 경로, quiet이라 아이템 재생만 남음)
  const { w, a } = mk({ set: 'shield' });
  a.hp = a.stats.maxHp - 100;
  const h0 = a.hp;
  run(w, 5);
  ok('2 방패: 5초 동안 재생 정확히 4', near(a.hp - h0, 4, 1e-6), (a.hp - h0).toFixed(6)); }
{ // 피해 회복: 챔피언에게 맞으면 8초 동안 초당 2.5(= 20). 맞은 직후부터 셈
  const { w, a, e } = mk({ set: 'shield', enemy: true });
  a.hp = a.stats.maxHp - 200;
  Core.dealPhys(w, e, a, 100);                                       // 챔피언 e1의 평타 피해(방어력 적용, 값은 상관없음)
  const hit = a.hp, dsA = a.dsRec;
  ok('2 방패: 챔피언에게 맞으면 회복 8초 시작', dsA === 8, dsA);
  run(w, 8);
  ok('2 방패: 8초 뒤 회복 합 20 + 재생 6.4 (정확)', near(a.hp - hit, 20 + 0.8 * 8, 1e-6), (a.hp - hit).toFixed(6));
  ok('2 방패: 8초가 끝나면 회복 남은 시간 0', a.dsRec === 0, a.dsRec);
  const before = a.hp;
  run(w, 1);
  ok('2 방패: 끝난 뒤에는 재생 0.8/초만', near(a.hp - before, 0.8, 1e-6), (a.hp - before).toFixed(6)); }
{ // 다시 셈(겹치지 않음): 0초에 맞고 4초에 또 맞으면 12초까지 초당 2.5 → 합 30(40이 아님)
  const { w, a, e } = mk({ set: 'shield', enemy: true });
  a.hp = a.stats.maxHp - 300;
  Core.dealPhys(w, e, a, 100);
  const hp1 = a.hp;
  run(w, 4);
  const hp2 = a.hp;
  Core.dealPhys(w, e, a, 100);
  const hp3 = a.hp;
  ok('2 방패: 다시 맞으면 남은 시간이 8초로 다시 시작', a.dsRec === 8, a.dsRec);
  run(w, 8);
  const hp4 = a.hp;
  ok('2 방패: 첫 4초 = 재생 3.2 + 회복 10', near(hp2 - hp1, 3.2 + 10, 1e-6), (hp2 - hp1).toFixed(6));
  ok('2 방패: 다시 맞은 뒤 8초 = 재생 6.4 + 회복 20(겹치지 않음)', near(hp4 - hp3, 6.4 + 20, 1e-6), (hp4 - hp3).toFixed(6));
  const after = a.hp;
  run(w, 1);
  ok('2 방패: 12초 뒤 회복 없음(합 30, 40 아님)', near(a.hp - after, 0.8, 1e-6), (a.hp - after).toFixed(6)); }
{ // 포탑 피해는 해당 없음: 진짜 포탑이 맞혀도 회복이 시작되지 않음
  const { w, a } = mk({ set: 'shield' });
  const t = w.turrets.find(x => x.id === 't_foe');
  t.dead = false; t.hp = t.maxHp;
  a.x = t.x - px(400); a.y = t.y;                                    // 포탑 사거리(775) 안, 중심 거리 400
  a.hp = a.stats.maxHp - 100;
  let minHp = a.hp, maxDs = 0;
  for (let i = 0; i < 300; i++) { Core.step(w, []); maxDs = Math.max(maxDs, a.dsRec); minHp = Math.min(minHp, a.hp); }
  Core.drainEvents(w);
  ok('2 방패: 포탑이 맞힘(체력이 줄었음)', minHp < a.stats.maxHp - 100 + 1e-6, minHp.toFixed(2));
  ok('2 방패: 포탑 피해는 회복을 시작하지 않음', maxDs === 0, maxDs); }
{ // 허수아비(가해자가 챔피언이 아님): 회복 시작 안 함
  const { w, a, d } = mk({ set: 'shield' });
  a.hp = a.stats.maxHp - 100;
  Core.dealTrue(w, d, a, 50);                                        // 허수아비가 준 피해 (가해자 kind = dummy)
  ok('2 방패: 허수아비가 준 피해는 회복을 시작하지 않음', a.dsRec === 0, a.dsRec);
  ok('2 방패: 피해 자체는 들어감', near(a.hp, a.stats.maxHp - 150, 1e-9), a.hp); }
{ // 점화(챔피언이 건 것)도 포함: 틱 피해 1초 뒤 회복 시작
  const { w, a, e } = mk({ set: 'shield', enemy: true });
  a.ign = { t: 0, src: e.id, n: 0 };
  run(w, 1);
  ok('2 방패: 챔피언이 건 점화 틱 피해도 회복 시작(8)', a.dsRec === 8, a.dsRec);
  Core.drainEvents(w); }

// ---------------------------------------------------------------------
// 3. 체력 물약
// ---------------------------------------------------------------------
{ // 시작 개수 2 → 사용하면 1, 15초(900틱, 사용한 틱 포함) 동안 초당 8 → 합 120, 끝나면 마시는 중 해제
  const { w, a } = mk({ set: 'blade' });
  ok('3 물약: 시작 개수 2, 마시는 중 아님', a.potions === 2 && a.potion === null);
  a.hp = a.stats.maxHp - 200;
  const h0 = a.hp;
  Core.step(w, [item('p1')]);
  const evs = fxOf(w, 'potion');
  ok('3 물약: 사용하면 개수 1, 15초 시작, 이벤트 fx potion', a.potions === 1 && a.potion !== null && evs.length === 1 && evs[0].id === 'p1', JSON.stringify(a.potion));
  run(w, 1 - TICK);
  ok('3 물약: 1초 동안 8 회복', near(a.hp - h0, 8, 1e-6), (a.hp - h0).toFixed(6));
  run(w, 14);
  ok('3 물약: 15초 동안 합 120 정확(검은 재생 없음)', near(a.hp - h0, 120, 1e-6), (a.hp - h0).toFixed(6));
  ok('3 물약: 15초가 지나면 마시는 중 끝', a.potion === null, JSON.stringify(a.potion));
  ok('3 물약: 끝난 뒤 개수는 1 그대로', a.potions === 1, a.potions); }
{ // 두 번째 물약: 첫 번째가 끝난 뒤 사용 → 개수 0. 그 다음에는 '없음'
  const { w, a } = mk({ set: 'blade' });
  Core.step(w, [item('p1')]);
  run(w, 15 - TICK);
  Core.step(w, [item('p1')]);
  ok('3 물약: 끝난 뒤 두 번째 사용 → 개수 0', a.potions === 0 && a.potion !== null, a.potions);
  run(w, 15 - TICK);
  Core.step(w, [item('p1')]);
  ok('3 물약: 개수 0 → 다시 누르면 없음(개수 그대로)', a.potions === 0 && a.potion === null && hasText(w, '없음'));
  Core.drainEvents(w); }
{ // 마시는 중 사용 불가: '사용 중', 개수 그대로
  const { w, a } = mk({ set: 'blade' });
  Core.step(w, [item('p1')]);
  Core.step(w, [item('p1')]);
  ok('3 물약: 마시는 중 다시 누르면 개수 그대로(1), 사용 중 글자', a.potions === 1 && hasText(w, '사용 중'), a.potions);
  Core.drainEvents(w); }
{ // 개수 0: 없음
  const { w, a } = mk({ set: 'blade' });
  a.potions = 0;
  Core.step(w, [item('p1')]);
  ok('3 물약: 개수 0이면 "없음" 글자, 아무 일도 없음', a.potion === null && hasText(w, '없음'));
  Core.drainEvents(w); }
{ // 침묵 중에도 사용 가능
  const { w, a } = mk({ set: 'blade' });
  a.silence = { t: 10 };
  a.hp = a.stats.maxHp - 200;
  Core.step(w, [item('p1')]);
  ok('3 물약: 침묵 중에도 사용 가능', a.potions === 1 && a.potion !== null);
  ok('3 물약: 침묵 중 회복도 됨', near(a.hp, a.stats.maxHp - 200 + 8 * TICK, 1e-6), a.hp); }
{ // 공중에 뜸 중에도 사용 가능
  const { w, a } = mk({ set: 'blade' });
  a.air = 1; a.airMax = 1;
  Core.step(w, [item('p1')]);
  ok('3 물약: 공중에 뜸 중에도 사용 가능', a.potions === 1 && a.potion !== null); }
{ // 죽었을 때는 사용 불가(아무 글자도 없음, 개수 그대로)
  const { w, a } = mk({ set: 'blade' });
  a.dead = true; a.respawn = 5;
  Core.step(w, [item('p1')]);
  ok('3 물약: 죽은 상태에서는 사용 불가(개수 그대로)', a.potions === 2 && a.potion === null); }
{ // 점화 중 회복 ×0.6 (ign 5초, 실제 피해 틱은 없음: n = 5). 처음 5초 = 8 × 0.6 × 5 = 24, 나머지 10초 = 80 → 합 104
  const { w, a, e } = mk({ set: 'blade', enemy: true });
  a.ign = { t: 0, src: e.id, n: 5 };                                  // 틱 피해는 이미 다 나갔고, 남은 5초 동안 치유 감소만 걸림
  a.hp = a.stats.maxHp - 300; const h0 = a.hp;
  Core.step(w, [item('p1')]);                                         // 1틱: 물약 사용 틱도 회복
  run(w, 5 - TICK);                                                   // 300틱 = 5초 동안 점화 중
  ok('3 물약: 점화 중 처음 5초 회복 = 24(×0.6)', near(a.hp - h0, 24, 1e-6), (a.hp - h0).toFixed(6));
  run(w, 10);                                                         // 이후 600틱 = 10초, 점화 끝 → ×1
  ok('3 물약: 점화가 끝난 뒤 나머지 10초는 ×1 → 합 104', near(a.hp - h0, 104, 1e-6), (a.hp - h0).toFixed(6)); }
{ // 아트록스 세계의 종결자 중 회복 ×1.5 (1단계 → 50%): 1초에 8 × 1.5 = 12
  const { w, a } = mk({ key: 'aatrox', set: 'blade' });
  lvl(w, a, { r: 1 });
  Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]);
  ok('3 물약: 아트록스 궁극기 발동 확인', !!a.ar);
  a.hp = a.stats.maxHp - 300; const h0 = a.hp;
  Core.step(w, [item('p1')]);
  run(w, 1 - TICK);                                                   // 사용한 틱 포함 60틱 = 1초
  ok('3 물약: 세계의 종결자 중 회복 ×1.5 → 1초에 12', near(a.hp - h0, 12, 1e-6), (a.hp - h0).toFixed(6)); }

// ---------------------------------------------------------------------
// 4. 부활 · 개발 도구
// ---------------------------------------------------------------------
{ // 점화 틱으로 죽임(실제 처치 경로). 물약은 마시는 중, 방패 회복도 시작된 상태 → 부활 뒤 아이템·물약 개수만 남음
  const { w, a, e } = mk({ set: 'shield', enemy: true });
  Core.step(w, [item('p1')]);                                        // 물약 1개 사용(개수 2 → 1)
  a.hp = 10;
  a.ign = { t: 0, src: e.id, n: 0 };
  run(w, 1.1);
  ok('4 부활: 점화 틱으로 죽음', a.dead);
  ok('4 죽으면 물약·도란의 방패 회복 사라짐', a.potion === null && a.dsRec === 0);
  run(w, 5.2);
  ok('4 부활: 체력 가득(추가 체력 포함)', !a.dead && a.hp === a.stats.maxHp && a.stats.maxHp === MAXHP + 110, a.hp + ' / ' + a.stats.maxHp);
  ok('4 부활: 아이템 유지', JSON.stringify(a.items) === '["doranShield"]' && a.bonus.hp === 110);
  ok('4 부활: 물약 개수 1 그대로(다시 채우지 않음)', a.potions === 1, a.potions);
  ok('4 부활: 물약 상태·회복 상태 초기화', a.potion === null && a.dsRec === 0); }
{ // 개발 도구 '쿨타임 초기화'(ready)는 물약 개수를 채우지 않음(가득 채우면 2가 됐을 것)
  const { w, a } = mk({ set: 'blade' });
  Core.step(w, [item('p1')]);
  ok('4 개발: 사용 뒤 개수 1', a.potions === 1);
  a.mana = 0;
  Core.step(w, [cmd('dev', 'p1', { op: 'ready' })]);
  ok('4 개발: 쿨타임 초기화는 물약 개수를 채우지 않음(1 그대로)', a.potions === 1, a.potions);
  ok('4 개발: 쿨타임 초기화는 마나를 채움(기존 동작 유지)', a.mana >= a.stats.maxMana - 1e-9, a.mana); }

// ---------------------------------------------------------------------
// 5. 세트 선택 규칙 (엔진 기본값, 방 기본값, 혼자 연습 기본값)
// ---------------------------------------------------------------------
{ const w = Core.createWorld({ players: [{ id: 'p1', key: 'garen', team: 0 }], dummy: false });
  const c = w.champs[0];
  ok('5 엔진: 세트를 안 넘기면 빈 챔피언(아이템·물약 없음)', JSON.stringify(c.items) === '[]' && c.potions === 0 && c.bonus.hp === 0 && c.stats.maxHp === Core.calcStats('garen', 6).maxHp); }
{ const w = Core.createWorld({ players: [{ id: 'p1', key: 'garen', team: 0, set: 'nope' }], dummy: false });
  ok('5 엔진: 모르는 세트는 빈 챔피언', w.champs[0].items.length === 0 && w.champs[0].potions === 0); }
{ const w = Core.createWorld({ players: [{ id: 'p1', key: 'darius', team: 0, set: 'shield' }, { id: 'p2', key: 'garen', team: 1, set: 'blade' }], dummy: false });
  ok('5 엔진: 세트 지정 → 아이템 목록과 물약 2개', JSON.stringify(w.champs[0].items) === '["doranShield"]' && w.champs[0].potions === 2);
  ok('5 엔진: 세트 지정 → 검 목록', JSON.stringify(w.champs[1].items) === '["doranBlade"]' && w.champs[1].bonus.ad === 10); }
{ // 방: 기본값 = 챔피언의 첫 번째 선택지, 챔피언을 바꾸면 기본값도 따라감, 직접 고르면 유지
  const room = new Room({ code: 'ABCD', test: false, countdownSec: 3 });
  const conn = { send() {} };
  room.addPlayer({ pid: 'p1', name: 'A', conn });
  room.addPlayer({ pid: 'p2', name: 'B', conn });
  const sets = () => room.players.map(p => p.set).join(',');
  ok('5 방: 첫 입장 기본 세트 = 다리우스 첫 선택지 blade', sets() === 'blade,blade');
  room.pick('p1', 'garen');
  ok('5 방: 가렌을 고르면 기본 세트 = shield(첫 선택지)', room.find('p1').set === 'shield');
  room.pick('p1', 'yi');
  ok('5 방: 직접 고르지 않은 상태에서 챔피언을 바꾸면 새 챔피언의 첫 선택지', room.find('p1').set === 'blade');
  ok('5 방: 세트를 고르면 setExplicit', room.pickSet('p1', 'shield') === null && room.find('p1').setExplicit === true);
  room.pick('p1', 'garen');
  ok('5 방: 직접 고른 세트는 챔피언을 바꿔도 그대로(shield 유지)', room.find('p1').set === 'shield');
  room.pick('p1', 'aatrox');
  ok('5 방: 직접 고른 세트는 다른 챔피언으로 바꿔도 그대로(shield)', room.find('p1').set === 'shield');
  ok('5 방: 세트 잘못된 값은 bad_msg', room.pickSet('p1', 'nope') === 'bad_msg');
  ok('5 방: 없는 플레이어는 bad_msg', room.pickSet('zz', 'blade') === 'bad_msg');
  room.setReady('p1', true);
  ok('5 방: 준비한 뒤에는 세트를 바꿀 수 없음(bad_state)', room.pickSet('p1', 'blade') === 'bad_state' && room.find('p1').set === 'shield');
  ok('5 방: 준비한 뒤에는 챔피언도 못 바꿈(기존 규칙)', room.pick('p1', 'yi') === 'bad_state');
  room.pickSet('p2', 'shield');
  room.setReady('p2', true);                                         // 둘 다 준비 → 카운트다운 → 시작 (countdownSec 3 이라 아직 selecting 아님)
  ok('5 방: 카운트다운 중에는 세트 변경 불가(준비 상태)', room.pickSet('p2', 'blade') === 'bad_state'); }
{ // 혼자 연습(LocalSession): 세트를 안 넘기면 첫 선택지, 넘기면 그대로
  const sessCtx = { Core, window: {} };
  vm.createContext(sessCtx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../client/session_local.js'), 'utf8'), sessCtx);
  const LS = sessCtx.window.LocalSession;
  const s1 = new LS([{ id: 'p1', key: 'garen', team: 0 }], 'p1');
  ok('5 혼자 연습: 가렌 기본 = 도란의 방패', JSON.stringify(s1.me().items) === '["doranShield"]' && s1.me().potions === 2);
  const s2 = new LS([{ id: 'p1', key: 'garen', team: 0, set: 'blade' }], 'p1');
  ok('5 혼자 연습: 넘긴 세트는 그대로(검)', JSON.stringify(s2.me().items) === '["doranBlade"]'); }

// ---------------------------------------------------------------------
// 6. 프로토콜: it 행동, 허용 목록, 명령 변환, 실제 사용
// ---------------------------------------------------------------------
{ const f = P.sanitizeFrame({ s: 3, acts: [{ k: 'it', s: 'potion' }, { k: 'it', s: 'nope' }, { k: 'it' }, { k: 'it', s: 'potion', extra: 1 }] }, false);
  ok('6 프로토콜: it(potion)은 남고, 모르는 항목·s 없음은 버림', f.acts.length === 2 && f.acts[0].k === 'it' && f.acts[0].s === 'potion' && f.acts[1].s === 'potion', JSON.stringify(f.acts));
  ok('6 프로토콜: it 행동은 테스트 도구 허용과 무관하게 살아남음', P.sanitizeFrame({ s: 1, acts: [{ k: 'it', s: 'potion' }] }, false).acts.length === 1);
  ok('6 프로토콜: ITEM_KEYS = [potion]', JSON.stringify(P.ITEM_KEYS) === '["potion"]');
  const cmds = P.frameToCmds('p1', P.sanitizeFrame({ s: 1, acts: [{ k: 'it', s: 'potion' }] }, false));
  ok('6 프로토콜: it → {type:item, id, item:potion} 명령', cmds.some(c => c.type === 'item' && c.id === 'p1' && c.item === 'potion'), JSON.stringify(cmds));
  const { w, a } = mk({ set: 'blade' });
  a.hp = a.stats.maxHp - 100;
  Core.step(w, P.frameToCmds('p1', P.sanitizeFrame({ s: 1, mx: 0, my: 0, acts: [{ k: 'it', s: 'potion' }] }, false)));
  ok('6 프로토콜: 프레임 행동으로 실제로 물약을 마심', a.potions === 1 && a.potion !== null);
  ok('6 프로토콜: START_SET_KEYS = [blade, shield]', JSON.stringify(P.START_SET_KEYS) === '["blade","shield"]');
  ok('6 프로토콜 버전 18(선딜 30%·후딜 0, 현재 버전 고정 검사)', P.VERSION === 18, P.VERSION); }

// ---------------------------------------------------------------------
// 7. 결정성: 같은 입력이면 같은 월드(물약·방패·검 포함)
// ---------------------------------------------------------------------
function scenario() {
  const w = Core.createWorld({ players: [{ id: 'p1', key: 'garen', team: 0, set: 'shield' }, { id: 'e1', key: 'yi', team: 1, set: 'blade' }], dummy: false, devMode: false });
  for (const c of w.champs) quiet(c);
  w.champs[0].x = AT.x; w.champs[0].y = AT.y; w.champs[1].x = AT.x + px(160); w.champs[1].y = AT.y;
  for (let i = 0; i < 900; i++) {
    const cmds = [inp('p1', Math.cos(i / 30), Math.sin(i / 40), i % 90 < 30), inp('e1', -1, 0, i % 70 < 25)];
    if (i === 100) cmds.push(item('p1'));
    if (i === 500) cmds.push(item('p1'));                             // 첫 물약이 아직 남아 있어 '사용 중'으로 막힘
    if (i === 800) cmds.push(item('e1'));                             // e1은 중간에 한 번 죽고 부활해 있음(죽었을 때 사용 불가 · 부활 뒤 사용)
    Core.step(w, cmds);
  }
  return w;
}
{ const w1 = scenario(), w2 = scenario();
  ok('7 결정성: 같은 입력이면 같은 월드(JSON 동일)', JSON.stringify(P.slimWorld(w1)) === JSON.stringify(P.slimWorld(w2)));
  /* 시나리오: p1은 100틱에 마시고 500틱은 '사용 중'으로 막힘(개수 1). e1은 부활해 있는 800틱에 마심(개수 1) */
  ok('7 결정성: 시나리오가 실제로 일어남(사용·거부·처치가 반영됨)', w1.champs[0].potions === 1 && w1.champs[1].potions === 1 && !w1.champs[1].dead,
    JSON.stringify([w1.champs[0].potions, w1.champs[1].potions, w1.champs[1].dead])); }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
