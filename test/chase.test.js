/* =====================================================================
   평타 자동 추적 규칙 테스트 (docs/spec/attack-chase.md)
   - 평타 버튼을 눌렀을 때 사거리 안에 대상이 없으면 가장 가까운 챔피언(없으면 더미)을 찾아 이동하고,
     사거리 안에 들어오면 평타를 칩니다. 조이스틱 입력·성공한 스킬 시전 등으로 취소됩니다.
   - 6레벨 기준. 포탑은 격리(죽은 상태), 자연 회복은 끔. 거리 단위는 유닛(히트박스 끝 기준).
   ===================================================================== */
const Core = require('../shared/core.js');
const fs = require('fs'), path = require('path');
Core.setMap(JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/walk_rle.json'), 'utf8')));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  → ' + extra : '')); };
const near = (a, b, e = 0.01) => Math.abs(a - b) <= e;
const px = Core.px, TICK = Core.TICK, CHASE = Core.CHASE;
const ticks = sec => Math.round(sec / TICK);
const cmd = (type, id, extra) => Object.assign({ type, id }, extra || {});
const inp = (id, mx, my, atk) => cmd('input', id, { mx, my, atk: !!atk });
const press = (w, id) => Core.step(w, [inp(id, 0, 0, true)]);          // 평타 버튼 누름(상승 에지)
const run = (w, n, cmds) => { for (let i = 0; i < n; i++) Core.step(w, i === 0 ? cmds : []); };
const quiet = c => { c.stats.regen = 0; c.stats.manaRegen = 0; };
const gap = (a, b) => Core.edgeDist(a, b) / px(1);                       // 두 히트박스 사이 거리(유닛)
const evsOf = w => Core.drainEvents(w);
const atkFx = evs => evs.filter(e => e.type === 'fx' && e.fx === 'atkRange');
const DEF_PLAYERS = [{ id: 'p1', key: 'darius', team: 0 }, { id: 'e1', key: 'yi', team: 1 }];
// 포탑 격리(죽은 상태), 챔피언 자연 회복 끔
function mk(opts) {
  const w = Core.createWorld(Object.assign({ players: DEF_PLAYERS, dummy: false }, opts || {}));
  w.turrets.forEach(t => { t.dead = true; });
  w.champs.forEach(quiet);
  return w;
}
const P = w => w.champs.find(c => c.id === 'p1');
const E = w => w.champs.find(c => c.id === 'e1');
const D = w => w.dummies[0];
// p를 (600, 500)에 두고, e를 오른쪽에 두어 두 히트박스 사이 거리가 dist 유닛이 되게 함(이 줄은 걸을 수 있는 곳)
function placeRight(w, dist) { const p = P(w), e = E(w); p.x = 600; p.y = 500; e.x = p.x + px(dist + 55 + 55); e.y = p.y; }

// ---------------------------------------------------------------------
// (a) 사거리 밖 평타 → 가장 가까운 챔피언 추적 → 사거리 안에서 평타, 추적 해제
// ---------------------------------------------------------------------
{ const w = mk(); placeRight(w, 600); const p = P(w), e = E(w);
  press(w, 'p1');
  ok('a 평타 누름(대상 600 유닛) → 추적 대상 e1', !!p.chase && p.chase.targetId === 'e1', JSON.stringify(p.chase));
  const full = px(p.stats.ms) * TICK;          // 한 틱에 가는 거리 = 이속 × 1/60초
  let n = 0, allFull = true, decreasing = true, prev = gap(p, e);
  while (p.chase && n < ticks(3)) {
    const x0 = p.x, y0 = p.y;
    Core.step(w, []); n++;
    if (p.chase && Math.abs(Math.hypot(p.x - x0, p.y - y0) - full) > 1e-6) allFull = false;
    const g = gap(p, e); if (g > prev + 1e-9) decreasing = false; prev = g;
  }
  ok('a 추적 중 매 틱 이동 거리 = 이속 × 1/60초', allFull && n > 10, `${n}틱`);
  ok('a 추적 중 대상과의 거리가 매 틱 줄어듦', decreasing);
  ok('a 사거리(175) 안에 들어오면 추적 해제 + 대상에게 평타 시작', !p.chase && !!p.atk && p.atk.targetId === 'e1');
  ok('a 평타 시작 거리는 사거리 안(한 걸음 이내)', gap(p, e) <= 175 + 1e-6 && gap(p, e) > 175 - full / px(1) - 1e-6, gap(p, e).toFixed(2));
  run(w, ticks(0.5), []);
  ok('a 대상이 사거리 안이면 평타 끝난 뒤에도 추적이 다시 붙지 않음', !p.chase);
}

// ---------------------------------------------------------------------
// (b) 사거리 표시(atkRange fx): 평타 버튼을 누른 순간(상승 에지)에만, 내 챔피언 것으로
// ---------------------------------------------------------------------
{ const w = mk({ players: [{ id: 'p1', key: 'darius', team: 0 }], dummy: false });   // 적이 아예 없음
  P(w).x = 600; P(w).y = 500;
  press(w, 'p1');
  const f = atkFx(evsOf(w));
  ok('b 대상 없이 누른 순간 atkRange fx 1개 (owner p1, life 0.6)', f.length === 1 && f[0].owner === 'p1' && f[0].life === 0.6, JSON.stringify(f));
  run(w, ticks(0.5), []);
  ok('b 누르고 있기만 하면 fx가 다시 나오지 않음', atkFx(evsOf(w)).length === 0);
}
{ const w = mk(); placeRight(w, 600); press(w, 'p1');
  const f = atkFx(evsOf(w));
  ok('b 대상을 찾아 추적을 시작해도 fx 1개 (owner p1)', f.length === 1 && f[0].owner === 'p1');
}
{ const w = mk(); placeRight(w, 100); press(w, 'p1');
  ok('b 사거리 안에 대상이 이미 있으면 fx 없음(바로 평타)', atkFx(evsOf(w)).length === 0 && !!P(w).atk);
}

// ---------------------------------------------------------------------
// (c) 챔피언 우선 · 챔피언 없으면 더미 (연습 모드)
// ---------------------------------------------------------------------
{ const w = mk({ dummy: true }); const p = P(w), e = E(w), d = D(w);
  p.x = 600; p.y = 500;
  d.x = p.x - px(300 + 70 + 55); d.y = 500;       // 더미: 300 유닛 왼쪽 (가까움)
  e.x = p.x + px(800 + 55 + 55); e.y = 500;       // 챔피언: 800 유닛 오른쪽 (멂)
  press(w, 'p1');
  ok('c 더미(300)보다 챔피언(800)을 우선', !!p.chase && p.chase.targetId === 'e1', JSON.stringify(p.chase));
  ok('c Core.chaseTarget도 챔피언을 고름', Core.chaseTarget(w, p) === e);
}
{ const w = mk({ dummy: true }); const p = P(w), e = E(w), d = D(w);
  p.x = 600; p.y = 500;
  d.x = p.x - px(300 + 70 + 55); d.y = 500;       // 더미: 300 유닛 왼쪽
  e.x = p.x + px(1300 + 55 + 55); e.y = 500;     // 챔피언: 1300 유닛 (찾는 거리 1200 밖)
  press(w, 'p1');
  ok('c 챔피언이 1200 밖이면 더미를 추적', !!p.chase && p.chase.targetId === 'dummy1', JSON.stringify(p.chase));
  let g = 0; while (D(w).total <= 0 && g++ < ticks(4)) Core.step(w, []);
  ok('c 더미 추적 → 평타로 더미가 맞음', D(w).total > 0, D(w).total.toFixed(1));
}
{ const w = mk({ players: [{ id: 'p1', key: 'darius', team: 0 }], dummy: true });   // 적 챔피언이 아예 없음
  const p = P(w), d = D(w);
  p.x = 600; p.y = 500; d.x = p.x - px(300 + 70 + 55); d.y = 500;
  press(w, 'p1');
  ok('c 적 챔피언이 없으면 더미를 추적(연습 모드)', !!p.chase && p.chase.targetId === 'dummy1');
}
{ // 포탑은 추적 대상이 아님 (살아 있는 적 포탑이 가까이 있어도)
  const w = Core.createWorld({ players: [{ id: 'p1', key: 'darius', team: 0 }], dummy: false });
  const p = P(w), t = w.turrets.find(u => u.team === 1);
  p.x = t.x - px(400 + 175 + 55); p.y = t.y;
  press(w, 'p1');
  ok('c 살아 있는 적 포탑은 추적 대상이 아님', p.chase === null && evsOf(w).some(e => e.type === 'text' && e.txt === '사거리 내 대상 없음'));
}

// ---------------------------------------------------------------------
// (d) 1200 안에 대상이 없으면 추적 없음 · "사거리 내 대상 없음" 텍스트
// ---------------------------------------------------------------------
{ const w = mk({ dummy: true }); const p = P(w), e = E(w), d = D(w);
  p.x = 600; p.y = 500;
  d.x = p.x - px(1300 + 70 + 55); d.y = 500;     // 더미도 1200 밖
  e.x = p.x + px(1300 + 55 + 55); e.y = 500;     // 챔피언도 1200 밖
  press(w, 'p1');
  const evs = evsOf(w);
  ok('d 1200 안에 대상이 없으면 추적 없음 · 평타 없음', p.chase === null && !p.atk);
  ok('d "사거리 내 대상 없음" 텍스트(본인에게)', evs.some(x => x.type === 'text' && x.txt === '사거리 내 대상 없음' && x.to === 'p1'));
  ok('d 대상이 없어도 사거리 표시는 나옴', atkFx(evs).length === 1);
}

// ---------------------------------------------------------------------
// (e) 취소: 조이스틱 입력 · 성공한 스킬 시전 (실패한 시전과 레벨업은 취소하지 않음)
// ---------------------------------------------------------------------
{ const w = mk(); placeRight(w, 600); const p = P(w);
  press(w, 'p1'); run(w, ticks(0.2), []);
  ok('e 추적 중(0.2초 뒤)', !!p.chase);
  Core.step(w, [inp('p1', -1, 0, true)]);        // 왼쪽 조이스틱 (평타 버튼은 계속 누르고 있음)
  ok('e 조이스틱 입력 → 추적 취소', p.chase === null);
  let restarted = false;
  for (let i = 0; i < ticks(0.5); i++) { Core.step(w, []); if (p.chase) restarted = true; }
  ok('e 조이스틱을 쥔 채 평타를 누르고 있어도 다시 추적하지 않음', !restarted);
  Core.step(w, [inp('p1', 0, 0, true)]);         // 조이스틱을 놓음, 평타는 여전히 누르고 있음
  run(w, ticks(0.5), []);
  ok('e 취소 뒤 평타를 누르고 있는 동안에는 재추적 없음(버튼을 떼야 함)', !p.chase);
  Core.step(w, [inp('p1', 0, 0, false)]);        // 평타를 뗌
  Core.step(w, [inp('p1', 0, 0, true)]);         // 다시 누름
  ok('e 평타를 떼었다 다시 누르면 추적 시작', !!p.chase && p.chase.targetId === 'e1');
}
{ const w = mk(); placeRight(w, 600); const p = P(w);
  press(w, 'p1'); run(w, ticks(0.2), []);
  Core.step(w, [cmd('levelup', 'p1', { skill: 'q' })]);
  ok('e 레벨업은 추적을 취소하지 않음', !!p.chase && p.sk.q === 1);
}
{ const w = mk(); placeRight(w, 600); const p = P(w);   // 다리우스 E 성공
  p.sk.e = 1; p.mana = p.stats.maxMana;
  press(w, 'p1'); run(w, ticks(0.2), []);
  Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]);
  ok('e 다리우스 E 성공 → 추적 취소 · 포획 시전 시작', p.chase === null && !!p.cast && p.cast.type === 'e');
  run(w, ticks(0.5), []);
  ok('e E 뒤 평타 버튼을 누르고 있어도 취소된 추적은 되살아나지 않음', p.chase === null);
}
{ const w = mk({ players: [{ id: 'p1', key: 'yi', team: 0 }, { id: 'e1', key: 'darius', team: 1 }] }); placeRight(w, 600); const p = P(w);
  p.sk.r = 1; p.mana = p.stats.maxMana;          // 마스터 이 R 성공
  press(w, 'p1'); run(w, ticks(0.2), []);
  Core.step(w, [cmd('cast', 'p1', { skill: 'r' })]);
  ok('e 마스터 이 R 성공 → 추적 취소 · 최후의 전사 시작', p.chase === null && p.hl > 0);
}
{ const w = mk(); placeRight(w, 600); const p = P(w);   // 쿨타임 중 E: 실패 → 추적 유지
  p.sk.e = 1; p.mana = p.stats.maxMana; p.cd.e = 5;
  press(w, 'p1'); run(w, ticks(0.2), []);
  Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]);
  ok('e 쿨타임 중 E 실패 → 추적 유지', !!p.chase && p.chase.targetId === 'e1' && p.cast === null);
}
{ const w = mk(); placeRight(w, 600); const p = P(w);   // 마나 부족 E: 실패 → 추적 유지
  p.sk.e = 1; p.mana = 0;
  press(w, 'p1'); run(w, ticks(0.2), []);
  Core.step(w, [cmd('cast', 'p1', { skill: 'e', ang: 0 })]);
  ok('e 마나 부족 E 실패 → 추적 유지', !!p.chase && p.cast === null);
}
{ const w = mk(); placeRight(w, 600); const p = P(w);   // 사거리(525) 안 대상 없는 R: 실패 → 추적 유지
  p.sk.r = 1; p.mana = p.stats.maxMana;
  press(w, 'p1'); run(w, ticks(0.2), []);
  Core.step(w, [cmd('cast', 'p1', { skill: 'r', ang: 0 })]);
  ok('e 대상 없는 R 실패 → 추적 유지', !!p.chase && p.cast === null);
}

// ---------------------------------------------------------------------
// (f) 취소: 대상이 대상 지정 불가(마스터 이 일격필살) · 대상이 죽음 · 내가 죽음(부활 후에도 추적 없음)
// ---------------------------------------------------------------------
{ const w = mk(); placeRight(w, 550); const p = P(w), e = E(w);
  e.sk.q = 1; e.mana = e.stats.maxMana; e.cd.q = 0;
  press(w, 'p1'); run(w, ticks(0.1), []);
  Core.step(w, [cmd('cast', 'e1', { skill: 'q', ang: 0 })]);   // 상대 마스터 이가 일격필살 → 대상 지정 불가
  ok('f 대상이 대상 지정 불가가 되면 추적 취소', e.untarget === true && p.chase === null);
  run(w, ticks(0.4), []);                         // 일격필살 등장(0.9초) 전
  ok('f 대상 지정 불가 동안 다른 대상이 없으면 추적 없음', p.chase === null && !p.atk && e.untarget === true);
}
{ const w = mk(); placeRight(w, 600); const p = P(w), e = E(w);
  press(w, 'p1'); run(w, ticks(0.2), []);
  e.dead = true; e.respawn = 5;                   // 대상이 죽음
  Core.step(w, []);
  ok('f 대상이 죽으면 추적 취소', p.chase === null);
}
{ const w = mk(); placeRight(w, 600); const p = P(w);
  press(w, 'p1'); run(w, ticks(0.2), []);
  p.hp = 1; p.bleed = { stacks: 5, t: 5, total: 5000, acc: 0, txtT: 0, src: 'e1', pen: 0 };   // 과다출혈로 내가 죽음
  Core.step(w, []);
  ok('f 내가 죽으면 추적 취소', p.dead && p.chase === null);
  Core.step(w, [inp('p1', 0, 0, false)]);         // 부활까지 평타 버튼을 뗌
  run(w, ticks(6), []);
  ok('f 부활 후 추적 없음', !p.dead && p.chase === null);
}

// ---------------------------------------------------------------------
// (g) 둔화는 추적 이동에도 적용: 한 틱 이동 = 이속 × (1 - 둔화) × 1/60초
// ---------------------------------------------------------------------
{ const w = mk(); placeRight(w, 600); const p = P(w);
  p.slow = { pct: 0.4, t: 100 };
  press(w, 'p1');
  const x0 = p.x, y0 = p.y; Core.step(w, []);
  const moved = Math.hypot(p.x - x0, p.y - y0);
  ok('g 둔화 40%: 한 틱 이동 = 이속 × 0.6 × 1/60초', near(moved, px(p.stats.ms) * 0.6 * TICK, 1e-6), moved.toFixed(4));
}

// ---------------------------------------------------------------------
// (h) 누르고 있기: 첫 평타 뒤에도 계속 평타 · 대상이 사거리 밖으로 나가면 누르고 있는 동안 추적 재개
// ---------------------------------------------------------------------
{ const w = mk(); placeRight(w, 600); const p = P(w), e = E(w);
  press(w, 'p1');
  let attacks = 0, seen = null, g = 0, chaseAtFirst = 'unset';
  while (attacks < 2 && g++ < ticks(10)) {
    Core.step(w, []);
    if (p.atk && p.atk !== seen) { seen = p.atk; attacks++; if (attacks === 1) chaseAtFirst = p.chase; }
  }
  ok('h 첫 평타가 시작되면 추적은 해제됨', attacks >= 1 && chaseAtFirst === null);
  while (attacks < 4 && g++ < ticks(10)) {
    Core.step(w, []);
    if (p.atk && p.atk !== seen) { seen = p.atk; attacks++; }
  }
  ok('h 계속 누르고 있으면 사거리 안의 대상에게 평타가 계속 나감', attacks >= 4, `${attacks}회`);
  ok('h 그동안 추적은 다시 붙지 않음', !p.chase);
  const hpBefore = e.hp; run(w, ticks(0.3), []);
  e.x = p.x + px(600 + 55 + 55); e.y = p.y;      // 대상이 600 유닛 밖으로 빠져나감 (버튼은 계속 누르고 있음)
  let g2 = 0; while (!p.chase && g2++ < ticks(2.5)) Core.step(w, []);
  ok('h 누르고 있는 채로 대상이 나가면 추적 재개', !!p.chase && p.chase.targetId === 'e1', `${(g2 * TICK).toFixed(2)}초 뒤`);
}

// ---------------------------------------------------------------------
// (j) 추적 포기: 대상이 search + 300(1500) 유닛보다 멀어지면 취소, 그 이내면 유지. 찾는 거리 상수
// ---------------------------------------------------------------------
{ const w = mk(); placeRight(w, 1100); const p = P(w), e = E(w);
  ok('j 찾는 거리 CHASE.search = 1200', CHASE.search === 1200);
  press(w, 'p1'); run(w, ticks(0.1), []);
  e.x = p.x + px(1400 + 55 + 55); e.y = p.y;    // 1400 유닛: 아직 포기 전
  Core.step(w, []);
  ok('j 대상이 1400 유닛이어도 추적 유지', !!p.chase);
  e.x = p.x + px(1600 + 55 + 55); e.y = p.y;    // 1600 유닛: 포기
  Core.step(w, []);
  ok('j 대상이 1500 유닛을 넘으면 추적 포기', p.chase === null);
}

// ---------------------------------------------------------------------
// (k) 다리우스 W 강화 중에는 사거리 +25 (추적 판정도 같은 사거리)
// ---------------------------------------------------------------------
{ const w = mk(); placeRight(w, 190); const p = P(w);
  p.wBuff = true;                              // 175 < 190 ≤ 200
  press(w, 'p1');
  ok('k W 강화 중 사거리 200 → 추적 없이 바로 평타', p.chase === null && !!p.atk && p.atk.targetId === 'e1');
}
{ const w = mk(); placeRight(w, 190); const p = P(w);
  press(w, 'p1');
  ok('k W 없으면 사거리 175 밖 → 추적', !!p.chase && p.chase.targetId === 'e1');
}

// ---------------------------------------------------------------------
// (l) 명상 중 평타 버튼: 명상은 끊기고 추적은 정상 시작
// ---------------------------------------------------------------------
{ const w = mk({ players: [{ id: 'p1', key: 'yi', team: 0 }, { id: 'e1', key: 'darius', team: 1 }] }); placeRight(w, 600); const p = P(w);
  p.sk.w = 1; p.mana = p.stats.maxMana;
  Core.step(w, [cmd('cast', 'p1', { skill: 'w' })]);
  const meditating = !!p.med;
  press(w, 'p1');
  ok('l 명상 중 평타 버튼 → 명상 끊기고 추적 시작', meditating && !p.med && !!p.chase && p.chase.targetId === 'e1', `명상 시작=${meditating}`);
}

// ---------------------------------------------------------------------
// (i) 결정성: 같은 명령 스트림 → 같은 월드 JSON (추적·취소·스킬 포함)
// ---------------------------------------------------------------------
{ const script = {
    0: [inp('p1', 0, 0, true)],               // 평타 → 추적
    120: [inp('p1', -1, 0, true)],            // 조이스틱 왼쪽 → 취소
    150: [inp('p1', 0, 0, true)],             // 놓음 → 재추적
    300: [cmd('cast', 'p1', { skill: 'e', ang: 0 })],   // E 성공 → 취소
    400: [inp('p1', 0, 0, false)],            // 평타 버튼 뗌
    420: [inp('e1', -1, 0, false)],           // 상대가 뒤로 빠짐
    500: [inp('p1', 0, 0, true)],             // 다시 평타
    700: [inp('p1', 1, 0, false)],
  };
  const play = () => {
    const w = mk({ dummy: true });
    placeRight(w, 900); D(w).x = 265; D(w).y = 500;
    P(w).sk.e = 1; P(w).mana = P(w).stats.maxMana;
    let sawChase = false;
    for (let i = 0; i < 900; i++) { Core.step(w, script[i] || []); if (P(w).chase) sawChase = true; }
    return { w, sawChase };
  };
  const a = play(), b = play();
  ok('i 같은 명령 스트림 900틱 → 월드 JSON 동일', JSON.stringify(a.w) === JSON.stringify(b.w));
  ok('i 추적이 실제로 일어났음(추적 중 상태 있음, 대상 피해 있음)', a.sawChase && E(a.w).hp < E(a.w).stats.maxHp, E(a.w).hp.toFixed(1));
}


// ---------------------------------------------------------------------
// (j) 추적 중에는 쫓는 챔피언만 노림: 가는 길에 허수아비가 사거리에 들어와도 무시 (버튼 계속 누름)
// ---------------------------------------------------------------------
{ const w = mk({ dummy: true }); placeRight(w, 700); const p = P(w), e = E(w), d = D(w);
  d.x = p.x + px(55 + 70 + 300); d.y = p.y + px(60);   // 가는 길 옆(지나가며 사거리 175 안에 들어옴)
  let hitDummy = false, n = 0;
  while (n < ticks(4) && !(p.atk && p.atk.targetId === 'e1')) {
    Core.step(w, [inp('p1', 0, 0, true)]); n++;
    if (p.atk && p.atk.targetId !== 'e1') hitDummy = true;
  }
  ok('j 추적 중 길가의 허수아비를 치지 않음', !hitDummy);
  ok('j 결국 쫓던 챔피언에게 평타 시작', !!p.atk && p.atk.targetId === 'e1', n + '틱');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
