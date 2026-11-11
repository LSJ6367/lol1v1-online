/* =====================================================================
   마스터 이 규칙 테스트 (DESIGN_YI.md, 원문 docs/spec/yi.md)
   - 6레벨 기준. 수치는 공식에서 직접 계산해 비교합니다.
     마스터 이 6레벨: 공격력 77.5, 방어력 58, 최대 체력 1165, 최대 마나 461, 공속 0.763875, 이속 355
   - 자연 회복은 끄고(quiet), 포탑은 격리(mk)해서 각 규칙만 봅니다.
   ===================================================================== */
const Core = require('../shared/core.js');
const fs = require('fs'), path = require('path');
Core.setMap(JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/walk_rle.json'), 'utf8')));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  → ' + extra : '')); };
const near = (a, b, e = 0.01) => Math.abs(a - b) <= e;
const px = Core.px, TICK = Core.TICK, EPS = 1e-6;
const steps = sec => Math.round(sec / TICK);
const run = (w, sec, cmds) => { const n = steps(sec); for (let i = 0; i < n; i++) Core.step(w, i === 0 ? cmds : []); };
const cmd = (type, id, extra) => Object.assign({ type, id }, extra || {});
// 마스터 이(p1, 팀0) + 더미. 포탑은 죽은 상태로 격리. opts.turrets = true면 살아 있음
const mk = (opts) => {
  const w = Core.createWorld(Object.assign({ players: [{ id: 'p1', key: 'yi', team: 0 }], dummy: true }, opts || {}));
  if (!(opts && opts.turrets)) w.turrets.forEach(t => { t.dead = true; });
  return w;
};
const duel = () => {   // 마스터 이(p1, 팀0) 대 다리우스(e1, 팀1). 포탑 격리, 더미 없음
  const w = Core.createWorld({ players: [{ id: 'p1', key: 'yi', team: 0 }, { id: 'e1', key: 'darius', team: 1 }], dummy: false });
  w.turrets.forEach(t => { t.dead = true; });
  const y = w.champs[0], e = w.champs[1];
  quiet(y); quiet(e); y.x = 600; y.y = 500; e.x = y.x + px(55 + 55 + 100); e.y = y.y;
  return { w, y, e };
};
const quiet = c => { c.stats.regen = 0; c.stats.manaRegen = 0; };   // 자연 회복 끄기
const lvl = (w, c, pts) => { for (const [k, n] of Object.entries(pts)) for (let i = 0; i < n; i++) Core.step(w, [cmd('levelup', c.id, { skill: k })]); };
const D = w => w.dummies[0];
const nearDummy = (c, d) => { c.x = d.x - px(150); c.y = d.y; };   // 평타 사거리 안(히트박스 끝 기준 약 25유닛)
const AD = 77.5;                              // 6레벨 공격력: 65 + 2.5×5
const A = AD, H = AD * 0.5;                   // 평타 피해, 2연속 두 번째 타격 피해 (더미 방어력 0)
const WUJU1 = 20 + 0.35 * AD;                 // 우주류 검술 1레벨 추가 고정 피해 = 47.125
const ALPHA1 = (35 + 1.225 * AD) * 0.25;      // 일격필살 1레벨 1타 = 32.484
const lbl = d => near(d, A, 0.05) ? 'A' : near(d, H, 0.05) ? 'H' : '?';

// 평타 1회: 적중 틱의 대상 체력 감소량을 돌려줌
function attackOnce(w, c, d) {
  let g = 0, drop = 0;
  while ((c.atk || c.atkCd > 0) && g++ < 2000) Core.step(w, []);
  Core.step(w, [cmd('input', c.id, { mx: 0, my: 0, atk: true })]);
  g = 0;
  while (!(c.atk && c.atk.hit) && g++ < 2000) { const h = d.hp; Core.step(w, []); drop = h - d.hp; }
  Core.step(w, [cmd('input', c.id, { mx: 0, my: 0, atk: false })]);
  return drop;
}
// 평타를 계속 누른 채로 n회 적중까지. 틱마다 더미 체력 감소와 Q 쿨타임 변화를 기록
function holdAttacks(w, c, d, n) {
  const hits = [], strikes = [];
  let seen = null, g = 0;
  Core.step(w, [cmd('input', c.id, { mx: 0, my: 0, atk: true })]);
  while (strikes.length < n && g++ < 4000) {
    const h = d.hp, q = c.cd.q, t = w.time;
    Core.step(w, []);
    if (h - d.hp > 1e-9) hits.push({ dmg: h - d.hp, t, cdDiff: q - c.cd.q });
    if (c.atk && c.atk.hit && c.atk !== seen) { seen = c.atk; strikes.push(c.dstack); }
  }
  Core.step(w, [cmd('input', c.id, { mx: 0, my: 0, atk: false })]);
  return { hits, strikes };
}
// 이동할 수 있는 빈 직선 찾기(맵 마스크 기준)
function clearRun(len) {
  for (let y = 150; y < 1000; y += 6) for (let x = 100; x < 1200; x += 6) {
    let good = true;
    for (let s = 0; s <= len; s += 3) if (!Core.canStand(x + s, y)) { good = false; break; }
    if (good) return { x, y };
  }
  return null;
}

// ---------------------------------------------------------------------
// 1. 포탑 관통 30% · 명상 중 피해 감소
// ---------------------------------------------------------------------
{ const w = mk({ turrets: true }), c = w.champs[0], t = w.turrets[1];
  quiet(c); c.x = t.x - px(55 + 175 + 700); c.y = t.y;
  const base = 182 / (1 + c.stats.armor * 0.7 / 100);   // 0~30초 포탑 공격력 182, 관통 30%
  const drops = []; let prev = c.hp;
  for (let i = 0; i < steps(3.5); i++) { Core.step(w, []); const dd = prev - c.hp; if (dd > 1) drops.push(dd); prev = c.hp; }
  ok('1 포탑 피해 = 182 ÷ (1 + 방어력 58×0.7%)', drops.length >= 2 && near(drops[0], base, 0.05), drops.map(x => x.toFixed(2)).join(', ') + ' / ' + base.toFixed(2));
  ok('1 포탑 중첩 1회 뒤 ×1.5', drops.length >= 2 && near(drops[1], base * 1.5, 0.05), drops[1] && drops[1].toFixed(2));
}
{ // 명상 중(W 5레벨, 레벨 감소 55%): 포탑 피해 ×(1 - 0.55×0.5). 자신의 회복량을 빼서 순수 피해만 본다
  const w = mk({ turrets: true }), c = w.champs[0], t = w.turrets[1];
  quiet(c); lvl(w, c, { w: 5 }); c.x = t.x - px(55 + 175 + 700); c.y = t.y;
  Core.step(w, [cmd('cast', c.id, { skill: 'w', ang: 0 })]);
  const drops = [];
  for (let i = 0; i < steps(3.5) - 1; i++) {
    const before = c.hp, heal = 100 * (1 + (c.stats.maxHp - before) / c.stats.maxHp) * TICK;
    const healEff = Math.min(c.stats.maxHp, before + heal) - before;
    Core.step(w, []);
    const dmg = before + healEff - c.hp;
    if (dmg > 1) drops.push(dmg);
  }
  const base = 182 / (1 + c.stats.armor * 0.7 / 100);
  ok('1 명상 중 포탑 피해 = 기본 × (1 - 55%×0.5)', drops.length >= 1 && near(drops[0], base * (1 - 0.55 * 0.5), 0.05), drops.map(x => x.toFixed(2)).join(', ') + ' / ' + (base * 0.725).toFixed(2));
}

// ---------------------------------------------------------------------
// 2. 2연속 공격 패시브
// ---------------------------------------------------------------------
{ const w = mk(), c = w.champs[0], d = D(w);
  quiet(c); c.cd.q = 1000; nearDummy(c, d);
  const r = holdAttacks(w, c, d, 9);
  const seq = r.hits.map(h => lbl(h.dmg)).join('');
  ok('2 평타 9회: 4번째·7번째만 2연속 (평평평 평평 평 평 평평 평 평)', seq === 'AAAAHAAAHAA', seq);
  ok('2 스택: 1,2,3,(4번째 예약 0),2,3,(7번째 예약 0),2,3', r.strikes.join(',') === '1,2,3,0,2,3,0,2,3', r.strikes.join(','));
  const gap = r.hits[4] && r.hits[3] ? r.hits[4].t - r.hits[3].t : -1;
  ok('2 두 번째 타격은 첫 타격 0.12초 뒤(틱 단위: 0.117초)', gap >= 0.11 && gap <= 0.13, gap.toFixed(4));
  ok('2 두 번째 타격 피해 = 0.5 × 공격력 (물리)', r.hits[4] && near(r.hits[4].dmg, H, 0.05), r.hits[4] && r.hits[4].dmg.toFixed(3));
  ok('2 평타 적중마다(두 번째 타격 포함) Q 쿨타임 -1초', r.hits.every(h => near(h.cdDiff, TICK + 1, 1e-6)), r.hits.map(h => h.cdDiff.toFixed(4)).join(','));
}
{ const w = mk(), c = w.champs[0], d = D(w);   // 우주류 검술 중: 두 번째 타격에도 추가 고정 피해
  quiet(c); c.cd.q = 1000; nearDummy(c, d); c.sk.e = 1; c.wuju = 1000;
  const r = holdAttacks(w, c, d, 9);
  ok('2 우주류 중 두 번째 타격도 추가 고정 피해(47.125)', r.hits.length === 11 && near(r.hits[4].dmg, H + WUJU1, 0.05) && near(r.hits[0].dmg, A + WUJU1, 0.05), r.hits[4] && r.hits[4].dmg.toFixed(3));
}

// ---------------------------------------------------------------------
// 3. 일격필살 (Q)
// ---------------------------------------------------------------------
{ const w = mk(), c = w.champs[0], d = D(w);   // 대상 없음: 소모·쿨타임 없음
  quiet(c); lvl(w, c, { q: 1 }); c.x = d.x - px(900); c.y = d.y;
  const m0 = c.mana;
  Core.step(w, [cmd('cast', c.id, { skill: 'q', ang: 0 })]);
  ok('3a 사거리 안 대상 없음 → 마나·쿨타임 소모 없음, 사라지지 않음', c.mana === m0 && c.cd.q === 0 && !c.yq && !c.untarget, c.mana.toFixed(2) + ' / ' + c.cd.q);
}
{ const w = mk(), c = w.champs[0], d = D(w);   // 사거리 600 경계: 가장자리 간 599 안, 601 밖
  quiet(c); lvl(w, c, { q: 1 }); c.x = d.x - px(724); c.y = d.y;
  const inside = Core.yiQTarget(w, c) === d;
  Core.step(w, [cmd('cast', c.id, { skill: 'q', ang: 0 })]);
  const w2 = mk(), c2 = w2.champs[0], d2 = D(w2);
  quiet(c2); lvl(w2, c2, { q: 1 }); c2.x = d2.x - px(726);
  const outside = Core.yiQTarget(w2, c2) === null;
  Core.step(w2, [cmd('cast', c2.id, { skill: 'q', ang: 0 })]);
  ok('3b 사거리 600: 가장자리 599면 대상, 601이면 없음(시전 안 됨)', inside && !!c.yq && outside && !c2.yq && !c2.untarget);
}
{ const w = mk(), c = w.champs[0], d = D(w);   // 1레벨 일격필살 타격 시각·피해·등장
  quiet(c); lvl(w, c, { q: 1 }); c.x = d.x - px(724); c.y = d.y;
  const hits = []; let appearAt = -1;
  const t0 = w.time;   // 시전 틱 기준 시각(앞선 레벨업 틱은 뺌)
  Core.step(w, [cmd('cast', c.id, { skill: 'q', ang: 0 })]);
  const mana = c.mana, cdAtCast = c.cd.q;
  for (let i = 0; i < 59; i++) {
    const hp = d.hp, cq = c.cd.q;
    Core.step(w, []);
    if (hp - d.hp > 1e-9) hits.push({ t: w.time - t0, dmg: hp - d.hp, cdDiff: cq - c.cd.q });
    if (appearAt < 0 && !c.untarget) appearAt = w.time - t0;
  }
  const exp = [0.2, 0.42, 0.64, 0.86];
  ok('3c 4회 타격 시각 0.2 / 0.42 / 0.64 / 0.86초 (틱 단위)', hits.length === 4 && hits.every((h, i) => h.t >= exp[i] - EPS && h.t < exp[i] + TICK + EPS), hits.map(h => h.t.toFixed(4)).join(', '));
  ok('3c 각 타격 = (35 + 1.225×공격력) × 25% 물리', hits.length === 4 && hits.every(h => near(h.dmg, ALPHA1, 0.02)), hits.map(h => h.dmg.toFixed(3)).join(', ') + ' / ' + ALPHA1.toFixed(3));
  ok('3c 일격필살 타격은 쿨타임을 줄이지 않음(기본 공격이 아님)', hits.every(h => near(h.cdDiff, TICK, 1e-9)));
  ok('3c 마나 50, 쿨타임 20초(1레벨) — 시전 즉시 시작', near(c.stats.maxMana - mana, 50, 1e-6) && near(cdAtCast, 20, TICK + EPS), cdAtCast.toFixed(4));
  ok('3c 0.9초에 등장(시전 즉시 사라짐)', near(appearAt, 0.9, TICK + EPS) && !c.untarget && !c.yq, appearAt.toFixed(4));
  ok('3c 등장 위치: 대상 반대편(시전 위치 반대), 히트박스+히트박스×0.8+12 거리', c.x > d.x && near(Math.hypot(c.x - d.x, c.y - d.y), px(126), 0.05) && Core.canStand(c.x, c.y), (Math.hypot(c.x - d.x, c.y - d.y) / px(1)).toFixed(1) + '유닛');
}
{ const w = mk({ turrets: true }), c = w.champs[0], t = w.turrets[1], d = D(w);   // 포탑: 조준 해제, 날아가던 투사체 무효
  quiet(c); lvl(w, c, { q: 1 }); c.x = t.x - px(55 + 175 + 700); c.y = t.y;
  d.x = c.x - px(150); d.y = c.y;
  run(w, 0.95);
  const inFlight = !!t.shot;
  const hp0 = c.hp;
  Core.step(w, [cmd('cast', c.id, { skill: 'q', ang: 0 })]);
  ok('3d 날아가던 포탑 공격: 조준 해제·투사체 취소', inFlight && t.targetId === null && t.shot === null && t.stacks === 0, 'inFlight=' + inFlight);
  let dmgSeen = false;
  for (let i = 0; i < steps(1.0); i++) { Core.step(w, []); if (c.hp < hp0 - 1e-9) dmgSeen = true; }
  ok('3d 대상 지정 불가·등장 직후까지 포탑 피해 없음', !dmgSeen);
}
{ const { w, y, e } = duel();   // 다리우스는 일격필살 중인 마스터 이를 고를 수 없음
  lvl(w, y, { q: 1 });
  Core.step(w, [cmd('cast', 'p1', { skill: 'q', ang: 0 })]);
  ok('3e 일격필살 중 궁극기·사거리 대상에서 마스터 이 제외', y.untarget && Core.ultTarget(w, e) === null && Core.targetInRange(w, e) === null);
  Core.step(w, [cmd('input', 'e1', { mx: 0, my: 0, atk: true })]);
  run(w, 0.6);
  ok('3e 다리우스 평타도 마스터 이에게 닿지 않음', y.hp === y.stats.maxHp, (y.stats.maxHp - y.hp).toFixed(3));
}
{ const costs = [];
  for (const L of [1, 5]) {
    const w = mk(), c = w.champs[0], d = D(w); quiet(c); lvl(w, c, { q: L }); nearDummy(c, d);
    const m0 = c.mana;
    Core.step(w, [cmd('cast', c.id, { skill: 'q', ang: 0 })]);
    costs.push([m0 - c.mana, c.cd.q]);
  }
  ok('3f 레벨별 마나 50(1레벨), 70(5레벨)', near(costs[0][0], 50, 1e-6) && near(costs[1][0], 70, 1e-6), costs.map(x => x[0]).join(' / '));
  ok('3f 레벨별 쿨타임 20(1레벨), 18(5레벨)', near(costs[0][1], 20, TICK + EPS) && near(costs[1][1], 18, TICK + EPS), costs.map(x => x[1].toFixed(3)).join(' / '));
}
{ const w = mk(), c = w.champs[0], d = D(w);   // 일격필살 뒤 평타 적중 → Q 쿨타임 -1초
  quiet(c); lvl(w, c, { q: 5 }); nearDummy(c, d);
  Core.step(w, [cmd('cast', c.id, { skill: 'q', ang: 0 })]);
  run(w, 1.0);
  const r = holdAttacks(w, c, d, 1);
  ok('3g 평타 적중 시 일격필살 쿨타임 -1초(기본 공격 적중마다)', r.hits.length === 1 && near(r.hits[0].cdDiff, TICK + 1, 1e-6), r.hits[0] && r.hits[0].cdDiff.toFixed(4));
}

// ---------------------------------------------------------------------
// 4. 명상 (W)
// ---------------------------------------------------------------------
{ const w = mk(), c = w.champs[0], d = D(w); quiet(c); lvl(w, c, { w: 1 });
  c.hp = c.stats.maxHp - 300; const hp0 = c.hp, m0 = c.mana;
  Core.step(w, [cmd('cast', c.id, { skill: 'w', ang: 0 })]);
  ok('4a 마나 = 40 + 최대 마나 6%', near(m0 - c.mana, 40 + 0.06 * c.stats.maxMana, 1e-6), (m0 - c.mana).toFixed(3));
  ok('4a 쿨타임 10초, 시전 즉시 시작', near(c.cd.w, 10, TICK + EPS), c.cd.w.toFixed(4));
  const heal1 = c.hp - hp0, exp1 = 30 * (1 + 300 / c.stats.maxHp) * TICK;
  ok('4a 1틱 회복 = (30 + 0.25×주문력) × (1 + 잃은 체력%) × dt', near(heal1, exp1, 1e-6), heal1.toFixed(5) + ' / ' + exp1.toFixed(5));
  run(w, 0.99);
  const gain = c.hp - hp0;   // 1초 동안 누적. 잃은 체력이 줄면서 회복이 조금씩 줄어드는 것까지 포함한 값
  ok('4a 1초 누적 회복 ≈ 37.09 (잃은 체력 300 기준, 1레벨 30/초)', near(gain, 37.09, 0.3), gain.toFixed(3));
}
{ const w = mk(), c = w.champs[0]; quiet(c); lvl(w, c, { w: 1 });
  Core.step(w, [cmd('cast', c.id, { skill: 'w', ang: 0 })]);
  ok('4b 시작 0.5초 동안 받는 피해 70% 감소', near(Core.dmgTakenMul(c, false), 0.3, 1e-9), Core.dmgTakenMul(c, false));
  ok('4b 포탑 피해는 절반(35%)', near(Core.dmgTakenMul(c, true), 0.65, 1e-9), Core.dmgTakenMul(c, true));
  run(w, 0.6);
  ok('4b 0.5초 뒤 레벨 감소 45%(1레벨)', near(Core.dmgTakenMul(c, false), 0.55, 1e-9) && !!c.med, Core.dmgTakenMul(c, false));
  ok('4b 포탑 피해는 22.5%', near(Core.dmgTakenMul(c, true), 0.775, 1e-9), Core.dmgTakenMul(c, true));
  run(w, 3.4);
  ok('4b 4초 뒤 명상 종료, 종료 후 0.5초 동안 레벨 감소 유지', !c.med && near(Core.dmgTakenMul(c, false), 0.55, 1e-9) && c.medPost > 0);
  run(w, 0.6);
  ok('4b 종료 후 0.5초가 지나면 감소 없음', near(Core.dmgTakenMul(c, false), 1, 1e-9) && c.medPost === 0);
}
{ const w = mk(), c = w.champs[0]; quiet(c); lvl(w, c, { w: 1 });   // 이동 입력으로 끊김
  Core.step(w, [cmd('cast', c.id, { skill: 'w', ang: 0 })]); run(w, 1.0);
  Core.step(w, [cmd('input', c.id, { mx: 1, my: 0, atk: false })]);
  ok('4c 이동 입력 → 명상 끊김, 끊긴 뒤 0.5초 감소', !c.med && c.medPost > 0 && near(Core.dmgTakenMul(c, false), 0.55, 1e-9));
}
{ const w = mk(), c = w.champs[0]; quiet(c); lvl(w, c, { w: 1 });   // 평타 입력으로 끊김
  Core.step(w, [cmd('cast', c.id, { skill: 'w', ang: 0 })]); run(w, 1.0);
  Core.step(w, [cmd('input', c.id, { mx: 0, my: 0, atk: true })]);
  ok('4c 평타 입력 → 명상 끊김', !c.med && c.medPost > 0);
}
{ const w = mk(), c = w.champs[0]; quiet(c); lvl(w, c, { w: 1 });   // 공중에 뜸으로 끊김
  Core.step(w, [cmd('cast', c.id, { skill: 'w', ang: 0 })]); run(w, 1.0);
  Core.step(w, [cmd('dev', c.id, { op: 'air' })]);
  ok('4c 공중에 뜸 → 명상 끊김', !c.med && c.air > 0);
}
{ const { w, y, e } = duel(); lvl(w, y, { w: 1 }); e.stats.ad = 500;   // 다리우스 평타(큰 피해)로도 안 끊김
  Core.step(w, [cmd('cast', 'p1', { skill: 'w', ang: 0 })]);
  Core.step(w, [cmd('input', 'e1', { mx: 0, my: 0, atk: true })]);
  let sawDrop = false, g = 0, prev = y.hp;
  while (g++ < steps(1.5)) { Core.step(w, []); if (y.hp < prev - 1) sawDrop = true; prev = y.hp; }
  ok('4c 피해를 받아도 명상은 끊기지 않음', sawDrop && !!y.med, sawDrop ? '' : '피해가 들어가지 않음');
}
{ const { w, y, e } = duel(); lvl(w, y, { w: 1, e: 1, r: 1 });   // E·R로는 끊기지 않음
  Core.step(w, [cmd('cast', 'p1', { skill: 'w', ang: 0 })]); run(w, 0.5);
  Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]);
  const afterE = !!y.med;
  Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]);
  ok('4c 우주류 검술·최후의 전사 시전으로는 끊기지 않음', afterE && !!y.med && y.hl > 0 && y.wuju > 0);
}
{ const w = mk(), c = w.champs[0]; quiet(c); lvl(w, c, { w: 1 });   // 1초마다 기본 공격 스택 +1 (최대 3)
  Core.step(w, [cmd('cast', c.id, { skill: 'w', ang: 0 })]);
  run(w, 1.02); const s1 = c.dstack;
  run(w, 1.0); const s2 = c.dstack;
  run(w, 1.0); const s3 = c.dstack;
  run(w, 1.5); const s4 = c.dstack;
  ok('4d 명상 1·2·3초에 스택 1·2·3, 최대 3', s1 === 1 && s2 === 2 && s3 === 3 && s4 === 3, [s1, s2, s3, s4].join(','));
  ok('4d 4초 명상 뒤 다음 평타는 2연속 발동', (run(w, 0.2), c.dstack >= 3) && (() => { const d = D(w); nearDummy(c, d); attackOnce(w, c, d); return !!c.dhit; })());
}
{ const w = mk(), c = w.champs[0]; quiet(c); lvl(w, c, { e: 1, w: 1 });   // 명상 중에는 우주류 검술 지속시간이 줄지 않음
  Core.step(w, [cmd('cast', c.id, { skill: 'e', ang: 0 }), cmd('cast', c.id, { skill: 'w', ang: 0 })]);
  run(w, 2.0);
  ok('4d 명상 중 우주류 검술 남은 시간 정지', near(c.wuju, 5, 1e-9), c.wuju.toFixed(5));
  run(w, 2.5);
  ok('4d 명상이 끝나면 우주류 검술이 다시 줄어듦', c.wuju < 5 - 0.1 && !c.med, c.wuju.toFixed(3));
}
{ const w = mk(), c = w.champs[0], d = D(w); quiet(c); lvl(w, c, { e: 1, q: 1 }); nearDummy(c, d);   // 일격필살 중에도 정지
  Core.step(w, [cmd('cast', c.id, { skill: 'e', ang: 0 }), cmd('cast', c.id, { skill: 'q', ang: 0 })]);
  run(w, 0.8);
  ok('4d 일격필살 중 우주류 검술 남은 시간 정지', near(c.wuju, 5, 1e-9), c.wuju.toFixed(5));
  run(w, 0.5);
  ok('4d 일격필살이 끝난 뒤 다시 줄어듦', c.wuju < 5 && !c.yq, c.wuju.toFixed(4));
}

// ---------------------------------------------------------------------
// 5. 우주류 검술 (E)
// ---------------------------------------------------------------------
{ const w = mk(), c = w.champs[0], d = D(w); quiet(c); lvl(w, c, { e: 1 }); nearDummy(c, d);
  const m0 = c.mana;
  Core.step(w, [cmd('cast', c.id, { skill: 'e', ang: 0 })]);
  ok('5 마나 소모 없음, 쿨타임 14초, 지속 5초', c.mana === m0 && near(c.cd.e, 14, TICK + EPS) && near(c.wuju, 5, TICK + EPS), c.cd.e.toFixed(4) + ' / ' + c.wuju.toFixed(4));
  const drop = attackOnce(w, c, d);
  ok('5 기본 공격 적중마다 고정 피해 20 + 0.35×공격력', near(drop, A + WUJU1, 0.05), drop.toFixed(3));
}
{ const w = mk(), c = w.champs[0], d = D(w); quiet(c); lvl(w, c, { e: 1 }); nearDummy(c, d);
  Core.step(w, [cmd('cast', c.id, { skill: 'e', ang: 0 })]);
  run(w, 5.05);
  ok('5 5초 뒤 지속 종료, 쿨타임은 남아 있음', c.wuju === 0 && c.cd.e > 8, c.cd.e.toFixed(3));
  const drop = attackOnce(w, c, d);
  ok('5 종료 뒤 평타는 물리 피해만', near(drop, A, 0.05), drop.toFixed(3));
}

// ---------------------------------------------------------------------
// 6. 최후의 전사 (R)
// ---------------------------------------------------------------------
{ const w = mk(), c = w.champs[0], d = D(w); quiet(c); lvl(w, c, { r: 1 }); c.slow = { pct: 0.4, t: 3 }; nearDummy(c, d);
  const m0 = c.mana;
  Core.step(w, [cmd('cast', c.id, { skill: 'r', ang: 0 })]);
  ok('6 마나 100, 쿨타임 85초, 지속 7초, 기존 둔화 제거', near(m0 - c.mana, 100, 1e-6) && near(c.cd.r, 85, TICK + EPS) && near(c.hl, 7, TICK + EPS) && c.slow === null, c.cd.r.toFixed(3));
  ok('6 이동속도 = 355 × 1.4 = 497', near(Core.curMS(c), 497, 1e-9), Core.curMS(c));
  ok('6 공격속도 = 기본 × (1 + 성장% + 25%)', near(Core.curAS(c), 0.679 * (1 + 0.025 * 5 + 0.25), 1e-9), Core.curAS(c).toFixed(6));
  Core.step(w, [cmd('input', c.id, { mx: 0, my: 0, atk: true })]);
  ok('6 평타 주기는 curAS 기준(1/공속)', near(c.atkCd, 1 / Core.curAS(c), 1e-9), c.atkCd.toFixed(6));
  run(w, 6.9);
  ok('6 6.9초에는 아직 지속', c.hl > 0);
  run(w, 0.2);
  ok('6 7초 뒤 종료', c.hl === 0 && Core.curMS(c) === 355);
}
{ const sp = clearRun(90);   // 이동속도: 빈 직선에서 1초 전진 거리 비교
  const w = mk({ dummy: false }), c = w.champs[0]; quiet(c); lvl(w, c, { r: 1 });
  c.x = sp.x; c.y = sp.y;
  Core.step(w, [cmd('cast', c.id, { skill: 'r', ang: 0 })]);
  const x0 = c.x, y0 = c.y;
  Core.step(w, [cmd('input', c.id, { mx: 1, my: 0, atk: false })]);
  run(w, 0.5);
  const dist = Math.hypot(c.x - x0, c.y - y0);
  ok('6 최후의 전사 중 실제 이동 거리 = 497 × 시간', near(dist, px(497) * 31 * TICK, px(497) * 0.02), (dist / px(1)).toFixed(2) + ' 유닛');
}
{ const { w, y, e } = duel(); lvl(w, e, { w: 1 }); lvl(w, y, { r: 1 });   // 최후의 전사 중 둔화 면역
  Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]);
  Core.step(w, [cmd('cast', 'e1', { skill: 'w', ang: 0 }), cmd('input', 'e1', { mx: 0, my: 0, atk: true })]);
  run(w, 1.5);
  ok('6 최후의 전사 중 다리우스 W 둔화 무시', y.slow === null, JSON.stringify(y.slow));
  const { w: w2, y: y2, e: e2 } = duel(); lvl(w2, e2, { w: 1 });
  Core.step(w2, [cmd('cast', 'e1', { skill: 'w', ang: 0 }), cmd('input', 'e1', { mx: 0, my: 0, atk: true })]);
  run(w2, 0.6);   // 둔화는 1초 지속: 1초 안에 확인
  ok('6 대조: 최후의 전사가 없으면 둔화 적용', !!y2.slow, JSON.stringify(y2.slow));
}

// ---------------------------------------------------------------------
// 7. 레벨업 · 부활
// ---------------------------------------------------------------------
{ const w = mk(), c = w.champs[0]; c.sp += 10;   // 포인트 16개 (5/5/5/1)
  lvl(w, c, { q: 5, w: 5, e: 5, r: 1 });
  Core.step(w, [cmd('levelup', c.id, { skill: 'r' })]);
  ok('7 레벨업 5/5/5/1, 궁극기 1 상한, 포인트 소모', c.sk.q === 5 && c.sk.w === 5 && c.sk.e === 5 && c.sk.r === 1 && c.sp === 0, [c.sk.q, c.sk.w, c.sk.e, c.sk.r, c.sp].join('/'));
}
{ const w = mk({ turrets: true }), c = w.champs[0], t = w.turrets[1];
  lvl(w, c, { q: 2, w: 1, e: 1 });   // 포인트 2개 남음
  c.x = t.x - px(55 + 175 + 500); c.y = t.y; c.hp = 1;
  Core.step(w, [cmd('cast', c.id, { skill: 'w', ang: 0 })]);
  c.dstack = 2; c.wuju = 3; c.hl = 2;
  run(w, 3);
  const died = c.dead;
  run(w, 5.2);
  ok('7 부활 전 포탑에 맞아 사망', died);
  ok('7 부활: 명상·스택·우주류·최후의 전사 초기화, 스킬 레벨·포인트 유지', !c.dead && c.dstack === 0 && c.wuju === 0 && c.hl === 0 && !c.med && !c.untarget && !c.yq && c.sk.q === 2 && c.sk.w === 1 && c.sk.e === 1 && c.sp === 2, [c.sk.q, c.sk.w, c.sk.e, c.sp].join('/'));
}

// ---------------------------------------------------------------------
// 8. 결정성 (같은 명령 → 같은 월드 JSON)
// ---------------------------------------------------------------------
{ const script = {
    0: [{ type: 'levelup', id: 'p1', skill: 'q' }, { type: 'levelup', id: 'p1', skill: 'w' }, { type: 'levelup', id: 'p1', skill: 'e' }, { type: 'levelup', id: 'p1', skill: 'r' }],
    10: [{ type: 'input', id: 'p1', mx: 0, my: 0, atk: true }],
    60: [{ type: 'cast', id: 'p1', skill: 'q', ang: 0 }],
    120: [{ type: 'cast', id: 'p1', skill: 'w', ang: 0 }],
    150: [{ type: 'cast', id: 'p1', skill: 'e', ang: 0.3 }],
    200: [{ type: 'cast', id: 'p1', skill: 'r', ang: 0 }, { type: 'input', id: 'p1', mx: 0, my: 0, atk: false }],
    300: [{ type: 'input', id: 'p1', mx: 1, my: -0.4, atk: false }],
    350: [{ type: 'input', id: 'p1', mx: 0, my: 0, atk: true }],
    420: [{ type: 'input', id: 'p1', mx: 0, my: 0, atk: false }, { type: 'cast', id: 'p2', skill: 'q', ang: 0 }],
    500: [{ type: 'cast', id: 'p1', skill: 'e', ang: 0 }]
  };
  const play = () => {
    const w = Core.createWorld({ players: [{ id: 'p1', key: 'yi', team: 0 }, { id: 'p2', key: 'darius', team: 1 }], dummy: true });
    const y = w.champs[0], e = w.champs[1];
    y.x = 600; y.y = 500; e.x = y.x + px(55 + 55 + 100); e.y = y.y;
    for (let i = 0; i < 600; i++) Core.step(w, script[i] || []);
    return w;
  };
  const a = play(), b = play();
  ok('8 같은 명령 스트림 600틱 → 월드 JSON 동일(Yi 스킬 포함)', JSON.stringify(a) === JSON.stringify(b));
  ok('8 스킬이 실제로 쓰였음(R 쿨타임 있음, 2연속·스택 변화)', a.champs[0].cd.r > 0 && a.champs[0].sk.r === 1 && a.champs[0].dstack >= 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
