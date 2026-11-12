/* =====================================================================
   가렌 규칙 테스트 (DESIGN_GAREN.md §0 G5~G13, §2 / 원문 docs/spec/garen.md)
   - 6레벨 기준. 가렌 6레벨: 최대 체력 1180, 공격력 91.5, 방어력 59, 마법저항력 39.75, 공속 0.625×1.1825
   - 자연 회복은 끄고(quiet), 포탑은 격리해서 각 규칙만 봅니다. 거리 단위는 유닛(히트박스 끝 기준).
   - 다리우스·마스터 이와 붙여 맞춰 보는 테스트는 같은 식(공식)으로 기대값을 계산합니다.
   ===================================================================== */
const Core = require('../shared/core.js');
const fs = require('fs'), path = require('path');
Core.setMap(JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/walk_rle.json'), 'utf8')));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  → ' + extra : '')); };
const near = (a, b, e = 0.01) => Math.abs(a - b) <= e;
const px = Core.px, TICK = Core.TICK, EPS = 1e-6;
const ticks = sec => Math.round(sec / TICK);
const run = (w, sec, cmds) => { const n = ticks(sec); for (let i = 0; i < n; i++) Core.step(w, i === 0 ? cmds : []); };
const until = (w, pred, max = 30) => { let n = 0; while (!pred() && n++ < max / TICK) Core.step(w, []); return n; };
const cmd = (type, id, extra) => Object.assign({ type, id }, extra || {});
const inp = (id, mx, my, atk) => cmd('input', id, { mx, my, atk: !!atk });
const quiet = c => { c.stats.regen = 0; c.stats.manaRegen = 0; };   // 자연 회복 끄기
const lvl = (w, c, pts) => { for (const [k, n] of Object.entries(pts)) for (let i = 0; i < n; i++) Core.step(w, [cmd('levelup', c.id, { skill: k })]); };
const gar = w => w.champs[0], dum = w => w.dummies[0];
const hasText = (evs, s) => evs.some(e => e.type === 'text' && e.txt === s);
const pool = u => u.hp + Core.shieldOf(u);   // 보호막까지 합친 체력: 이 값의 감소 = 방어력·감소 적용 뒤 받은 피해
// 가렌(p1, 팀0) + 허수아비. 포탑 격리, 자연 회복 끔
const mk = (players) => {
  const w = Core.createWorld({ players: players || [{ id: 'p1', key: 'garen', team: 0 }], dummy: true });
  w.turrets.forEach(t => { t.dead = true; });
  w.champs.forEach(quiet);
  return w;
};
// 적 챔피언이 있는 1:1 (허수아비 없음). 두 번째 챔피언은 e1
const duel = (enemyKey) => {
  const w = Core.createWorld({ players: [{ id: 'p1', key: 'garen', team: 0 }, { id: 'e1', key: enemyKey, team: 1 }], dummy: false });
  w.turrets.forEach(t => { t.dead = true; });
  w.champs.forEach(quiet);
  const g = w.champs[0], e = w.champs[1];
  g.x = 600; g.y = 500;
  return { w, g, e };
};
// c를 t의 히트박스 끝에서 edge 유닛만큼 떨어진 곳(각도 ang 방향)에 둔다. t는 움직이지 않음
const placeEdge = (c, t, edge, ang = Math.PI) => { const dd = px(edge) + px(c.r) + px(t.r); c.x = t.x + Math.cos(ang) * dd; c.y = t.y + Math.sin(ang) * dd; };
// 걸을 수 있는 가로 200px 구간을 찾음(이동 테스트용)
const openSpot = () => {
  for (let y = 300; y < 900; y += 20) for (let x = 200; x < 1100; x += 20) {
    let good = true;
    for (let k = 0; k <= 10 && good; k++) if (!Core.canStand(x + k * 20, y)) good = false;
    if (good) return { x, y };
  }
  return null;
};
// 평타 한 번 적중: 대상의 (체력+보호막) 감소량 = 방어력·관통·피해 감소 뒤 받은 피해
const hitOnce = (w, a, t) => {
  let g = 0;
  while ((a.atk || a.atkCd > 0) && g++ < 2000) Core.step(w, []);
  const p0 = pool(t);
  Core.step(w, [inp(a.id, 0, 0, true)]);
  while (!(a.atk && a.atk.hit) && g++ < 4000) Core.step(w, []);
  Core.step(w, [inp(a.id, 0, 0, false)]);
  return p0 - pool(t);
};

// ---------------------------------------------------------------------
// 1. 기본 스탯 · 마나 없음 · 스킬 마나 0 (§2-1)
// ---------------------------------------------------------------------
{ const st = Core.calcStats('garen', 6);
  ok('1 레벨 6 최대 체력 = 690 + 98×5 = 1180', st.maxHp === 1180, st.maxHp);
  ok('1 체력 재생 = 8 + 0.5×5 = 10.5', near(st.regen, 10.5, 1e-9), st.regen);
  ok('1 공격력 = 69 + 4.5×5 = 91.5', near(st.ad, 91.5, 1e-9), st.ad);
  ok('1 방어력 = 38 + 4.2×5 = 59, 마법 저항력 = 32 + 1.55×5 = 39.75', near(st.armor, 59, 1e-9) && near(st.mr, 39.75, 1e-9), `${st.armor} / ${st.mr}`);
  ok('1 공격속도 성장 3.65%: 0.625 × (1 + 0.0365×5)', near(st.as, 0.625 * 1.1825, 1e-9), st.as);
  ok('1 사거리 175, 이동속도 340', st.range === 175 && st.ms === 340);
  ok('1 마나 없음: 최대 마나 0, 마나 재생 0', st.maxMana === 0 && st.manaRegen === 0);
  const w = mk(), c = gar(w);
  ok('1 curAS(6레벨) = 0.625 × 1.1825', near(Core.curAS(c), 0.625 * 1.1825, 1e-9), Core.curAS(c));
  ok('1 모든 스킬 마나 소모 0', ['q', 'w', 'e', 'r'].every(k => Core.skMana(c, k) === 0));
  ok('1 레벨 캡: Q·W·E 5, R 1', Core.SKILLS.garen.q.max === 5 && Core.SKILLS.garen.w.max === 5 && Core.SKILLS.garen.e.max === 5 && Core.SKILLS.garen.r.max === 1);
  // 자연 재생을 켠 채 10초: 마나 0이고 숫자 오류(NaN)가 없어야 함
  const wn = Core.createWorld({ players: [{ id: 'p1', key: 'garen', team: 0 }], dummy: true });
  wn.turrets.forEach(t => { t.dead = true; });
  const cn = wn.champs[0]; cn.hp = cn.stats.maxHp - 200;
  run(wn, 10);
  ok('1 자연 재생을 켠 채 10초: 마나 0, NaN 없음, 체력 재생은 정상', cn.mana === 0 && !Number.isNaN(cn.mana) && Number.isFinite(cn.hp) && cn.hp > cn.stats.maxHp - 200, `mana ${cn.mana} hp ${cn.hp.toFixed(2)}`);
  // 마나 0이어도 시전 가능 (결정타 + 용기)
  lvl(w, c, { q: 5, w: 1 });
  Core.step(w, [cmd('cast', 'p1', { skill: 'q', ang: 0 })]);
  Core.step(w, [cmd('cast', 'p1', { skill: 'w', ang: 0 })]);
  ok('1 마나 0으로 결정타·용기 시전 가능', !!c.gq && !!c.gw && c.mana === 0 && !Number.isNaN(c.mana));
  ok('1 용기 처치 수 0: 방어력 = 기본 방어력', c.courage === 0 && Core.armorOf(c) === 59, Core.armorOf(c)); }

// ---------------------------------------------------------------------
// 2. 인내심 패시브 (§2-2, G5)
// ---------------------------------------------------------------------
{ // 2a. 피해 없이 8초가 지나기 전에는 회복 없음, 지난 뒤 초당 최대 체력 0.5%
  const w = mk(), c = gar(w);
  c.hp = 1000;
  run(w, 7.9);
  ok('2 피해 없이 7.9초: 회복 없음', c.hp === 1000, c.hp);
  run(w, 0.2);
  const h0 = c.hp;
  run(w, 2);
  ok('2 8초 뒤부터 초당 0.5%(1180 × 0.005 = 5.9) 연속 회복 → 2초에 11.8', near(c.hp - h0, 11.8, 0.05), (c.hp - h0).toFixed(3)); }

{ // 2b. 피해를 받으면 다시 8초: 피해 뒤 7.9초에는 회복 없음
  const { w, g, e } = duel('darius');
  placeEdge(e, g, 200, 0);
  lvl(w, e, { r: 1 }); e.mana = e.stats.maxMana;
  g.hp = 1000;
  Core.step(w, [cmd('cast', 'e1', { skill: 'r', ang: 0 })]);
  run(w, 0.5);
  ok('2 다리우스 궁극기(진실 피해 125) 적중 → 체력 875, 인내심 타이머 리셋', near(g.hp, 875, 1e-6) && g.persT < 0.3, `${g.hp} persT ${g.persT.toFixed(3)}`);
  until(w, () => g.persT >= 7.9);
  ok('2 피해 뒤 7.9초: 회복 없음', near(g.hp, 875, 1e-6), g.hp);
  until(w, () => g.persT >= 8.1);
  const h0 = g.hp;
  run(w, 2);
  ok('2 다시 8초 뒤부터 회복: 2초에 11.8', near(g.hp - h0, 11.8, 0.05), (g.hp - h0).toFixed(3)); }

{ // 2c. 보호막이 피해를 전부 막아도 인내심 타이머는 리셋됨
  const { w, g, e } = duel('darius');
  placeEdge(e, g, 200, 0);
  lvl(w, e, { r: 1 }); e.mana = e.stats.maxMana;
  g.hp = 1000;
  Core.addShield(g, 500, 5, 'test');
  Core.step(w, [cmd('cast', 'e1', { skill: 'r', ang: 0 })]);
  run(w, 0.5);
  ok('2 보호막이 125를 전부 흡수: 체력 그대로, 보호막 375 남음', g.hp === 1000 && near(Core.shieldOf(g), 375, 1e-6), `hp ${g.hp} shield ${Core.shieldOf(g)}`);
  ok('2 보호막에 막힌 피해도 인내심 타이머 리셋', g.persT < 0.3, g.persT.toFixed(3));
  until(w, () => g.persT >= 7.9);
  ok('2 막힌 피해 뒤 7.9초: 회복 없음', g.hp === 1000, g.hp); }

{ // 2d. 다른 챔피언(다리우스)에게는 인내심이 없음
  const w = Core.createWorld({ players: [{ id: 'p1', key: 'darius', team: 0 }], dummy: false });
  w.turrets.forEach(t => { t.dead = true; });
  const d = w.champs[0]; quiet(d); d.hp = d.stats.maxHp - 500;
  run(w, 10);
  ok('2 다리우스는 10초 동안 회복 없음(인내심은 가렌만)', d.hp === d.stats.maxHp - 500, d.hp); }

// ---------------------------------------------------------------------
// 3. 결정타 Q (§2-3, G6, G7)
// ---------------------------------------------------------------------
{ // 3a. 둔화 제거 · 이동속도 +35% · 강화 상태
  const w = mk(), c = gar(w); lvl(w, c, { q: 5 });
  c.slow = { pct: 0.4, t: 3 };
  Core.step(w, [cmd('cast', 'p1', { skill: 'q', ang: 0 })]);
  ok('3 Q: 모든 둔화 제거', c.slow === null);
  ok('3 Q: 이동속도 +35% (curMS = 340 × 1.35)', near(Core.curMS(c), 459, 1e-6), Core.curMS(c));
  ok('3 Q: 5레벨 이동속도 지속 3.6초', near(c.gqMs, 3.6, 2 * TICK), c.gqMs);
  ok('3 Q: 강화 4.5초(c.gq = {t, lv})', !!c.gq && c.gq.lv === 5 && near(c.gq.t, 4.5, 2 * TICK), JSON.stringify(c.gq)); }

{ // 3b. 이동속도: 강화 중 ×1.35 (걷기 거리 비교)
  const spot = openSpot();
  const walk = withQ => {
    const w = Core.createWorld({ players: [{ id: 'p1', key: 'garen', team: 0 }], dummy: false });
    w.turrets.forEach(t => { t.dead = true; });
    const c = w.champs[0]; quiet(c); lvl(w, c, { q: 5 });
    c.x = spot.x; c.y = spot.y;
    const x0 = c.x;
    const cmds = withQ ? [cmd('cast', 'p1', { skill: 'q', ang: 0 }), inp('p1', 1, 0, false)] : [inp('p1', 1, 0, false)];
    Core.step(w, cmds);
    run(w, 0.5, [inp('p1', 1, 0, false)]);
    return c.x - x0;
  };
  const d0 = walk(false), d1 = walk(true);
  ok('3 결정타 강화 중 이동 거리 ×1.35 (걷기만 할 때 대비)', near(d1 / d0, 1.35, 0.01), `${d1.toFixed(3)} / ${d0.toFixed(3)} = ${(d1 / d0).toFixed(4)}`); }

{ // 3c. 다음 평타 피해 = (150 + 1.5×총 공격력) × 방어력 배율 (6레벨, 5레벨 Q, 방어력 60)
  const w = mk(), c = gar(w), d = dum(w); lvl(w, c, { q: 5 });
  d.armor = 60; placeEdge(c, d, 20);
  Core.step(w, [cmd('cast', 'p1', { skill: 'q', ang: 0 })]);
  const dmg = hitOnce(w, c, d);
  const expect = (150 + 1.5 * Core.curAD(c)) / (1 + 0.6);
  ok('3 결정타 평타 피해 = (150 + 1.5×91.5) ÷ 1.6 = 179.53', near(dmg, expect, 0.001), dmg.toFixed(4));
  ok('3 강화는 그 평타로 소모됨', c.gq === null);
  ok('3 대상 1.5초 침묵', !!d.silence && near(d.silence.t, 1.5, 3 * TICK), d.silence && d.silence.t.toFixed(4));
  run(w, 1);
  ok('3 평타가 나간 뒤부터 Q 쿨타임이 흐름(8 → 약 7)', near(c.cd.q, 7, 0.05), c.cd.q.toFixed(3)); }

{ // 3d. 강인함 60%면 침묵 1.5초가 0.6초
  const w = mk(), c = gar(w), d = dum(w); lvl(w, c, { q: 5 });
  d.armor = 0; placeEdge(c, d, 20);
  Core.addTenacity(d, 0.6, 99);
  Core.step(w, [cmd('cast', 'p1', { skill: 'q', ang: 0 })]);
  hitOnce(w, c, d);
  ok('3 강인함 60%: 결정타 침묵 1.5 → 0.6초', !!d.silence && near(d.silence.t, 0.6, 3 * TICK), d.silence && d.silence.t.toFixed(4)); }

{ // 3e. 강화는 4.5초 뒤 사라지고, 그동안 Q 쿨타임은 멈춰 있음
  const w = mk(), c = gar(w); lvl(w, c, { q: 5 });
  Core.step(w, [cmd('cast', 'p1', { skill: 'q', ang: 0 })]);
  run(w, 4.4);
  ok('3 4.4초: 강화 아직 있음', !!c.gq);
  ok('3 강화 중 Q 쿨타임 멈춤(8초 그대로)', c.cd.q === 8, c.cd.q);
  run(w, 0.2);
  ok('3 4.5초가 지나면 강화 사라짐', c.gq === null);
  const cdAtExpire = c.cd.q;
  run(w, 1);
  ok('3 강화가 끝난 뒤 쿨타임이 흐름(1초에 약 1 감소)', near(cdAtExpire - c.cd.q, 1, 0.05) && c.cd.q < 8, `${cdAtExpire.toFixed(3)} → ${c.cd.q.toFixed(3)}`); }

{ // 3f. 회전(E) 중 Q: 둔화 제거·이동만 적용, 평타는 못 침. 회전이 끝난 뒤 남은 강화로 평타
  const w = mk(), c = gar(w), d = dum(w); lvl(w, c, { q: 5, e: 1 });
  d.armor = 0; placeEdge(c, d, 60);
  Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]);
  run(w, 0.1);
  Core.step(w, [cmd('cast', 'p1', { skill: 'q', ang: 0 })]);
  ok('3 회전 중 Q 사용 가능: 강화 생김', !!c.gq && !!c.ge);
  Core.step(w, [inp('p1', 0, 0, true)]);
  ok('3 회전 중 평타 버튼은 무시(평타 동작 없음)', !c.atk && !c.chase);
  Core.step(w, [inp('p1', 0, 0, false)]);
  until(w, () => !c.ge, 10);
  ok('3 회전이 끝나도 강화는 남아 있음(4.5초 안)', !!c.gq, c.gq && c.gq.t.toFixed(3));
  const dmg = hitOnce(w, c, d);
  ok('3 회전 뒤 강화 평타 = 150 + 1.5×91.5 = 287.25 (방어력 0)', near(dmg, 287.25, 0.001), dmg.toFixed(4));
  ok('3 강화 소모', c.gq === null); }

// ---------------------------------------------------------------------
// 4. 용기 W (§2-4, G8)
// ---------------------------------------------------------------------
{ // 4a. 받는 물리 피해 ×0.75 (1레벨 25%). 마스터 이 평타(77.5 공격력) 두 번 비교
  const w = Core.createWorld({ players: [{ id: 'p1', key: 'garen', team: 0 }, { id: 'e1', key: 'yi', team: 1 }], dummy: false });
  w.turrets.forEach(t => { t.dead = true; });
  w.champs.forEach(quiet);
  const g = w.champs[0], y = w.champs[1];
  g.x = 600; g.y = 500; placeEdge(y, g, 40, 0);
  const d0 = hitOnce(w, y, g);
  g.gw = { t: 4, lv: 1 };
  const d1 = hitOnce(w, y, g);
  ok('4 평타 피해 기준: 77.5 ÷ (1 + 방어력 59 × 0.01)', near(d0, 77.5 / 1.59, 0.01), d0.toFixed(3));
  ok('4 용기 1레벨: 받는 물리 피해 ×0.75', near(d1 / d0, 0.75, 0.005), `${d0.toFixed(3)} → ${d1.toFixed(3)}`); }

{ // 4b. 진실 피해(다리우스 궁극기 125)도 감소 → 93.75
  const { w, g, e } = duel('darius'); placeEdge(e, g, 200, 0); lvl(w, e, { r: 1 }); e.mana = e.stats.maxMana;
  g.hp = 1000; g.gw = { t: 4, lv: 1 };
  Core.step(w, [cmd('cast', 'e1', { skill: 'r', ang: 0 })]); run(w, 0.5);
  ok('4 용기 중 고정 피해 125 → 93.75', near(1000 - g.hp, 93.75, 1e-6), (1000 - g.hp).toFixed(3)); }

{ // 4c. 포탑 피해도 감소 (용기 있을 때 / 없을 때 같은 시간 비교)
  const lossT = withW => {
    const w = Core.createWorld({ players: [{ id: 'p1', key: 'garen', team: 0 }], dummy: false });
    w.turrets.forEach(t => { t.dead = true; });
    const tf = w.turrets.find(t => t.id === 't_foe'); tf.dead = false; tf.hp = tf.maxHp;
    const g = w.champs[0]; quiet(g);
    g.x = tf.x - px(250); g.y = tf.y;
    if (withW) g.gw = { t: 4, lv: 1 };
    const h0 = g.hp; run(w, 4);
    return h0 - g.hp;
  };
  const a = lossT(false), b = lossT(true);
  ok('4 포탑 피해도 감소: 용기 1레벨 ×0.75', a > 0 && near(b / a, 0.75, 0.005), `${a.toFixed(2)} / ${b.toFixed(2)}`); }

{ // 4d. 보호막 65 + 추가 체력 100의 18% = 83, 강인함 60%, 0.75초 뒤 사라짐. 피해 감소는 4초
  const w = mk(), c = gar(w); lvl(w, c, { w: 1 }); c.bonus.hp = 100;
  Core.step(w, [cmd('cast', 'p1', { skill: 'w', ang: 0 })]);
  ok('4 용기 보호막 = 65 + 18% × 추가 체력 100 = 83', near(Core.shieldOf(c), 83, 1e-6), Core.shieldOf(c));
  ok('4 용기 강인함 60%, 피해 감소 상태(gw)', near(Core.tenacityOf(c), 0.6, 1e-9) && !!c.gw && c.gw.lv === 1);
  run(w, 0.7);
  ok('4 0.7초: 보호막·강인함 남아 있음', Core.shieldOf(c) > 0 && Core.tenacityOf(c) > 0);
  run(w, 0.1);
  ok('4 0.8초: 보호막·강인함 사라짐', Core.shieldOf(c) === 0 && c.shields.length === 0 && Core.tenacityOf(c) === 0);
  run(w, 3.0);
  ok('4 3.8초: 피해 감소 아직 있음', !!c.gw);
  run(w, 0.3);
  ok('4 4.1초: 피해 감소 끝', c.gw === null && Core.dmgTakenMul(c, false) === 1); }

{ // 4e. 보호막이 피해 감소 뒤의 값을 깎음: 용기 1레벨 + 다리우스 궁극기 125 → 93.75 - 65 = 28.75
  const { w, g, e } = duel('darius'); placeEdge(e, g, 200, 0); lvl(w, e, { r: 1 }); e.mana = e.stats.maxMana;
  g.hp = 1000; lvl(w, g, { w: 1 });
  Core.step(w, [cmd('cast', 'p1', { skill: 'w', ang: 0 })]);
  Core.step(w, [cmd('cast', 'e1', { skill: 'r', ang: 0 })]); run(w, 0.5);
  ok('4 보호막은 피해 감소 뒤 값(93.75)을 깎음 → 체력 28.75 감소', near(1000 - g.hp, 28.75, 0.02) && Core.shieldOf(g) === 0, `${(1000 - g.hp).toFixed(3)} shield ${Core.shieldOf(g)}`); }

{ // 4f. 다리우스 W 둔화(1초)가 용기 강인함(60%)에 줄어듦 → 0.4초
  const { w, g, e } = duel('darius'); placeEdge(e, g, 40, 0);
  lvl(w, g, { w: 1 }); lvl(w, e, { w: 1 }); e.mana = e.stats.maxMana;
  Core.step(w, [cmd('cast', 'p1', { skill: 'w', ang: 0 }), cmd('cast', 'e1', { skill: 'w', ang: 0 })]);
  hitOnce(w, e, g);
  ok('4 다리우스 W 둔화 1초 × (1 - 강인함 0.6) = 0.4초(틱 오차 3까지)', !!g.slow && near(g.slow.t, 0.4, 3 * TICK), g.slow && g.slow.t.toFixed(4)); }

// 용기 영구 효과: 처치 +0.2 (챔피언·허수아비, 평타·궁극기·회전 모두), 최대 30, 부활해도 유지
{ const w = mk(), c = gar(w), d = dum(w);
  placeEdge(c, d, 20); d.armor = 0; d.hp = 1;
  hitOnce(w, c, d);
  ok('4 허수아비 평타 처치 → 용기 +0.2 (방어력·마법 저항력 각 +0.2)', near(c.courage, 0.2, 1e-9) && near(Core.armorOf(c), 59.2, 1e-9) && near(Core.mrOf(c), 39.95, 1e-9), `${c.courage} / ${Core.armorOf(c)}`);
  d.hp = 1;
  hitOnce(w, c, d);
  ok('4 같은 처치 두 번이면 +0.4', near(c.courage, 0.4, 1e-9), c.courage); }

{ const w = mk(), c = gar(w), d = dum(w);
  placeEdge(c, d, 20); d.armor = 0; c.courage = 29.9; d.hp = 1;
  hitOnce(w, c, d);
  ok('4 용기 29.9에서 처치 → 최대 30', c.courage === 30, c.courage);
  d.hp = 1;
  hitOnce(w, c, d);
  ok('4 최대 30을 넘지 않음', c.courage === 30, c.courage); }

{ const { w, g, e } = duel('darius'); placeEdge(e, g, 40, 0); e.hp = 1; e.stats.armor = 0;
  hitOnce(w, g, e);
  ok('4 챔피언 평타 처치 → 용기 +0.2', near(g.courage, 0.2, 1e-9) && e.dead, g.courage); }

{ const w = mk(), c = gar(w), d = dum(w); lvl(w, c, { r: 1 }); placeEdge(c, d, 100); d.hp = 100;
  Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]); run(w, 0.5);
  ok('4 궁극기 처치 → 용기 +0.2', near(c.courage, 0.2, 1e-9), c.courage); }

{ const w = mk(), c = gar(w), d = dum(w); lvl(w, c, { e: 1 }); placeEdge(c, d, 60); d.hp = 1;
  Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]); run(w, 3.5);
  ok('4 회전 타격으로 처치 → 용기 +0.2 (처치는 한 번만 셈)', near(c.courage, 0.2, 1e-9), c.courage); }

{ const { w, g, e } = duel('darius'); lvl(w, g, { q: 2 }); g.courage = 5; g.hp = 1;
  placeEdge(e, g, 200, 0); lvl(w, e, { r: 1 }); e.mana = e.stats.maxMana;
  Core.step(w, [cmd('cast', 'e1', { skill: 'r', ang: 0 })]); run(w, 0.5);
  ok('4 가렌이 죽음(다리우스 궁극기) → 가렌 용기는 그대로(다리우스가 용기를 얻지 않음)', g.dead && g.courage === 5 && e.courage === 0, `${g.courage} ${e.courage}`);
  run(w, 5.2);
  ok('4 부활 후 용기 5 유지, 방어력 64에 반영, 스킬 레벨 유지', !g.dead && g.courage === 5 && near(Core.armorOf(g), 64, 1e-9) && g.sk.q === 2, `${g.courage} ${Core.armorOf(g)} q${g.sk.q}`); }

// ---------------------------------------------------------------------
// 5. 심판 E (§2-5, G9~G11)
// ---------------------------------------------------------------------
const spinCount = bonusAS => { const w = mk(), c = gar(w); c.bonus.as = bonusAS; lvl(w, c, { e: 1 }); Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]); return c.ge ? c.ge.n : -1; };
{ ok('5 회전 수 7 (레벨 6, 레벨 성장 공속 18.25%)', spinCount(0) === 7, spinCount(0));
  ok('5 추가 공속 +10% → 공속 28.25% → 8회', spinCount(0.10) === 8, spinCount(0.10));
  ok('5 추가 공속 +40% → 58.25% → 9회', spinCount(0.40) === 9, spinCount(0.40)); }

{ // 5b. 타격 시점 (k+0.5)×3/7: 첫 타 0.21초. 회전은 정확히 3초, 끝나는 순간 E 쿨타임 9 시작
  const w = mk(), c = gar(w), d = dum(w); lvl(w, c, { e: 1 }); placeEdge(c, d, 60);
  Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]);
  ok('5 회전 중 E 쿨타임 표시값 0 (버튼은 취소 상태: c.ge != null)', c.cd.e === 0 && !!c.ge, c.cd.e);
  const hitT = []; let el = TICK, endT = null, cdEnd = null;
  for (let i = 0; i < 260; i++) {
    Core.step(w, []); el += TICK;
    for (const e of Core.drainEvents(w)) if (e.type === 'fx' && e.fx === 'gspin') hitT.push(el);
    if (!c.ge && endT === null) { endT = el; cdEnd = c.cd.e; }
  }
  const exp = [0, 1, 2, 3, 4, 5, 6].map(k => (k + 0.5) * 3 / 7);
  ok('5 회전 타격 7회', hitT.length === 7, hitT.length);
  ok('5 타격 시점 (k+0.5)×3/7, 첫 타 약 0.21초 (±1틱)', hitT.length === 7 && hitT.every((t, k) => Math.abs(t - exp[k]) <= TICK + EPS), hitT.map(t => t.toFixed(3)).join(' '));
  ok('5 회전은 3초에 끝나고 그때 E 쿨타임 9 시작', endT !== null && Math.abs(endT - 3) <= 2 * TICK && near(cdEnd, 9, 2 * TICK), `end ${endT && endT.toFixed(3)} cd ${cdEnd && cdEnd.toFixed(3)}`); }

{ // 5c. 가장 가까운 적 ×1.25: 허수아비(가까움) 50.75, 다리우스(멂, 방어력 0) 40.6
  const w = Core.createWorld({ players: [{ id: 'p1', key: 'garen', team: 0 }, { id: 'e1', key: 'darius', team: 1 }], dummy: true });
  w.turrets.forEach(t => { t.dead = true; }); w.champs.forEach(quiet);
  const g = w.champs[0], e = w.champs[1], d = w.dummies[0];
  lvl(w, g, { e: 1 }); d.armor = 0; e.stats.armor = 0;
  placeEdge(g, d, 60); placeEdge(e, g, 150, Math.PI / 2);
  const e0 = e.hp, d0 = d.total;
  Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]); run(w, 3.5);
  const raw = 4 + 0.4 * 91.5;   // 1레벨 E: 4 + 0.4 × 총 공격력 = 40.6
  ok('5 가장 가까운 허수아비: 7회 × 40.6 × 1.25 = 355.25', near(d.total - d0, 7 * raw * 1.25, 0.01), (d.total - d0).toFixed(3));
  ok('5 멀리 있는 다리우스: 7회 × 40.6 = 284.2 (×1.25 없음)', near(e0 - e.hp, 7 * raw, 0.01), (e0 - e.hp).toFixed(3)); }

{ // 5d. 6번째 타격으로 챔피언에게 방어력 감소 25%(6초), 7번째 타격부터 줄어든 방어력 적용
  const { w, g, e } = duel('darius'); lvl(w, g, { e: 1 }); placeEdge(e, g, 60, 0);
  let prev = e.hp; const per = []; let shredSeen = null;
  for (let i = 0; i < 220; i++) {
    Core.step(w, i === 0 ? [cmd('cast', 'p1', { skill: 'e', ang: 0 })] : []);
    const hitNow = Core.drainEvents(w).some(x => x.type === 'fx' && x.fx === 'gspin');
    if (hitNow) per.push(prev - e.hp);
    prev = e.hp;
    if (per.length === 6 && shredSeen === null) shredSeen = e.shred ? { pct: e.shred.pct, t: e.shred.t } : 'none';
  }
  const one = 4 + 0.4 * 91.5;
  ok('5 다리우스 방어력 63: 1~6타 = 40.6 × 1.25 ÷ 1.63 = 31.14', per.length >= 6 && near(per[5], one * 1.25 / 1.63, 0.01), per.map(x => x.toFixed(2)).join(' '));
  ok('5 6번째 타격 뒤 방어력 감소 25%, 6초', shredSeen && shredSeen.pct === 0.25 && near(shredSeen.t, 6, 2 * TICK), JSON.stringify(shredSeen));
  ok('5 7번째 타격은 방어력 63 × 0.75 = 47.25 기준 (40.6 × 1.25 ÷ 1.4725 = 34.47)', per.length === 7 && near(per[6], one * 1.25 / 1.4725, 0.01), per[6] && per[6].toFixed(3)); }

{ // 5e. 반지름 경계: 히트박스 끝에서 325 (다리우스 Q와 같은 식). 안쪽 324.9는 맞고 325.1은 안 맞음
  const hitsAt = edge => { const w = mk(), c = gar(w), d = dum(w); lvl(w, c, { e: 1 }); d.armor = 0; placeEdge(c, d, edge);
    Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]); run(w, 3.5); return d.total; };
  ok('5 반지름 325 안쪽(가장자리 324.9) → 맞음', hitsAt(324.9) > 0, hitsAt(324.9).toFixed(2));
  ok('5 반지름 325 바깥(가장자리 325.1) → 안 맞음', hitsAt(325.1) === 0, hitsAt(325.1)); }

{ // 5f. 회전 중 이동 가능: 1초 걷기 = 340 유닛 (맵에서 걸을 수 있는 구간)
  const spot = openSpot(); const w = Core.createWorld({ players: [{ id: 'p1', key: 'garen', team: 0 }], dummy: false });
  w.turrets.forEach(t => { t.dead = true; }); const c = w.champs[0]; quiet(c); lvl(w, c, { e: 1 });
  c.x = spot.x; c.y = spot.y;
  Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]);
  const x0 = c.x;
  run(w, 1, [inp('p1', 1, 0, false)]);
  ok('5 회전 중 이동 가능: 1초 걷기 = 340 유닛', near(c.x - x0, px(340), 0.5), (c.x - x0).toFixed(3));
  ok('5 이동하는 동안에도 회전은 계속(타격 2회 이상)', !!c.ge && c.ge.done >= 2, c.ge && c.ge.done); }

{ // 5g. 공중에 뜨면 이동만 막히고 회전·타격은 계속, 공중이 끝나면 다시 이동
  const spot = openSpot(); const w = mk(), c = gar(w), d = dum(w); lvl(w, c, { e: 1 });
  c.x = spot.x; c.y = spot.y; placeEdge(d, c, 60, 0);
  Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]);
  Core.step(w, [cmd('dev', 'p1', { op: 'air' })]);
  const x0 = c.x, y0 = c.y;
  run(w, 0.9, [inp('p1', 1, 0, false)]);
  ok('5 공중에 뜸: 이동 불가(위치 그대로)', c.x === x0 && c.y === y0);
  ok('5 공중에 떠도 회전 타격 계속(2회 이상)', c.ge && c.ge.done >= 2 && d.total > 0, c.ge && c.ge.done);
  run(w, 0.3);
  ok('5 공중이 끝나면 다시 이동', c.x !== x0 || c.y !== y0); }

{ // 5h. 다시 누르면 취소: 쿨타임 9초 시작, 이후 타격 없음
  const w = mk(), c = gar(w), d = dum(w); lvl(w, c, { e: 1 }); placeEdge(c, d, 60);
  Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]);
  run(w, 1);
  const tot = d.total;
  Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]);
  ok('5 E 다시 누르면 회전 취소', !c.ge);
  ok('5 취소하면 E 쿨타임 9초 시작', near(c.cd.e, 9, 2 * TICK), c.cd.e);
  run(w, 0.8);
  ok('5 취소 뒤에는 타격 없음', d.total === tot, d.total - tot);
  ok('5 취소 뒤 쿨타임 흐름', c.cd.e < 9 && c.cd.e > 8, c.cd.e.toFixed(3)); }

{ // 5i. R을 누르면 회전이 즉시 멈추고 궁극기 시전 (E 쿨타임 9 시작)
  const w = mk(), c = gar(w), d = dum(w); lvl(w, c, { e: 1, r: 1 }); placeEdge(c, d, 60);
  Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]);
  run(w, 0.5);
  Core.drainEvents(w);
  const tot = d.total, miss = d.maxHp - d.hp;   // 궁극기 피해 = 125 + 25% × 잃은 체력(회전 타격으로 잃은 만큼 포함)
  Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]);
  ok('5 R 누르면 회전 즉시 멈추고 궁극기 시전', !c.ge && !!c.gr);
  ok('5 회전이 멈춘 순간 E 쿨타임 9초 시작', near(c.cd.e, 9, 2 * TICK), c.cd.e);
  run(w, 0.5);
  const evs = Core.drainEvents(w);
  ok('5 궁극기 시전 중에는 회전 타격 없음, 궁극기 125만 들어감', !evs.some(x => x.type === 'fx' && x.fx === 'gspin') && near(d.total - tot, 125 + 0.25 * miss, 0.01), (d.total - tot).toFixed(3)); }

// ---------------------------------------------------------------------
// 6. 데마시아의 정의 R (§2-6, G12, G13)
// ---------------------------------------------------------------------
{ // 6a. 대상: 400 안 가장 가까운 챔피언 우선(허수아비가 더 가까워도), 없으면 허수아비
  const w = Core.createWorld({ players: [{ id: 'p1', key: 'garen', team: 0 }, { id: 'e1', key: 'darius', team: 1 }], dummy: true });
  w.turrets.forEach(t => { t.dead = true; }); w.champs.forEach(quiet);
  const g = w.champs[0], e = w.champs[1], d = w.dummies[0];
  lvl(w, g, { r: 1 });
  placeEdge(g, d, 100); placeEdge(e, g, 300, 0);
  Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]);
  ok('6 챔피언이 허수아비보다 우선(챔피언이 더 멀어도)', !!g.gr && g.gr.targetId === 'e1', g.gr && g.gr.targetId);
  const w2 = mk(), g2 = gar(w2), d2 = dum(w2); lvl(w2, g2, { r: 1 }); placeEdge(g2, d2, 300);
  Core.step(w2, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]);
  ok('6 챔피언이 없으면 400 안 허수아비', !!g2.gr && g2.gr.targetId === 'dummy1', g2.gr && g2.gr.targetId); }

{ // 6b. 사거리 400 경계(히트박스 끝 기준): 399는 시전, 401은 대상 없음(쿨타임·마나 소모 없음)
  const tryAt = edge => {
    const w = mk(), c = gar(w), d = dum(w); lvl(w, c, { r: 1 }); placeEdge(c, d, edge);
    Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]);
    const evs = Core.drainEvents(w);
    return { gr: c.gr, cd: c.cd.r, msg: hasText(evs, '사거리 내 대상 없음') };
  };
  const a = tryAt(399), b = tryAt(401);
  ok('6 사거리 안(399): 궁극기 시전, 쿨타임 소모', !!a.gr && a.cd > 119);
  ok('6 사거리 밖(401): 대상 없음 안내, 쿨타임 0 그대로', !b.gr && b.cd === 0 && b.msg, `${b.gr} ${b.cd} ${b.msg}`); }

{ // 6c. 피해: 125 + 25% × 잃은 체력 (허수아비 3000 → 잃은 2000 → 625, 다리우스 체력 1222-300 → 200)
  const w = mk(), c = gar(w), d = dum(w); lvl(w, c, { r: 1 }); placeEdge(c, d, 100); d.hp = 3000;
  Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]); run(w, 0.5);
  ok('6 허수아비 잃은 체력 2000 → 고정 피해 625', near(3000 - d.hp, 625, 0.01), (3000 - d.hp).toFixed(3));
  const { w: w2, g: g2, e: e2 } = duel('darius'); placeEdge(e2, g2, 100, 0); lvl(w2, g2, { r: 1 });
  e2.hp = e2.stats.maxHp - 300;
  Core.step(w2, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]); run(w2, 0.5);
  ok('6 다리우스 잃은 체력 300 → 125 + 75 = 200', near(e2.stats.maxHp - 300 - e2.hp, 200, 0.01), (e2.stats.maxHp - 300 - e2.hp).toFixed(3)); }

{ // 6d. 시전 중 대상이 대상 지정 불가(마스터 이 일격필살) → 즉시 취소, 쿨타임 반환, '취소됨'
  const { w, g, e } = duel('yi'); placeEdge(e, g, 200, 0); lvl(w, g, { r: 1 }); lvl(w, e, { q: 1 }); e.mana = e.stats.maxMana;
  Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]);
  Core.drainEvents(w);
  Core.step(w, [cmd('cast', 'e1', { skill: 'q', ang: 0 })]);
  const evs = Core.drainEvents(w);
  ok('6 마스터 이 일격필살로 대상 지정 불가가 되면 궁극기 즉시 취소', e.untarget === true && g.gr === null && hasText(evs, '취소됨'));
  ok('6 취소되면 궁극기 쿨타임 반환(0)', g.cd.r === 0, g.cd.r); }

{ // 6e. 시전 중 대상이 400 밖으로 나감 → 그 틱에 헛방: 시전 종료, 피해 없음, 쿨타임 소모, Garen은 바로 이동 가능
  const spot = openSpot(); const w = mk(), c = gar(w), d = dum(w); lvl(w, c, { r: 1 });
  c.x = spot.x; c.y = spot.y; placeEdge(d, c, 100, Math.PI);
  Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]);
  run(w, 0.2);
  Core.drainEvents(w);
  placeEdge(d, c, 450, Math.PI);                                  // 0.2초 시점에 사거리 400 밖(450)으로 이동
  const n = until(w, () => !c.gr, 1);
  const evs = Core.drainEvents(w);
  ok('6 시전 중 400 밖으로 나감 → 그 틱에 헛방(시전 종료, 피해 없음)', n === 1 && !c.gr && d.hp === d.maxHp && hasText(evs, '빗나감'), `n ${n} hp ${d.hp}`);
  ok('6 헛방 쿨타임은 소모된 채(약 120)', c.cd.r > 119 && c.cd.r < 120, c.cd.r.toFixed(3));
  const x0 = c.x; run(w, 0.3, [inp('p1', 1, 0, false)]);
  ok('6 헛방 뒤 Garen 바로 이동 가능', c.x > x0, (c.x - x0).toFixed(3)); }

{ // 6f. 시전 내내 400 안(가장자리 399) → 적중: 고정 피해 125 + 25% × 잃은 체력, 칼 이펙트, 헛방 없음
  const w = mk(), c = gar(w), d = dum(w); lvl(w, c, { r: 1 }); placeEdge(c, d, 399); d.hp = 3000;
  Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]);
  const evs = [];
  run(w, 0.6); evs.push(...Core.drainEvents(w));
  ok('6 시전 내내 400 안(399) → 적중: 고정 피해 625, 빗나감 없음', near(3000 - d.hp, 625, 0.01) && !hasText(evs, '빗나감'), (3000 - d.hp).toFixed(3));
  ok('6 적중: 칼 이펙트(gsword), 쿨타임 소모, 시전 끝', evs.some(x => x.type === 'fx' && x.fx === 'gsword') && c.cd.r > 119 && c.cd.r < 120 && !c.gr, c.cd.r.toFixed(3)); }

{ // 6g. 시전이 끝나는 틱에는 거리 검사 없음: 완료 직전까지 400 안이던 대상이 완료 틱에 400 밖(500)이어도 적중
  const w = mk(), c = gar(w), d = dum(w); lvl(w, c, { r: 1 }); placeEdge(c, d, 100); d.hp = 3000;
  Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]);
  while (c.gr && c.gr.t + TICK < Core.SKILLS.garen.r.cast - EPS) Core.step(w, []);   // 완료 직전 틱까지 대상은 400 안
  const pre = Core.drainEvents(w), casting = !!c.gr;
  placeEdge(d, c, 500, 0);                                        // 다음 틱이 완료 틱
  Core.step(w, []);
  const evs = Core.drainEvents(w);
  ok('6 완료 직전까지 400 안이면 빗나감 없이 시전 중', casting && !hasText(pre, '빗나감'));
  ok('6 완료 틱에 대상이 400 밖(500)이어도 적중: 고정 피해 625', !c.gr && near(3000 - d.hp, 625, 0.01) && !hasText(evs, '빗나감'), (3000 - d.hp).toFixed(3)); }

{ // 6h. 시전 중 대상 지정 불가(직접 설정) → 즉시 취소, 쿨타임 반환, '취소됨', 피해 없음
  const w = mk(), c = gar(w), d = dum(w); lvl(w, c, { r: 1 }); placeEdge(c, d, 100);
  Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]); run(w, 0.2);
  Core.drainEvents(w);
  d.untarget = true;
  Core.step(w, []);
  const evs = Core.drainEvents(w);
  ok('6 시전 중 대상 지정 불가 → 즉시 취소, 쿨타임 반환(0), 피해 없음', !c.gr && c.cd.r === 0 && hasText(evs, '취소됨') && d.hp === d.maxHp, `${c.gr} ${c.cd.r} ${d.hp}`); }

{ // 6i. 시전 중 대상 사망 → 즉시 취소, 쿨타임 반환. 사망 상태는 settle이 남기는 것과 같게 직접 설정
  const { w, g, e } = duel('darius'); placeEdge(e, g, 100, 0); lvl(w, g, { r: 1 });
  Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]); run(w, 0.2);
  Core.drainEvents(w);
  e.hp = 0; e.dead = true; e.respawn = Core.RESPAWN_SEC;
  Core.step(w, []);
  const evs = Core.drainEvents(w);
  ok('6 시전 중 대상 사망 → 즉시 취소, 쿨타임 반환(0)', !g.gr && g.cd.r === 0 && hasText(evs, '취소됨'), `${g.gr} ${g.cd.r}`); }

{ // 6j. 궁극기 시전 중 Garen은 이동·평타 불가
  const w = mk(), c = gar(w), d = dum(w); lvl(w, c, { r: 1 }); placeEdge(c, d, 100);
  Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]);
  const x0 = c.x, y0 = c.y;
  run(w, 0.3, [inp('p1', 1, 0, true)]);
  ok('6 궁극기 시전 중 이동 불가', c.x === x0 && c.y === y0, `${c.x - x0}`);
  ok('6 궁극기 시전 중 평타 불가', !c.atk && !c.chase); }

// ---------------------------------------------------------------------
// 7. 결정성: 같은 명령 순서면 항상 같은 월드(JSON). 가렌·다리우스·마스터 이 모두
// ---------------------------------------------------------------------
{ const play = key => {
    const w = Core.createWorld({ players: [{ id: 'p1', key, team: 0 }], dummy: true });
    w.turrets.forEach(t => { t.dead = true; });
    const c = w.champs[0], d = w.dummies[0];
    placeEdge(c, d, 70);
    for (let i = 0; i < 1500; i++) {
      const cmds = [];
      if (i === 0) for (const k of ['q', 'w', 'e', 'r']) cmds.push(cmd('levelup', 'p1', { skill: k }));
      if (i === 10) cmds.push(cmd('cast', 'p1', { skill: 'q', ang: 0 }));
      if (i === 20) cmds.push(cmd('input', 'p1', { mx: 0, my: 0, atk: true }));
      if (i === 25) cmds.push(cmd('input', 'p1', { mx: 0, my: 0, atk: false }));
      if (i === 60) cmds.push(cmd('cast', 'p1', { skill: 'w', ang: 0 }));
      if (i === 90) cmds.push(cmd('cast', 'p1', { skill: 'e', ang: 0 }));
      if (i === 300) cmds.push(cmd('input', 'p1', { mx: 1, my: 0, atk: false }));
      if (i === 400) cmds.push(cmd('input', 'p1', { mx: 0, my: 0, atk: false }));
      if (i === 500) cmds.push(cmd('cast', 'p1', { skill: 'r', ang: 0 }));
      if (i === 700) cmds.push(cmd('cast', 'p1', { skill: 'e', ang: 0 }));
      if (i === 1000) cmds.push(cmd('input', 'p1', { mx: 0, my: 0, atk: true }));
      Core.step(w, cmds);
    }
    return w;
  };
  for (const key of ['garen', 'darius', 'yi']) {
    const a = play(key), b = play(key);
    ok(`7 ${key}: 같은 명령 → 같은 결과(JSON 동일)`, JSON.stringify(a) === JSON.stringify(b));
    ok(`7 ${key}: 시나리오가 실제로 진행됨(허수아비 피해 > 0)`, a.dummies[0].total > 0, a.dummies[0].total.toFixed(1));
  }
  const g = play('garen');
  ok('7 가렌: NaN 없음(체력·마나·용기)', [g.champs[0].hp, g.champs[0].mana, g.champs[0].courage, g.champs[0].persT].every(Number.isFinite)); }

// ---------------------------------------------------------------------
// 8. 회전·강화 중 W 사용 가능, 부활하면 가렌 상태 초기화(용기는 유지)
// ---------------------------------------------------------------------
{ const w = mk(), c = gar(w), d = dum(w); lvl(w, c, { e: 1, q: 1, w: 1 }); placeEdge(c, d, 60);
  Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]);
  Core.step(w, [cmd('cast', 'p1', { skill: 'q', ang: 0 })]);
  Core.step(w, [cmd('cast', 'p1', { skill: 'w', ang: 0 })]);
  ok('8 회전 중 Q·W 사용 가능(둘 다 적용, 회전은 계속)', !!c.ge && !!c.gq && !!c.gw && Core.shieldOf(c) > 0);
  ok('8 회전 중 W 사용 뒤에도 E 쿨타임 표시값 0(취소 상태)', c.cd.e === 0); }

{ const w = Core.createWorld({ players: [{ id: 'p1', key: 'garen', team: 0 }, { id: 'e1', key: 'darius', team: 1 }], dummy: false });
  w.turrets.forEach(t => { t.dead = true; }); w.champs.forEach(quiet);
  const g = w.champs[0], e = w.champs[1];
  lvl(w, g, { q: 1, w: 1, e: 1, r: 1 }); g.courage = 4;
  g.gq = { t: 3, lv: 1 }; g.gqMs = 1; g.gqMsPct = 0.35; g.gw = { t: 2, lv: 1 }; g.persT = 3;
  g.ge = { t: 0.1, lv: 1, n: 7, done: 0, hits: {} }; g.gr = { t: 0.1, targetId: 'e1', lv: 1 };
  g.hp = 1; placeEdge(e, g, 40, 0); lvl(w, e, { r: 1 }); e.mana = e.stats.maxMana;
  Core.step(w, [cmd('cast', 'e1', { skill: 'r', ang: 0 })]); run(w, 0.5);
  ok('8 가렌 사망 → 강화·용기 피해 감소·회전·궁극기 상태 모두 사라짐', g.dead && g.gq === null && g.gw === null && g.ge === null && g.gr === null && g.gqMs === 0);
  run(w, 5.2);
  ok('8 부활 → 인내심 타이머·상태 초기화, 용기 4 유지', !g.dead && g.persT < 1 && g.gq === null && g.courage === 4 && g.ge === null, `persT ${g.persT.toFixed(2)} courage ${g.courage}`); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
