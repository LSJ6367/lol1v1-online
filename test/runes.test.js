/* =====================================================================
   룬 테스트 (DESIGN_RUNES §2~5, 원문 docs/spec/runes.md)
   - 정복자(Q1~Q7): 기본 공격·스킬 피해로 중첩 얻기(5초짜리 묶음, 2중첩), 최대 12중첩, 1중첩 공격력·주문력(레벨 성장),
     최대 중첩 때 적 챔피언 대상 피해의 8% 회복, 노란 도끼 표시용 데이터(스냅숏 conq)
   - 칼날비(L1~L7): 적 챔피언 대상 평타 3번 강화(강화 공속 +90%), 3초 안에 다음 적중이 없으면 끝,
     선딜 취소 한 번마다 강화 횟수 +1(후딜 취소는 환급 없음), 포탑 대상 평타에는 적용 없음
   - R0: createWorld({ runes: false })면 룬 효과 전부 없음
   ===================================================================== */
const Core = require('../shared/core.js');
const Protocol = require('../shared/protocol.js');
const fs = require('fs'), path = require('path');
const RLE = JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/walk_rle.json'), 'utf8'));
Core.setMap(RLE);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  → ' + extra : '')); };
const near = (a, b, e = 0.01) => Math.abs(a - b) <= e;
const TICK = Core.TICK, px = Core.px, ticks = sec => Math.round(sec / TICK);
const cmd = (type, id, extra) => Object.assign({ type, id }, extra || {});
const inp = (id, mx, my, atk) => cmd('input', id, { mx, my, atk: !!atk });
const P = w => w.champs.find(c => c.id === 'p1');
const E = w => w.champs.find(c => c.id === 'e1');
const steps = (w, n) => { for (let i = 0; i < n; i++) Core.step(w, []); };
const quiet = c => { c.stats.regen = 0; c.stats.manaRegen = 0; };   // 자연 회복 끄기
const giveAll = c => { c.sk.q = 1; c.sk.w = 1; c.sk.e = 1; c.sk.r = 1; c.sp = 0; c.mana = c.stats.maxMana; };

// 나(p1) + 허수아비(dummy1, 기본 위치 HOME). 나는 허수아비 옆 사거리 안 (gap 20 유닛)
function mkD(key, opts) {
  const w = Core.createWorld(Object.assign({ players: [{ id: 'p1', key, team: 0 }], dummy: true }, opts || {}));
  w.turrets.forEach(t => { t.dead = true; });
  w.champs.forEach(quiet);
  const p = P(w), d = w.dummies[0];
  p.x = d.x - px(Core.HIT_R + d.r + 20); p.y = d.y;
  return w;
}
// 나(p1, 팀0)와 상대 챔피언(e1, 팀1) 1:1. 나는 (600,500), 상대는 gap 유닛 떨어진 오른쪽
function mkDuel(p1key, e1key, opts) {
  const w = Core.createWorld(Object.assign({ players: [{ id: 'p1', key: p1key, team: 0 }, { id: 'e1', key: e1key, team: 1 }], dummy: false }, opts || {}));
  w.turrets.forEach(t => { t.dead = true; });
  w.champs.forEach(quiet);
  const p = P(w); p.x = 600; p.y = 500;
  return w;
}
const place = (w, gap) => { const p = P(w), e = E(w); e.x = p.x + px(gap + 110); e.y = p.y; };
// 나(p1) + 포탑(적 t_foe 살림, 아군 포탑 격리). 포탑은 gap 유닛 떨어진 곳
function mkTurret(key) {
  const w = Core.createWorld({ players: [{ id: 'p1', key, team: 0 }], dummy: false });
  w.turrets.forEach(t => { if (t.team === 0) t.dead = true; });
  w.champs.forEach(quiet);
  const p = P(w); p.x = 600; p.y = 500;
  const t = w.turrets.find(u => u.team === 1);
  t.x = p.x + px(20 + 175 + 55); t.y = p.y;
  return { w, t };
}

// 평타 한 번을 적중까지 진행. 버튼을 떼고 고정도 푼다(자동 평타가 이어지지 않게). 반환: 적중 여부
function strike(w, p) {
  Core.step(w, [inp(p.id, 0, 0, true)]);
  let g = 0;
  while (!(p.atk && p.atk.hit) && g++ < 2000) Core.step(w, [inp(p.id, 0, 0, false)]);
  p.lock = null;
  Core.step(w, [inp(p.id, 0, 0, false)]);
  return g < 2000;
}
// 칼날비 기록: 한 틱 진행하고 새로 시작된 평타(번호 lt, 대기시간 cd, 선딜 wind, 후딜 back)와 적중한 평타 번호를 쌓음
function track(w, p, rec, cmds) {
  Core.step(w, cmds || []);
  if (p.atk && p.atk !== rec.last) { rec.last = p.atk; rec.starts.push({ t: w.time, lt: p.atk.lt || 0, cd: p.atkCd, wind: p.atk.wind, back: p.atk.back }); }
  if (p.atk && p.atk.hit && rec.lastHit !== p.atk) { rec.lastHit = p.atk; rec.hits.push(p.atk.lt || 0); }
}
const newRec = () => ({ starts: [], hits: [], last: null, lastHit: null });
/* 칼날비 강화 공속(L2) 공식 검사: 기본 공속 × (1 + 추가 공속 비율 + 0.9). 기본 공속이 1.0인 챔피언이면 1.9가 됨(원문 예시).
   마스터 이(기본 0.679)는 실제 값으로 계산: 원래 공속 curAS, 강화 공속 ltAS */
const ltFormula = c => Core.CHAMPS[c.key].b.as * (1 + Core.bonusASPct(c) + 0.9);

// ---------------------------------------------------------------------
// 7. 정복자 시간 규칙 (원문 예시): 평타 한 번 → 2중첩 5초. 3초 뒤 평타 → 4중첩, 2초 뒤 2중첩, 3초 뒤 0
// ---------------------------------------------------------------------
{ const w = mkDuel('darius', 'yi'), p = P(w);
  place(w, 60);
  const hit1 = strike(w, p);
  ok('7 평타 적중 → 2중첩(묶음 1개)', hit1 && p.conq.length === 1 && Core.conqStacks(p) === 2, JSON.stringify(p.conq));
  ok('7 묶음 시간 5초(방금 얻음)', near(p.conq[0], 5, 0.05), p.conq[0]);
  steps(w, ticks(3));
  ok('7 3초 뒤: 2중첩, 남은 시간 2초', Core.conqStacks(p) === 2 && near(p.conq[0], 2, 0.05), p.conq[0]);
  const hit2 = strike(w, p);
  ok('7 3초 뒤 평타 → 4중첩(두 묶음)', hit2 && Core.conqStacks(p) === 4 && p.conq.length === 2, JSON.stringify(p.conq));
  steps(w, ticks(1.5));
  ok('7 두 번째 평타 1.5초 뒤: 4중첩', Core.conqStacks(p) === 4);
  steps(w, ticks(1.0));
  ok('7 2.5초 뒤: 2중첩 (첫 묶음 만료)', Core.conqStacks(p) === 2, JSON.stringify(p.conq));
  steps(w, ticks(2.0));
  ok('7 4.5초 뒤: 아직 2중첩', Core.conqStacks(p) === 2, JSON.stringify(p.conq));
  steps(w, ticks(1.0));
  ok('7 5.5초 뒤: 0중첩 (묶음 모두 만료)', Core.conqStacks(p) === 0 && p.conq.length === 0, JSON.stringify(p.conq));
}
// 7b. 스킬 피해도 중첩을 얻음 (다리우스 Q 학살, 적 챔피언 대상)
{ const w = mkDuel('darius', 'yi'), p = P(w);
  giveAll(p); place(w, 100);
  Core.step(w, [cmd('cast', 'p1', { skill: 'q', ang: 0 })]);
  steps(w, ticks(1.0));
  ok('7 스킬(다리우스 Q) 피해로도 2중첩을 얻음', p.conq.length === 1 && Core.conqStacks(p) === 2, JSON.stringify(p.conq));
}

// ---------------------------------------------------------------------
// 8. 정복자 1중첩 값: 공격력 레벨 1 1.08 · 레벨 6 1.47, 주문력 1.8 · 2.445(레벨 6). 추가 공격력에 들어가고 과다출혈 총량에도 반영
// ---------------------------------------------------------------------
{ const w = mkD('darius'), p = P(w), d = w.dummies[0];
  p.level = 1; p.conq = [5];
  ok('8 레벨 1: 1중첩 공격력 1.08', near(Core.conqPerStack(p), 1.08, 0.005), Core.conqPerStack(p));
  ok('8 레벨 1: 추가 공격력 = 2중첩 × 1.08 = 2.16 (bonusAD)', near(Core.bonusAD(p), 2.16, 0.005), Core.bonusAD(p));
  p.level = 6;
  ok('8 레벨 6: 1중첩 공격력 1.47', near(Core.conqPerStack(p), 1.47, 0.005), Core.conqPerStack(p));
  ok('8 레벨 6: 추가 공격력 2.94, 총 공격력에도 들어감', near(Core.bonusAD(p), 2.94, 0.005) && near(Core.totalAD(p), p.stats.ad + 2.94, 0.005), Core.bonusAD(p));
  p.stats.ap = 10;                                   // 적응형(Q3): 주문력 10 > 추가 공격력 0 → 주문력으로 얻음 (1중첩 주문력 = 1.8 + 0.129 × 5 = 2.445)
  ok('8 적응형: 주문력이 더 높으면 주문력(conqAP = 2 × 2.445), 추가 공격력은 0', near(Core.conqAP(p), 2 * 2.445, 0.01) && Core.conqAD(p) === 0, `${Core.conqAP(p)} / ${Core.conqAD(p)}`);
  p.stats.ap = 0;
  // 과다출혈: 같은 타격에서 얻은 중첩이 바로 반영 (1중첩 출혈 = 18 + 0.3 × 추가 공격력)
  p.conq = []; p.level = 6;
  strike(w, p);
  ok('8 평타 적중 때 얻은 중첩이 같은 타격의 과다출혈 총량에 들어감', d.bleed && near(d.bleed.total, 18 + 0.3 * 2.94, 0.02), d.bleed && d.bleed.total);
}
// 8b. 아트록스 R 공격력 증가의 바탕에도 정복자 추가 공격력이 들어감 (순환 없이)
{ const w = mkD('aatrox'), a = P(w);
  a.conq = [5, 5];
  a.ar = { t: 0, dur: 10, msT: 0, lv: 1 };
  const cAD = Core.conqAD(a), ratio = Core.SKILLS.aatrox.r.ad[0];
  ok('8 아트록스 R: 추가 공격력 = 정복자 + (기본 공격력 + 정복자) × 증가율', near(Core.bonusAD(a), cAD + (a.stats.ad + cAD) * ratio, 0.01), Core.bonusAD(a).toFixed(3));
}

// ---------------------------------------------------------------------
// 9. 한 틱 여러 피해: 다리우스 W 강화 평타(평타 + 추가 피해가 같은 틱) → 2중첩만
// ---------------------------------------------------------------------
{ const w = mkD('darius'), p = P(w), d = w.dummies[0];
  giveAll(p);
  Core.step(w, [cmd('cast', 'p1', { skill: 'w', ang: 0 })]);
  ok('9 준비: 다리우스 W 강화', p.wBuff === true);
  Core.step(w, [inp('p1', 0, 0, true)]);
  let hitHurts = -1, g = 0;
  while (hitHurts < 0 && g++ < 2000) {
    const before = d.hits.length;
    Core.step(w, [inp('p1', 0, 0, false)]);
    if (p.atk && p.atk.hit) hitHurts = d.hits.length - before;    // 적중 틱에 일어난 피해 횟수(출혈 틱은 적중 뒤에 시작)
  }
  p.lock = null;
  ok('9 강화 평타: 한 틱에 여러 번 맞지만(평타 + 추가 피해, 출혈 첫 틱 포함) 중첩은 2중첩만', hitHurts >= 2 && p.conq.length === 1 && Core.conqStacks(p) === 2, `적중 틱 피해 ${hitHurts}번, ${JSON.stringify(p.conq)}`);
}

// ---------------------------------------------------------------------
// 10. 가렌 E 회전 타격마다 +2: 6묶음(12중첩)에서 멈춤, 7번째 타격은 가장 오래된 묶음을 갱신
// ---------------------------------------------------------------------
{ const w = mkD('garen'), g = P(w);
  giveAll(g);
  Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]);
  let lastTick = -1, maxStacks = 0;
  const gains = [];
  for (let i = 0; i < ticks(3.3); i++) {
    const pre = g.conq.slice();
    Core.step(w, []);
    maxStacks = Math.max(maxStacks, Core.conqStacks(g));
    if (g.conqTick !== lastTick) { lastTick = g.conqTick; gains.push({ pre, post: g.conq.slice() }); }
  }
  ok('10 회전 타격 7번 → 얻음 7번(타격마다 한 번)', gains.length === 7, gains.length);
  ok('10 여섯 번째 타격 뒤 12중첩', gains.length >= 6 && Core.conqStacks({ conq: gains[5].post }) === 12, gains[5] && JSON.stringify(gains[5].post));
  ok('10 최대 12중첩을 넘지 않음', maxStacks === 12, maxStacks);
  const last = gains[6];
  ok('10 일곱 번째: 묶음은 6개 그대로, 새 묶음 5초가 들어감', last.post.length === 6 && last.post.some(x => near(x, 5, 1e-6)), JSON.stringify(last.post));
  ok('10 일곱 번째: 가장 짧게 남은 묶음(가장 오래된)이 빠짐', Math.min(...last.post.filter(x => x < 4.999)) > Math.min(...last.pre) + 0.2, `${Math.min(...last.pre).toFixed(3)} → ${Math.min(...last.post.filter(x => x < 4.999)).toFixed(3)}`);
}

// ---------------------------------------------------------------------
// 11. 최대 중첩 회복: 12중첩이면 입힌 피해(체력+보호막에 실제로 들어간 양)의 8%. 11→12 타격은 회복 없음.
//     점화 틱도 회복하지만 점화로는 중첩을 얻지 않음. 과다출혈도 회복하지만 중첩은 얻지 않음
// ---------------------------------------------------------------------
{ const w = mkD('darius'), p = P(w), d = w.dummies[0];
  p.hp = p.stats.maxHp - 300; p.conq = [5, 5, 5, 5, 5, 5];
  Core.step(w, [inp('p1', 0, 0, true)]);
  let res = null;
  for (let i = 0; i < 2000 && !res; i++) {
    const hd = d.hp, hp = p.hp;
    Core.step(w, [inp('p1', 0, 0, false)]);
    if (p.atk && p.atk.hit) res = { dealt: hd - d.hp, healed: p.hp - hp };
  }
  p.lock = null;
  ok('11 12중첩 평타: 입힌 피해의 8% 회복', !!res && res.dealt > 0 && near(res.healed, 0.08 * res.dealt, 0.01), res && `${res.dealt.toFixed(2)} → +${res.healed.toFixed(3)}`);
}
{ const w = mkD('garen'), p = P(w), d = w.dummies[0];        // 가렌: 과다출혈이 없어서 이 타격의 피해는 평타 한 번뿐
  p.hp = p.stats.maxHp - 300; p.conq = [5, 5, 5, 5, 5];           // 10중첩: 이 타격에서 12가 됨
  Core.step(w, [inp('p1', 0, 0, true)]);
  let res = null;
  for (let i = 0; i < 2000 && !res; i++) {
    const hd = d.hp, hp = p.hp;
    Core.step(w, [inp('p1', 0, 0, false)]);
    if (p.atk && p.atk.hit) res = { dealt: hd - d.hp, healed: p.hp - hp };
  }
  p.lock = null;
  ok('11 11→12 타격: 회복 없음(타격 전 중첩 기준), 이후 12중첩', !!res && res.dealt > 0 && near(res.healed, 0, 1e-9) && Core.conqStacks(p) === 12, res && `+${res.healed}, 중첩 ${Core.conqStacks(p)}`);
  steps(w, ticks(1.5));                                            // 첫 평타의 쿨타임이 끝날 때까지 기다림
  Core.step(w, [inp('p1', 0, 0, true)]);                           // 다음 평타(12중첩)부터는 회복
  const second = p.atk;
  res = null;
  for (let i = 0; i < 2000 && !res; i++) {
    const hd = d.hp, hp = p.hp;
    Core.step(w, [inp('p1', 0, 0, false)]);
    if (p.atk && p.atk !== second && p.atk.hit) res = { dealt: hd - d.hp, healed: p.hp - hp };
  }
  p.lock = null;
  ok('11 12중첩이 된 다음 타격부터 8% 회복', !!res && res.dealt > 0 && near(res.healed, 0.08 * res.dealt, 0.01), res && `${res.dealt.toFixed(2)} → +${res.healed.toFixed(3)}`);
}
{ const w = mkD('darius'), p = P(w), d = w.dummies[0];
  p.hp = p.stats.maxHp - 300; p.conq = [5, 5, 5, 5, 5, 5];
  Core.step(w, [cmd('spell', 'p1', { spell: 'ignite' })]);
  const hp0 = p.hp, d0 = d.hp;
  steps(w, ticks(1.02));
  const dealt = d0 - d.hp;
  ok('11 점화 틱도 12중첩이면 회복 8%', dealt > 30 && near(p.hp - hp0, 0.08 * dealt, 0.01), `점화 피해 ${dealt.toFixed(2)} → +${(p.hp - hp0).toFixed(3)}`);
  ok('11 점화로는 중첩을 얻지 않음', p.conq.length === 6, p.conq.length);
}
{ const w = mkD('darius'), p = P(w), d = w.dummies[0];
  p.conq = [];
  Core.step(w, [cmd('spell', 'p1', { spell: 'ignite' })]);
  steps(w, ticks(1.02));
  ok('11 점화 피해만으로는 중첩 0 (빈 상태에서 점화)', p.conq.length === 0, p.conq.length);
}
{ const w = mkD('darius'), p = P(w), d = w.dummies[0];
  p.conq = [];
  d.bleed = { stacks: 5, t: 5, total: 100, acc: 0, txtT: 0, src: 'p1', pen: 0 };   // 과다출혈 5초 100
  steps(w, ticks(1.0));
  ok('11 과다출혈 피해로는 중첩을 얻지 않음', p.conq.length === 0, p.conq.length);
}
{ const w = mkD('darius'), p = P(w), d = w.dummies[0];
  p.hp = p.stats.maxHp - 300; p.conq = [5, 5, 5, 5, 5, 5];
  d.bleed = { stacks: 5, t: 5, total: 100, acc: 0, txtT: 0, src: 'p1', pen: 0 };
  const hp0 = p.hp, d0 = d.hp;
  steps(w, ticks(1.0));
  const dealt = d0 - d.hp;
  ok('11 과다출혈 피해도 12중첩이면 8% 회복', dealt > 15 && near(p.hp - hp0, 0.08 * dealt, 0.01), `출혈 ${dealt.toFixed(2)} → +${(p.hp - hp0).toFixed(3)}`);
}

// ---------------------------------------------------------------------
// 12. 얻지 않는 경우: 포탑 평타 → 중첩 없음. 마스터 이 → 정복자 없음. runes:false → 전부 없음
// ---------------------------------------------------------------------
{ const { w, t } = mkTurret('darius'), p = P(w);
  const hit = strike(w, p);
  ok('12 포탑 평타: 적중했는데 중첩 없음', hit && t.hp < t.maxHp && p.conq.length === 0, `포탑 ${t.hp}/${t.maxHp}`);
}
{ const w = mkD('yi'), p = P(w);
  strike(w, p);
  ok('12 마스터 이 평타: 정복자 중첩 없음(칼날비 룬)', p.conq.length === 0 && Core.runeOf(w, p) === 'lethalTempo');
}
{ const w = mkD('darius', { runes: false }), p = P(w), d = w.dummies[0];
  strike(w, p);
  ok('12 runes:false: 룬 이름 null, 중첩 없음, 추가 공격력 0, 출혈 총량은 기본(18)', Core.runeOf(w, p) === null && p.conq.length === 0 && Core.bonusAD(p) === 0 && near(d.bleed.total, 18, 1e-9), `${Core.bonusAD(p)} / ${d.bleed && d.bleed.total}`);
}
{ const w = mkD('yi', { runes: false }), p = P(w);
  Core.step(w, [inp('p1', 0, 0, true)]); Core.step(w, [inp('p1', 0, 0, false)]);
  steps(w, ticks(1));
  ok('12 runes:false: 마스터 이 칼날비 번호 없음(n 0, max 3)', Core.runeOf(w, p) === null && p.lt.n === 0 && p.lt.max === 3 && !(p.atk && p.atk.lt));
}

// ---------------------------------------------------------------------
// 13. 칼날비 간격: 공속 1.0 → 강화 1.9. 1·2번 간격 1/강화, 3→4번 간격 1/원래(묶음 마지막), 4·5번 다시 1/강화. 선딜 = WINDUP/강화
// ---------------------------------------------------------------------
{ const w = mkD('yi'), p = P(w);
  ok('13 강화 공속 = 기본 × (1 + 추가 공속 + 90%) (L2)', near(Core.ltAS(p), ltFormula(p), 1e-12) && Core.ltAS(p) > Core.curAS(p), `${Core.curAS(p).toFixed(4)} → ${Core.ltAS(p).toFixed(4)}`);
  const LT = 1 / Core.ltAS(p), CUR = 1 / Core.curAS(p);
  const rec = newRec();
  track(w, p, rec, [inp('p1', 0, 0, true)]);
  track(w, p, rec, [inp('p1', 0, 0, false)]);
  for (let i = 0; i < ticks(5) && rec.starts.length < 5; i++) track(w, p, rec);
  const s = rec.starts;
  ok('13 평타 5번 시작의 강화 번호 1,2,3,1,2', s.length >= 5 && s.slice(0, 5).map(x => x.lt).join(',') === '1,2,3,1,2', s.map(x => x.lt).join(','));
  ok('13 대기시간: 1번·2번·4번 = 1/강화 공속, 3번(묶음 마지막) = 1/원래 공속', s.length >= 5 && near(s[0].cd, LT, 1e-9) && near(s[1].cd, LT, 1e-9) && near(s[2].cd, CUR, 1e-9) && near(s[3].cd, LT, 1e-9), s.slice(0, 4).map(x => x.cd.toFixed(4)).join(' '));
  ok('13 간격: 1→2 · 2→3 = 1/강화, 3→4 = 1/원래, 4→5 = 1/강화 (±1틱)',
    s.length >= 5 && near(s[1].t - s[0].t, LT, TICK + 1e-9) && near(s[2].t - s[1].t, LT, TICK + 1e-9) && near(s[3].t - s[2].t, CUR, TICK + 1e-9) && near(s[4].t - s[3].t, LT, TICK + 1e-9),
    s.length >= 5 ? [s[1].t - s[0].t, s[2].t - s[1].t, s[3].t - s[2].t, s[4].t - s[3].t].map(x => x.toFixed(3)).join(' ') : 'short');
  ok('13 선딜·후딜 길이 = 강화 공속 기준 (WINDUP/강화, BACKSWING/강화)', near(s[0].wind, Core.WINDUP * LT, 1e-9) && near(s[0].back, Core.BACKSWING * LT, 1e-9), `${s[0].wind.toFixed(4)} ${s[0].back.toFixed(4)}`);
}

// ---------------------------------------------------------------------
// 14. 칼날비 3초 제한: 1번 평타 뒤 3초가 넘게 쉼 → 효과 사라짐, 다음 평타는 새 묶음 1번(n=1)
// ---------------------------------------------------------------------
{ const w = mkD('yi'), p = P(w);
  const rec = newRec();
  track(w, p, rec, [inp('p1', 0, 0, true)]);
  track(w, p, rec, [inp('p1', 0, 0, false)]);
  let g = 0; while (rec.hits.length < 1 && g++ < ticks(2)) track(w, p, rec);
  p.lock = null;                                       // 고정 해제: 더 치지 않음
  ok('14 1번 적중 뒤 묶음 진행 중(n=1)', rec.hits.join(',') === '1' && p.lt.n === 1, `n=${p.lt.n}`);
  steps(w, ticks(2.5));
  ok('14 2.5초 쉼: 아직 묶음 진행 중(n=1)', p.lt.n === 1, `n=${p.lt.n}, idle=${p.lt.idle.toFixed(3)}`);
  steps(w, ticks(0.8));
  ok('14 3초 넘게 쉼: 효과 사라짐(n=0, max=3)', p.lt.n === 0 && p.lt.max === 3, `n=${p.lt.n} max=${p.lt.max}`);
  const rec2 = newRec();
  track(w, p, rec2, [inp('p1', 0, 0, true)]);
  ok('14 다음 평타는 새 묶음 1번(n=1, 번호 1)', !!p.atk && p.atk.lt === 1 && p.lt.n === 1, `lt=${p.atk && p.atk.lt}, n=${p.lt.n}`);
}

// ---------------------------------------------------------------------
// 15. 칼날비 환급: 2번째 평타 선딜을 조이스틱으로 취소 → 강화 횟수 4 → 적중한 강화 평타가 3번 나온 뒤 원래 쿨타임
// ---------------------------------------------------------------------
{ const w = mkD('yi'), p = P(w);
  const LT = 1 / Core.ltAS(p), CUR = 1 / Core.curAS(p);
  const rec = newRec();
  track(w, p, rec, [inp('p1', 0, 0, true)]);
  track(w, p, rec, [inp('p1', 0, 0, false)]);
  let g = 0;
  while (!(p.atk && p.atk.lt === 2 && !p.atk.hit) && g++ < ticks(3)) track(w, p, rec);
  ok('15 준비: 2번째 강화 평타 선딜 중', !!p.atk && p.atk.lt === 2 && !p.atk.hit);
  track(w, p, rec, [inp('p1', 1, 0, false)]);         // 조이스틱 → 선딜 취소 (고정도 풀림)
  ok('15 선딜 취소 → 강화 횟수 +1 (max 4), 대기시간 0', p.atk === null && p.lt.max === 4 && p.atkCd === 0, `max=${p.lt.max}, atkCd=${p.atkCd}`);
  track(w, p, rec, [inp('p1', 0, 0, false)]);
  track(w, p, rec, [inp('p1', 0, 0, true)]);         // 다시 누름: 3번째 강화 평타
  g = 0; while (rec.starts.length < 5 && g++ < ticks(5)) track(w, p, rec, [inp('p1', 0, 0, false)]);
  const s = rec.starts;
  ok('15 평타 시작 번호: 1, 2(취소), 3, 4(묶음 마지막), 다음 묶음 1', s.length >= 5 && s.slice(0, 5).map(x => x.lt).join(',') === '1,2,3,4,1', s.map(x => x.lt).join(','));
  ok('15 적중한 강화 평타는 1·3·4번째 3번, 그 뒤 4번째는 원래 쿨타임', rec.hits.slice(0, 3).join(',') === '1,3,4' && s.length >= 5 && near(s[3].cd, CUR, 1e-9) && near(s[2].cd, LT, 1e-9), `hits ${rec.hits.join(',')} / cd ${s.length >= 5 ? s[2].cd.toFixed(3) + ' ' + s[3].cd.toFixed(3) : '-'}`);
}
// 15b. 후딜 취소(이미 맞음)는 환급 없음
{ const w = mkD('yi'), p = P(w);
  const rec = newRec();
  track(w, p, rec, [inp('p1', 0, 0, true)]);
  track(w, p, rec, [inp('p1', 0, 0, false)]);
  let g = 0; while (rec.hits.length < 1 && g++ < ticks(2)) track(w, p, rec);
  track(w, p, rec, [inp('p1', 1, 0, false)]);        // 후딜 중 조이스틱
  ok('15 후딜 취소는 환급 없음(max 3 그대로), 평타는 끝남', p.lt.max === 3 && p.atk === null, `max=${p.lt.max}`);
}

// ---------------------------------------------------------------------
// 16. 포탑 평타는 칼날비 없음 (번호·묶음 변화 없음)
// ---------------------------------------------------------------------
{ const { w, t } = mkTurret('yi'), p = P(w);
  strike(w, p);
  ok('16 포탑 평타 적중, 칼날비 번호·묶음 변화 없음', t.hp < t.maxHp && p.lt.n === 0 && p.lt.max === 3 && !(p.atk && p.atk.lt), `n=${p.lt.n} max=${p.lt.max}`);
}

// ---------------------------------------------------------------------
// Q6. 부활: 정복자·칼날비 상태는 죽으면 사라지고 부활하면 처음부터
// ---------------------------------------------------------------------
{ const w = mkD('darius'), p = P(w);
  p.conq = [5, 5]; p.dead = true; p.respawn = 0.05;
  steps(w, ticks(0.1));
  ok('Q6 부활하면 정복자 중첩 0', !p.dead && p.conq.length === 0 && p.lt.n === 0, JSON.stringify(p.conq));
}

// ---------------------------------------------------------------------
// 17. 스냅숏·결정성: 룬 상태가 스냅숏에 실리고, 같은 입력은 같은 결과. JSON으로 복원해도 이어서 같은 결과
// ---------------------------------------------------------------------
const script = {
  0: [inp('p1', 0, 0, true)], 2: [inp('p1', 0, 0, false)],
  120: [cmd('cast', 'p1', { skill: 'w', ang: 0 })],
  200: [inp('p1', 0, 0, true)], 204: [inp('p1', 0, 0, false)],
  330: [inp('p1', -1, 0, false)], 335: [inp('p1', 0, 0, false)],
  360: [cmd('cast', 'p1', { skill: 'q', ang: 0 })],
  500: [inp('p1', 0, 0, true)], 504: [inp('p1', 0, 0, false)],
  700: [cmd('spell', 'p1', { spell: 'ignite' })],
};
const playScript = (n) => {
  const w = mkDuel('darius', 'yi');
  place(w, 100);
  for (let i = 0; i < n; i++) Core.step(w, script[i] || []);
  return w;
};
{ const a = playScript(1000), b = playScript(1000);
  ok('17 같은 입력 1000틱 → 월드 JSON 동일', JSON.stringify(a) === JSON.stringify(b));
  const snap = Protocol.slimWorld(a);
  ok('17 스냅숏: 정복자 중첩(conq 배열)과 룬 설정이 실림', Array.isArray(snap.champs[0].conq) && snap.runes === true, JSON.stringify(snap.champs[0].conq));
  ok('17 스냅숏: 칼날비 상태(lt)가 실림', !!snap.champs[1].lt && typeof snap.champs[1].lt.n === 'number', JSON.stringify(snap.champs[1].lt));
  ok('17 시나리오가 실제로 일어남(정복자 중첩을 얻고 상대가 맞음)', a.champs[0].conqTick >= 0 && E(a).hp < E(a).stats.maxHp);
}
{ const w = playScript(600);
  const restored = Protocol.restoreWorld(JSON.parse(JSON.stringify(Protocol.slimWorld(w))));
  const cont = (x, from) => { for (let i = from; i < from + 600; i++) Core.step(x, script[i] || []); return x; };
  const left = cont(w, 600), right = cont(restored, 600);
  ok('17 스냅숏을 JSON으로 복원해도 이어서 같은 결과', JSON.stringify(Protocol.slimWorld(left)) === JSON.stringify(Protocol.slimWorld(right)));
}

const total = pass + fail;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) throw new Error(`${fail} of ${total} checks failed`);
