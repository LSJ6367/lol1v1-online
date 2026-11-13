/* =====================================================================
   아트록스 2부 테스트 (DESIGN_AATROX.md §0-2 B1~B12, §2-4~2-6 / 원문 docs/spec/aatrox.md 두 번째 블록)
   - 회복 단일 입구(heal, B9: 회복 증가 ×1.5, 최대 체력 넘지 않음)
   - 지옥사슬(W): 투사체, 첫 적중 1명, 사거리, 둔화, 충격 지대, 1.5초 뒤 판정·끌림
   - 파멸의 돌진(E): 흡혈(16% + 0.013% × 추가 체력, 챔피언·허수아비만, 광역 ×0.33), 돌진 방향, 벽, 사용 조건
   - 세계의 종결자(R): 이동속도 10초 감쇠, 공격력 +20%, 회복 ×1.5, 챔피언 처치 +5초·감쇠 초기화
   - 자연 회복은 끄고(quiet), 포탑은 격리. 아트록스는 (400,700)(px)에 둡니다. 거리 단위는 유닛, 좌표는 px.
   - 허수아비 방어력·마법저항력은 0이라 피해 값이 그대로. 가렌(6레벨 방어력 59, 마법저항력 39.75)은 1/1.59 배.
   ===================================================================== */
const Core = require('../shared/core.js');
const P = require('../shared/protocol.js');
const fs = require('fs'), path = require('path');
Core.setMap(JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/walk_rle.json'), 'utf8')));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  → ' + extra : '')); };
const near = (a, b, e = 0.01) => Math.abs(a - b) <= e;
const px = Core.px, TICK = Core.TICK, EPS = 1e-9;
const cmd = (type, id, extra) => Object.assign({ type, id }, extra || {});
const inp = (id, mx, my, atk) => cmd('input', id, { mx, my, atk: !!atk });
const cast = (id, skill, ang, aimed) => cmd('cast', id, Object.assign({ skill, ang }, aimed ? { aimed: true } : {}));
const quiet = c => { c.stats.regen = 0; c.stats.manaRegen = 0; };        // 자연 회복 끄기
const lvl = (w, c, pts) => { for (const [k, n] of Object.entries(pts)) for (let i = 0; i < n; i++) Core.step(w, [cmd('levelup', c.id, { skill: k })]); };
const run = (w, sec, cmds) => { const n = Math.round(sec / TICK); for (let i = 0; i < n; i++) Core.step(w, i === 0 ? cmds : []); };
const pool = u => u.hp + Core.shieldOf(u);
const fxs = w => Core.drainEvents(w).filter(e => e.type === 'fx');
const AT = { x: 400, y: 700 };
const AD = 85;                                  // 6레벨 아트록스 총 공격력(60 + 5 × 5)
const MAXHP = 1220;                             // 6레벨 아트록스 최대 체력(650 + 114 × 5)

// 아트록스(p1, 팀0). enemy: 가렌(e1, 팀1). dummy: 허수아비 기본 위치(700,500). 포탑 격리, 자연 회복 끔
const mk = (o) => {
  o = o || {};
  const players = [{ id: 'p1', key: o.key || 'aatrox', team: 0 }];
  if (o.enemy) players.push({ id: 'e1', key: 'garen', team: 1 });
  const w = Core.createWorld({ players, dummy: o.dummy !== false });
  w.turrets.forEach(t => { t.dead = true; });
  w.champs.forEach(quiet);
  const a = w.champs[0];
  a.x = o.x ?? AT.x; a.y = o.y ?? AT.y;
  return { w, a, d: w.dummies[0] || null, e: w.champs[1] || null };
};
// 기준 c에서 (앞 f, 옆 s) 유닛, 방향 ang (앞 = (cos, sin), 옆 = (-sin, cos)). 월드 px
const at = (c, f, s, ang = 0) => ({ x: c.x + px(f) * Math.cos(ang) - px(s) * Math.sin(ang), y: c.y + px(f) * Math.sin(ang) + px(s) * Math.cos(ang) });
const put = (t, c, f, s, ang = 0) => { const p = at(c, f, s, ang); t.x = p.x; t.y = p.y; };
// 평타 한 번 적중: 적중 틱 전후 대상 체력+보호막 감소(dealt)와 가해자 체력 증가(gain)
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
// 조건이 참이 될 때까지 명령 없이 한 틱씩(최대 maxSec). 몇 틱 걸렸는지 돌려줌
const until = (w, pred, maxSec) => { let n = 0; while (!pred() && n < Math.round(maxSec / TICK)) { Core.step(w, []); n++; } return n; };
// 점과 볼록 다각형(테스트 전용 구현): 모든 변에 대해 같은 쪽이면 안
const inPoly = (qx, qy, poly) => {
  let pos = false, neg = false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const cr = (b[0] - a[0]) * (qy - a[1]) - (b[1] - a[1]) * (qx - a[0]);
    if (cr > 0) pos = true; else if (cr < 0) neg = true;
    if (pos && neg) return false;
  }
  return true;
};
// 지대 좌표(앞 f, 옆 s, 유닛)가 지대 안인지 해석식으로: 길이 ±412.5, 폭 반쪽 = 200 + 150 × (f + 412.5) / 825
const zoneAna = (f, s) => Math.abs(f) <= 412.5 && Math.abs(s) <= 200 + 150 * (f + 412.5) / 825;

// ---------------------------------------------------------------------
// 1. 회복 단일 입구 (B9): 배율, 최대 체력 넘지 않음, 모든 회복 경로 ×1.5
// ---------------------------------------------------------------------
{ const { w, a } = mk({ dummy: false });
  ok('1 R 전에는 회복 배율 1', Core.healMul(a) === 1);
  lvl(w, a, { r: 1 }); Core.step(w, [cast('p1', 'r', 0)]);
  ok('1 R 중에는 회복 배율 1.5(회복 증가 50%)', near(Core.healMul(a), 1.5, 1e-12), Core.healMul(a));
  // 직접 호출: 회복 100, 빈 체력 충분 → 150. 빈 체력 40 → 최대 체력에서 멈춤
  a.hp = MAXHP - 300; const g1 = Core.heal(w, a, 100, 'test');
  ok('1 heal: R 중 회복 100 → 150 회복', near(g1, 150, 1e-9) && near(a.hp, MAXHP - 150, 1e-9), `${g1} hp ${a.hp}`);
  a.hp = MAXHP - 40; const g2 = Core.heal(w, a, 100, 'test');
  ok('1 heal: 최대 체력을 넘지 않음(빈 만큼만)', near(g2, 40, 1e-9) && a.hp === MAXHP, `${g2} hp ${a.hp}`);
  ok('1 heal: 스킬 마나는 모두 0', ['q', 'w', 'e', 'r'].every(k => Core.skMana(a, k) === 0));
}
{ // 체력 재생(regen): R 없음 ×1, R 중 ×1.5. 5초 동안 수치 5
  const { w, a } = mk({ dummy: false });
  a.stats.regen = 5; a.hp = MAXHP - 100;
  run(w, 5, []);
  const g0 = a.hp - (MAXHP - 100);
  ok('1 체력 재생 R 없음: 5초에 수치 5 (기존과 같음)', near(g0, 5, 0.01), g0.toFixed(4));
  const b = mk({ dummy: false }); b.w.champs[0].stats.regen = 5;
  lvl(b.w, b.a, { r: 1 }); Core.step(b.w, [cast('p1', 'r', 0)]);
  b.a.hp = MAXHP - 100; const h1 = b.a.hp;
  run(b.w, 5, []);
  const g1 = b.a.hp - h1;
  ok('1 체력 재생 R 중: ×1.5 (7.5)', near(g1, 7.5, 0.02), g1.toFixed(4));
}
{ // 흡혈 ×1.5 (R 중). 평타 적중 흡혈 20%. 사신 태세 준비 안 됨(apCd 10)이라 회복은 흡혈만
  const mkStrike = (withR) => {
    const { w, a, d } = mk();
    a.bonus.omni = 0.2; a.apCd = 10; a.hp = MAXHP - 500;
    put(d, a, 55 + 70 + 20, 0);
    if (withR) { lvl(w, a, { r: 1 }); Core.step(w, [cast('p1', 'r', 0)]); }
    return strikeOnce(w, a, d);
  };
  const r0 = mkStrike(false), r1 = mkStrike(true);
  ok('1 흡혈 R 없음: 흡혈 = 입힌 피해 × 20%', near(r0.gain, 0.2 * r0.dealt, 1e-6), `${r0.gain} / ${r0.dealt}`);
  ok('1 흡혈 R 중: ×1.5 (입힌 피해 × 30%)', near(r1.gain, 0.3 * r1.dealt, 1e-6), `${r1.gain} / ${r1.dealt}`);
}
{ // 사신 태세 회복 ×1.5 (준비된 평타, 허수아비 마법 피해 = 5000 × (4 + 6/17 × 5)%)
  const mkP = (withR) => {
    const { w, a, d } = mk();
    a.hp = MAXHP - 600; a.apCd = 0;
    put(d, a, 55 + 70 + 20, 0);
    if (withR) { lvl(w, a, { r: 1 }); Core.step(w, [cast('p1', 'r', 0)]); }
    return strikeOnce(w, a, d);
  };
  const magic = 5000 * (0.04 + 5 * 0.06 / 17);     // 288.235
  const p0 = mkP(false), p1 = mkP(true);
  ok('1 사신 태세 회복 R 없음: 마법 피해의 100%', near(p0.gain, magic, 0.01), `${p0.gain} vs ${magic.toFixed(3)}`);
  ok('1 사신 태세 회복 R 중: ×1.5', near(p1.gain, 1.5 * magic, 0.02), p1.gain.toFixed(3));
}
{ // 다리우스 Q 회복 ×1.5. 다리우스는 R이 없으므로 c.ar을 직접 넣음(healMul은 c.ar만 봄)
  const run1 = (withR) => {
    const { w, a, d } = mk({ key: 'darius' });
    lvl(w, a, { q: 1 });
    put(d, a, 350, 0);                             // 허수아비 중심 350 유닛: 학살 도끼날 구간(자루 바깥)
    a.hp = a.stats.maxHp - 400;
    if (withR) a.ar = { t: 0, dur: 10, msT: 0, lv: 1 };
    const h0 = a.hp;
    Core.step(w, [cast('p1', 'q', 0)]); run(w, 1.0, []);
    return a.hp - h0;
  };
  const q0 = run1(false), q1 = run1(true);
  ok('1 다리우스 Q 회복 R 없음: 잃은 체력 × 17%', near(q0, 68, 0.01), q0.toFixed(3));
  ok('1 다리우스 Q 회복 R 중: ×1.5', near(q1, 102, 0.02), q1.toFixed(3));
}
{ // 마스터 이 명상 회복 ×1.5 (1틱 비교: 두 번째 명상 틱의 회복량 비율)
  const run1 = (withR) => {
    const { w, a } = mk({ key: 'yi' });
    lvl(w, a, { w: 1 });
    a.hp = a.stats.maxHp - 300;
    if (withR) a.ar = { t: 0, dur: 10, msT: 0, lv: 1 };
    const h0 = a.hp;
    Core.step(w, [cast('p1', 'w', 0)]);
    return a.hp - h0;
  };
  const m0 = run1(false), m1 = run1(true);
  ok('1 명상 회복 R 중: ×1.5 (1틱 비교)', m0 > 0 && near(m1 / m0, 1.5, 1e-9), `${m0} → ${m1}`);
}
{ // 가렌 인내심 회복 ×1.5. 8초 동안 피해가 없으면 초당 최대 체력 0.5%
  const run1 = (withR) => {
    const { w, a } = mk({ key: 'garen' });
    a.hp = a.stats.maxHp - 300;
    if (withR) a.ar = { t: 0, dur: 10, msT: 0, lv: 1 };
    run(w, 8.5, []);
    const h0 = a.hp;
    run(w, 1.0, []);
    return a.hp - h0;
  };
  const g0 = run1(false), g1 = run1(true);
  ok('1 가렌 인내심 회복 R 중: ×1.5', g0 > 0 && near(g1 / g0, 1.5, 1e-6), `${g0.toFixed(3)} → ${g1.toFixed(3)}`);
}

// ---------------------------------------------------------------------
// 2. 지옥사슬 W (§2-4, B1~B3)
// ---------------------------------------------------------------------
{ // 2a. 투사체 이동 시간: 허수아비 히트박스 끝 400 → 400/1800초 (±1틱)
  const { w, a, d } = mk(); lvl(w, a, { w: 1 }); Core.drainEvents(w);
  put(d, a, 400 + 70, 0);
  Core.step(w, [cast('p1', 'w', 0)]);
  const n = 1 + until(w, () => d.total > 0, 2);
  const tHit = n * TICK, tExp = 400 / 1800;
  ok('2a 지옥사슬 속도 1800: 히트박스 끝 400에서 적중(400/1800초 ±1틱)', Math.abs(tHit - tExp) <= TICK + EPS, `${tHit.toFixed(4)} vs ${tExp.toFixed(4)}`);
}
{ // 2b. 첫 대상만: 앞 허수아비(끝 300) 적중, 뒤 가렌(끝 500)은 못 맞음
  const { w, a, d, e } = mk({ enemy: true }); lvl(w, a, { w: 1 }); Core.drainEvents(w);
  put(d, a, 300 + 70, 0);
  put(e, a, 500 + 55, 0);
  Core.step(w, [cast('p1', 'w', 0)]); run(w, 0.6, []);
  ok('2b 첫 대상만: 앞 허수아비 적중(64)', near(d.total, 64, 1e-9), d.total);
  ok('2b 첫 대상만: 뒤 가렌은 체력 그대로', e.hp === e.stats.maxHp, e.hp);
}
{ // 2b-2. 허수아비 두 개가 일직선: 가까운 쪽(끝 300)만 맞고 먼 쪽(끝 500)은 안 맞음
  const { w, a, d } = mk(); lvl(w, a, { w: 1 }); Core.drainEvents(w);
  const far = JSON.parse(JSON.stringify(d)); far.id = 'dummy2'; w.dummies.push(far);
  put(d, a, 300 + 70, 0);
  put(far, a, 500 + 70, 0);
  Core.step(w, [cast('p1', 'w', 0)]); run(w, 0.6, []);
  ok('2b-2 허수아비 두 개 일직선: 가까운 것만 적중(64), 먼 것은 0', near(d.total, 64, 1e-9) && far.total === 0, `${d.total} / ${far.total}`);
  ok('2b-2 먼 허수아비는 둔화도 없음', far.slow === null && d.slow !== null);
}
{ // 2c. 사거리 825: 허수아비 끝 824 → 적중, 826 → 빗나감(awMiss)
  const hit = mk(); lvl(hit.w, hit.a, { w: 1 }); Core.drainEvents(hit.w);
  put(hit.d, hit.a, 824 + 70, 0);
  Core.step(hit.w, [cast('p1', 'w', 0)]); run(hit.w, 0.6, []);
  ok('2c 사거리 안(끝 824): 적중', near(hit.d.total, 64, 1e-9), hit.d.total);
  const miss = mk(); lvl(miss.w, miss.a, { w: 1 }); Core.drainEvents(miss.w);
  put(miss.d, miss.a, 826 + 70, 0);
  Core.step(miss.w, [cast('p1', 'w', 0)]); run(miss.w, 0.6, []);
  const evs = fxs(miss.w);
  ok('2c 사거리 밖(끝 826): 빗나감, 피해 없음', miss.d.total === 0 && evs.some(e => e.fx === 'awMiss') && !evs.some(e => e.fx === 'awHit'), `total ${miss.d.total}`);
}
{ // 2d. 피해: 물리 30 + 0.4 × 총 공격력 (1단계 = 64), 5단계 = 70 + 34 = 104
  const s1 = mk(); lvl(s1.w, s1.a, { w: 1 }); Core.drainEvents(s1.w);
  put(s1.d, s1.a, 400 + 70, 0);
  Core.step(s1.w, [cast('p1', 'w', 0)]); run(s1.w, 0.4, []);
  ok('2d 지옥사슬 1단계 피해 = 30 + 0.4 × 85 = 64', near(s1.d.total, 64, 1e-9), s1.d.total);
  const s5 = mk(); lvl(s5.w, s5.a, { w: 5 }); Core.drainEvents(s5.w);
  put(s5.d, s5.a, 400 + 70, 0);
  Core.step(s5.w, [cast('p1', 'w', 0)]); run(s5.w, 0.4, []);
  ok('2d 지옥사슬 5단계 피해 = 70 + 0.4 × 85 = 104', near(s5.d.total, 104, 1e-9), s5.d.total);
}
{ // 2e. 둔화 25% → 35%, 1.5초. 강인함 50%면 0.75초
  const s1 = mk(); lvl(s1.w, s1.a, { w: 1 });
  put(s1.d, s1.a, 400 + 70, 0);
  Core.step(s1.w, [cast('p1', 'w', 0)]); until(s1.w, () => s1.d.total > 0, 1);
  ok('2e 둔화 1단계 25%', s1.d.slow && near(s1.d.slow.pct, 0.25, 1e-12), JSON.stringify(s1.d.slow));
  ok('2e 둔화 1.5초(적중 틱에 1틱 줄어든 값)', s1.d.slow && near(s1.d.slow.t, 1.5 - TICK, 1e-9), s1.d.slow && s1.d.slow.t);
  const s5 = mk(); lvl(s5.w, s5.a, { w: 5 });
  put(s5.d, s5.a, 400 + 70, 0);
  Core.step(s5.w, [cast('p1', 'w', 0)]); until(s5.w, () => s5.d.total > 0, 1);
  ok('2e 둔화 5단계 35%', s5.d.slow && near(s5.d.slow.pct, 0.35, 1e-12), JSON.stringify(s5.d.slow));
  const t = mk(); lvl(t.w, t.a, { w: 1 });
  Core.addTenacity(t.d, 0.5, 5);
  put(t.d, t.a, 400 + 70, 0);
  Core.step(t.w, [cast('p1', 'w', 0)]); until(t.w, () => t.d.total > 0, 1);
  ok('2e 강인함 50%: 둔화 1.5초가 0.75초로 줄어듦', t.d.slow && near(t.d.slow.t, 0.75 - TICK, 1e-9), t.d.slow && t.d.slow.t);
}
{ // 2f. 충격 지대 꼭짓점 (world px). 각도 0과 π/2
  const Z0 = Core.aatroxWZone(0, 0, 0);
  ok('2f 지대 꼭짓점(ang 0): 뒤 변 y ±px(200), 앞 변 y ±px(350), x = ∓px(412.5)',
    near(Z0[0][0], -px(412.5), 1e-9) && near(Z0[0][1], -px(200), 1e-9) && near(Z0[1][0], px(412.5), 1e-9) && near(Z0[1][1], -px(350), 1e-9) &&
    near(Z0[2][0], px(412.5), 1e-9) && near(Z0[2][1], px(350), 1e-9) && near(Z0[3][0], -px(412.5), 1e-9) && near(Z0[3][1], px(200), 1e-9), JSON.stringify(Z0));
  const Z90 = Core.aatroxWZone(0, 0, Math.PI / 2);
  ok('2f 지대 꼭짓점(ang π/2 회전): 뒤 변 x = px(200)·(옆 방향 뒤집힘), 길이는 y 방향',
    near(Z90[0][0], px(200), 1e-9) && near(Z90[0][1], -px(412.5), 1e-9) && near(Z90[1][0], px(350), 1e-9) && near(Z90[1][1], px(412.5), 1e-9), JSON.stringify(Z90));
  const cen = Core.aatroxWZone(1000, 500, 0.3);
  const nearMid = [(cen[0][0] + cen[3][0]) / 2, (cen[0][1] + cen[3][1]) / 2], farMid = [(cen[1][0] + cen[2][0]) / 2, (cen[1][1] + cen[2][1]) / 2];
  const mid = [(nearMid[0] + farMid[0]) / 2, (nearMid[1] + farMid[1]) / 2];      // 두 짧은·긴 변의 가운데를 잇는 선의 가운데
  ok('2f 지대 가운데는 맞은 위치(1000, 500)', near(mid[0], 1000, 1e-9) && near(mid[1], 500, 1e-9), mid.join(','));
  // 안/밖 판정: 해석식과 꼭짓점 다각형이 같은 답. 여러 점, 두 각도
  const pts = [[0, 0, true], [412, 0, true], [413, 0, false], [-412, 0, true], [-413, 0, false], [-410, 200, true], [-410, 201, false],
               [410, 349, true], [410, 351, false], [300, 329, true], [300, 331, false], [0, 260, true], [0, 280, false]];
  let agree = true, right = true;
  for (const ang of [0, Math.PI / 2, -0.6]) {
    const poly = Core.aatroxWZone(700, 900, ang);
    for (const [f, s, want] of pts) {
      const p = at({ x: 700, y: 900 }, f, s, ang);
      const inside = inPoly(p.x, p.y, poly);
      if (inside !== zoneAna(f, s)) agree = false;
      if (inside !== want) right = false;
    }
  }
  ok('2f 지대 안/밖: 꼭짓점 다각형과 해석식이 같음(모서리 포함 13점 × 3각도)', agree);
  ok('2f 지대 안/밖: 기대한 안·밖(앞·뒤·옆 모서리, 90° 회전 포함)', right);
}
{ // 2g. 1.5초 뒤 중심이 안 → 같은 피해 + 지대 중심으로 0.25초 끌림, 둔화 없음, 공중에 뜨지 않음
  const { w, a, e } = mk({ enemy: true, dummy: false });
  lvl(w, a, { w: 1 }); put(e, a, 400 + 55, 0);
  Core.step(w, [cast('p1', 'w', 0)]);
  until(w, () => !!a.awZone, 1);
  const zx = a.awZone.x, zy = a.awZone.y;
  const hp1 = e.hp;                                     // 1차 적중 뒤
  const dealt1 = e.stats.maxHp - hp1;
  e.x = zx + px(150); e.y = zy;                          // 지대 안, 중심에서 앞으로 150 (대상은 가만히 있지 않아도 됨)
  until(w, () => !!e.pull, 2);
  const dealt2 = hp1 - e.hp;
  ok('2g 1.5초 뒤 중심이 안: 같은 피해 한 번 더', near(dealt2, dealt1, 1e-6), `${dealt1.toFixed(3)} / ${dealt2.toFixed(3)}`);
  ok('2g 끌림 시작: 지대 중심으로(dest 일치)', e.pull && near(e.pull.tx, zx, 1e-6) && near(e.pull.ty, zy, 1e-6), e.pull && `${e.pull.tx},${e.pull.ty}`);
  run(w, 0.3, []);
  ok('2g 끌림 끝: 지대 중심에 도착, 끌림 해제', near(e.x, zx, 1e-6) && near(e.y, zy, 1e-6) && !e.pull, `${e.x},${e.y}`);
  run(w, 0.05, []);
  ok('2g 끌림 뒤 공중에 뜨지 않고 둔화도 없음(지옥사슬 끌림)', e.air === 0 && e.slow === null, `air ${e.air} slow ${JSON.stringify(e.slow)}`);
  ok('2g 지대는 판정 뒤 사라짐', a.awZone === null);
}
{ // 2h. 1.5초 전에 지대를 벗어남 → 아무 일 없음
  const { w, a, e } = mk({ enemy: true, dummy: false });
  lvl(w, a, { w: 1 }); put(e, a, 400 + 55, 0);
  Core.step(w, [cast('p1', 'w', 0)]);
  until(w, () => !!a.awZone, 1);
  const zx = a.awZone.x, zy = a.awZone.y, hp1 = e.hp;
  run(w, 0.5, []);
  e.x = zx; e.y = zy + px(400);                          // 옆으로 400 유닛: 지대 밖(폭 반쪽 275 < 400)
  run(w, 1.2, []);
  ok('2h 1.5초 전에 벗어남: 두 번째 피해 없음, 끌림 없음', e.hp === hp1 && !e.pull && a.awZone === null, `${hp1} → ${e.hp}`);
}
{ // 2i. 1.5초 시점에 대상 지정 불가 → 아무 일 없음
  const { w, a, e } = mk({ enemy: true, dummy: false });
  lvl(w, a, { w: 1 }); put(e, a, 400 + 55, 0);
  Core.step(w, [cast('p1', 'w', 0)]);
  until(w, () => !!a.awZone, 1);
  const hp1 = e.hp;
  run(w, 0.5, []);
  e.untarget = true;
  run(w, 1.2, []);
  ok('2i 1.5초 시점에 대상 지정 불가: 두 번째 피해·끌림 없음', e.hp === hp1 && !e.pull && a.awZone === null, `${hp1} → ${e.hp}`);
}
{ // 2j. 사신 태세 재사용 -2초: 적중마다 (준비 안 됨 apCd 10). 1차 적중·2차 판정 각각 -2초(같은 틱의 감소 포함)
  const { w, a, d } = mk({ dummy: true }); lvl(w, a, { w: 1 }); a.apCd = 10;
  put(d, a, 400 + 70, 0);
  Core.step(w, [cast('p1', 'w', 0)]);
  let prev = a.apCd, firstDelta = null;
  for (let i = 0; i < 60 && firstDelta === null; i++) {
    prev = a.apCd; Core.step(w, []); if (d.total > 0) firstDelta = a.apCd - prev; }
  ok('2j 지옥사슬 1차 적중: 사신 태세 -2초', firstDelta !== null && near(firstDelta, -2 - TICK, 1e-9), firstDelta);
  let zoneDelta = null, g = 0;
  while (zoneDelta === null && g++ < 200) { const had = !!a.awZone; prev = a.apCd; Core.step(w, []); if (had && !a.awZone) zoneDelta = a.apCd - prev; }
  ok('2j 지대 판정(1.5초 뒤, 중심 안): 사신 태세 -2초', zoneDelta !== null && near(zoneDelta, -2 - TICK, 1e-9), zoneDelta);
  ok('2j 지대 판정 뒤 허수아비 두 번 맞음(64 + 64)', near(d.total, 128, 1e-9), d.total);
}
{ // 2k. 죽으면 W·지대·R·E 상태 초기화, 부활하면 그대로 없음
  const { w, a, e } = mk({ enemy: true, dummy: false });
  a.aw = { x: a.x, y: a.y, ang: 0, dist: 0, lv: 1 };
  a.awZone = { x: a.x + px(300), y: a.y, ang: 0, t: 0, targetId: 'e1', lv: 1, raw: 50 };
  a.ar = { t: 0, dur: 10, msT: 0, lv: 1 };
  a.dash = { t: 0, dir: 0, x0: a.x, y0: a.y };
  a.hp = 1;
  put(e, a, 55 + 55 + 20, 0);                             // 가렌이 바로 옆에서 평타로 처치
  e.in.atk = true;
  until(w, () => a.dead, 3);
  ok('2k 죽음: aw·awZone·ar·dash 초기화', a.dead && a.aw === null && a.awZone === null && a.ar === null && a.dash === null);
  e.in.atk = false;
  run(w, 5.2, []);
  ok('2k 부활: 상태 없음, 재사용 대기 0', !a.dead && a.aw === null && a.awZone === null && a.ar === null && a.dash === null && a.cd.w === 0 && a.cd.r === 0);
}

// ---------------------------------------------------------------------
// 3. 파멸의 돌진 E (§2-5, B4~B7)
// ---------------------------------------------------------------------
{ // 3a. 흡혈 16%: 챔피언(가렌)·허수아비 평타 적중. 사신 태세 준비 안 됨(apCd 10)
  const { w, a, e } = mk({ enemy: true, dummy: false }); lvl(w, a, { e: 1 }); a.apCd = 10; a.hp = MAXHP - 500;
  put(e, a, 55 + 55 + 20, 0);
  const r = strikeOnce(w, a, e);
  ok('3a E 패시브: 챔피언에게 입힌 피해 × 16% 흡혈', near(r.gain, 0.16 * r.dealt, 1e-6), `${r.gain} / ${r.dealt}`);
}
{ // 3b. 허수아비에게도 16%
  const { w, a, d } = mk(); lvl(w, a, { e: 1 }); a.apCd = 10; a.hp = MAXHP - 500;
  put(d, a, 55 + 70 + 20, 0);
  const r = strikeOnce(w, a, d);
  ok('3b E 패시브: 허수아비에게도 16%', near(r.gain, 0.16 * r.dealt, 1e-6), `${r.gain} / ${r.dealt}`);
}
{ // 3c. 16% + 0.013% × 추가 체력 (추가 체력 500 → 0.225)
  const { w, a, d } = mk(); lvl(w, a, { e: 1 }); a.apCd = 10; a.hp = MAXHP - 500; a.bonus.hp = 500;
  put(d, a, 55 + 70 + 20, 0);
  const r = strikeOnce(w, a, d);
  ok('3c E 패시브: 추가 체력 500 → 16% + 6.5% = 22.5%', near(r.gain, 0.225 * r.dealt, 1e-6), `${r.gain} / ${r.dealt}`);
  ok('3c omnivampOf(c, 허수아비) = 0.225, 대상 없이는 아이템 값 0', near(Core.omnivampOf(a, d), 0.225, 1e-12) && Core.omnivampOf(a) === 0);
}
{ // 3d. E 레벨 0이면 흡혈 없음
  const { w, a, d } = mk(); a.apCd = 10; a.hp = MAXHP - 500;
  put(d, a, 55 + 70 + 20, 0);
  const r = strikeOnce(w, a, d);
  ok('3d E 레벨 0: 흡혈 없음', r.dealt > 0 && r.gain === 0 && Core.omnivampOf(a, d) === 0, `${r.gain}`);
}
{ // 3e. 광역 Q: 흡혈 16% × 0.33. 1단계 몸통 피해 10 + 0.6 × 85 = 61
  const { w, a, d } = mk(); lvl(w, a, { q: 1, e: 1 }); a.hp = MAXHP - 500; Core.drainEvents(w);
  put(d, a, 300, 0);
  Core.step(w, [cast('p1', 'q', 0)]);
  run(w, 0.7, []);
  const dealt = d.total, gain = a.hp - (MAXHP - 500);
  ok('3e 광역(Q) 피해 = 61', near(dealt, 61, 1e-9), dealt);
  ok('3e 광역(Q) 흡혈 = 피해 × 16% × 0.33', near(gain, 0.16 * 0.33 * dealt, 1e-6), `${gain} / ${dealt}`);
}
{ // 3f. 돌진 300유닛 / 0.2초. 조이스틱 방향 (cast ang은 조준 표시가 없으면 무시)
  const { w, a } = mk({ dummy: false }); lvl(w, a, { e: 1 }); Core.drainEvents(w);
  const x0 = a.x, y0 = a.y;
  Core.step(w, [inp('p1', 1, 0, false), cast('p1', 'e', 2.0)]);
  run(w, 0.3, [inp('p1', 0, 0, false)]);
  ok('3f 돌진 300유닛(조이스틱 +x, 조준 없는 ang 무시)', near(a.x - x0, px(300), 1e-6) && near(a.y - y0, 0, 1e-6), `${(a.x - x0) / px(1)} / ${(a.y - y0) / px(1)}`);
  ok('3f 돌진 끝: 돌진 상태 null, 쿨타임 9초 시작', a.dash === null && near(a.cd.e, 9 - 0.3, 0.02), a.cd.e);
  const ev = fxs(w).filter(e => e.fx === 'aeDash');
  ok('3f 돌진 이펙트 aeDash 1개(x0,y0 → x1,y1)', ev.length === 1 && near(ev[0].x0, x0, 1e-9) && near(ev[0].x1, a.x, 1e-6), JSON.stringify(ev[0] || null));
}
{ // 3g. 조이스틱을 놓으면 마지막으로 움직인 방향(faceAng)으로 돌진
  const { w, a } = mk({ dummy: false }); lvl(w, a, { e: 1 }); Core.drainEvents(w);
  run(w, 10 * TICK, [inp('p1', 0, 1, false)]);
  Core.step(w, [inp('p1', 0, 0, false)]);
  ok('3g 마지막으로 움직인 방향 기록(+y = π/2)', near(a.faceAng, Math.PI / 2, 1e-9), a.faceAng);
  const x0 = a.x, y0 = a.y;
  Core.step(w, [cast('p1', 'e', 0)]);
  run(w, 0.3, []);
  ok('3g 조이스틱을 놓고 돌진: faceAng 방향(+y)으로 300유닛', near(a.x - x0, 0, 1e-6) && near(a.y - y0, px(300), 1e-6), `dx ${((a.x - x0) / px(1)).toFixed(3)} dy ${((a.y - y0) / px(1)).toFixed(3)}`);
}
{ // 3h. 기본 방향: 팀 0 = 0(오른쪽), 팀 1 = π(왼쪽). 움직인 적 없는 상태
  const { w, a, e } = mk({ enemy: true, dummy: false });
  ok('3h faceAng 기본: 팀 0 = 0, 팀 1 = π', a.faceAng === 0 && e.faceAng === Math.PI, `${a.faceAng} / ${e.faceAng}`);
  void w;
}
{ // 3i. 조준(aimed): 스킬 버튼을 끌었으면 ang이 방향(조이스틱보다 우선). aimed 없으면 ang 무시
  const { w, a } = mk({ dummy: false }); lvl(w, a, { e: 1 }); Core.drainEvents(w);
  const x0 = a.x, y0 = a.y;
  Core.step(w, [inp('p1', 1, 0, false), cast('p1', 'e', Math.PI / 2, true)]);
  run(w, 0.3, [inp('p1', 0, 0, false)]);
  ok('3i 조준 aimed: 방향 π/2(+y)가 조이스틱(+x)보다 우선, 300유닛', near(a.x - x0, 0, 1e-6) && near(a.y - y0, px(300), 1e-6), `${(a.x - x0) / px(1)} / ${(a.y - y0) / px(1)}`);
}
{ // 3j. 벽: 오른쪽 벽(1140,300) 앞에서 돌진 → 300보다 짧게 가고, 서 있을 수 있는 자리에 멈춤
  const { w, a } = mk({ dummy: false, x: 1140, y: 300 }); lvl(w, a, { e: 1 }); Core.drainEvents(w);
  const x0 = a.x;
  Core.step(w, [inp('p1', 1, 0, false), cast('p1', 'e', 0)]);
  run(w, 0.3, [inp('p1', 0, 0, false)]);
  const moved = (a.x - x0) / px(1);
  ok('3j 벽에 막힘: 300보다 짧게 이동, 끝 자리는 서 있을 수 있음', moved < 290 && Core.canStand(a.x, a.y) && a.dash === null, `${moved.toFixed(2)} units`);
}
{ // 3k. Q 시전 중(0.6초) 돌진 가능. Q 판정은 돌진 뒤 아트록스 위치에서. 허수아비 750(돌진 전에는 Q 밖, 돌진 뒤 450 = 끝부분)
  const withE = mk(); lvl(withE.w, withE.a, { q: 1, e: 1 }); put(withE.d, withE.a, 750, 0); Core.drainEvents(withE.w);
  Core.step(withE.w, [cast('p1', 'q', 0)]);
  run(withE.w, 0.15, []);
  Core.step(withE.w, [inp('p1', 1, 0, false), cast('p1', 'e', 0)]);
  run(withE.w, 0.1, [inp('p1', 0, 0, false)]);
  let g = 0; while (withE.a.aq && g++ < 200) Core.step(withE.w, []);
  const evs = fxs(withE.w);
  const hit = evs.find(e => e.fx === 'aqHit');
  const sweet = 17.5 + 1.05 * AD;                       // 1단계 끝부분
  ok('3k Q 시전 중 돌진 가능: 돌진 300유닛 완료', near(withE.a.x - AT.x, px(300), 1e-6) && withE.a.dash === null, `${((withE.a.x - AT.x) / px(1)).toFixed(3)}`);
  ok('3k 돌진 뒤 Q 끝부분 적중: 허수아비 피해 = 끝부분 17.5 + 1.05 × 85', near(withE.d.total, sweet, 1e-6), `${withE.d.total} / ${sweet}`);
  ok('3k Q 판정 위치 = 판정 순간 아트록스 위치(B5)', hit && near(hit.x, withE.a.x, 1e-6) && near(hit.y, withE.a.y, 1e-6), hit && `${hit.x} vs ${withE.a.x}`);
  const noE = mk(); lvl(noE.w, noE.a, { q: 1 }); put(noE.d, noE.a, 750, 0); Core.drainEvents(noE.w);
  Core.step(noE.w, [cast('p1', 'q', 0)]); run(noE.w, 0.7, []);
  ok('3k 돌진 없이 Q: 허수아비 750은 안 맞음(범위 밖)', noE.d.total === 0, noE.d.total);
}
{ // 3l. 사용 불가: 침묵 · 공중에 뜸 · 끌려옴 → 돌진 없음, 쿨타임 그대로
  const s = mk({ dummy: false }); lvl(s.w, s.a, { e: 1 }); s.a.silence = { t: 2 }; const x0 = s.a.x;
  Core.step(s.w, [cast('p1', 'e', 0)]); run(s.w, 0.3, []);
  ok('3l 침묵 중: 돌진 없음, 쿨타임 0', s.a.dash === null && s.a.cd.e === 0 && near(s.a.x, x0, 1e-9));
  const g = mk({ dummy: false }); lvl(g.w, g.a, { e: 1 }); g.a.air = 1; const gx = g.a.x;
  Core.step(g.w, [inp('p1', 1, 0, false), cast('p1', 'e', 0)]); run(g.w, 0.3, [inp('p1', 0, 0, false)]);
  ok('3l 공중에 뜸: 돌진 없음', g.a.dash === null && g.a.cd.e === 0 && near(g.a.x, gx, 1e-9));
  const p = mk({ dummy: false }); lvl(p.w, p.a, { e: 1 }); p.a.pull = { t: 0, dur: 1, fx: p.a.x, fy: p.a.y, tx: p.a.x, ty: p.a.y, src: 'x' };
  Core.step(p.w, [cast('p1', 'e', 0)]);
  ok('3l 끌려오는 중: 돌진 없음', p.a.dash === null && p.a.cd.e === 0);
}
{ // 3m. 돌진 중 공중에 뜨면 끊김. 재사용 대기 중에는 못 씀
  const { w, a } = mk({ dummy: false }); lvl(w, a, { e: 1 }); Core.drainEvents(w);
  Core.step(w, [cast('p1', 'e', 0)]); run(w, 0.05, []);
  a.air = 0.5;                                          // 돌진 중 공중에 뜸
  run(w, 0.05, []);
  ok('3m 돌진 중 공중에 뜸: 돌진 끊김', a.dash === null);
  const x0 = a.x;
  Core.step(w, [cast('p1', 'e', 0)]);
  ok('3m 재사용 대기 중에는 못 씀(쿨타임 9초)', a.dash === null && a.cd.e > 8 && near(a.x, x0, 1e-9));
}
{ // 3n. 레벨별 쿨타임 9/8/7/6/5, 돌진 중에도 W·R 시전·Q 가능(E는 W 비행 중·R 중에도 가능)
  const { w, a } = mk({ dummy: false }); lvl(w, a, { e: 5 });
  ok('3n E 쿨타임: 5단계 5초', Core.skCd(a, 'e') === 5, Core.skCd(a, 'e'));
  const r = mk({ dummy: false }); lvl(r.w, r.a, { r: 1, e: 1 });
  Core.step(r.w, [cast('p1', 'r', 0)]);
  const x0 = r.a.x;
  Core.step(r.w, [inp('p1', 1, 0, false), cast('p1', 'e', 0)]); run(r.w, 0.3, [inp('p1', 0, 0, false)]);
  ok('3n R 중 E 가능(돌진 300)', near(r.a.x - x0, px(300), 1e-6));
  const v = mk({ dummy: false }); lvl(v.w, v.a, { w: 1, e: 1 });
  Core.step(v.w, [cast('p1', 'w', 0)]);
  const x1 = v.a.x;
  Core.step(v.w, [inp('p1', 1, 0, false), cast('p1', 'e', 0)]); run(v.w, 0.3, [inp('p1', 0, 0, false)]);
  ok('3n W 비행 중 E 가능(돌진 300, 그동안 W는 날아감)', near(v.a.x - x1, px(300), 1e-6) && v.a.aw !== null);
}
{ // 3o. W·R 시전은 Q 시전 중 불가(0.6초), E는 가능 (3k에서 확인). 여기서는 W·R이 막히는 것만
  const { w, a, d } = mk(); lvl(w, a, { q: 1, w: 1, r: 1 }); put(d, a, 900, 0); Core.drainEvents(w);
  Core.step(w, [cast('p1', 'q', 0)]);
  Core.step(w, [cast('p1', 'w', 0)]);
  Core.step(w, [cast('p1', 'r', 0)]);
  ok('3o Q 시전 중 W·R 불가: 지옥사슬·세계의 종결자 시작 안 함', a.aw === null && a.ar === null && a.cd.w === 0 && a.cd.r === 0);
}

// ---------------------------------------------------------------------
// 4. 세계의 종결자 R (§2-6, B8~B11)
// ---------------------------------------------------------------------
{ // 4a. 이동속도 증가 60%에서 10초에 걸쳐 0으로. 0·5·10초에 확인
  const { w, a } = mk({ dummy: false }); lvl(w, a, { r: 1 }); Core.drainEvents(w);
  Core.step(w, [cast('p1', 'r', 0)]);
  const f0 = Core.curMS(a) / a.stats.ms;
  ok('4a 발동 직후 이동속도 +60%(한 틱 감쇠 포함)', near(f0, 1.6, 0.005), f0);
  run(w, 5, []);
  const f5 = Core.curMS(a) / a.stats.ms, m5 = a.ar.msT;
  ok('4a 5초: 증가율 60% × (1 − 5/10) → +30%', near(m5, 5, 2 * TICK) && near(f5, 1 + 0.6 * (1 - m5 / 10), 1e-9), `${f5.toFixed(4)} msT ${m5.toFixed(4)}`);
  run(w, 4.9, []);                                   // 이제 약 9.9초
  ok('4a 10초 직전(9.9초): 증가 거의 0', Core.curMS(a) / a.stats.ms < 1.01, Core.curMS(a) / a.stats.ms);
  run(w, 0.5, []);
  ok('4a 10초 이후: 증가 없음(원래 이동속도)', near(Core.curMS(a), a.stats.ms, 1e-9), Core.curMS(a));
  ok('4a 지속 10초: 끝나면 R 상태 없음', a.ar === null);
}
{ // 4b. 공격력 +20%: 총 공격력 × 0.2 를 추가(기본 85 → 102)
  const { w, a } = mk({ dummy: false }); lvl(w, a, { r: 1 });
  const before = Core.totalAD(a);
  Core.step(w, [cast('p1', 'r', 0)]);
  ok('4b 공격력 +20%: 85 → 102, 추가 공격력 17', near(Core.totalAD(a), AD * 1.2, 1e-9) && near(Core.bonusAD(a), AD * 0.2, 1e-9), `${before} → ${Core.totalAD(a)}`);
  run(w, 10.2, []);
  ok('4b R이 끝나면 공격력 원래대로', near(Core.totalAD(a), AD, 1e-9));
}
{ // 4c. 챔피언 처치: 지속 +5초, 이동속도 효과 초기화. 허수아비 처치는 아님
  const { w, a, e } = mk({ enemy: true, dummy: false }); lvl(w, a, { r: 1, w: 1 });
  Core.step(w, [cast('p1', 'r', 0)]);
  run(w, 3, []);
  e.hp = 1; put(e, a, 455, 0);
  Core.step(w, [cast('p1', 'w', 0)]);
  until(w, () => e.dead, 1);
  ok('4c 챔피언 처치: 지속 10 → 15초', near(a.ar.dur, 15, 1e-9), a.ar && a.ar.dur);
  ok('4c 챔피언 처치: 이동속도 감쇠 초기화(msT 0 근처)', a.ar && a.ar.msT < 2 * TICK, a.ar && a.ar.msT);
  ok('4c 처치 뒤 증가율 다시 60%', near(Core.curMS(a) / a.stats.ms, 1.6, 0.01), Core.curMS(a) / a.stats.ms);
  run(w, 11.5, []);
  ok('4c 처치로 늘어난 시간 동안(원래 10초 지나도) 아직 R 중', a.ar !== null && near(Core.healMul(a), 1.5, 1e-12));
  run(w, 3.6, []);
  ok('4c 15초 뒤 끝', a.ar === null && near(Core.totalAD(a), AD, 1e-9));
}
{ // 4d. 허수아비 처치는 연장 없음
  const { w, a, d } = mk(); lvl(w, a, { r: 1, w: 1 });
  Core.step(w, [cast('p1', 'r', 0)]);
  d.hp = 1; put(d, a, 400 + 70, 0);
  Core.step(w, [cast('p1', 'w', 0)]);
  run(w, 0.5, []);
  ok('4d 허수아비 처치: 지속 연장 없음(10초 그대로)', a.ar && a.ar.dur === 10, a.ar && a.ar.dur);
}
{ // 4e. 회복 ×1.5 (1부 heal 섹션에서도 확인). 여기서는 R 시전 직후 healMul
  const { w, a } = mk({ dummy: false }); lvl(w, a, { r: 1 });
  Core.step(w, [cast('p1', 'r', 0)]);
  ok('4e 발동 직후 회복 배율 1.5, R 쿨타임 120(임시값 B10)', near(Core.healMul(a), 1.5, 1e-12) && a.cd.r > 119 && a.cd.r <= 120, `${Core.healMul(a)} / ${a.cd.r}`);
  ok('4e 발동 이벤트 arStart', fxs(w).some(e => e.fx === 'arStart'));
}
{ // 4f. Q 시전 중에는 R 불가(0.6초). 침묵이면 불가
  const { w, a, d } = mk(); lvl(w, a, { q: 1, r: 1 }); put(d, a, 900, 0);
  Core.step(w, [cast('p1', 'q', 0)]); Core.step(w, [cast('p1', 'r', 0)]);
  ok('4f Q 시전 중 R 불가', a.ar === null && a.cd.r === 0);
}

// ---------------------------------------------------------------------
// 5. 결정성: 같은 명령 순서 → 같은 월드 (W·E·R·Q 섞어서)
// ---------------------------------------------------------------------
{ const play = () => {
    const { w, a, d, e } = mk({ enemy: true });
    lvl(w, a, { q: 1, w: 1, e: 1, r: 1 }); a.apCd = 10; a.hp = MAXHP - 400;
    put(d, a, 470, 0); put(e, a, 300, 40);
    Core.step(w, [cast('p1', 'w', 0)]); run(w, 0.4, []);
    Core.step(w, [inp('p1', 1, 0, false), cast('p1', 'e', 0)]); run(w, 0.3, [inp('p1', 0, 0, false)]);
    Core.step(w, [cast('p1', 'r', 0)]); run(w, 1.2, []);
    Core.step(w, [cast('p1', 'q', 0.5)]); run(w, 1.5, []);
    return JSON.stringify(w);
  };
  ok('5 같은 명령 → 같은 월드(JSON 동일)', play() === play());
}

// ---------------------------------------------------------------------
// 6. 프로토콜: 버전 12, 돌진 조준 표시(aimed)
// ---------------------------------------------------------------------
{ ok('6 프로토콜 버전 12', P.VERSION === 12, P.VERSION);
  const f = P.sanitizeFrame({ s: 3, mx: 0, my: 0, acts: [{ k: 'cast', skill: 'e', ang: 1.2, aimed: true }, { k: 'cast', skill: 'w', ang: 0.5, aimed: 'yes' }] });
  ok('6 cast aimed: true만 통과(문자열은 버림)', f.acts[0].aimed === true && !('aimed' in f.acts[1]), JSON.stringify(f.acts));
  const cmds = P.frameToCmds('p1', f);
  ok('6 frameToCmds: 돌진 cast에 aimed 전달', cmds[1].type === 'cast' && cmds[1].aimed === true && cmds[2].aimed === undefined, JSON.stringify(cmds));
  const snap = P.slimWorld((() => { const { w, a } = mk({ dummy: false }); lvl(w, a, { w: 1, e: 1, r: 1 }); a.aw = { x: 1, y: 2, ang: 0, dist: 3, lv: 1 }; a.ar = { t: 1, dur: 10, msT: 1, lv: 1 }; a.dash = { t: 0.1, dir: 0, x0: 1, y0: 2 }; return w; })());
  ok('6 스냅샷(JSON)에 aw·ar·dash가 그대로 들어감', snap.champs[0].aw && snap.champs[0].ar && snap.champs[0].dash && snap.champs[0].faceAng === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
