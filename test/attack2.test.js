/* =====================================================================
   평타 v2 테스트 (DESIGN_ATTACK2.md, 원문 docs/spec/attack-v2.md)
   - T1 후딜 취소: 후딜 중 스킬을 쓰면 후딜이 끝나고 스킬이 같은 틱에 나간다. 선딜 중 스킬은 평타를 취소한다.
   - T2 스킬 뒤 평타 초기화: ATTACK_RESET_ON_SKILL이 true면 스킬이 끝나는 순간 평타 대기시간(atkCd)을 0으로.
     false면 후딜만 취소되고 대기시간은 그대로. 주문·물약은 대기시간을 건드리지 않는다.
   - T4·T5 평타 고정: 버튼을 누른 순간 대상을 고정하고 버튼을 떼도 계속 친다.
     조이스틱·성공한 스킬·점화·점멸·공중/끌림·대상 사망·지정 불가·거리 밖(1500 초과)에서 풀린다. 물약은 풀지 않는다.
   - 6레벨 기준. 포탑은 격리(죽은 상태), 자연 회복은 끔. 거리 단위는 유닛(히트박스 끝 기준).
   ===================================================================== */
const Core = require('../shared/core.js');
const fs = require('fs'), path = require('path');
const RLE = JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/walk_rle.json'), 'utf8'));
Core.setMap(RLE);

// 같은 core.js를 다시 읽되 ATTACK_RESET_ON_SKILL만 false로 고친 사본(따로 돌아감). 기본 코어와 섞이지 않음
function loadCoreWithFlag(flag) {
  const src = fs.readFileSync(path.join(__dirname, '../shared/core.js'), 'utf8');
  const from = 'const ATTACK_RESET_ON_SKILL = true;';
  if (!src.includes(from)) throw new Error('ATTACK_RESET_ON_SKILL 선언 줄을 찾지 못함');
  const m = { exports: {} };
  new Function('module', 'exports', src.replace(from, `const ATTACK_RESET_ON_SKILL = ${flag};`))(m, m.exports);
  m.exports.setMap(RLE);
  return m.exports;
}
const C_OFF = loadCoreWithFlag(false);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  → ' + extra : '')); };
const near = (a, b, e = 0.01) => Math.abs(a - b) <= e;
const TICK = Core.TICK, px = Core.px, ticks = sec => Math.round(sec / TICK);
const cmd = (type, id, extra) => Object.assign({ type, id }, extra || {});
const inp = (id, mx, my, atk) => cmd('input', id, { mx, my, atk: !!atk });

// 두 캐릭터(p1 = 나, e1 = 상대) 월드. 포탑 격리, 자연 회복 끔. 기본 위치: p1 (600,500)
function mk(C, p1key, e1key, opts) {
  const w = C.createWorld(Object.assign({ players: [{ id: 'p1', key: p1key, team: 0 }, { id: 'e1', key: e1key || 'yi', team: 1 }], dummy: false }, opts || {}));
  w.turrets.forEach(t => { t.dead = true; });
  w.champs.forEach(c => { c.stats.regen = 0; c.stats.manaRegen = 0; });
  const p = w.champs.find(c => c.id === 'p1');
  p.x = 600; p.y = 500;
  return w;
}
const P = w => w.champs.find(c => c.id === 'p1');
const E = w => w.champs.find(c => c.id === 'e1');
// 상대를 나와 gap 유닛(히트박스 끝 기준) 떨어진 오른쪽에 둠
const place = (w, gap) => { const p = P(w), e = E(w); e.x = p.x + px(gap + 110); e.y = p.y; };
const giveAll = c => { c.sk.q = 1; c.sk.w = 1; c.sk.e = 1; c.sk.r = 1; c.sp = 0; c.mana = c.stats.maxMana; };
const prepP = (w, key) => { const p = P(w); giveAll(p); if (key === 'garen') p.sk.r = 1; return p; };

// 평타 한 번을 선딜 끝(타격)까지 진행. 버튼을 누른 채 둔다(release 옵션으로 뗄 수 있음). 반환: 타격 성공 여부
function strikeOnce(C, w, p, release) {
  C.step(w, [inp(p.id, 0, 0, true)]);
  let g = 0;
  while (!(p.atk && p.atk.hit) && g++ < 2000) C.step(w, []);
  if (release) C.step(w, [inp(p.id, 0, 0, false)]);
  return g < 2000;
}

// ---------------------------------------------------------------------
// A. T1 후딜 취소: 모든 챔피언의 스킬이 후딜을 끊고 같은 틱에 시작
// ---------------------------------------------------------------------
// 각 항목: 상대 챔피언 키, 스킬, 이 스킬이 시작됐는지, 시전 중 이동 가능 여부(이동 입력 3틱이 먹는지)
const CASES = [
  { key: 'garen', k: 'q', ok: p => p.gq !== null, move: true },
  { key: 'garen', k: 'w', ok: p => p.gw !== null, move: true },
  { key: 'garen', k: 'e', ok: p => p.ge !== null, move: true },
  { key: 'garen', k: 'r', ok: p => p.gr !== null, move: false },
  { key: 'darius', k: 'q', ok: p => p.qPrep !== null, move: true },
  { key: 'darius', k: 'w', ok: p => p.wBuff === true, move: true },
  { key: 'darius', k: 'e', ok: p => p.cast !== null && p.cast.type === 'e', move: false },
  { key: 'darius', k: 'r', ok: p => p.cast !== null && p.cast.type === 'r', move: false },
  { key: 'yi', k: 'q', ok: p => p.yq !== null, move: false },
  { key: 'yi', k: 'w', ok: p => p.med !== null, move: false },
  { key: 'yi', k: 'e', ok: p => p.wuju > 0, move: true },
  { key: 'yi', k: 'r', ok: p => p.hl > 0, move: true },
  { key: 'aatrox', k: 'q', ok: p => p.aq !== null, move: false },
  { key: 'aatrox', k: 'w', ok: p => p.aw !== null, move: true },
  { key: 'aatrox', k: 'e', ok: p => p.dash !== null, move: false },
  { key: 'aatrox', k: 'r', ok: p => p.ar !== null, move: true },
];
const castName = c => `${c.key} ${c.k.toUpperCase()}`;
for (const c of CASES) {
  const w = mk(Core, c.key, c.key === 'yi' ? 'darius' : 'yi');
  const p = prepP(w, c.key);
  place(w, 100);
  strikeOnce(Core, w, p, true);                       // 평타 한 번 맞힘 → 후딜 중
  const inBack = !!p.atk && p.atk.hit;
  const x0 = p.x;
  Core.step(w, [cmd('cast', 'p1', { skill: c.k, ang: 0 })]);
  ok(`A1 ${castName(c)} 후딜 중 시전 → 후딜 끝, 스킬 같은 틱에 시작`, inBack && p.atk === null && c.ok(p));
  if (c.move) {
    for (let i = 0; i < 3; i++) Core.step(w, [inp('p1', 1, 0, false)]);
    ok(`A1 ${castName(c)} 시전 뒤 바로 이동 가능`, p.x > x0 + 1e-6, (p.x - x0).toFixed(2));
  }
}
// 선딜 중 스킬: 평타 취소(타격 없음). 선딜 끝까지 기다려도 상대 체력 그대로
{ const w = mk(Core, 'garen', 'darius');
  const p = prepP(w, 'garen'), e = E(w);
  place(w, 100);
  Core.step(w, [inp('p1', 0, 0, true)]);
  ok('A2 준비: 선딜 중', !!p.atk && !p.atk.hit);
  const hp0 = e.hp;
  Core.step(w, [cmd('cast', 'p1', { skill: 'q', ang: 0 }), inp('p1', 0, 0, false)]);   // 스킬과 함께 버튼을 뗌
  ok('A2 선딜 중 스킬 → 평타 취소(atk 없음), 스킬은 나감', p.atk === null && p.gq !== null);
  for (let i = 0; i < ticks(1); i++) Core.step(w, []);
  ok('A2 취소된 평타는 맞지 않음 (상대 체력 그대로)', e.hp === hp0, `${hp0} → ${e.hp}`);
}

// ---------------------------------------------------------------------
// B. T2 스킬 뒤 평타 초기화 (ATTACK_RESET_ON_SKILL = true)
// ---------------------------------------------------------------------
ok('B0 ATTACK_RESET_ON_SKILL 기본값 true로 내보냄', Core.ATTACK_RESET_ON_SKILL === true);
// B1 즉발 스킬: 시전 순간 대기시간 0, 누르고 있으면 같은 틱(다음 틱 이내) 평타 시작
const INSTANT = CASES.filter(c => !(c.key === 'darius' && (c.k === 'q' || c.k === 'e' || c.k === 'r')) && !(c.key === 'yi' && c.k === 'q') && !(c.key === 'aatrox' && c.k === 'q') && !(c.key === 'garen' && (c.k === 'e' || c.k === 'r')));
for (const c of INSTANT) {
  const w = mk(Core, c.key, c.key === 'yi' ? 'darius' : 'yi');
  const p = prepP(w, c.key);
  place(w, 100);
  strikeOnce(Core, w, p, true);                       // 평타 한 번 맞히고 뗌(후딜 중)
  Core.step(w, [cmd('cast', 'p1', { skill: c.k, ang: 0 }), inp('p1', 0, 0, false)]);
  const reset = p.atkCd === 0;                        // 시전 순간 대기시간 0
  // 다시 누르면 바로 평타. 아트록스 E는 0.2초 돌진 동안 평타가 막힘(돌진이 끝난 틱에 바로 나감)
  const maxT = c.key === 'aatrox' && c.k === 'e' ? ticks(0.25) : 1;
  let t = 0; Core.step(w, [inp('p1', 0, 0, true)]);
  while (!p.atk && t++ < maxT + 2) Core.step(w, [inp('p1', 0, 0, true)]);
  ok(`B1 ${castName(c)} 즉발: 시전 순간 평타 대기 0, 다시 누르면 바로 평타`, reset && !!p.atk && t <= maxT, `atkCd=${p.atkCd.toFixed(3)} t=${t}`);
  Core.step(w, [inp('p1', 0, 0, false)]);
}
// B1-held: 누르고 있는 채 스킬을 쓰면 같은 틱에 평타가 다시 나감(고정 없이 누르고 있기)
{ const w = mk(Core, 'garen', 'yi');
  const p = prepP(w, 'garen');
  place(w, 100);
  strikeOnce(Core, w, p, true);
  Core.step(w, [inp('p1', 0, 0, true)]);              // 다시 누름(고정, 후딜 중)
  Core.step(w, [cmd('cast', 'p1', { skill: 'q', ang: 0 })]);
  ok('B1 누르고 있는 채 가렌 Q → 같은 틱에 평타 다시 시작', !!p.atk && !p.atk.hit && p.gq !== null);
}
// B2 cast-time 스킬: 시전이 끝나는 틱에 0 (그 전에는 대기시간 유지)
const CAST_TIME = [
  { name: 'darius Q 준비', key: 'darius', k: 'q', busy: p => p.qPrep !== null },
  { name: 'darius E', key: 'darius', k: 'e', busy: p => p.cast !== null },
  { name: 'darius R', key: 'darius', k: 'r', busy: p => p.cast !== null },
  { name: 'aatrox Q 단계', key: 'aatrox', k: 'q', busy: p => p.aq !== null },
  { name: 'garen R', key: 'garen', k: 'r', busy: p => p.gr !== null },
  { name: 'yi Q 일격필살 등장', key: 'yi', k: 'q', busy: p => p.yq !== null },
];
for (const c of CAST_TIME) {
  const w = mk(Core, c.key, c.key === 'yi' ? 'darius' : 'yi');
  const p = prepP(w, c.key);
  place(w, 100);
  strikeOnce(Core, w, p, true);
  Core.step(w, [cmd('cast', 'p1', { skill: c.k, ang: 0 })]);
  let early = true, g = 0, endedAt0 = false;
  if (!c.busy(p)) early = false;
  while (c.busy(p) && g++ < ticks(3)) { if (!(p.atkCd > 0)) early = false; Core.step(w, []); }
  endedAt0 = !c.busy(p) && p.atkCd === 0;
  ok(`B2 ${c.name}: 시전 중에는 대기시간 유지`, early && g > 0, `${g}틱`);
  ok(`B2 ${c.name}: 끝나는 틱에 대기시간 0`, endedAt0, `atkCd=${p.atkCd}`);
}
// B3 Garen E 회전 끝: 회전 중에는 평타 없음, 끝나면 대기시간 0
{ const w = mk(Core, 'garen', 'darius');
  const p = prepP(w, 'garen');
  place(w, 100);
  strikeOnce(Core, w, p, true);
  Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]);
  let g = 0, noAtk = true;
  while (p.ge && g++ < ticks(4)) { if (p.atk) noAtk = false; Core.step(w, []); }
  ok('B3 가렌 E 회전 중에는 평타 시작 안 함', noAtk && g > 0);
  ok('B3 가렌 E 회전이 끝나는 틱에 대기시간 0', !p.ge && p.atkCd === 0, `atkCd=${p.atkCd}`);
}
// B4 주문·물약은 대기시간을 건드리지 않음 (점멸은 선딜을 끊지만 대기시간은 그대로)
{ const w = mk(Core, 'darius', 'yi');
  const p = prepP(w, 'darius'), e = E(w);
  p.potions = 2;                                       // 시작 세트 없이 만들었으므로 물약을 직접 채움
  place(w, 100);
  strikeOnce(Core, w, p, true);
  const a0 = p.atkCd;
  Core.step(w, [cmd('item', 'p1', { item: 'potion' })]);
  ok('B4 물약: 대기시간 그대로', near(p.atkCd, a0 - TICK, 1e-9) && !!p.potion, `${a0.toFixed(4)} → ${p.atkCd.toFixed(4)}`);
  p.spCd.flash = 0;
  Core.step(w, [cmd('spell', 'p1', { spell: 'flash', ang: 0, aimed: true })]);
  ok('B4 점멸: 대기시간 그대로(주문은 리셋 안 함)', p.atkCd > 0.5 && p.atk === null, `atkCd=${p.atkCd.toFixed(3)}`);
}
{ const w = mk(Core, 'darius', 'yi');
  const p = prepP(w, 'darius'), e = E(w);
  place(w, 100);
  strikeOnce(Core, w, p, true);
  const a0 = p.atkCd;
  p.spCd.ignite = 0;
  Core.step(w, [cmd('spell', 'p1', { spell: 'ignite' })]);
  ok('B4 점화: 대기시간 그대로, 후딜은 그대로 둠(atk 유지)', !!p.atk && p.atkCd > a0 - 2 * TICK && e.ign !== null, `atkCd=${p.atkCd.toFixed(3)}`);
}

// B5 ATTACK_RESET_ON_SKILL = false: 후딜만 취소, 대기시간은 그대로
{ const w = mk(C_OFF, 'garen', 'yi');
  const p = prepP(w, 'garen');
  place(w, 100);
  strikeOnce(C_OFF, w, p, true);
  const a0 = p.atkCd;
  C_OFF.step(w, [cmd('cast', 'p1', { skill: 'q', ang: 0 })]);
  ok('B5 플래그 끔: 즉발 스킬이어도 후딜은 끊김', p.atk === null && p.gq !== null);
  ok('B5 플래그 끔: 대기시간 그대로(0이 되지 않음)', near(p.atkCd, a0 - TICK, 1e-9) && p.atkCd > 0, `${a0.toFixed(4)} → ${p.atkCd.toFixed(4)}`);
}
{ const w = mk(C_OFF, 'darius', 'yi');
  const p = prepP(w, 'darius');
  place(w, 100);
  strikeOnce(C_OFF, w, p, true);
  C_OFF.step(w, [cmd('cast', 'p1', { skill: 'q', ang: 0 })]);
  let g = 0; while (p.qPrep && g++ < ticks(3)) C_OFF.step(w, []);
  ok('B5 플래그 끔: 다리우스 Q 준비가 끝나도 대기시간 유지(> 0)', !p.qPrep && p.atkCd > 0, `atkCd=${p.atkCd.toFixed(3)}`);
}

// ---------------------------------------------------------------------
// C. T3: 선딜 중 스킬 취소는 위 A2에서 확인. 시전 시간 있는 스킬도 평타 선딜을 취소
// ---------------------------------------------------------------------
{ const w = mk(Core, 'darius', 'yi');
  const p = prepP(w, 'darius'), e = E(w);
  place(w, 100);
  Core.step(w, [inp('p1', 0, 0, true)]);
  ok('C1 준비: 선딜 중(타격 전)', !!p.atk && !p.atk.hit);
  const hp0 = e.hp;
  Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 }), inp('p1', 0, 0, false)]);
  ok('C1 선딜 중 포획 시전 → 평타 취소, 시전 시작', p.atk === null && !!p.cast);
  let g = 0, atkDuring = false;
  while (p.cast && g++ < ticks(1)) { Core.step(w, []); if (p.atk) atkDuring = true; }
  ok('C1 포획 시전 중에는 평타가 시작되지 않음', !atkDuring && g > 0);
}

// ---------------------------------------------------------------------
// D. T4 고정: 한 번 누르면 버튼을 떼도 계속 공격
// ---------------------------------------------------------------------
{ const w = mk(Core, 'darius', 'yi');
  const p = prepP(w, 'darius'), e = E(w);
  place(w, 100);
  Core.step(w, [inp('p1', 0, 0, true)]);
  Core.step(w, [inp('p1', 0, 0, false)]);             // 한 틱만 누르고 뗌
  ok('D1 한 번 누른 뒤 고정 대상 e1', !!p.lock && p.lock.targetId === 'e1');
  let hits = 0, seen = p.atk;
  const hp0 = e.hp;
  for (let i = 0; i < ticks(6); i++) { Core.step(w, []); if (p.atk && p.atk !== seen) { seen = p.atk; hits++; } }
  ok('D1 버튼을 떼도 6초 동안 계속 평타(3회 이상)', hits >= 3 && e.hp < hp0, `${hits}회`);
}
// D2 대상이 사거리 밖으로 나가면 따라가고, 다시 사거리 안에 들어오면 평타 재개
{ const w = mk(Core, 'aatrox', 'darius');
  const p = prepP(w, 'aatrox'), e = E(w);
  place(w, 100);
  Core.step(w, [inp('p1', 0, 0, true)]);
  Core.step(w, [inp('p1', 0, 0, false)]);
  for (let i = 0; i < ticks(1); i++) Core.step(w, []);
  e.x = p.x + px(400 + 110); e.y = p.y;               // 사거리 밖(400)으로 빠짐
  const d0 = Core.edgeDist(p, e) / px(1);
  for (let i = 0; i < ticks(1.5); i++) Core.step(w, []);
  const d1 = Core.edgeDist(p, e) / px(1);
  ok('D2 사거리 밖: 고정 대상을 따라감', !!p.lock && d1 < d0 - 100, `${d0.toFixed(0)} → ${d1.toFixed(0)}`);
  let hit2 = false, seen = p.atk, g = 0;
  while (g++ < ticks(4) && !hit2) { Core.step(w, []); if (p.atk && p.atk !== seen) { seen = p.atk; if (p.atk.targetId === 'e1') hit2 = true; } }
  ok('D2 사거리 안에 들어온 뒤 다시 평타', hit2);
}
// D3 조이스틱 입력이 고정을 풀고, 누르고 있는 채로는 다시 고정하지 않음(떼었다 누르면 새로 고정)
{ const w = mk(Core, 'darius', 'yi');
  const p = prepP(w, 'darius'), e = E(w);
  place(w, 400);
  Core.step(w, [inp('p1', 0, 0, true)]);
  for (let i = 0; i < ticks(0.2); i++) Core.step(w, []);
  ok('D3 준비: 추적 고정 중', !!p.lock);
  Core.step(w, [inp('p1', -1, 0, true)]);
  ok('D3 조이스틱 입력 → 고정 해제', p.lock === null);
  let relock = false; for (let i = 0; i < ticks(1.5); i++) { Core.step(w, [inp('p1', 0, 0, true)]); if (p.lock) relock = true; }
  ok('D3 조이스틱 뒤 누르고 있는 동안 다시 고정하지 않음', !relock && !p.atk);
  Core.step(w, [inp('p1', 0, 0, false)]);
  Core.step(w, [inp('p1', 0, 0, true)]);
  ok('D3 떼었다 다시 누르면 새로 고정', !!p.lock && p.lock.targetId === 'e1');
}
// D4 조이스틱 뒤 누르고 있으면 사거리 안 대상은 누르고 있는 동안만 침(고정 아님)
{ const w = mk(Core, 'darius', 'yi');
  const p = prepP(w, 'darius'), e = E(w);
  place(w, 100);
  Core.step(w, [inp('p1', 0, 0, true)]);
  Core.step(w, [inp('p1', 0, 0, true)]);
  Core.step(w, [inp('p1', 1, 0, true)]);              // 조이스틱 → 고정 해제
  ok('D4 준비: 조이스틱으로 고정 해제', p.lock === null);
  let hits = 0, seen = p.atk;
  for (let i = 0; i < ticks(2); i++) { Core.step(w, [inp('p1', 0, 0, true)]); if (p.atk && p.atk !== seen) { seen = p.atk; hits++; } }
  ok('D4 누르고 있는 동안은 사거리 안 대상을 침', hits >= 1, `${hits}회`);
  Core.step(w, [inp('p1', 0, 0, false)]);
  let after = 0; seen = p.atk;
  for (let i = 0; i < ticks(3); i++) { Core.step(w, []); if (p.atk && p.atk !== seen) { seen = p.atk; after++; } }
  ok('D4 버튼을 떼면 더 이상 치지 않음(고정 없음)', after === 0 && p.lock === null, `${after}회`);
}
// D5 스킬 성공 → 고정 해제, 실패(쿨타임)는 고정 유지
{ const w = mk(Core, 'darius', 'yi');
  const p = prepP(w, 'darius');
  place(w, 100);
  Core.step(w, [inp('p1', 0, 0, true)]); Core.step(w, [inp('p1', 0, 0, false)]);
  p.cd.e = 5;
  Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]);
  ok('D5 쿨타임 중 E 실패 → 고정 유지', !!p.lock && p.cast === null);
  p.mana = 0; p.cd.e = 0;
  Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]);
  ok('D5 마나 부족 E 실패 → 고정 유지', !!p.lock && p.cast === null);
  p.mana = p.stats.maxMana;
  Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]);
  ok('D5 성공한 E → 고정 해제 · 포획 시전 시작', p.lock === null && !!p.cast && p.cast.type === 'e');
}
// D6 점화·점멸 성공 → 고정 해제 (실패한 점화는 유지)
{ const w = mk(Core, 'darius', 'yi');
  const p = prepP(w, 'darius'), e = E(w);
  place(w, 100);
  Core.step(w, [inp('p1', 0, 0, true)]); Core.step(w, [inp('p1', 0, 0, false)]);
  p.spCd.ignite = 99;
  Core.step(w, [cmd('spell', 'p1', { spell: 'ignite' })]);
  ok('D6 쿨타임 중 점화 실패 → 고정 유지', !!p.lock);
  p.spCd.ignite = 0;
  Core.step(w, [cmd('spell', 'p1', { spell: 'ignite' })]);
  ok('D6 점화 성공 → 고정 해제', p.lock === null && e.ign !== null);
}
{ const w = mk(Core, 'darius', 'yi');
  const p = prepP(w, 'darius');
  place(w, 100);
  Core.step(w, [inp('p1', 0, 0, true)]); Core.step(w, [inp('p1', 0, 0, false)]);
  Core.step(w, [cmd('spell', 'p1', { spell: 'flash', ang: 0, aimed: true })]);
  ok('D6 점멸 성공 → 고정 해제', p.lock === null);
}
// D7 물약은 고정을 풀지 않음
{ const w = mk(Core, 'darius', 'yi');
  const p = prepP(w, 'darius');
  p.potions = 2;
  place(w, 100);
  Core.step(w, [inp('p1', 0, 0, true)]); Core.step(w, [inp('p1', 0, 0, false)]);
  Core.step(w, [cmd('item', 'p1', { item: 'potion' })]);
  ok('D7 물약 사용 → 고정 그대로', !!p.lock && p.lock.targetId === 'e1' && !!p.potion);
}
// D8 대상 사망·지정 불가 → 고정 해제, 1500 초과 → 해제, 내가 공중에 뜨면 해제
{ const w = mk(Core, 'darius', 'yi');
  const p = prepP(w, 'darius'), e = E(w);
  place(w, 100);
  Core.step(w, [inp('p1', 0, 0, true)]); Core.step(w, [inp('p1', 0, 0, false)]);
  e.dead = true; e.respawn = 5; Core.step(w, []);
  ok('D8 대상이 죽으면 고정 해제', p.lock === null);
}
{ const w = mk(Core, 'darius', 'yi');
  const p = prepP(w, 'darius'), e = E(w);
  place(w, 100);
  Core.step(w, [inp('p1', 0, 0, true)]); Core.step(w, [inp('p1', 0, 0, false)]);
  e.untarget = true; Core.step(w, []);
  ok('D8 대상이 지정 불가가 되면 고정 해제', p.lock === null);
}
{ const w = mk(Core, 'darius', 'yi');
  const p = prepP(w, 'darius'), e = E(w);
  place(w, 100);
  Core.step(w, [inp('p1', 0, 0, true)]); Core.step(w, [inp('p1', 0, 0, false)]);
  e.x = p.x + px(1600 + 110); e.y = p.y; Core.step(w, []);
  ok('D8 대상이 1500 유닛을 넘어가면 고정 해제', p.lock === null);
}
{ const w = mk(Core, 'darius', 'yi');
  const p = prepP(w, 'darius');
  place(w, 100);
  Core.step(w, [inp('p1', 0, 0, true)]); Core.step(w, [inp('p1', 0, 0, false)]);
  p.air = 0.5; Core.step(w, []);
  ok('D8 공중에 뜨면 고정 해제', p.lock === null && p.atk === null);
}
// D9 고정 중 누르고 있으면 누르기 한 번이 다시 대상을 고름(이전 고정은 버림, 가장 가까운 대상)
{ const w = mk(Core, 'darius', 'yi', { dummy: true });
  const p = prepP(w, 'darius'), e = E(w), d = w.dummies[0];
  place(w, 150);                                      // e1이 사거리 안
  d.x = p.x; d.y = p.y + px(900);                     // 더미는 멀리
  Core.step(w, [inp('p1', 0, 0, true)]); Core.step(w, [inp('p1', 0, 0, false)]);
  ok('D9 준비: e1 고정', !!p.lock && p.lock.targetId === 'e1');
  // 더미를 사거리 안 가장 가까운 곳에 둠. 누르고 있는 고정은 e1을 계속 침(더미 무시)
  d.x = p.x; d.y = p.y + px(40 + 55 + 70);            // 히트박스 끝 기준 약 40
  let other = 0, hits = 0, seen = p.atk;
  for (let i = 0; i < ticks(4); i++) { Core.step(w, []); if (p.atk && p.atk !== seen) { seen = p.atk; hits++; if (p.atk.targetId !== 'e1') other++; } }
  ok('D9 고정 대상이 있으면 사거리 안의 다른(더 가까운) 대상은 무시', hits >= 2 && other === 0 && d.total === 0, `${hits}회, 더미 ${other}회`);
  // 떼었다가 다시 누르면 그 순간 가장 가까운 더미로 바뀜 (더미는 3초 넘게 맞지 않으면 제자리로 돌아가므로 다시 세움)
  Core.step(w, [inp('p1', 0, 0, false)]);
  d.x = p.x; d.y = p.y + px(40 + 55 + 70); d.homeT = 0;
  Core.step(w, [inp('p1', 0, 0, true)]);
  ok('D9 다시 누르면 가장 가까운 대상(더미)으로 고정 변경', !!p.lock && p.lock.targetId === 'dummy1', JSON.stringify(p.lock));
}
// D10 사거리 안 대상이 없을 때 누르면 "사거리 내 대상 없음" + 사거리 표시 (대상 고정 없음)
{ const w = mk(Core, 'darius', 'yi');
  const p = prepP(w, 'darius'), e = E(w);
  e.x = p.x + px(1400 + 110); e.y = p.y;             // 찾는 거리(1200) 밖
  Core.step(w, [inp('p1', 0, 0, true)]);
  const evs = Core.drainEvents(w);
  ok('D10 찾는 거리 안 대상이 없으면 고정 없음', p.lock === null);
  ok('D10 "사거리 내 대상 없음" 텍스트와 사거리 표시', evs.some(x => x.type === 'text' && x.txt === '사거리 내 대상 없음') && evs.some(x => x.type === 'fx' && x.fx === 'atkRange'));
}
// D11 대상 없이 누르고 있다가 사거리 안에 들어오면 평타 누른 것과 같이 고정
{ const w = mk(Core, 'darius', 'yi');
  const p = prepP(w, 'darius'), e = E(w);
  e.x = p.x + px(1400 + 110); e.y = p.y;
  Core.step(w, [inp('p1', 0, 0, true)]); Core.drainEvents(w);
  e.x = p.x + px(900 + 110); e.y = p.y;             // 찾는 거리 안으로 들어옴 (버튼 계속 누름)
  Core.step(w, []);
  ok('D11 누르고 있는 채 찾는 거리 안에 들어오면 고정', !!p.lock && p.lock.targetId === 'e1');
}

// ---------------------------------------------------------------------
// E. 고정 대상만 노림: 고정 중에는 사거리 안에 다른 대상이 있어도 치지 않음
// ---------------------------------------------------------------------
{ const w = mk(Core, 'darius', 'yi', { dummy: true });
  const p = prepP(w, 'darius'), e = E(w), d = w.dummies[0];
  place(w, 100);                                      // e1 사거리 안에서 고정
  d.x = p.x + px(900); d.y = p.y;
  Core.step(w, [inp('p1', 0, 0, true)]); Core.step(w, [inp('p1', 0, 0, false)]);
  d.x = p.x; d.y = p.y + px(40 + 55 + 70);           // 더미가 더 가깝게 사거리 안으로
  let other = 0, seen = p.atk;
  for (let i = 0; i < ticks(3); i++) { Core.step(w, []); if (p.atk && p.atk !== seen) { seen = p.atk; if (p.atk.targetId !== 'e1') other++; } }
  ok('E1 고정 대상 e1을 계속 치고 더미는 맞히지 않음', other === 0 && d.total === 0, `더미 ${d.total.toFixed(1)}`);
}

// ---------------------------------------------------------------------
// F. 결정성: 같은 입력 스트림 → 같은 월드(고정·스킬·취소 포함)
// ---------------------------------------------------------------------
{ const script = {
    0: [inp('p1', 0, 0, true)], 2: [inp('p1', 0, 0, false)],
    120: [cmd('cast', 'p1', { skill: 'w', ang: 0 })],
    200: [inp('p1', 0, 0, true)], 205: [inp('p1', 0, 0, false)],
    330: [inp('p1', -1, 0, false)],
    360: [cmd('cast', 'p1', { skill: 'e', ang: 0 })],
    500: [inp('p1', 0, 0, true)], 505: [inp('p1', 0, 0, false)],
    700: [cmd('spell', 'p1', { spell: 'ignite' })],
    800: [cmd('item', 'p1', { item: 'potion' })],
  };
  const play = () => {
    const w = mk(Core, 'darius', 'yi');
    const p = prepP(w, 'darius'); place(w, 300);
    for (let i = 0; i < 1000; i++) Core.step(w, script[i] || []);
    return w;
  };
  const a = play(), b = play();
  ok('F1 같은 명령 스트림 1000틱 → 월드 JSON 동일', JSON.stringify(a) === JSON.stringify(b));
  ok('F1 시나리오가 실제로 일어남(고정·스킬 반영)', E(a).hp < E(a).stats.maxHp && P(a).atkCd >= 0);
}

// ---------------------------------------------------------------------
// G. 상수·내보내기
// ---------------------------------------------------------------------
ok('G1 CHASE.search 1200 (찾는 거리 그대로)', Core.CHASE.search === 1200);
ok('G2 WINDUP 22% · BACKSWING 13%', near(Core.WINDUP, 0.22, 1e-12) && near(Core.BACKSWING, 0.13, 1e-12));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
