/* =====================================================================
   아트록스 테스트 (DESIGN_AATROX.md §2, 원문 docs/spec/aatrox.md / 범위 그림 q1-1·q1-2·q1-3)
   - 6레벨 기준: 체력 1220, 공격력 85(60+5×5), 방어력 62, 마법저항력 42.25, 공속 0.651×1.125.
   - 허수아비 방어력 0·마법저항력 0이라 피해 값이 그대로 나옵니다. 챔피언 대상은 가렌(방어력 59, 마법저항력 39.75).
   - 자연 회복은 끄고(quiet), 포탑은 격리. 아트록스는 (400,700)에 두고 허수아비 기본 위치(700,500)와 멀리 떼어 둡니다.
   - 거리 단위는 유닛. 허수아비 히트박스 반지름 70유닛. 도형 판정은 "허수아비 원이 도형과 겹치면 적중"이라서 기대 경계도 70유닛 기준입니다.
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
const run = (w, sec, cmds) => { const n = Math.round(sec / TICK); for (let i = 0; i < n; i++) Core.step(w, i === 0 ? cmds : []); };
const quiet = c => { c.stats.regen = 0; c.stats.manaRegen = 0; };   // 자연 회복 끄기
const lvl = (w, c, pts) => { for (const [k, n] of Object.entries(pts)) for (let i = 0; i < n; i++) Core.step(w, [cmd('levelup', c.id, { skill: k })]); };
const pool = u => u.hp + Core.shieldOf(u);
const texts = w => w.events.filter(e => e.type === 'text').map(e => e.txt);
const AT = { x: 400, y: 700 };
const AD = 85;   // 6레벨 아트록스 총 공격력

// 아트록스(p1, 팀0). 기본은 허수아비 포함, 포탑 격리, 자연 회복 끔
const mk = (opts) => {
  opts = opts || {};
  const w = Core.createWorld({ players: [{ id: 'p1', key: 'aatrox', team: 0 }], dummy: opts.dummy !== false });
  w.turrets.forEach(t => { t.dead = true; });
  if (!opts.natural) w.champs.forEach(quiet);
  const a = w.champs[0];
  a.x = AT.x; a.y = AT.y;
  return { w, a, d: w.dummies[0] || null };
};
// (앞 f, 옆 s) 유닛, 방향 ang 기준 월드 px (앞 = (cos, sin), 옆 = (-sin, cos))
const at = (a, f, s, ang = 0) => ({ x: a.x + px(f) * Math.cos(ang) - px(s) * Math.sin(ang), y: a.y + px(f) * Math.sin(ang) + px(s) * Math.cos(ang) });
const place = (t, a, f, s, ang = 0) => { const p = at(a, f, s, ang); t.x = p.x; t.y = p.y; };
// 대상 t를 가해자 c에서 히트박스 틈 gap 유닛(각도 ang)에 둠
const placeGap = (c, t, gap, ang = 0) => { const dd = px(gap) + px(c.r) + px(t.r); t.x = c.x + Math.cos(ang) * dd; t.y = c.y + Math.sin(ang) * dd; };
// 평타 한 번 적중. 적중 틱 직전 값(pre)과 직후 값을 돌려줌
const strikeOnce = (w, a, t) => {
  let g = 0;
  while ((a.atk || a.atkCd > 0) && g++ < 2000) Core.step(w, []);
  Core.step(w, [inp(a.id, 0, 0, true)]);
  let pre = null;
  while (!(a.atk && a.atk.hit) && g++ < 4000) { pre = { p: pool(t), h: a.hp, ap: a.apCd }; Core.step(w, []); }
  const out = { dealt: pre.p - pool(t), gain: a.hp - pre.h, apPre: pre.ap, apPost: a.apCd };
  Core.step(w, [inp(a.id, 0, 0, false)]);
  return out;
};
const castQ = (w, ang = 0) => Core.step(w, [cmd('cast', 'p1', { skill: 'q', ang })]);
// 시전 중인 Q가 판정될 때까지 한 틱씩. 호출 전에 castQ를 한 번 했다고 보고 시전 틱 수를 포함해 돌려줌
const qRun = (w, a) => { let n = 1; while (a.aq && n < 1000) { Core.step(w, []); n++; } return n; };
// 허수아비를 (f, s, ang)에 두고 Q 단계 st를 한 번 시전. 창을 직접 열어 단계를 고름. 돌려줌: 맞은 양, 공중에 뜸 남은 초
const probe = (st, f, s, ang = 0, lv = 1, extra) => {
  const { w, a, d } = mk();
  lvl(w, a, { q: lv });
  if (st > 1) { a.aqWin = 3; a.aqNext = st; }
  if (extra) extra(w, a);
  place(d, a, f, s, ang);
  castQ(w, ang); qRun(w, a);
  return { dmg: d.total, air: d.air, w, a, d };
};
const kindOf = r => r.dmg <= 0 ? 'none' : r.air > 0 ? 'sweet' : 'body';
const K2 = Math.SQRT1_2;

// ---------------------------------------------------------------------
// 1. 기본 스탯 · 마나 없음 · 스킬 마나 0 (§2-1)
// ---------------------------------------------------------------------
{ const st = Core.calcStats('aatrox', 6);
  ok('1 레벨 6 체력 = 650 + 114×5 = 1220', st.maxHp === 1220, st.maxHp);
  ok('1 레벨 6 공격력 = 60 + 5×5 = 85', near(st.ad, AD, 1e-9), st.ad);
  ok('1 레벨 6 공격속도 = 0.651 × (1 + 0.025×5) = 0.732375', near(st.as, 0.651 * 1.125, 1e-9), st.as);
  ok('1 레벨 6 방어력 = 38 + 4.8×5 = 62, 마법저항력 = 32 + 2.05×5 = 42.25', near(st.armor, 62, 1e-9) && near(st.mr, 42.25, 1e-9), `${st.armor} / ${st.mr}`);
  ok('1 사거리 175, 이동속도 345', st.range === 175 && st.ms === 345);
  ok('1 체력 재생 placeholder = 3 + 0.5×5 = 5.5 (A1 임시값)', near(st.regen, 5.5, 1e-9), st.regen);
  ok('1 마나 없음: 최대 마나 0, 마나 재생 0', st.maxMana === 0 && st.manaRegen === 0);
  const { w, a } = mk({ natural: true, dummy: false });
  ok('1 모든 스킬 마나 0', ['q', 'w', 'e', 'r'].every(k => Core.skMana(a, k) === 0));
  a.hp = a.stats.maxHp - 300; run(w, 10);
  ok('1 자연 재생을 켠 채 10초: 마나 0, NaN 없음, 체력은 재생', a.mana === 0 && Number.isFinite(a.hp) && a.hp > a.stats.maxHp - 300, `mana ${a.mana} hp ${a.hp.toFixed(2)}`); }

// ---------------------------------------------------------------------
// 2. 사신 태세 · 사거리 (§2-2, A2·A3)
// ---------------------------------------------------------------------
{ // 2a. 준비됨: 평타 사거리 175+50. 허수아비 히트박스 끝까지 224는 평타 시작, 226은 안 됨
  const r = gap => { const { w, a, d } = mk(); placeGap(a, d, gap, 0); Core.step(w, [inp(a.id, 0, 0, true)]); return !!a.atk; };
  ok('2a 준비됨: 히트박스 끝 224에서 평타 시작(사거리 225)', r(224) === true);
  ok('2a 준비됨: 히트박스 끝 226에서는 평타 시작 안 함', r(226) === false); }
{ // 2b. 준비 안 됨(재사용 대기 중): 210에서도 평타 안 함
  const { w, a, d } = mk(); placeGap(a, d, 210, 0); a.apCd = 5;
  Core.step(w, [inp(a.id, 0, 0, true)]);
  ok('2b 재사용 대기 중: 히트박스 끝 210에서도 평타 시작 안 함(사거리 175)', !a.atk); }
{ const { w, a, d } = mk(); placeGap(a, d, 210, 0);
  Core.step(w, [inp(a.id, 0, 0, true)]);
  ok('2b 준비됨: 같은 거리 210에서는 평타 시작', !!a.atk); }

// 2c. 강화 평타 피해: 85 + 대상 최대 체력 × (4 + 6/17×5)% 마법 피해(허수아비 마법 저항 0). 회복 = 마법 피해 100%, 재사용 22초
{ const { w, a, d } = mk(); placeGap(a, d, 100, 0);
  a.hp = a.stats.maxHp - 400;
  const raw = 5000 * (0.04 + 0.06 / 17 * 5);
  const r = strikeOnce(w, a, d);
  ok('2c 강화 평타 적중: 허수아비 피해 = 85 + 마법 피해(5000 × 5.7647%)', near(r.dealt, AD + raw, 1e-6), `${r.dealt.toFixed(4)} / ${(AD + raw).toFixed(4)}`);
  ok('2c 마법 피해 = 대상 최대 체력의 5.76%(≈288.2)', near(raw, 288.2353, 1e-3), raw.toFixed(4));
  ok('2c 회복 = 마법 피해의 100%', near(r.gain, raw, 1e-6), r.gain.toFixed(4));
  ok('2c 적중 틱에 재사용 대기 22초 시작(강화 평타는 쿨 감소 없음)', r.apPost === 22, r.apPost);
  ok('2c 적중 뒤 해제 틱 1개만 더 흐름(22 - 1틱)', near(a.apCd, 22 - TICK, 1e-9), a.apCd); }
{ // 2d. 마법 피해는 마법 저항 적용 뒤. 가렌(방어력 59, 마법저항력 39.75, 체력 1180)
  const w = Core.createWorld({ players: [{ id: 'p1', key: 'aatrox', team: 0 }, { id: 'e1', key: 'garen', team: 1 }], dummy: false });
  w.turrets.forEach(t => { t.dead = true; }); w.champs.forEach(quiet);
  const a = w.champs[0], g = w.champs[1];
  a.x = AT.x; a.y = AT.y; placeGap(a, g, 100, 0);
  a.hp = a.stats.maxHp - 400;
  const raw = 1180 * (0.04 + 0.06 / 17 * 5);
  const r = strikeOnce(w, a, g);
  const phys = AD / 1.59, magic = raw / 1.3975;
  ok('2d 가렌 대상: 평타 = 85 ÷ 1.59, 마법 = 최대 체력 비례 피해 ÷ 1.3975', near(r.dealt, phys + magic, 1e-6), `${r.dealt.toFixed(4)} / ${(phys + magic).toFixed(4)}`);
  ok('2d 회복 = 마법 저항 적용 뒤 마법 피해의 100%', near(r.gain, magic, 1e-6), r.gain.toFixed(4)); }
{ // 2e. 평타 적중 뒤 준비 안 된 상태: 적중마다 -2초, 0 아래로 안 내려감. 마법 피해 없음
  const { w, a, d } = mk(); placeGap(a, d, 100, 0);
  a.apCd = 10;
  const r = strikeOnce(w, a, d);
  ok('2e 준비 안 됨 평타 적중: 피해 = 85(마법 없음)', near(r.dealt, AD, 1e-6), r.dealt);
  ok('2e 준비 안 됨 평타 적중: 재사용 -2초(같은 틱의 감소 포함)', near(r.apPost, r.apPre - TICK - 2, 1e-9), `${r.apPre} → ${r.apPost}`);
  const w2 = mk(); const a2 = w2.a; placeGap(a2, w2.d, 100, 0); a2.apCd = 1;
  strikeOnce(w2.w, a2, w2.d);
  ok('2e 재사용 대기 1초에 평타 적중: 0 아래로 내려가지 않음', a2.apCd === 0, a2.apCd); }
{ // 2f. 실제 시간 흐름: 22초에서 1초 뒤 21초
  const { w, a, d } = mk(); placeGap(a, d, 100, 0);
  strikeOnce(w, a, d);
  run(w, 1);
  ok('2f 사신 태세 재사용 대기는 실제 시간으로 줄어듦(적중 뒤 61틱 = 1초 + 해제 1틱)', near(a.apCd, 22 - 61 * TICK, 1e-6), a.apCd); }
{ // 2g. 터렛은 강화 평타 대상이 아님(챔피언·허수아비만): 마법 없음, 대기 시간 그대로
  const w = Core.createWorld({ players: [{ id: 'p1', key: 'aatrox', team: 0 }], dummy: false });
  const a = w.champs[0]; quiet(a);
  const t = w.turrets.find(u => u.team === 1);
  a.x = t.x - px(175 + 55 + 40); a.y = t.y;     // 터렛 히트박스 끝에서 40유닛 떨어진 평타 거리
  const r = strikeOnce(w, a, t);
  const exp = AD * (1 / 1.6) * 0.15;   // 터렛 방어력 60, 15% 감소 (300초 전)
  ok('2g 터렛 평타: 마법 피해 없음(85 ÷ 1.6 × 0.15)', near(r.dealt, exp, 1e-6), r.dealt.toFixed(5));
  ok('2g 터렛 평타: 사신 태세 대기 그대로 0, 회복 없음', a.apCd === 0 && r.gain === 0, `${a.apCd} / ${r.gain}`); }

{ // 2h. Q 한 번(단계당 한 번)에 사신 태세 재사용 감소: 끝부분 -4, 몸통만 -2, 아무도 안 맞으면 0, 두 대상 동시에도 -4 한 번
  const runQ = setup => { const { w, a, d } = mk(); lvl(w, a, { q: 1 }); a.apCd = 10; setup(w, a, d); castQ(w, 0); const n = qRun(w, a); return { ap: a.apCd, n }; };
  const body = runQ((w, a, d) => place(d, a, 300, 159, 0));
  ok('2h Q 몸통만 맞음: 재사용 -2초', near(body.ap, 10 - body.n * TICK - 2, 1e-6), body.ap.toFixed(4));
  const sweet = runQ((w, a, d) => place(d, a, 694, 0, 0));
  ok('2h Q 끝부분 맞음: 재사용 -4초', near(sweet.ap, 10 - sweet.n * TICK - 4, 1e-6), sweet.ap.toFixed(4));
  const none = runQ((w, a, d) => place(d, a, 900, 0, 0));
  ok('2h Q 아무도 안 맞음: 재사용은 시간만큼만 줄어듦', near(none.ap, 10 - none.n * TICK, 1e-6), none.ap.toFixed(4));
  const w2 = Core.createWorld({ players: [{ id: 'p1', key: 'aatrox', team: 0 }, { id: 'e1', key: 'garen', team: 1 }], dummy: true });
  w2.turrets.forEach(t => { t.dead = true; }); w2.champs.forEach(quiet);
  const a2 = w2.champs[0], g2 = w2.champs[1], d2 = w2.dummies[0];
  a2.x = AT.x; a2.y = AT.y; lvl(w2, a2, { q: 1 }); a2.apCd = 10;
  place(d2, a2, 694, 0, 0);           // 허수아비: 끝부분
  place(g2, a2, 300, 144, 0);         // 가렌(반지름 55): 몸통 안쪽 가장자리 90+55-1
  castQ(w2, 0); const n2 = qRun(w2, a2);
  ok('2h 끝부분과 몸통이 동시에: 재사용 -4 한 번(중복 없음)', d2.total > 0 && g2.hp < g2.stats.maxHp && near(a2.apCd, 10 - n2 * TICK - 4, 1e-6), a2.apCd.toFixed(4)); }

// ---------------------------------------------------------------------
// 3. Q 도형 (§2-3, A5·A8, 원문 범위 그림). 허수아비 중심을 (앞 f, 옆 s)에 두고 판정 결과를 봄
// ---------------------------------------------------------------------
const B1 = 61, S1 = 106.75, B2 = 76.25, S2 = 133.25, B3 = 91.5, S3 = 160.125;   // 1레벨, 공격력 85
const geo = [
  // [이름, 단계, 앞, 옆, 기대]  (허수아비 반지름 70 기준으로 안쪽 1유닛 / 바깥 1유닛)
  ['1단계 끝부분 앞면 안쪽', 1, 694, 0, 'sweet'], ['1단계 앞면 바깥', 1, 696, 0, 'none'],
  ['1단계 옆면 안쪽', 1, 300, 159, 'body'], ['1단계 옆면 바깥', 1, 300, 161, 'none'],
  ['1단계 뒷면 안쪽', 1, -69, 0, 'body'], ['1단계 뒷면 바깥', 1, -71, 0, 'none'],
  ['1단계 끝부분 경계 안(앞 450-70+1)', 1, 381, 0, 'sweet'], ['1단계 끝부분 경계 밖(앞 450-70-1)', 1, 379, 0, 'body'],
  ['1단계 뒤 모서리 안(모서리에서 69)', 1, -69 * K2, 90 + 69 * K2, 'body'], ['1단계 뒤 모서리 밖(모서리에서 71)', 1, -71 * K2, 90 + 71 * K2, 'none'],
  ['2단계 뒷면 안쪽', 2, -169, 0, 'body'], ['2단계 뒷면 바깥', 2, -171, 0, 'none'],
  ['2단계 앞면 안쪽', 2, 544, 0, 'sweet'], ['2단계 앞면 바깥', 2, 546, 0, 'none'],
  ['2단계 끝부분 경계 안(앞 300-70+1)', 2, 231, 0, 'sweet'], ['2단계 끝부분 경계 밖(앞 300-70-1)', 2, 229, 0, 'body'],
  ['3단계 큰 원 앞쪽 안(중심 180+300+69)', 3, 549, 0, 'body'], ['3단계 큰 원 앞쪽 밖', 3, 551, 0, 'none'],
  ['3단계 가운데 원 안(중심 180+200+69)', 3, 449, 0, 'sweet'], ['3단계 가운데 원 밖(중심 180+200+71)', 3, 451, 0, 'body'],
  ['3단계 큰 원 뒤쪽 안', 3, -189, 0, 'body'], ['3단계 큰 원 뒤쪽 밖', 3, -191, 0, 'none'],
  ['3단계 큰 원 옆쪽 안', 3, 180, 369, 'body'], ['3단계 큰 원 옆쪽 밖', 3, 180, 371, 'none']
];
// 2단계 옆면(사다리꼴 빗변): 앞 0에서 가장자리 점 M = (0, -(150 + 75×100/575)), 바깥 법선 n = (-75, -575)/|(575,-75)|
{ const hw0 = 150 + 75 * 100 / 575, L = Math.hypot(575, 75), nf = -75 / L, ns = -575 / L;
  geo.push(['2단계 옆면(빗변) 안쪽', 2, 0 + nf * 69, -hw0 + ns * 69, 'body']);
  geo.push(['2단계 옆면(빗변) 바깥', 2, 0 + nf * 71, -hw0 + ns * 71, 'none']); }
for (const [name, st, f, s, exp] of geo) {
  const r = probe(st, f, s, 0);
  ok(`3 ${name}: ${exp}`, kindOf(r) === exp, `${kindOf(r)} (피해 ${r.dmg.toFixed(2)})`);
}
// 같은 경계를 방향 90°·180°로 돌려도 같은 결과(화면이 도형을 돌려 그리므로)
for (const ang of [Math.PI / 2, Math.PI, -Math.PI / 2]) {
  const sub = geo.filter(g => ['1단계 끝부분 앞면 안쪽', '1단계 옆면 안쪽', '1단계 옆면 바깥', '2단계 앞면 안쪽', '2단계 끝부분 경계 밖(앞 300-70-1)', '3단계 가운데 원 안(중심 180+200+69)', '3단계 큰 원 옆쪽 밖'].includes(g[0]));
  let allOk = true, detail = [];
  for (const [name, st, f, s, exp] of sub) {
    const r = probe(st, f, s, ang);
    if (kindOf(r) !== exp) { allOk = false; detail.push(`${name}:${kindOf(r)}`); }
  }
  ok(`3 방향 ${Math.round(ang * 180 / Math.PI)}°에서도 경계 판정 동일`, allOk, detail.join(', ') || `${sub.length}개`);
}

// 3b. 피해 값: 끝부분 = 끝부분 피해(겹치면 몸통 피해는 따로 없음), 1·2·3단계 모두
{ const r1s = probe(1, 694, 0, 0), r1b = probe(1, 300, 159, 0), r2b = probe(2, 50, 0, 0), r2s = probe(2, 544, 0, 0), r3b = probe(3, 549, 0, 0), r3s = probe(3, 449, 0, 0);
  ok('3b 1단계 앞면: 몸통과 끝부분 둘 다 겹쳐도 끝부분 피해 한 번만', near(r1s.dmg, S1, 1e-6), r1s.dmg.toFixed(4));
  ok('3b 1단계 몸통 피해 61 = 10 + 0.6×85', near(r1b.dmg, B1, 1e-6), r1b.dmg.toFixed(4));
  ok('3b 2단계 몸통 피해 76.25 · 끝부분 피해 133.25', near(probe(2, 50, 0, 0).dmg, B2, 1e-6) && near(r2s.dmg, S2, 1e-6), `${r2b.dmg.toFixed(3)} / ${r2s.dmg.toFixed(3)}`);
  ok('3b 3단계 몸통 91.5 · 중앙 160.125', near(r3b.dmg, B3, 1e-6) && near(r3s.dmg, S3, 1e-6), `${r3b.dmg.toFixed(3)} / ${r3s.dmg.toFixed(3)}`); }

// 3c. 끝부분 맞으면 0.25초 공중에 뜸(다리우스 E와 같은 air/airMax), 몸통은 안 뜸. 공중 시간이 지나면 내려옴
{ const r = probe(1, 694, 0, 0);
  ok('3c 끝부분 적중: 공중에 뜸 0.25초(airMax 0.25)', r.d.airMax === 0.25 && r.air > 0.2, `air ${r.air.toFixed(4)} max ${r.d.airMax}`);
  ok('3c 끝부분 적중 글자: 공중에 뜸', r.w.events.some(e => e.type === 'text' && e.txt === '공중에 뜸'));
  const rb = probe(1, 300, 159, 0);
  ok('3c 몸통만 적중: 공중에 뜨지 않음', rb.air === 0 && rb.d.air === 0);
  run(r.w, 0.2);
  ok('3c 0.2초 뒤에도 공중(0.25초 중)', r.d.air > 0);
  run(r.w, 0.1);
  ok('3c 0.25초가 지나면 내려옴', r.d.air === 0, r.d.air); }

// 3d. 도형 내보내기: 화면이 같은 도형을 그림. 월드 픽셀, 뒤 모서리/앞 모서리 위치
{ const s1 = Core.aatroxQShape(1, 600, 500, 0);
  ok('3d 1단계 사각형: 앞 0~625, 폭 180 (px)', near(s1.poly[0][0], 600) && near(s1.poly[1][0], 600 + px(625)) && near(s1.poly[1][1], 500 - px(90)), JSON.stringify(s1.poly));
  ok('3d 1단계 끝부분: 앞 450부터', near(s1.sweetPoly[0][0], 600 + px(450)) && near(s1.sweetPoly[1][0], 600 + px(625)));
  ok('3d 1단계는 원 없음', s1.circle === null && s1.sweetCircle === null);
  const s2 = Core.aatroxQShape(2, 600, 500, 0);
  ok('3d 2단계 사다리꼴: 뒤 -100 · 폭 300, 앞 475 · 폭 450', near(s2.poly[0][0], 600 - px(100)) && near(s2.poly[0][1], 500 - px(150)) && near(s2.poly[1][0], 600 + px(475)) && near(s2.poly[1][1], 500 - px(225)));
  const sw = (s2.sweetPoly[3][1] - s2.sweetPoly[0][1]) / px(1);   // 끝부분 뒤 가장자리(앞 300) 폭 = 2 × (150 + 75×400/575)
  ok('3d 2단계 끝부분 뒤 가장자리(앞 300) 폭 ≈ 404.35', near(sw, 2 * (150 + 75 * 400 / 575), 0.01), sw.toFixed(3));
  const s3 = Core.aatroxQShape(3, 600, 500, 0);
  ok('3d 3단계 원: 중심 앞 180, 반지름 300 · 중앙 반지름 200', near(s3.circle.x, 600 + px(180)) && near(s3.circle.y, 500) && near(s3.circle.r, px(300)) && near(s3.sweetCircle.r, px(200)) && s3.poly === null);
  const r90 = Core.aatroxQShape(1, 600, 500, Math.PI / 2);
  ok('3d 방향 90°: 앞 = 아래쪽(+y)', near(r90.poly[1][1], 500 + px(625)) && near(r90.poly[1][0], 600 + px(90)), JSON.stringify(r90.poly[1])); }

// ---------------------------------------------------------------------
// 4. 피해 계산: 총 공격력 기준 (1레벨·5레벨), 공격력 변화 반영
// ---------------------------------------------------------------------
{ const t1 = { s1b: 10 + 0.6 * AD, s1s: 17.5 + 1.05 * AD };
  ok('4 1레벨 1단계: 몸통 10 + 0.6×85 = 61, 끝부분 17.5 + 1.05×85 = 106.75', near(t1.s1b, B1) && near(t1.s1s, S1));
  const p5 = [probe(1, 300, 159, 0, 5).dmg, probe(1, 694, 0, 0, 5).dmg, probe(2, 50, 0, 0, 5).dmg, probe(2, 544, 0, 0, 5).dmg, probe(3, 549, 0, 0, 5).dmg, probe(3, 449, 0, 0, 5).dmg];
  const e5 = [70 + 0.9 * AD, 122.5 + 1.575 * AD, 87.5 + 1.125 * AD, 153.1 + 1.97 * AD, 105 + 1.35 * AD, 183.75 + 2.36 * AD];
  ok('4 5레벨 1·2·3단계 몸통·끝부분 값(표 그대로)', p5.every((v, i) => near(v, e5[i], 1e-6)), p5.map(v => v.toFixed(2)).join(' / '));
  const { w, a, d } = mk();
  a.bonus.ad = 50;   // 추가 공격력 50 → 총 공격력 135
  lvl(w, a, { q: 1 });
  place(d, a, 300, 159, 0);
  castQ(w, 0); qRun(w, a);
  ok('4 추가 공격력 반영: 총 공격력 135 → 1단계 몸통 10 + 0.6×135 = 91', near(d.total, 91, 1e-6), d.total); }

// ---------------------------------------------------------------------
// 5. 시전 0.6초 잠금 · 판정 시점 · 이동·평타 불가 (A6)
// ---------------------------------------------------------------------
{ const { w, a, d } = mk();
  lvl(w, a, { q: 1 });
  place(d, a, 300, 159, 0);
  const x0 = a.x, y0 = a.y;
  castQ(w, 0);
  let k = 1, hitAt = -1, moved = false, attacked = false;
  while (a.aq && k < 200) {
    Core.step(w, [inp(a.id, 1, 0, true)]);   // 시전 중 이동 + 평타 누르기
    k++;
    if (a.aq && (a.x !== x0 || a.y !== y0)) moved = true;
    if (a.aq && a.atk) attacked = true;      // 시전이 끝난 틱부터는 누르고 있던 평타가 나가도 됨
    if (d.total > 0 && hitAt < 0) hitAt = k;
  }
  ok('5 시전 중 이동 불가', !moved);
  ok('5 시전 중 평타 시작 불가', !attacked);
  ok('5 판정은 0.6초(36틱, 시전 틱 포함) 뒤', hitAt === 36, `${hitAt} 틱 (${(hitAt * TICK).toFixed(3)}초)`);
  ok('5 판정 뒤 시전 해제', !a.aq); }

// ---------------------------------------------------------------------
// 6. 단계 진행 · 재사용 창 3초 · 쿨타임 (A7)
// ---------------------------------------------------------------------
{ const { w, a } = mk({ dummy: false });
  lvl(w, a, { q: 1 });
  ok('6 쿨타임 0이면 1단계 가능(표시 1)', Core.aatroxQStage(a) === 1, Core.aatroxQStage(a));
  castQ(w, 0); qRun(w, a);
  ok('6 1단계 판정 뒤: 다음 단계 2, 창 3초', a.aqNext === 2 && near(a.aqWin, 3, 1e-9), `${a.aqNext} / ${a.aqWin}`);
  ok('6 창이 열려 있으면 재사용 대기 중이어도 다음 단계 2 표시', Core.aatroxQStage(a) === 2 && a.cd.q > 0, `cd ${a.cd.q.toFixed(2)}`);
  run(w, 2);
  const cdBefore = a.cd.q;
  castQ(w, 0);
  ok('6 창 안(2초 뒤)에는 쿨타임과 무관하게 2단계 시전', a.aq && a.aq.stage === 2 && cdBefore > 0, `stage ${a.aq && a.aq.stage} cd ${cdBefore.toFixed(2)}`);
  qRun(w, a);
  ok('6 2단계 판정 뒤: 다음 단계 3, 창 3초', a.aqNext === 3 && near(a.aqWin, 3, 1e-9));
  castQ(w, 0);
  ok('6 창 안에서 3단계 시전', a.aq && a.aq.stage === 3);
  qRun(w, a);
  ok('6 3단계 판정 뒤: 다음은 1단계, 창 닫힘', a.aqNext === 1 && a.aqWin === 0, `${a.aqNext} / ${a.aqWin}`);
  ok('6 3단계 시전 시작 때 쿨타임 14초(1레벨)를 다시 셈: 판정 0.6초 동안 줄어 13.4 근처', a.cd.q > 13 && a.cd.q < 14, a.cd.q.toFixed(3));
  Core.drainEvents(w);
  castQ(w, 0);
  ok('6 3단계 뒤 쿨타임 중에는 1단계 못 씀', !a.aq && texts(w).includes('재사용 대기 중'), texts(w).join(','));
  ok('6 쿨타임 중 시도는 쿨타임을 건드리지 않음', a.cd.q > 13, a.cd.q.toFixed(3)); }

{ // 6b. 창 3초가 끝나면 다음은 1단계(쿨타임이 끝나야 함)
  const { w, a } = mk({ dummy: false });
  lvl(w, a, { q: 1 });
  castQ(w, 0); qRun(w, a);
  run(w, 3.1);
  ok('6b 창 3초가 끝나면 다음 단계 1, 창 닫힘', a.aqNext === 1 && a.aqWin === 0 && Core.aatroxQStage(a) === 0, `${a.aqNext} / ${a.aqWin} / 쿨 ${a.cd.q.toFixed(2)}`);
  castQ(w, 0);
  ok('6b 창이 닫히고 쿨타임 중에는 못 씀', !a.aq);
  let g = 0; while (a.cd.q > EPS && g++ < 2000) Core.step(w, []);
  castQ(w, 0);
  ok('6b 쿨타임이 끝나면 1단계 다시 시전', a.aq && a.aq.stage === 1); }

{ // 6c. 쿨타임은 단계를 시전할 때마다 처음부터(레벨 1: 14초). 2초 뒤 2단계 시전 → 14로 돌아감
  const { w, a } = mk({ dummy: false });
  lvl(w, a, { q: 1 });
  castQ(w, 0); qRun(w, a);
  run(w, 2);
  const cdMid = a.cd.q;
  castQ(w, 0);
  ok('6c 2초 뒤 쿨타임은 줄어 있음(14 → 약 11.4)', near(cdMid, 14 - 2.6, 0.1), cdMid.toFixed(3));
  ok('6c 2단계 시전 시작 → 쿨타임 다시 14(처음부터)', near(a.cd.q, 14, 2 * TICK), a.cd.q.toFixed(4)); }

{ // 6d. 레벨 3 쿨타임 10 · 레벨 5 쿨타임 6 (표 그대로)
  const { w, a } = mk({ dummy: false });
  lvl(w, a, { q: 5 });
  castQ(w, 0);
  ok('6d 5레벨 쿨타임 6초', near(a.cd.q, 6, 2 * TICK), a.cd.q.toFixed(4)); }

// ---------------------------------------------------------------------
// 7. 취소: 공중에 뜸·끌려옴 (A6). 취소되면 같은 단계 재사용 창 3초가 새로 열림, 쿨타임은 환급 없이 계속 흐름
// ---------------------------------------------------------------------
{ const { w, a, d } = mk();
  lvl(w, a, { q: 1 });
  castQ(w, 0); qRun(w, a);                  // 1단계 판정(허수아비에는 안 맞힘: 멀리 있음)
  place(d, a, 50, 0, 0);                    // 2단계 몸통 위치(앞 50, 뒤 판정 영역 안)
  run(w, 0.5);
  castQ(w, 0);
  ok('7 2단계 시전 시작', a.aq && a.aq.stage === 2);
  a.air = 0.4;                              // 공중에 뜸(시전 중)
  Core.step(w, []);
  ok('7 공중에 뜨면 시전 취소', !a.aq);
  ok('7 취소: 피해 없음', d.total === 0, d.total);
  ok('7 취소돼도 단계 2 유지, 창 3초로 새로 열림', a.aqNext === 2 && near(a.aqWin, 3, 1e-9), `${a.aqNext} / ${a.aqWin}`);
  run(w, 0.5);                              // 공중 0.4초 끝
  castQ(w, 0);
  ok('7 창 안에서 같은 2단계 다시 시전', a.aq && a.aq.stage === 2);
  qRun(w, a);
  ok('7 재시전 판정 · 몸통 피해 76.25', near(d.total, B2, 1e-6), d.total);
  ok('7 재시전 뒤 다음 단계 3', a.aqNext === 3); }

{ // 7b. 끌려옴(pull)도 취소
  const { w, a, d } = mk();
  lvl(w, a, { q: 1 });
  a.aqWin = 3; a.aqNext = 1;
  place(d, a, 300, 159, 0);
  castQ(w, 0);
  a.pull = { t: 0, dur: 0.5, fx: a.x, fy: a.y, tx: a.x, ty: a.y, src: 'x' };
  Core.step(w, []);
  ok('7b 끌려오는 중이면 시전 취소, 피해 없음', !a.aq && d.total === 0);
  ok('7b 끌려와도 같은 1단계 창 3초로 새로 열림', a.aqNext === 1 && near(a.aqWin, 3, 1e-9), `${a.aqNext} / ${a.aqWin}`);
  a.pull = null;
  castQ(w, 0);
  ok('7b 취소 뒤 창 안에서 1단계 다시 시전 가능(창 3초 열림)', a.aq && a.aq.stage === 1); }

{ // 7c. 1단계를 쿨타임 중에 취소해도 같은 1단계를 3초 창 안에서 다시 씀 (쿨타임을 기다리지 않음)
  const { w, a } = mk({ dummy: false });
  lvl(w, a, { q: 1 });
  castQ(w, 0);
  ok('7c 1단계 시전 중에는 재시전 불가', Core.aatroxQStage(a) === 0);
  a.air = 0.1;                                  // 공중에 뜸 → 취소
  Core.step(w, []);
  ok('7c 1단계 시전 취소, 피해 없음', !a.aq && a.aqNext === 1 && near(a.aqWin, 3, 1e-9), `${a.aqNext} / ${a.aqWin}`);
  ok('7c 쿨타임은 환급 없이 시전 시작부터 계속 흐름', a.cd.q > 13 && a.cd.q < 14, a.cd.q.toFixed(4));
  ok('7c 공중에 있는 동안은 재시전 불가', Core.aatroxQStage(a) === 0);
  run(w, 0.15);                                 // 공중 끝 (창은 계속 흐름)
  ok('7c 착지 뒤 쿨타임이 남아 있어도 1단계 재시전 가능', !(a.air > 0) && Core.aatroxQStage(a) === 1, `${Core.aatroxQStage(a)} / ${a.cd.q.toFixed(3)}`);
  castQ(w, 0);
  ok('7c 창 안에서 1단계 재시전 시작', a.aq && a.aq.stage === 1); }

{ // 7d. 창 3초가 끝나면 쿨타임이 끝나야 1단계를 다시 쓸 수 있음
  const { w, a } = mk({ dummy: false });
  lvl(w, a, { q: 1 });
  castQ(w, 0);
  a.air = 0.1;
  Core.step(w, []);
  run(w, 3.1);
  ok('7d 창 3초가 끝나면 닫힘, 다음은 1단계', a.aqWin === 0 && a.aqNext === 1, `${a.aqWin} / ${a.aqNext}`);
  ok('7d 창이 닫힌 뒤 쿨타임이 남아 있으면 재시전 불가', a.cd.q > 0 && Core.aatroxQStage(a) === 0, a.cd.q.toFixed(3));
  castQ(w, 0);
  ok('7d 쿨타임 중 Q는 시전되지 않음', !a.aq);
  let n = 0;
  while (a.cd.q > EPS && n++ < 2000) Core.step(w, []);
  ok('7d 쿨타임이 끝나면 1단계 재시전 가능', Core.aatroxQStage(a) === 1);
  castQ(w, 0);
  ok('7d 쿨타임이 끝난 뒤 1단계 시전 시작', a.aq && a.aq.stage === 1); }

{ // 7e. 3단계를 취소해도 3단계 창이 새로 열림
  const { w, a } = mk({ dummy: false });
  lvl(w, a, { q: 1 });
  a.aqWin = 3; a.aqNext = 3;
  castQ(w, 0);
  ok('7e 창이 열려 있으면 3단계 시전 시작', a.aq && a.aq.stage === 3);
  a.air = 0.1;
  Core.step(w, []);
  ok('7e 3단계 취소 뒤 다음 단계 3, 창 3초 새로 열림', !a.aq && a.aqNext === 3 && near(a.aqWin, 3, 1e-9), `${a.aqNext} / ${a.aqWin}`);
  run(w, 0.15);
  castQ(w, 0);
  ok('7e 창 안에서 3단계 재시전 시작', a.aq && a.aq.stage === 3); }

// ---------------------------------------------------------------------
// 8. 침묵은 재시전을 막음 (기존 규칙), 침묵 중에는 쿨타임·단계 그대로
// ---------------------------------------------------------------------
{ const { w, a } = mk({ dummy: false });
  lvl(w, a, { q: 1 });
  a.silence = { t: 2 };
  castQ(w, 0);
  ok('8 침묵 중 Q 시전 불가', !a.aq && a.cd.q === 0 && a.aqWin === 0);
  run(w, 2.1);
  castQ(w, 0);
  ok('8 침묵이 끝나면 1단계 시전', a.aq && a.aq.stage === 1); }

// ---------------------------------------------------------------------
// 9. W·E·R 준비 중: 시전되지 않고 '준비 중' 글자만, 비용·쿨타임 없음
// ---------------------------------------------------------------------
{ const { w, a } = mk({ dummy: false });
  lvl(w, a, { w: 1, e: 1, r: 1 });
  Core.drainEvents(w);
  for (const k of ['w', 'e', 'r']) Core.step(w, [cmd('cast', 'p1', { skill: k, ang: 0 })]);
  ok('9 W·E·R 시전 → 준비 중 글자', texts(w).filter(t => t === '준비 중').length === 3, texts(w).join(','));
  ok('9 W·E·R 시전 뒤 쿨타임·마나·상태 변화 없음', a.cd.w === 0 && a.cd.e === 0 && a.cd.r === 0 && a.mana === 0 && !a.cast && !a.aq); }

// ---------------------------------------------------------------------
// 10. 흡혈 × 0.33 (광역) · 패시브 흡혈 · 결정성
// ---------------------------------------------------------------------
{ const { w, a, d } = mk();
  a.bonus.omni = 0.2; a.hp = a.stats.maxHp - 500;
  lvl(w, a, { q: 1 });
  place(d, a, 300, 159, 0);
  const h0 = a.hp;
  castQ(w, 0); qRun(w, a);
  ok('10 Q 몸통 흡혈 = 61 × 0.2 × 0.33', near(a.hp - h0, B1 * 0.2 * 0.33, 1e-6), (a.hp - h0).toFixed(4));
  ok('10 Q로는 사신 태세 대기 시간 변화 없음(평타 아님)', a.apCd === 0); }
{ const { w, a, d } = mk();
  a.bonus.omni = 0.2; a.hp = a.stats.maxHp - 500;
  lvl(w, a, { q: 1 });
  place(d, a, 694, 0, 0);
  const h0 = a.hp;
  castQ(w, 0); qRun(w, a);
  ok('10 Q 끝부분 흡혈 = 106.75 × 0.2 × 0.33', near(a.hp - h0, S1 * 0.2 * 0.33, 1e-6), (a.hp - h0).toFixed(4)); }
{ const { w, a, d } = mk();   // 평타 흡혈(단일, 흡혈 20%): 사신 태세 강화 평타 피해 85 + 마법 → 전부 흡혈 20%
  a.bonus.omni = 0.2; a.hp = a.stats.maxHp - 500; placeGap(a, d, 100, 0);
  const r = strikeOnce(w, a, d);
  ok('10 강화 평타 흡혈 = (85 + 마법) × 20% + 패시브 회복 100%', near(r.gain, (AD + (5000 * (0.04 + 0.06 / 17 * 5))) * 0.2 + 5000 * (0.04 + 0.06 / 17 * 5), 1e-6), r.gain.toFixed(3)); }

{ const play = () => {
    const { w, a, d } = mk();
    a.bonus.omni = 0.2; a.hp = a.stats.maxHp - 400;
    placeGap(a, d, 100, 0);
    strikeOnce(w, a, d);
    place(d, a, 694, 0, 0);
    lvl(w, a, { q: 1 });
    castQ(w, 0); qRun(w, a);
    run(w, 1.5);
    return w;
  };
  const x = play(), y = play();
  ok('10 같은 명령 → 같은 결과(JSON 동일)', JSON.stringify(x) === JSON.stringify(y)); }

// ---------------------------------------------------------------------
// 11. 죽으면 상태 초기화, 부활 뒤 사신 태세 준비됨·Q는 1단계부터
// ---------------------------------------------------------------------
{ const w = Core.createWorld({ players: [{ id: 'p1', key: 'garen', team: 0 }, { id: 'e1', key: 'aatrox', team: 1 }], dummy: false });
  w.turrets.forEach(t => { t.dead = true; }); w.champs.forEach(quiet);
  const g = w.champs[0], a = w.champs[1];
  a.x = AT.x; a.y = AT.y;
  lvl(w, a, { q: 1 });
  a.apCd = 10; a.aqWin = 2; a.aqNext = 3;
  a.hp = 1;
  g.x = a.x - px(55 + 55 + 10); g.y = a.y;   // 가렌을 아트록스 왼쪽 10유닛 틈에 둠(평타 거리)
  strikeOnce(w, g, a);
  ok('11 아트록스 사망', a.dead === true);
  ok('11 사망하면 Q 시전 해제', !a.aq);
  run(w, 5.5);
  ok('11 부활 뒤 사신 태세 준비(apCd 0), 창 닫힘, 다음 1단계', !a.dead && a.apCd === 0 && a.aqWin === 0 && a.aqNext === 1, `${a.apCd} / ${a.aqWin} / ${a.aqNext}`);
  ok('11 부활해도 스킬 레벨 유지(Q 1)', a.sk.q === 1, a.sk.q); }

// ---------------------------------------------------------------------
// 12. 편의: 단계 표시 · 스킬 등록 · 프로토콜 · 같은 명령 결정성(Q 전체)
// ---------------------------------------------------------------------
{ const { a, w } = mk();
  ok('12 레벨 0이면 Q 단계 표시 0', Core.aatroxQStage(a) === 0);
  lvl(w, a, { q: 1 });
  ok('12 쿨타임 0이면 Q 단계 표시 1', Core.aatroxQStage(a) === 1);
  ok('12 Q 최대 레벨 5, W·E 5, R 1', Core.SKILLS.aatrox.q.max === 5 && Core.SKILLS.aatrox.w.max === 5 && Core.SKILLS.aatrox.e.max === 5 && Core.SKILLS.aatrox.r.max === 1);
  ok('12 프로토콜: aatrox 선택 가능, 버전 11', P.CHAMP_KEYS.includes('aatrox') && P.VERSION === 11, P.VERSION); }

{ const play = () => {
    const { w, a, d } = mk();
    a.bonus.omni = 0.2; a.hp = a.stats.maxHp - 300;
    lvl(w, a, { q: 5 });
    place(d, a, 694, 0, 0);
    castQ(w, 0); qRun(w, a);
    a.aqWin = 0; a.aqNext = 1; a.cd.q = 0;   // 창을 닫고 쿨타임을 끝낸 상태에서 1단계
    place(d, a, 300, 159, 0);
    castQ(w, 0); qRun(w, a);
    return w;
  };
  const x = play(), y = play();
  ok('12 같은 명령 → 월드 JSON 동일(Q 두 번 · 흡혈 포함)', JSON.stringify(x) === JSON.stringify(y)); }

// ---------------------------------------------------------------------
// 13. 판정 이벤트(화면용): 시전 시작 aqTele, 판정 aqHit
// ---------------------------------------------------------------------
{ const { w, a, d } = mk();
  lvl(w, a, { q: 1 });
  place(d, a, 300, 159, 0);
  Core.drainEvents(w);
  castQ(w, 0.5);
  const tele = Core.drainEvents(w).filter(e => e.type === 'fx' && e.fx === 'aqTele');
  ok('13 시전 시작 aqTele 1개(life 0.6, owner p1, stage 1, ang)', tele.length === 1 && tele[0].life === 0.6 && tele[0].owner === 'p1' && tele[0].stage === 1 && near(tele[0].ang, 0.5, 1e-9), JSON.stringify(tele[0] || null));
  qRun(w, a);
  const hit = Core.drainEvents(w).filter(e => e.type === 'fx' && e.fx === 'aqHit');
  ok('13 판정 aqHit 1개(stage 1, ang, 원점 x·y)', hit.length === 1 && hit[0].stage === 1 && near(hit[0].x, AT.x) && near(hit[0].y, AT.y)); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
