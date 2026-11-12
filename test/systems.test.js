/* =====================================================================
   공통 시스템 테스트 (DESIGN_GAREN.md §0 G1~G4, §1-1 ~ 1-6, §3 보호막·침묵)
   - 추가 스탯 · 다리우스 W 쿨타임 정지 · 다리우스 R 계수 · 침묵 · 보호막 · 강인함 · 방어력 감소(shred) · 결정성
   - 6레벨 기준. 자연 회복은 끄고(quiet), 포탑은 격리해서 각 규칙만 봅니다.
   - 허수아비는 4초 동안 맞지 않으면 체력을 빠르게 회복하므로, 긴 대기 뒤 체력을 재는 테스트는 그 점을 피해서 씁니다.
   ===================================================================== */
const Core = require('../shared/core.js');
const fs = require('fs'), path = require('path');
Core.setMap(JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/walk_rle.json'), 'utf8')));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  → ' + extra : '')); };
const near = (a, b, e = 0.01) => Math.abs(a - b) <= e;
const TICK = Core.TICK, px = Core.px;
const run = (w, sec, cmds) => { const n = Math.round(sec / TICK); for (let i = 0; i < n; i++) Core.step(w, i === 0 ? cmds : []); };
const cmd = (type, id, extra) => Object.assign({ type, id }, extra || {});
const quiet = c => { c.stats.regen = 0; c.stats.manaRegen = 0; };   // 자연 회복 끄기
const lvl = (w, c, pts) => { for (const [k, n] of Object.entries(pts)) for (let i = 0; i < n; i++) Core.step(w, [cmd('levelup', c.id, { skill: k })]); };
const mk = (players) => {   // 기본: 다리우스(p1, 팀0) + 허수아비. 포탑은 격리(죽은 상태)
  const w = Core.createWorld({ players: players || [{ id: 'p1', key: 'darius', team: 0 }], dummy: true });
  w.turrets.forEach(t => { t.dead = true; });
  return w;
};
const mulOf = armor => 1 / (1 + armor * 0.01);   // 방어력 공식(코어와 같은 식)
const hasText = (w, s) => w.events.some(e => e.type === 'text' && e.txt === s);
const nearDummy = (c, d) => { c.x = d.x - px(150); c.y = d.y; };   // 평타 사거리 안
const nearRUlt = (c, d) => { c.x = d.x - px(55 + 70 + 200); c.y = d.y; };   // 궁극기 사거리 안(히트박스 끝 기준 약 200유닛)

// 마스터 이(p1)가 허수아비를 평타 한 번 때림. 적중 틱까지 진행하고 허수아비가 받은 피해(보호막 포함)를 돌려줌
function yiHit(w, y, d) {
  let g = 0;
  while ((y.atk || y.atkCd > 0) && g++ < 2000) Core.step(w, []);
  const tot0 = d.total, hp0 = d.hp;
  Core.step(w, [cmd('input', 'p1', { mx: 0, my: 0, atk: true })]);
  while (!(y.atk && y.atk.hit) && g++ < 4000) Core.step(w, []);
  Core.step(w, [cmd('input', 'p1', { mx: 0, my: 0, atk: false })]);
  return { dealt: d.total - tot0, hpLoss: hp0 - d.hp };
}
// 다리우스 R을 허수아비에 쓰고 0.6초 뒤 체력 감소량. 중첩·추가 공격력 조건을 넣어 씀
function ultLoss({ stacks = 0, might = 0, bonusAD = 0, baseAD = null }) {
  const w = mk(), c = w.champs[0], d = w.dummies[0];
  quiet(c); lvl(w, c, { r: 1 });
  if (baseAD !== null) c.stats.ad = baseAD;   // 기본 공격력을 따로 올림(계수에 들어가면 안 됨)
  c.bonus.ad = bonusAD; c.might = might; c.mana = c.stats.maxMana;
  nearRUlt(c, d); d.armor = 60;   // 고정 피해는 방어력을 무시해야 함
  d.bleed = stacks ? { stacks, t: 5, total: 0, acc: 0, txtT: 0, src: 'p1', pen: 0 } : null;   // total 0: 출혈 틱 피해 없이 중첩만 둠
  const hp0 = d.hp;
  Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]);
  run(w, 0.6);
  return hp0 - d.hp;
}

// ---------------------------------------------------------------------
// 1. 추가 스탯 (G1, §1-1)
// ---------------------------------------------------------------------
{ const w = mk(), c = w.champs[0];
  ok('1 추가 스탯 기본값은 0', c.bonus.ad === 0 && c.bonus.hp === 0 && c.bonus.as === 0 && c.bonus.armor === 0 && c.bonus.mr === 0);
  ok('1 추가 공격력 0이면 총 공격력 = 기본 공격력', Core.bonusAD(c) === 0 && Core.curAD(c) === c.stats.ad);
  c.bonus.ad = 40;
  ok('1 추가 공격력 40 → 총 공격력 = 기본 + 40 (curAD = totalAD)', Core.curAD(c) === c.stats.ad + 40 && Core.totalAD(c) === Core.curAD(c) && Core.bonusAD(c) === 40, Core.curAD(c));
  c.might = 5;
  ok('1 추가 공격력에 다리우스 패시브 공격력 버프 포함(40 + 55)', Core.bonusAD(c) === 95 && Core.buffAD(c) === 55, Core.bonusAD(c));
  c.might = 0; c.bonus.ad = 0;
  ok('1 기본 공격력(레벨로 얻은 것)은 추가 공격력이 아님', Core.bonusAD(c) === 0 && Core.bonusHP(c) === 0);
  ok('1 추가 공속 0이면 공속 추가 비율 = 6레벨 성장 5%', near(Core.bonusASPct(c), 0.05, 1e-9), Core.bonusASPct(c));
  c.bonus.as = 0.2;
  ok('1 아이템 공속 20% 추가 → 공속 추가 비율 25%, 실제 공속에 반영', near(Core.bonusASPct(c), 0.25, 1e-9) && near(Core.curAS(c), 0.625 * 1.25, 1e-9), Core.curAS(c));
  c.bonus.as = 0;
  c.bonus.armor = 10; c.bonus.mr = 7;
  ok('1 추가 방어력·마법저항력이 읽기 함수에 포함', Core.armorOf(c) === c.stats.armor + 10 && Core.mrOf(c) === c.stats.mr + 7, Core.armorOf(c));
  c.bonus.armor = 0; c.bonus.mr = 0; }

// ---------------------------------------------------------------------
// 2. 다리우스 W: 강화 중 쿨타임 정지 (§1-2, 원문: 다음 공격까지 쿨타임이 흐르지 않음)
// ---------------------------------------------------------------------
{ const w = mk(), c = w.champs[0], d = w.dummies[0]; quiet(c); lvl(w, c, { q: 1, w: 1 });
  nearDummy(c, d);
  Core.step(w, [cmd('cast', 'p1', { skill: 'q', ang: 0 })]);
  Core.step(w, [cmd('cast', 'p1', { skill: 'w', ang: 0 })]);
  run(w, 3);
  ok('2 강화 중 3초가 지나도 W 쿨타임은 그대로(5초)', c.wBuff && near(c.cd.w, 5, 1e-9), c.cd.w);
  ok('2 같은 시간 Q 쿨타임은 흐름(9 → 약 6)', near(c.cd.q, 6, 0.1), c.cd.q.toFixed(3));
  // 강화 평타가 나갈 때까지 기다린 뒤 1초: 그때부터 쿨타임이 흐름
  let g = 0;
  Core.step(w, [cmd('input', 'p1', { mx: 0, my: 0, atk: true })]);
  while (c.wBuff && g++ < 600) Core.step(w, []);
  ok('2 강화 평타가 나가면 강화 해제', !c.wBuff);
  const atStrike = c.cd.w;
  run(w, 1);
  ok('2 강화 평타 뒤 1초부터 W 쿨타임 흐름(5 → 4)', near(atStrike, 5, 1e-9) && near(c.cd.w, 4, 0.03), atStrike.toFixed(3) + ' → ' + c.cd.w.toFixed(3));
  Core.step(w, [cmd('input', 'p1', { mx: 0, my: 0, atk: false })]); }

{ // 강화 중 W를 다시 누르면 '이미 강화됨' (쿨타임이 멈춰 있어도 같은 안내)
  const w = mk(), c = w.champs[0]; quiet(c); lvl(w, c, { w: 1 });
  Core.step(w, [cmd('cast', 'p1', { skill: 'w', ang: 0 })]); const m = c.mana;
  Core.drainEvents(w);
  Core.step(w, [cmd('cast', 'p1', { skill: 'w', ang: 0 })]);
  ok('2 강화 중 W 재시전은 막고 마나를 쓰지 않음', c.mana === m && hasText(w, '이미 강화됨') && !hasText(w, '재사용 대기 중')); }

// ---------------------------------------------------------------------
// 3. 다리우스 R: (125 + 0.75 × 추가 공격력) × (1 + 0.2 × 중첩)
// ---------------------------------------------------------------------
ok('3 추가 공격력 0, 중첩 0 → 125', near(ultLoss({ stacks: 0 }), 125, 0.05), ultLoss({ stacks: 0 }).toFixed(2));
ok('3 추가 공격력 0, 중첩 5 → 250 (×2)', near(ultLoss({ stacks: 5 }), 250, 0.05), ultLoss({ stacks: 5 }).toFixed(2));
ok('3 노서스 힘(공격력 버프 55) 활성, 중첩 0 → 125 + 0.75×55 = 166.25', near(ultLoss({ might: 5 }), 166.25, 0.05), ultLoss({ might: 5 }).toFixed(2));
ok('3 노서스 힘 활성, 중첩 5 → 166.25 × 2 = 332.5', near(ultLoss({ might: 5, stacks: 5 }), 332.5, 0.05), ultLoss({ might: 5, stacks: 5 }).toFixed(2));
ok('3 추가 공격력 40, 중첩 0 → 125 + 0.75×40 = 155', near(ultLoss({ bonusAD: 40 }), 155, 0.05), ultLoss({ bonusAD: 40 }).toFixed(2));
ok('3 추가 공격력 40, 중첩 5 → 155 × 2 = 310', near(ultLoss({ bonusAD: 40, stacks: 5 }), 310, 0.05), ultLoss({ bonusAD: 40, stacks: 5 }).toFixed(2));
ok('3 기본 공격력을 300으로 올려도 추가 공격력 0이면 궁극기 125(기본 공격력은 계수에 안 들어감)', near(ultLoss({ baseAD: 300 }), 125, 0.05), ultLoss({ baseAD: 300 }).toFixed(2));

// ---------------------------------------------------------------------
// 4. 침묵 (§1-3, G2)
// ---------------------------------------------------------------------
{ const w = mk(), c = w.champs[0], d = w.dummies[0]; quiet(c); lvl(w, c, { q: 1, e: 1 });
  nearDummy(c, d);
  Core.addSilence(w, c, 3);
  const m0 = c.mana; Core.drainEvents(w);
  Core.step(w, [cmd('cast', 'p1', { skill: 'q', ang: 0 })]);
  ok('4 침묵 중 스킬 시전 실패: 마나·쿨타임 소모 없음', !c.qPrep && c.mana === m0 && c.cd.q === 0, `mana ${c.mana} cd ${c.cd.q}`);
  ok('4 침묵 중 시전 시도에 \'침묵\' 안내', hasText(w, '침묵'));
  Core.step(w, [cmd('levelup', 'p1', { skill: 'e' })]);
  ok('4 침묵 중에도 레벨업은 가능(E 1 → 2)', c.sk.e === 2, c.sk.e);
  Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]);
  ok('4 침묵 중 E도 시전 불가(마나 그대로)', c.mana === m0 && !c.cast); }

{ // 4b. 침묵은 정신 집중(명상)을 끊고, 끊긴 뒤 0.5초 피해 감소를 유지한다 (endMed 경로)
  const w = mk([{ id: 'p1', key: 'yi', team: 0 }]), y = w.champs[0]; quiet(y); lvl(w, y, { w: 1 }); y.mana = y.stats.maxMana;
  Core.step(w, [cmd('cast', 'p1', { skill: 'w', ang: 0 })]); run(w, 0.5);
  ok('4b 명상 중', !!y.med);
  Core.addSilence(w, y, 3);
  ok('4b 침묵 → 명상 끊김', !y.med);
  ok('4b 끊긴 직후 0.5초 피해 감소(1레벨 45%) 유지', near(y.medPost, 0.5, 1e-9) && near(Core.dmgTakenMul(y, false), 0.55, 1e-9), y.medPost);
  run(w, 0.6);
  ok('4b 0.5초 뒤 피해 감소 없음', near(Core.dmgTakenMul(y, false), 1, 1e-9) && y.medPost === 0); }

{ // 4c. 다리우스 Q 준비와 궁극기 시전은 침묵에도 끊기지 않음
  const w = mk(), c = w.champs[0], d = w.dummies[0]; quiet(c); lvl(w, c, { q: 1, r: 1 }); nearDummy(c, d);
  Core.step(w, [cmd('cast', 'p1', { skill: 'q', ang: 0 })]); run(w, 0.2);
  Core.addSilence(w, c, 3);
  ok('4c 침묵해도 Q 준비 유지', !!c.qPrep);
  const hp0 = d.hp; run(w, 0.6);
  ok('4c Q 준비가 끝나고 휘두름(허수아비 피해)', !c.qPrep && d.hp < hp0, (hp0 - d.hp).toFixed(1));
  const w2 = mk(), c2 = w2.champs[0], d2 = w2.dummies[0]; quiet(c2); lvl(w2, c2, { r: 1 }); c2.mana = c2.stats.maxMana; nearRUlt(c2, d2);
  Core.step(w2, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]); run(w2, 0.1);
  Core.addSilence(w2, c2, 3);
  ok('4c 궁극기 시전 중 침묵해도 시전 유지', !!c2.cast && c2.cast.type === 'r');
  const h2 = d2.hp; run(w2, 0.4);
  ok('4c 궁극기 시전 완료 → 피해', !c2.cast && d2.hp < h2 - 100, (h2 - d2.hp).toFixed(1)); }

{ // 4d. 침묵은 진행 중인 평타를 끊지 않는다 (G2)
  const w = mk(), c = w.champs[0], d = w.dummies[0]; quiet(c); nearDummy(c, d);
  const hp0 = d.hp;
  Core.step(w, [cmd('input', 'p1', { mx: 0, my: 0, atk: true })]); run(w, 0.1);
  Core.addSilence(w, c, 3);
  ok('4d 평타 선딜 중 침묵 → 평타 동작 유지', !!c.atk);
  let g = 0; while (!(c.atk && c.atk.hit) && g++ < 600) Core.step(w, []);
  ok('4d 침묵 중에도 평타 적중', d.hp < hp0, (hp0 - d.hp).toFixed(1));
  Core.step(w, [cmd('input', 'p1', { mx: 0, my: 0, atk: false })]); }

{ // 4e. 침묵 지속: 시간이 지나면 풀리고, 강인함이 있으면 짧아진다
  const w = mk(), c = w.champs[0]; quiet(c); lvl(w, c, { q: 1 });
  Core.addSilence(w, c, 3);
  run(w, 2.9);
  ok('4e 3초 침묵 2.9초 시점에는 아직 침묵', !!c.silence);
  run(w, 0.2);
  ok('4e 3초가 지나면 침묵 해제', c.silence === null);
  Core.step(w, [cmd('cast', 'p1', { skill: 'q', ang: 0 })]);
  ok('4e 해제 뒤 Q 시전 가능(준비 시작)', !!c.qPrep && c.cd.q > 0);
  const w2 = mk(), c2 = w2.champs[0]; quiet(c2);
  Core.addTenacity(c2, 0.6, 99);
  Core.addSilence(w2, c2, 2);
  ok('4e 강인함 60%면 2초 침묵이 0.8초', near(c2.silence.t, 0.8, 1e-9), c2.silence && c2.silence.t);
  const w3 = mk(), c3 = w3.champs[0]; Core.addSilence(w3, c3, 2); Core.addSilence(w3, c3, 1);
  ok('4e 더 긴 쪽 유지(2초 뒤 1초 → 2초)', near(c3.silence.t, 2, 1e-9), c3.silence.t); }

{ // 4f. 허수아비에도 걸림, 죽은 챔피언에게는 안 걸림
  const w = mk(), d = w.dummies[0];
  Core.addSilence(w, d, 2);
  ok('4f 허수아비에 침묵 적용(2초)', !!d.silence && near(d.silence.t, 2, 1e-9), d.silence && d.silence.t);
  run(w, 1);
  ok('4f 허수아비 침묵도 시간이 흐름', d.silence && d.silence.t < 1.1 && d.silence.t > 0.9, d.silence && d.silence.t.toFixed(3));
  const w2 = mk(), c2 = w2.champs[0]; c2.dead = true; c2.respawn = 3;
  ok('4f 죽은 챔피언에게는 침묵이 안 붙음', Core.addSilence(w2, c2, 2) === false && c2.silence === null); }

// ---------------------------------------------------------------------
// 5. 보호막 (§1-4, G3)
// ---------------------------------------------------------------------
{ // 5a. 물리 피해: 방어력 적용 후 보호막이 먼저 깎임 (방어력 30 → 77.5 / 1.3)
  const w = mk([{ id: 'p1', key: 'yi', team: 0 }]), y = w.champs[0], d = w.dummies[0]; quiet(y); nearDummy(y, d); d.armor = 30;
  const raw = Core.curAD(y), dmg = raw / 1.3;
  Core.addShield(d, 100, 10, 'test');
  const r1 = yiHit(w, y, d);
  ok('5a 첫 평타 피해 = 공격력 ÷ 1.3 (방어력 30)', near(r1.dealt, dmg, 0.01), r1.dealt.toFixed(3));
  ok('5a 보호막이 피해를 전부 흡수: 체력 그대로, 보호막 100 − 피해', near(r1.hpLoss, 0, 1e-9) && near(Core.shieldOf(d), 100 - dmg, 0.01), `hp ${r1.hpLoss} shield ${Core.shieldOf(d).toFixed(3)}`);
  const left = Core.shieldOf(d);
  const r2 = yiHit(w, y, d);
  ok('5a 두 번째 평타: 남은 보호막만큼 흡수, 나머지만 체력에서 깎임', near(r2.hpLoss, dmg - left, 0.01) && Core.shieldOf(d) === 0 && d.shields.length === 0, `hp ${r2.hpLoss.toFixed(3)} expect ${(dmg - left).toFixed(3)}`); }

{ // 5b. 고정 피해(궁극기 125)도 보호막이 흡수 → 체력은 25만 감소
  const w = mk(), c = w.champs[0], d = w.dummies[0]; quiet(c); lvl(w, c, { r: 1 }); c.mana = c.stats.maxMana; nearRUlt(c, d);
  Core.addShield(d, 100, 5, 'test');
  const hp0 = d.hp;
  Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]); run(w, 0.5);
  ok('5b 고정 피해 125 중 보호막 100이 흡수 → 체력 25 감소', near(hp0 - d.hp, 25, 0.02) && d.shields.length === 0, (hp0 - d.hp).toFixed(3)); }

{ // 5c. 여러 보호막: 남은 시간이 짧은 것부터 깎는다 (긴 것 먼저 넣어도)
  const w = mk(), c = w.champs[0], d = w.dummies[0]; quiet(c); lvl(w, c, { r: 1 }); c.mana = c.stats.maxMana; nearRUlt(c, d);
  Core.addShield(d, 80, 5, 'long'); Core.addShield(d, 80, 2, 'short');
  const hp0 = d.hp;
  Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]); run(w, 0.5);
  ok('5c 짧은 보호막(2초)이 먼저 80 흡수, 긴 보호막은 45 흡수 → 35 남음', d.shields.length === 1 && d.shields[0].src === 'long' && near(d.shields[0].amt, 35, 0.02) && d.hp === hp0, JSON.stringify(d.shields));
}

{ // 5d. 보호막 시간 만료
  const w = mk(), d = w.dummies[0];
  Core.addShield(d, 50, 1, 'test');
  run(w, 0.9);
  ok('5d 1초 보호막은 0.9초에 아직 남아 있음', near(Core.shieldOf(d), 50, 1e-9));
  run(w, 0.2);
  ok('5d 1초가 지나면 보호막 사라짐', Core.shieldOf(d) === 0 && d.shields.length === 0); }

{ // 5e. 보호막을 넘은 피해는 체력으로: 보호막 30, 고정 피해 125 → 체력 95
  const w = mk(), c = w.champs[0], d = w.dummies[0]; quiet(c); lvl(w, c, { r: 1 }); c.mana = c.stats.maxMana; nearRUlt(c, d);
  Core.addShield(d, 30, 5, 'test');
  const hp0 = d.hp;
  Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]); run(w, 0.5);
  ok('5e 보호막 30 + 체력 95 = 피해 125', near(hp0 - d.hp, 95, 0.02) && Core.shieldOf(d) === 0, (hp0 - d.hp).toFixed(3));
  ok('5e 허수아비 총 피해 기록은 보호막이 막은 것까지 포함(125)', near(d.total, 125, 0.02) && near(d.hits[d.hits.length - 1].d, 125, 0.02), d.total.toFixed(2)); }

{ // 5f. 보호막이 고정 피해뿐 아니라 피해 감소 뒤의 값을 깎는다: 명상 중인 마스터 이가 궁극기를 맞음
  // 명상 피해 감소(첫 0.5초 70%)가 먼저 적용되고, 그 뒤 보호막이 깎음. 명상 힐 때문에 보호막 있을 때와 없을 때 차이로 잰다
  const lossWith = shield => {
    const w = Core.createWorld({ players: [{ id: 'p1', key: 'darius', team: 0 }, { id: 'e1', key: 'yi', team: 1 }], dummy: false });
    w.turrets.forEach(t => { t.dead = true; });
    const c = w.champs[0], y = w.champs[1];
    quiet(c); quiet(y); lvl(w, c, { r: 1 }); lvl(w, y, { w: 1 });
    c.mana = c.stats.maxMana; y.mana = y.stats.maxMana;
    c.x = 600; c.y = 500; y.x = c.x + px(55 + 70 + 200); y.y = c.y;
    Core.step(w, [cmd('cast', 'e1', { skill: 'w', ang: 0 })]);   // 명상 시작
    if (shield) Core.addShield(y, shield, 5, 'test');
    const hp0 = y.hp;
    Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]); run(w, 0.5);
    return { loss: hp0 - y.hp, left: Core.shieldOf(y) };
  };
  const a = lossWith(0), b = lossWith(30);
  ok('5f 명상 중 궁극기: 보호막이 감소 후 피해에서 30을 흡수(두 경우 차이 = 30)', near(a.loss - b.loss, 30, 0.5) && b.left === 0, `no shield ${a.loss.toFixed(2)} / shield ${b.loss.toFixed(2)}`);
  ok('5f 명상 중이면 피해가 줄어듦(125 → 약 37.5, 명상 힐 차감 후 40 미만)', a.loss < 40, a.loss.toFixed(2)); }

{ // 5g. 죽으면 보호막·침묵·강인함이 사라지고, 죽은 상태에는 새로 붙지 않음
  const w = mk([{ id: 'p1', key: 'darius', team: 0 }, { id: 'e1', key: 'yi', team: 1 }]), c = w.champs[0], e = w.champs[1];
  w.turrets.forEach(t => { t.dead = true; });
  quiet(c); lvl(w, c, { r: 1 }); c.mana = c.stats.maxMana; nearRUlt(c, e);
  e.hp = 10; e.bonus.ad = 40; quiet(e);
  Core.addSilence(w, e, 5); Core.addTenacity(e, 0.3, 99);
  Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]); run(w, 0.5);
  ok('5g 궁극기로 처치', e.dead, 'hp=' + e.hp);
  ok('5g 처치되면 침묵·강인함 사라짐', e.silence === null && e.tenSrc.length === 0 && e.shields.length === 0);
  Core.addShield(e, 50, 5, 'test');
  ok('5g 죽은 챔피언에게 보호막은 안 붙음', e.shields.length === 0);
  run(w, 5.2);
  ok('5g 부활 뒤 추가 스탯(아이템)은 유지, 침묵 없음', !e.dead && e.bonus.ad === 40 && e.silence === null); }

// ---------------------------------------------------------------------
// 6. 강인함 (§1-5, G4)
// ---------------------------------------------------------------------
{ const w = mk(), c = w.champs[0], d = w.dummies[0];
  ok('6 강인함 없으면 0', Core.tenacityOf(d) === 0 && Core.tenacityOf(c) === 0);
  Core.addTenacity(d, 0.6, 99); Core.addTenacity(d, 0.5, 99);
  ok('6 두 출처(60%·50%)는 곱연산 → 1 - 0.4×0.5 = 80%', near(Core.tenacityOf(d), 0.8, 1e-9), Core.tenacityOf(d));
  Core.addTenacity(d, 0.2, 0.5);
  ok('6 세 출처 곱연산: 1 - 0.4×0.5×0.8 = 84%', near(Core.tenacityOf(d), 0.84, 1e-9), Core.tenacityOf(d));
  run(w, 0.6);
  ok('6 0.5초 출처가 끝나면 빠짐 → 다시 80%', near(Core.tenacityOf(d), 0.8, 1e-9), Core.tenacityOf(d)); }
{ // 6b. 다리우스 W 둔화(1초)가 강인함에 줄어듦: 60% + 50% → 0.2초
  const w = mk(), c = w.champs[0], d = w.dummies[0]; quiet(c); lvl(w, c, { w: 1 });
  Core.addTenacity(d, 0.6, 99); Core.addTenacity(d, 0.5, 99);
  nearDummy(c, d);
  Core.step(w, [cmd('cast', 'p1', { skill: 'w', ang: 0 })]);
  Core.step(w, [cmd('input', 'p1', { mx: 0, my: 0, atk: true })]);
  let g = 0; while (!d.slow && g++ < 600) Core.step(w, []);
  ok('6b 강화 평타 둔화 적용(90%)', !!d.slow && d.slow.pct === 0.9, JSON.stringify(d.slow));
  ok('6b 둔화 지속 1초 × 0.2 = 0.2초(틱 오차 허용)', !!d.slow && near(d.slow.t, 0.2, 2 * TICK), d.slow && d.slow.t.toFixed(4));
  Core.step(w, [cmd('input', 'p1', { mx: 0, my: 0, atk: false })]); }
{ // 6c. 다리우스 E: 공중에 뜸·끌려옴은 강인함 적용 안 함, 착지 뒤 둔화만 줄어듦
  const eTimes = tenacity => {
    const w = mk(), c = w.champs[0], d = w.dummies[0]; quiet(c); lvl(w, c, { e: 1 });
    if (tenacity) Core.addTenacity(d, tenacity, 99);
    c.x = d.x - px(55 + 535 - 60); c.y = d.y;
    Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]);
    let pull = 0, air = 0, g = 0;
    while (!d.pull && g++ < 300) Core.step(w, []);
    while (d.pull && g++ < 300) { Core.step(w, []); pull++; }
    while (d.air > 0 && g++ < 300) { Core.step(w, []); air++; }
    return { pull, air, slow: d.slow ? d.slow.t : 0 };
  };
  const plain = eTimes(0), ten = eTimes(0.6);
  ok('6c 끌려오는 시간은 강인함과 무관(같은 틱 수)', plain.pull > 0 && plain.pull === ten.pull, `${plain.pull} / ${ten.pull}`);
  ok('6c 공중에 뜨는 시간은 강인함과 무관(같은 틱 수)', plain.air > 0 && plain.air === ten.air, `${plain.air} / ${ten.air}`);
  ok('6c 착지 뒤 둔화 1초 → 강인함 60%면 0.4초', near(plain.slow, 1 - TICK, 2 * TICK) && near(ten.slow, 0.4 - TICK, 2 * TICK), `${plain.slow.toFixed(3)} / ${ten.slow.toFixed(3)}`); }
{ // 6d. 강인함 출처 만료
  const w = mk(), d = w.dummies[0];
  Core.addTenacity(d, 0.6, 1);
  run(w, 1.1);
  ok('6d 1초 출처는 만료 뒤 강인함 0', Core.tenacityOf(d) === 0 && d.tenSrc.length === 0); }

// ---------------------------------------------------------------------
// 7. 방어력 감소(shred, §1-7): 관통 전에 방어력을 줄인다
// ---------------------------------------------------------------------
{ const w = mk([{ id: 'p1', key: 'yi', team: 0 }]), y = w.champs[0], d = w.dummies[0]; quiet(y); nearDummy(y, d);
  d.armor = 60; y.stats.pen = 20;
  d.shred = { t: 6, pct: 0.25 };
  const got = yiHit(w, y, d).dealt;
  ok('7 방어력 60 × (1-0.25) × (1-0.2 관통) = 36 → 77.5 ÷ 1.36', near(got, Core.curAD(y) * mulOf(60 * 0.75 * 0.8), 0.01), got.toFixed(3));
  run(w, 6.1);
  ok('7 방어력 감소는 6초 뒤 사라짐', d.shred === null); }
{ const w = mk([{ id: 'p1', key: 'yi', team: 0 }]), y = w.champs[0], d = w.dummies[0]; quiet(y); nearDummy(y, d);
  d.armor = 60; d.shred = { t: 6, pct: 0.25 };
  const got = yiHit(w, y, d).dealt;
  ok('7 관통 없이 방어력 감소만: 60 × 0.75 = 45 → 77.5 ÷ 1.45', near(got, Core.curAD(y) * mulOf(45), 0.01), got.toFixed(3)); }

// ---------------------------------------------------------------------
// 8. 허수아비 기록과 결정성
// ---------------------------------------------------------------------
{ // 8. 같은 입력이면 항상 같은 결과 (보호막·침묵·강인함·방어력 감소·궁극기·평타 섞음)
  const play = () => {
    const w = mk(), c = w.champs[0], d = w.dummies[0];
    for (let i = 0; i < 1000; i++) {
      let cmds = [];
      if (i === 0) cmds = [cmd('levelup', 'p1', { skill: 'q' }), cmd('levelup', 'p1', { skill: 'w' }), cmd('levelup', 'p1', { skill: 'e' }), cmd('levelup', 'p1', { skill: 'r' })];
      if (i === 5) { nearDummy(c, d); Core.addShield(d, 80, 3, 'x'); Core.addTenacity(c, 0.6, 2); }
      if (i === 20) cmds = [cmd('cast', 'p1', { skill: 'w', ang: 0 })];
      if (i === 60) Core.addSilence(w, c, 1.5);
      if (i === 90) cmds = [cmd('input', 'p1', { mx: 0, my: 0, atk: true })];
      if (i === 300) { d.shred = { t: 6, pct: 0.25 }; Core.addSilence(w, d, 2); }
      if (i === 400) cmds = [cmd('cast', 'p1', { skill: 'q', ang: 0 })];
      if (i === 600) { nearRUlt(c, d); cmds = [cmd('cast', 'p1', { skill: 'r', ang: 0 })]; }
      Core.step(w, cmds);
    }
    return w;
  };
  const a = play(), b = play();
  ok('8 같은 명령이면 같은 결과(보호막·침묵·강인함·방어력 감소 포함)', JSON.stringify(a) === JSON.stringify(b));
  ok('8 시나리오가 실제로 피해를 냄(허수아비 총 피해 > 0)', a.dummies[0].total > 0, a.dummies[0].total.toFixed(1)); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
