/* =====================================================================
   다리우스 패시브 「과다출혈」 규칙 테스트
   - 원문 대조 기준: 대화 기록 요약(compaction summary)에 남은 규칙 문장과
     이후 사용자 메시지(스킬별 중첩 여부, 궁극기 중첩 제거)를 따릅니다.
     원문 메시지 자체는 기록에 그대로 남아 있지 않아 문장 단위 대조는 불가능합니다.
   - 해석이 필요한 부분은 각 테스트 앞에 "해석:" 주석으로 표시합니다.
   ===================================================================== */
const Core = require('../shared/core.js');
const fs = require('fs');
const path = require('path');
const rle = JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/walk_rle.json'), 'utf8'));
Core.setMap(rle);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  → ' + extra : '')); };
const near = (a, b, e = 0.01) => Math.abs(a - b) <= e;
const TICK = Core.TICK;
const run = (w, sec, cmds) => { const n = Math.round(sec / TICK); for (let i = 0; i < n; i++) Core.step(w, i === 0 ? cmds : []); };
const mk = (opts) => {
  const w = Core.createWorld(Object.assign({ players: [{ id: 'p1', key: 'darius', team: 0 }], dummy: true }, opts));
  w.turrets.forEach(t => { t.dead = true; });   // 포탑이 끼어들지 않도록 격리
  return w;
};
const lvl = (w, c, pts) => { for (const [k, n] of Object.entries(pts)) for (let i = 0; i < n; i++) Core.step(w, [{ type: 'levelup', id: c.id, skill: k }]); };
// 레벨 L로 바꾸기(월드 조작): 레벨과 레벨 기준 스탯을 함께 맞춘다
const setLevel = (c, L) => { c.level = L; c.stats = Core.calcStats(c.key, L); };
// 평타 한 번: 선딜 끝 타격 직전 대상 체력(pre)을 돌려준다. 타격 틱에 들어간 출혈 1틱도 pre 이후에 포함된다.
function hit(w, c, t) {
  let g = 0;
  while ((c.atk || c.atkCd > 0) && g++ < 2000) Core.step(w, []);   // 공격 쿨다운과 후딜이 끝날 때까지 대기
  Core.step(w, [{ type: 'input', id: c.id, mx: 0, my: 0, atk: true }]);
  let pre = t.hp; g = 0;
  while (!(c.atk && c.atk.hit) && g++ < 2000) { pre = t.hp; Core.step(w, []); }
  Core.step(w, [{ type: 'input', id: c.id, mx: 0, my: 0, atk: false }]);
  return pre;
}
const drain = (w, t) => { let g = 0; while (t.bleed && g++ < 2000) Core.step(w, []); };
// 다리우스를 더미 바로 옆에 세움(평타 사거리 안, 도끼 자루 등 모든 범위 밖에서 시작하지 않음)
const place = (c, d) => { c.x = d.x - Core.px(150); c.y = d.y; };
const ad = c => c.stats.ad;

// ---------------------------------------------------------------------
// A. 기본 설정 / 계산식
// ---------------------------------------------------------------------
{ // A1. 시작 레벨 6
  const w = mk(), c = w.champs[0];
  ok('A1 시작 레벨 6', c.level === 6 && Core.START_LEVEL === 6, c.level);
  ok('A1 6레벨 중첩당 기본 피해 18 (13+(6-1))', near(Core.bleedPerStack(c), 18), Core.bleedPerStack(c)); }

{ // A2. 중첩당 피해 = 13 + (레벨-1) + 공격력 × 0.3  (레벨 1, 6, 18 모두 확인)
  // 해석: 공식의 "AD"는 적용 시점의 현재 공격력(버프 포함)으로 본다. 버프 없는 상태에서 검증한다.
  for (const L of [1, 6, 18]) {
    const w = mk(), c = w.champs[0]; setLevel(c, L);
    const expPer = 13 + (L - 1);
    ok(`A2 L${L} 중첩당 기본 피해 = ${expPer}`, near(Core.bleedPerStack(c), expPer), Core.bleedPerStack(c));
    ok(`A2 L${L} 1중첩 총량 = ${expPer} + 0.3×AD`, near(Core.bleedTotal(c, 1), expPer + 0.3 * c.stats.ad, 1e-6), Core.bleedTotal(c, 1).toFixed(3));
  }
  { const w = mk(), c = w.champs[0]; c.stats.ad = 100; c.level = 6;
    ok('A2 공식 예시: L6, AD100, 1중첩 = 48', near(Core.bleedTotal(c, 1), 48)); } }

{ // A3. 총량 = 중첩 수 × (중첩당 기본 + 0.3×AD)  (n = 1..5)
  const w = mk(), c = w.champs[0]; c.stats.ad = 100;
  let allOk = true; const got = [];
  for (let n = 1; n <= 5; n++) { const exp = n * (18 + 30); got.push(Core.bleedTotal(c, n)); if (!near(Core.bleedTotal(c, n), exp, 1e-9)) allOk = false; }
  ok('A3 1~5중첩 총량 = n×(18+30) (AD100, L6)', allOk, got.join(', ')); }

// ---------------------------------------------------------------------
// B. 적용 · 지속 · 틱 · 갱신 (실제 평타 경로로 중첩 적용)
// ---------------------------------------------------------------------
{ // B1. 평타 1회 → 1중첩, 5초 동안 총량을 모두 입힘 (방어력 0)
  for (const L of [6, 1, 18]) {
    const w = mk(), c = w.champs[0], d = w.dummies[0]; setLevel(c, L); place(c, d);
    const expTotal = Core.bleedTotal(c, 1), a = ad(c);   // 버프 없음 → AD = 기본 공격력
    const pre = hit(w, c, d);
    ok(`B1 L${L} 평타 1회 → 1중첩`, d.bleed && d.bleed.stacks === 1, d.bleed && d.bleed.stacks);
    ok(`B1 L${L} 출혈 지속 5초로 시작`, d.bleed && d.bleed.t > 4.7 && d.bleed.t <= 5.0, d.bleed && d.bleed.t.toFixed(3));
    drain(w, d);
    ok(`B1 L${L} 5초 뒤 출혈 종료`, d.bleed === null);
    const got = pre - d.hp;   // 평타 타격(공격력) + 출혈 총량
    ok(`B1 L${L} 평타 피해 + 출혈 총량 전부 입음`, near(got, a + expTotal, 0.05), `${got.toFixed(2)} vs ${(a + expTotal).toFixed(2)}`);
  } }

{ // B2. 틱 균등 분배: 5초를 300틱으로 나눠 매 틱 같은 양 (총량/300). 1초 뒤 1/5, 2.5초 뒤 1/2
  const w = mk(), c = w.champs[0], d = w.dummies[0]; place(c, d);
  // 평타 타격 틱부터 기록 (strike 스텝에도 출혈 1틱 포함)
  const pre = hit_track(w, c, d);
  const tot = d._lastTotal, a = ad(c);
  const drops = pre.drops;
  const bleedOnly = drops.slice(1);
  const per = tot / 300;
  const uniform = bleedOnly.every(x => Math.abs(x - per) < 1e-6);
  ok('B2 출혈 틱은 매 틱 같은 양(총량/300)', uniform && bleedOnly.length >= 298 && bleedOnly.length <= 302, `ticks=${bleedOnly.length} per=${per.toFixed(5)} min=${Math.min(...bleedOnly).toFixed(5)} max=${Math.max(...bleedOnly).toFixed(5)}`);
  const cum = (n) => drops.slice(0, n).reduce((s, x) => s + x, 0);
  // 1초 시점(60틱, 타격 틱 포함) → 출혈 총량의 1/5
  ok('B2 1초 뒤 출혈 누적 = 1/5', near(cum(60) - a, tot / 5, 0.1), (cum(60) - a).toFixed(2) + ' / ' + (tot / 5).toFixed(2));
  ok('B2 2.5초 뒤 출혈 누적 = 1/2', near(cum(150) - a, tot / 2, 0.1), (cum(150) - a).toFixed(2));
  ok('B2 5초 뒤 출혈 누적 = 총량', near(cum(drops.length) - a, tot, 0.1), (cum(drops.length) - a).toFixed(2) + ' / ' + tot.toFixed(2)); }

// 틱 기록용 평타 함수: 틱별 체력 감소량과 출혈 총량을 함께 돌려준다
function hit_track(w, c, t) {
  let g = 0;
  while ((c.atk || c.atkCd > 0) && g++ < 2000) Core.step(w, []);
  Core.step(w, [{ type: 'input', id: c.id, mx: 0, my: 0, atk: true }]);
  let pre = t.hp; g = 0;
  while (!(c.atk && c.atk.hit) && g++ < 2000) { pre = t.hp; Core.step(w, []); }
  const drops = [pre - t.hp];          // 타격 스텝(출혈 1틱 포함)
  t._lastTotal = t.bleed ? t.bleed.total : 0;
  let h = t.hp;
  Core.step(w, [{ type: 'input', id: c.id, mx: 0, my: 0, atk: false }]);
  drops.push(h - t.hp); h = t.hp;      // 평타 입력 해제 스텝(출혈 1틱)
  g = 0;
  while (t.bleed && g++ < 2000) { Core.step(w, []); drops.push(h - t.hp); h = t.hp; }
  while (drops.length && Math.abs(drops[drops.length - 1]) < 1e-9) drops.pop();   // 마지막 부동소수 찌꺼기 틱 제외
  return { pre, drops };
}

{ // B3. 재중첩 시 타이머 5초로 갱신 (3초 뒤 2번째 평타 → 5초 더 유지)
  const w = mk(), c = w.champs[0], d = w.dummies[0]; place(c, d);
  hit(w, c, d); run(w, 3);
  ok('B3 3초 뒤에도 1중첩 유지', d.bleed && d.bleed.stacks === 1 && d.bleed.t < 2.5);
  hit(w, c, d);
  ok('B3 재중첩: 2중첩', d.bleed && d.bleed.stacks === 2, d.bleed && d.bleed.stacks);
  ok('B3 재중첩: 타이머 5초로 갱신', d.bleed && d.bleed.t > 4.7 && d.bleed.t <= 5.0, d.bleed && d.bleed.t.toFixed(3));
  run(w, 4.5); ok('B3 원래 타이머(처음 5초)가 지난 뒤에도 출혈 유지', !!d.bleed);
  run(w, 0.8); ok('B3 갱신된 5초가 지나면 종료', d.bleed === null); }

{ // B4. 재중첩 시 총량 갱신: 새 중첩 수 기준으로 다시 계산해 남은 5초에 나눠 입힘
  const w = mk(), c = w.champs[0], d = w.dummies[0]; place(c, d);
  hit(w, c, d); run(w, 2.5);
  const pre2 = hit(w, c, d);
  ok('B4 재중첩 후 총량 = 2중첩 기준', d.bleed && near(d.bleed.total, Core.bleedTotal(c, 2), 1e-6), d.bleed && d.bleed.total.toFixed(3) + ' / ' + Core.bleedTotal(c, 2).toFixed(3));
  drain(w, d);
  // 2번째 평타 직전 체력 기준: 이전 출혈은 교체되므로 남은 피해는 타격 + 2중첩 총량
  ok('B4 재중첩 이후 누적 = 타격 + 2중첩 총량 (이전 출혈 잔여 제외)', near(pre2 - d.hp, ad(c) + Core.bleedTotal(c, 2), 0.1), (pre2 - d.hp).toFixed(2)); }

{ // B5. 중첩 상한 5 (6번째 적중도 5중첩)
  const w = mk(), c = w.champs[0], d = w.dummies[0]; place(c, d);
  for (let i = 0; i < 6; i++) hit(w, c, d);
  ok('B5 6번 적중해도 5중첩 상한', d.bleed && d.bleed.stacks === 5, d.bleed && d.bleed.stacks); }

// ---------------------------------------------------------------------
// C. 5중첩 공격력 증가 (버프)
// ---------------------------------------------------------------------
function stackFive(w, c, d) { for (let i = 0; i < 5; i++) hit(w, c, d); }

{ // C1. 4중첩까지는 버프 없음, 5번째 중첩에서 발동
  const w = mk(), c = w.champs[0], d = w.dummies[0]; place(c, d);
  for (let i = 0; i < 4; i++) hit(w, c, d);
  ok('C1 4중첩에서는 공격력 증가 없음', c.might === 0 && Core.buffAD(c) === 0);
  hit(w, c, d);
  ok('C1 5중첩 도달 시 공격력 증가 발동', c.might > 4.9 && c.might <= 5.0 && Core.buffAD(c) === 55, `might=${c.might.toFixed(3)} buff=${Core.buffAD(c)}`); }

{ // C2. 버프 값 = 30 + 5×(레벨-1)  (레벨 1, 6, 18). 월드 조작 + 실제 5중첩 발동 확인
  for (const [L, exp] of [[1, 30], [6, 55], [18, 115]]) {
    const w = mk(), c = w.champs[0]; setLevel(c, L); place(c, w.dummies[0]);
    stackFive(w, c, w.dummies[0]);
    ok(`C2 L${L} 공격력 증가 = ${exp}`, c.might > 0 && Core.buffAD(c) === exp && near(Core.curAD(c) - c.stats.ad, exp), Core.buffAD(c) + ' (' + c.stats.ad.toFixed(1) + '→' + Core.curAD(c).toFixed(1) + ')');
  } }

{ // C3. 버프 지속 5초
  const w = mk(), c = w.champs[0], d = w.dummies[0]; place(c, d);
  stackFive(w, c, d);
  run(w, 4.8); ok('C3 발동 4.8초 뒤에도 버프 유지', c.might > 0);
  run(w, 0.3); ok('C3 발동 5.1초 뒤 버프 종료', c.might === 0 && Core.buffAD(c) === 0, c.might.toFixed(3)); }

{ // C4. 버프 중 평타는 대상에게 최대 중첩(5)을 한 번에 쌓음
  // 해석: 버프 중 새 대상이 5중첩에 도달하면 '새로 5중첩 도달'로 보고 버프 타이머를 5초로 다시 맞춘다(현재 코드 동작).
  const w2 = mk({ players: [{ id: 'p1', key: 'darius', team: 0 }, { id: 'e1', key: 'yi', team: 1 }], dummy: true });
  w2.turrets.forEach(t => { t.dead = true; });
  const c2 = w2.champs[0], d2 = w2.dummies[0], y = w2.champs[1];
  y.x = 300; y.y = 300; y.stats.regen = 0;   // 처음에는 멀리 떨어뜨려 두어 더미만 때리게 함
  place(c2, d2); stackFive(w2, c2, d2);
  ok('C4 준비: 더미에 5중첩, 버프 중', c2.might > 0 && d2.bleed.stacks === 5);
  y.x = c2.x - Core.px(30); y.y = c2.y;   // 새 대상(챔피언)을 가장 가까운 적으로
  hit(w2, c2, y);
  ok('C4 버프 중 평타 1회 → 새 대상 즉시 5중첩', y.bleed && y.bleed.stacks === 5, y.bleed && y.bleed.stacks);
  ok('C4 (해석) 새 대상 5중첩 도달로 버프 재설정', c2.might > 4.5 && c2.might <= 5.0, c2.might.toFixed(3)); }

{ // C5. 버프가 끝난 뒤 중첩이 남아 있는 동안의 적중은 버프를 다시 켜지 않음
  // 해석: 버프 발동 조건은 '대상이 0~4중첩 → 5중첩으로 새로 도달'할 때만이다.
  const w = mk(), c = w.champs[0], d = w.dummies[0]; place(c, d);
  stackFive(w, c, d);            // 발동 t0, 버프 5초
  run(w, 2.5); hit(w, c, d);     // 버프 중 적중: 중첩 5 유지, 출혈 갱신
  ok('C5 버프 중 추가 적중은 5중첩 유지', d.bleed.stacks === 5 && c.might > 0);
  let g = 0; while (c.might > 0 && g++ < 2000) Core.step(w, []);
  ok('C5 버프 종료 뒤 출혈은 아직 남아 있음', !!d.bleed && d.bleed.stacks === 5);
  hit(w, c, d);
  ok('C5 버프 종료 후 적중(중첩 5 유지) → 버프 재발동 안 함', c.might === 0 && d.bleed.stacks === 5, c.might.toFixed(3)); }

{ // C6. 출혈이 완전히 끝난 뒤 다시 5중첩 → 버프 재발동
  const w = mk(), c = w.champs[0], d = w.dummies[0]; place(c, d);
  stackFive(w, c, d); run(w, 12);
  ok('C6 준비: 출혈·버프 모두 종료', d.bleed === null && c.might === 0);
  stackFive(w, c, d);
  ok('C6 다시 5중첩 도달 → 버프 재발동', c.might > 0 && Core.buffAD(c) === 55); }

{ // C7. 버프 중 적용된 출혈의 AD는 버프 포함 현재 공격력 (L6, 기본 AD 89 → 버프 중 144)
  // 해석: 중첩 피해 공식의 "AD"는 적용 시점의 현재 공격력으로 본다. 5번째 중첩은 버프가 켜진 뒤 계산되므로 버프 값이 포함된다.
  const w = mk(), c = w.champs[0], d = w.dummies[0]; place(c, d);
  stackFive(w, c, d);
  ok('C7 5중첩 총량에 버프 포함 공격력 사용 (5×18 + 0.3×144×5 = 306)', d.bleed && near(d.bleed.total, 306, 1e-6), d.bleed && d.bleed.total.toFixed(3)); }

// ---------------------------------------------------------------------
// D. 어떤 스킬이 중첩을 쌓는가 / 궁극기가 지우는가
// ---------------------------------------------------------------------
{ // D1. 기본 공격: 1중첩
  const w = mk(), c = w.champs[0], d = w.dummies[0]; place(c, d);
  hit(w, c, d); ok('D1 기본 공격 → 1중첩', d.bleed && d.bleed.stacks === 1); }

{ // D2. Q 도끼 자루(안쪽 205): 출혈 없음
  const w = mk(), c = w.champs[0], d = w.dummies[0]; lvl(w, c, { q: 1 });
  c.x = d.x - Core.px(240); c.y = d.y;   // 자루 구간(히트박스 끝부터 205 안쪽)
  Core.step(w, [{ type: 'cast', id: 'p1', skill: 'q', ang: 0 }]); run(w, 0.8);
  ok('D2 Q 도끼 자루는 피해를 주지만 출혈을 쌓지 않음', d.bleed === null && d.hp < d.maxHp); }

{ // D3. Q 도끼날(바깥 띠): 1중첩
  const w = mk(), c = w.champs[0], d = w.dummies[0]; lvl(w, c, { q: 1 });
  c.x = d.x - Core.px(300); c.y = d.y;
  Core.step(w, [{ type: 'cast', id: 'p1', skill: 'q', ang: 0 }]); run(w, 0.8);
  ok('D3 Q 도끼날 → 1중첩', d.bleed && d.bleed.stacks === 1, d.bleed && d.bleed.stacks); }

{ // D4. W 강화 평타: 1중첩 (추가 피해 포함 한 번만 쌓임)
  const w = mk(), c = w.champs[0], d = w.dummies[0]; lvl(w, c, { w: 1 }); place(c, d);
  Core.step(w, [{ type: 'cast', id: 'p1', skill: 'w', ang: 0 }]);
  hit(w, c, d);
  ok('D4 W 강화 평타 → 1중첩', d.bleed && d.bleed.stacks === 1, d.bleed && d.bleed.stacks); }

{ // D5. E 포획: 1중첩 (끌려온 대상)
  const w = mk(), c = w.champs[0], d = w.dummies[0]; lvl(w, c, { e: 1 });
  c.x = d.x - Core.px(55 + 535 + 40); c.y = d.y;
  Core.step(w, [{ type: 'cast', id: 'p1', skill: 'e', ang: 0 }]); run(w, 0.5);
  ok('D5 E 포획 → 1중첩', d.bleed && d.bleed.stacks === 1, d.bleed && d.bleed.stacks); }

{ // D6. 궁극기: 맞은 적의 중첩을 모두 제거하고, 중첩을 쌓지 않음
  const w = mk(), c = w.champs[0], d = w.dummies[0]; lvl(w, c, { r: 1 }); place(c, d);
  for (let i = 0; i < 3; i++) hit(w, c, d);
  ok('D6 준비: 3중첩', d.bleed && d.bleed.stacks === 3);
  c.x = d.x - Core.px(55 + 70 + 200); c.y = d.y; c.mana = c.stats.maxMana;
  while (c.cd.r > 0) Core.step(w, []);
  const stacks = d.bleed.stacks;
  Core.step(w, [{ type: 'cast', id: 'p1', skill: 'r', ang: 0 }]);
  let rDrop = null, g = 0;
  while (c.cast && g++ < 500) { const h = d.hp, was = !!c.cast; Core.step(w, []); if (was && !c.cast) rDrop = h - d.hp; }
  ok('D6 궁극기 후 중첩 모두 제거', d.bleed === null);
  // 궁극기 피해: (125 + 0.75×AD) × (1 + 0.2×중첩) — 중첩이 남아 있을 때의 배율 기준
  const exp = (125 + 0.75 * ad(c)) * (1 + 0.2 * stacks);
  ok('D6 궁극기 피해 배율 = 1 + 0.2×중첩(3중첩 → ×1.6)', rDrop !== null && near(rDrop, exp, 0.05), rDrop + ' / ' + exp.toFixed(2)); }

// ---------------------------------------------------------------------
// E. 적용 대상 (더미 · 챔피언)
// ---------------------------------------------------------------------
{ // E1. 더미에도 적용
  const w = mk(), c = w.champs[0], d = w.dummies[0]; place(c, d);
  hit(w, c, d); ok('E1 더미에 출혈 적용', d.bleed && d.bleed.stacks === 1); }

{ // E2. 챔피언에도 적용 (방어력 0으로 맞춰 총량을 정확히 확인)
  const w = Core.createWorld({ players: [{ id: 'p1', key: 'darius', team: 0 }, { id: 'e1', key: 'yi', team: 1 }], dummy: false });
  w.turrets.forEach(t => { t.dead = true; });
  const c = w.champs[0], y = w.champs[1];
  y.x = 400; y.y = 500; y.stats.regen = 0; y.stats.armor = 0;
  c.x = y.x - Core.px(30); c.y = y.y;
  const expTotal = Core.bleedTotal(c, 1), a = ad(c);
  const pre = hit(w, c, y);
  ok('E2 챔피언에 출혈 적용', y.bleed && y.bleed.stacks === 1);
  drain(w, y);
  ok('E2 챔피언 출혈 총량 = 평타 + 1중첩', near(pre - y.hp, a + expTotal, 0.1), (pre - y.hp).toFixed(2) + ' / ' + (a + expTotal).toFixed(2)); }

// ---------------------------------------------------------------------
// F. 피해 유형 (해석: 물리 피해. 방어력 · 물리관통력 적용)
// ---------------------------------------------------------------------
{ // F1. 방어력 60인 더미: 평타와 출혈 모두 1/1.6 로 감소
  // 해석: 원문에 피해 유형이 명시되지 않아 물리로 본다. 원문이 고정 피해라면 이 테스트는 불일치.
  const w = mk(), c = w.champs[0], d = w.dummies[0]; place(c, d); d.armor = 60;
  const a = ad(c), total = Core.bleedTotal(c, 1);
  const pre = hit(w, c, d); drain(w, d);
  ok('F1 방어력 60: 평타+출혈 = (공격력 + 총량) / 1.6', near(pre - d.hp, (a + total) / 1.6, 0.1), (pre - d.hp).toFixed(2) + ' / ' + ((a + total) / 1.6).toFixed(2)); }

{ // F2. 물리관통력(E Lv3 = 30%): 출혈도 관통 적용 (적용 시점 관통 기준)
  const w = mk(), c = w.champs[0], d = w.dummies[0]; lvl(w, c, { e: 3 }); place(c, d); d.armor = 60;
  ok('F2 준비: 관통력 30%', Core.penPct(c) === 30);
  const a = ad(c), total = Core.bleedTotal(c, 1);
  const pre = hit(w, c, d); drain(w, d);
  ok('F2 관통 30%: 방어력 60 → 유효 42', near(pre - d.hp, (a + total) / (1 + 42 / 100), 0.1), (pre - d.hp).toFixed(2)); }

// ---------------------------------------------------------------------
// G. 기타 확인
// ---------------------------------------------------------------------
{ // G1. 새 더미는 출혈이 없다
  const w = mk(); ok('G1 시작 시 출혈 없음', w.dummies[0].bleed === null); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
