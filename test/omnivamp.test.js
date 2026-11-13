/* =====================================================================
   모든 피해 흡혈 테스트 (DESIGN_AATROX.md §1-1, A9 / DESIGN.md §1-1)
   - 흡혈 = 입힌 피해(체력+보호막에 실제로 들어간 양) × 흡혈 수치 × (광역이면 0.33). 최대 체력을 넘지 않음.
   - 출혈 틱·포탑 피해는 흡혈 없음. 마법 피해는 마법 저항 100/(100+MR) 적용 뒤 양을 기준으로 함.
   - 자연 회복은 끄고(quiet), 허수아비는 기본 위치(700,500)에 둬서 자동 복귀가 끼지 않게 합니다.
   ===================================================================== */
const Core = require('../shared/core.js');
const fs = require('fs'), path = require('path');
Core.setMap(JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/walk_rle.json'), 'utf8')));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  → ' + extra : '')); };
const near = (a, b, e = 0.01) => Math.abs(a - b) <= e;
const px = Core.px, TICK = Core.TICK;
const run = (w, sec, cmds) => { const n = Math.round(sec / TICK); for (let i = 0; i < n; i++) Core.step(w, i === 0 ? cmds : []); };
const cmd = (type, id, extra) => Object.assign({ type, id }, extra || {});
const inp = (id, mx, my, atk) => cmd('input', id, { mx, my, atk: !!atk });
const quiet = c => { c.stats.regen = 0; c.stats.manaRegen = 0; };   // 자연 회복 끄기
const lvl = (w, c, pts) => { for (const [k, n] of Object.entries(pts)) for (let i = 0; i < n; i++) Core.step(w, [cmd('levelup', c.id, { skill: k })]); };
const pool = u => u.hp + Core.shieldOf(u);   // 체력 + 보호막
const hasHealText = w => w.events.some(e => e.type === 'text' && /^\+\d/.test(e.txt));
// 챔피언 두 명(p1 팀0, e1 팀1). 포탑 격리, 허수아비 없음, 자연 회복 끔. 가해자 p1은 (600,500)
const pair = (k1, k2) => {
  const w = Core.createWorld({ players: [{ id: 'p1', key: k1, team: 0 }, { id: 'e1', key: k2, team: 1 }], dummy: false });
  w.turrets.forEach(t => { t.dead = true; });
  w.champs.forEach(quiet);
  const a = w.champs[0], e = w.champs[1];
  a.x = 600; a.y = 500;
  return { w, a, e };
};
// 대상 t를 가해자 c의 오른쪽(각도 ang)에 히트박스 틈 gap 유닛만큼 떨어뜨림
const place = (c, t, gap, ang = 0) => { const dd = px(gap) + px(c.r) + px(t.r); t.x = c.x + Math.cos(ang) * dd; t.y = c.y + Math.sin(ang) * dd; };
// 평타 한 번 적중: 적중 틱 직전·직후 대상 체력+보호막 감소와 가해자 체력 증가
const strikeOnce = (w, a, t) => {
  let g = 0;
  while ((a.atk || a.atkCd > 0) && g++ < 2000) Core.step(w, []);
  const p0 = pool(t), h0 = a.hp;
  Core.step(w, [inp(a.id, 0, 0, true)]);
  while (!(a.atk && a.atk.hit) && g++ < 4000) Core.step(w, []);
  const out = { dealt: p0 - pool(t), gain: a.hp - h0 };
  Core.step(w, [inp(a.id, 0, 0, false)]);
  return out;
};

// ---------------------------------------------------------------------
// 1. 흡혈 0이면 어디서도 회복 없음 (기존 규칙 그대로)
// ---------------------------------------------------------------------
{ const { w, a, e } = pair('garen', 'darius');
  place(a, e, 20, Math.PI);
  a.hp = a.stats.maxHp - 500;
  const h0 = a.hp;
  for (let i = 0; i < 3; i++) strikeOnce(w, a, e);
  ok('1 흡혈 0: 평타 3번 뒤 가해자 체력 변화 없음', a.hp === h0, `${h0} → ${a.hp}`);
  ok('1 흡혈 0: 회복 글자 없음', !hasHealText(w)); }

{ const w = Core.createWorld({ players: [{ id: 'p1', key: 'garen', team: 0 }], dummy: true });
  w.turrets.forEach(t => { t.dead = true; }); w.champs.forEach(quiet);
  const g = w.champs[0], d = w.dummies[0];
  g.x = 600; g.y = 500; lvl(w, g, { e: 1 }); g.hp = g.stats.maxHp - 500;
  const h0 = g.hp;
  run(w, 3.2, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]);
  ok('1 흡혈 0: 가렌 E가 허수아비를 맞혀도 가렌 체력 그대로', d.total > 0 && g.hp === h0, `피해 ${d.total.toFixed(1)}, 체력 ${h0} → ${g.hp}`); }

// ---------------------------------------------------------------------
// 2. 평타: 보호막·방어력을 거친 뒤의 피해 × 흡혈 (가렌 → 다리우스, 다리우스 방어력 63)
// ---------------------------------------------------------------------
{ const { w, a, e } = pair('garen', 'darius');
  a.bonus.omni = 0.2;
  place(a, e, 20, Math.PI);
  a.hp = a.stats.maxHp - 500;
  const r = strikeOnce(w, a, e);
  const exp = 91.5 / (1 + 0.63);                  // 가렌 공격력 91.5, 다리우스 방어력 63 (6레벨)
  ok('2 평타 피해 = 공격력 ÷ (1 + 방어력 0.01)', near(r.dealt, exp, 1e-6), r.dealt.toFixed(4));
  ok('2 평타 흡혈 = 방어력 적용 후 피해 × 20%', near(r.gain, 0.2 * exp, 1e-6), r.gain.toFixed(4)); }

// ---------------------------------------------------------------------
// 3. 고정 피해도 흡혈. 보호막에 막힌 양도 포함. 초과 피해(남은 체력보다 큰 부분)는 제외. 최대 체력 넘지 않음
// ---------------------------------------------------------------------
{ const { w, a, e } = pair('garen', 'darius');
  a.bonus.omni = 0.2; a.hp = a.stats.maxHp - 500;
  const h0 = a.hp; Core.dealTrue(w, a, e, 100);
  ok('3 고정 피해 100 → 흡혈 20', near(a.hp - h0, 20, 1e-9), a.hp - h0); }
{ const { w, a, e } = pair('garen', 'darius');
  a.bonus.omni = 0.2; a.hp = a.stats.maxHp - 500;
  Core.addShield(e, 50, 5, 'test');
  const e0 = pool(e), h0 = a.hp;
  Core.dealTrue(w, a, e, 100);
  ok('3 보호막 50에 100 고정 피해 → 대상 체력+보호막 100 감소, 흡혈 20(보호막 부분 포함)', near(e0 - pool(e), 100, 1e-9) && near(a.hp - h0, 20, 1e-9), `감소 ${e0 - pool(e)}, 흡혈 ${a.hp - h0}`);
  ok('3 보호막 부분도 흡혈 대상(보호막 소진)', e.shields.length === 0); }
{ const { w, a, e } = pair('garen', 'darius');
  a.bonus.omni = 0.2; a.hp = a.stats.maxHp - 500;
  e.hp = 30;
  const h0 = a.hp; Core.dealTrue(w, a, e, 100);
  ok('3 남은 체력 30에 100 피해 → 실제로 들어간 30만 흡혈 (초과분 제외) = 6', near(a.hp - h0, 6, 1e-9) && e.hp === 0, `흡혈 ${a.hp - h0}`); }
{ const { w, a, e } = pair('garen', 'darius');
  a.bonus.omni = 1.0; a.hp = a.stats.maxHp - 5;
  Core.dealTrue(w, a, e, 100);
  ok('3 흡혈로 회복해도 최대 체력을 넘지 않음', a.hp === a.stats.maxHp, a.hp); }

// ---------------------------------------------------------------------
// 4. 광역 0.33: 다리우스 Q, 가렌 E. 단일 대상 피해는 전부
// ---------------------------------------------------------------------
{ const w = Core.createWorld({ players: [{ id: 'p1', key: 'garen', team: 0 }], dummy: true });
  w.turrets.forEach(t => { t.dead = true; }); w.champs.forEach(quiet);
  const g = w.champs[0], d = w.dummies[0];
  g.bonus.omni = 0.2; g.hp = g.stats.maxHp - 500;
  const h0 = g.hp;
  Core.dealPhys(w, g, d, 100, { aoe: true });
  const h1 = g.hp;
  Core.dealPhys(w, g, d, 100);
  ok('4 광역 피해 100 → 흡혈 100 × 0.2 × 0.33 = 6.6', near(h1 - h0, 6.6, 1e-9), h1 - h0);
  ok('4 단일 피해 100 → 흡혈 20', near(g.hp - h1, 20, 1e-9), g.hp - h1); }

{ const w = Core.createWorld({ players: [{ id: 'p1', key: 'garen', team: 0 }], dummy: true });
  w.turrets.forEach(t => { t.dead = true; }); w.champs.forEach(quiet);
  const g = w.champs[0], d = w.dummies[0];
  g.x = 600; g.y = 500;                             // 허수아비(700,500) 옆
  g.bonus.omni = 0.2; g.hp = g.stats.maxHp - 500;
  lvl(w, g, { e: 1 });
  const h0 = g.hp;
  run(w, 3.2, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]);
  const got = g.hp - h0;
  ok('4 가렌 E(광역) 허수아비 피해 합의 0.066배만큼 흡혈', d.total > 0 && near(got, d.total * 0.2 * 0.33, 1e-6), `피해 ${d.total.toFixed(3)}, 흡혈 ${got.toFixed(3)}`); }

{ // 다리우스 Q(광역): 손잡이 구간(출혈 없음)에 허수아비. 손잡이 = 17.5 + 0.35 × 공격력 89 = 48.65
  const w = Core.createWorld({ players: [{ id: 'p1', key: 'darius', team: 0 }], dummy: true });
  w.turrets.forEach(t => { t.dead = true; }); w.champs.forEach(quiet);
  const a = w.champs[0], d = w.dummies[0];
  a.x = 700 - px(150); a.y = 500; a.bonus.omni = 0.2; a.hp = a.stats.maxHp - 300;   // 허수아비(700,500)와 중심 거리 150유닛
  lvl(w, a, { q: 1 });
  const h0 = a.hp;
  run(w, 1.2, [cmd('cast', 'p1', { skill: 'q', ang: 0 })]);
  const got = a.hp - h0;
  ok('4 다리우스 Q 손잡이 피해 48.65 (출혈 없음)', near(d.total, 48.65, 1e-6) && !d.bleed, d.total.toFixed(4));
  ok('4 다리우스 Q 흡혈 = 48.65 × 0.2 × 0.33', near(got, 48.65 * 0.2 * 0.33, 1e-6), got.toFixed(4)); }

// ---------------------------------------------------------------------
// 5. 출혈 틱·포탑 피해는 흡혈 없음
// ---------------------------------------------------------------------
{ const { w, a, e } = pair('darius', 'garen');   // 다리우스 평타 → 가렌에게 출혈
  a.bonus.omni = 0.5; a.hp = a.stats.maxHp - 500;
  place(a, e, 20, 0);
  const r = strikeOnce(w, a, e);
  const hAfterHit = a.hp;
  ok('5 출혈이 걸린 상태(평타 적중 뒤)', !!e.bleed && r.gain > 0, `흡혈 ${r.gain.toFixed(2)}`);
  run(w, 6);   // 출혈 5초 + 여유
  ok('5 출혈 틱이 계속 들어가도 가해자 체력은 그대로(흡혈 없음)', a.hp === hAfterHit && !e.bleed, `${hAfterHit} → ${a.hp}`); }

{ const w = Core.createWorld({ players: [{ id: 'p1', key: 'darius', team: 0 }], dummy: false });   // 포탑 살려 둠
  const a = w.champs[0];
  quiet(a); a.bonus.omni = 0.5;
  const t = w.turrets.find(u => u.team === 1);     // 적 포탑
  a.x = t.x - px(150); a.y = t.y;                  // 포탑 사거리 안
  a.hp = a.stats.maxHp - 500;
  const seq = [a.hp];
  for (let i = 0; i < Math.round(4 / TICK); i++) { Core.step(w, []); seq.push(a.hp); }
  const monotone = seq.every((v, i) => i === 0 || v <= seq[i - 1] + 1e-12);
  ok('5 포탑 공격을 맞는 4초 동안 가해자 체력은 줄기만 함(흡혈 없음)', seq[seq.length - 1] < seq[0] && monotone, `${seq[0]} → ${seq[seq.length - 1]}`); }

// ---------------------------------------------------------------------
// 6. 체력 회복 상한 · 마법 피해 (마법 저항 100/(100+MR) 정확히)
// ---------------------------------------------------------------------
{ const { w, a, e } = pair('darius', 'garen');   // 가렌 마법 저항 32 + 1.55×5 = 39.75
  const m0 = e.hp;
  const got = Core.dealMagic(w, a, e, 100);
  const drop = m0 - e.hp;
  ok('6 가렌(마법 저항 39.75)에게 마법 100 → 100 ÷ 1.3975', near(drop, 100 / 1.3975, 1e-9) && near(got, 100 / 1.3975, 1e-9), drop.toFixed(6));
  ok('6 마법 저항 39.75 확인', near(Core.mrOf(e), 39.75, 1e-9), Core.mrOf(e)); }

{ const { w, a } = pair('darius', 'garen');
  const d = w.dummies[0] || Core.createWorld({ players: [], dummy: true }).dummies[0];   // 허수아비 마법 저항 50 (기본 0)
  d.mr = 50; const d0 = d.hp;
  Core.dealMagic(w, a, d, 100);
  ok('6 허수아비(마법 저항 50)에게 마법 100 → 66.67', near(d0 - d.hp, 100 / 1.5, 1e-9), (d0 - d.hp).toFixed(6)); }

{ const { w, a, e } = pair('darius', 'garen');
  a.bonus.omni = 0.2; a.hp = a.stats.maxHp - 500;
  const h0 = a.hp;
  const got = Core.dealMagic(w, a, e, 100);
  ok('6 마법 피해 흡혈은 마법 저항 적용 뒤 양 기준(0.2 × 100 ÷ 1.3975)', near(a.hp - h0, 0.2 * 100 / 1.3975, 1e-9) && near(got, 100 / 1.3975, 1e-9), (a.hp - h0).toFixed(6)); }

// ---------------------------------------------------------------------
// 7. 같은 명령이면 같은 결과 (결정성)
// ---------------------------------------------------------------------
{ const play = () => {
    const { w, a, e } = pair('garen', 'darius');
    a.bonus.omni = 0.2; place(a, e, 20, Math.PI); a.hp = a.stats.maxHp - 400;
    for (let i = 0; i < 3; i++) strikeOnce(w, a, e);
    Core.dealTrue(w, a, e, 77);
    return w;
  };
  const x = play(), y = play();
  ok('7 같은 명령 → 월드 JSON 동일(흡혈 포함)', JSON.stringify(x) === JSON.stringify(y)); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
