/* =====================================================================
   평타 선딜 취소 테스트 (DESIGN_RUNES C1~C5, 원문 docs/spec/runes.md)
   - C1: 선딜 취소 = 평타 없던 일. 피해 없음, 평타 대기시간 0(곧바로 다시 평타). 모든 취소는 cancelWindup을 지남
   - C2: 취소 원인 = 조이스틱, 성공한 스킬, 점멸, 공중·끌림(locked), 개발자 'air'. 점화·물약은 평타를 끊지 않음
   - C3: 조이스틱 선딜 취소: 평타를 시작할 때 이미 기울어 있었으면(joy0) 한 번 놓은 뒤부터, 아니면 처음부터 취소
   - C4: 후딜 중 조이스틱 → 후딜 끝, 대기시간은 그대로 흐름 (MOVE_CANCEL_BACKSWING)
   - C5: 취소된 틱에 바로 이동. 평타 고정은 조이스틱으로 풀림
   룬 끔(runes:false) 월드에서 검사: 칼날비·정복자 수치가 섞이지 않게 함
   ===================================================================== */
const Core = require('../shared/core.js');
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

// 나(p1, 팀0)와 상대(e1, 팀1) 1:1, 포탑 격리, 자연 회복 끔, 룬 끔. 나는 (600,500)
function mk(p1key, e1key) {
  const w = Core.createWorld({ players: [{ id: 'p1', key: p1key, team: 0 }, { id: 'e1', key: e1key, team: 1 }], dummy: false, runes: false });
  w.turrets.forEach(t => { t.dead = true; });
  w.champs.forEach(c => { c.stats.regen = 0; c.stats.manaRegen = 0; });
  const p = P(w); p.x = 600; p.y = 500;
  return w;
}
// 상대를 나와 gap 유닛(히트박스 끝 기준) 떨어진 오른쪽에 둠
const place = (w, gap) => { const p = P(w), e = E(w); e.x = p.x + px(gap + 110); e.y = p.y; };
const giveAll = c => { c.sk.q = 1; c.sk.w = 1; c.sk.e = 1; c.sk.r = 1; c.sp = 0; c.mana = c.stats.maxMana; };

// ---------------------------------------------------------------------
// 1. 선딜 중 조이스틱: 평타를 탭(조이스틱 없이 시작)한 뒤 조이스틱을 기울이면 취소
// ---------------------------------------------------------------------
{ const w = mk('darius', 'yi'), p = P(w), e = E(w);
  place(w, 100);
  Core.step(w, [inp('p1', 0, 0, true)]);             // 탭: 고정 + 평타 시작 (조이스틱 없음 → joy0 = false)
  Core.step(w, [inp('p1', 0, 0, false)]);
  ok('1 준비: 선딜 중(joy0 = false)', !!p.atk && !p.atk.hit && p.atk.joy0 === false);
  const hp0 = e.hp, x0 = p.x;
  Core.step(w, [inp('p1', -1, 0, false)]);           // 선딜 중 조이스틱
  ok('1 조이스틱으로 평타 취소: atk null, 대기시간 0', p.atk === null && p.atkCd === 0, `atkCd=${p.atkCd}`);
  ok('1 같은 틱에 이동', p.x < x0 - 1e-6, (x0 - p.x).toFixed(3));
  for (let i = 0; i < ticks(0.5); i++) Core.step(w, [inp('p1', -1, 0, false)]);
  ok('1 취소된 평타는 맞지 않음(선딜이 끝날 시간이 지나도 상대 체력 그대로)', e.hp === hp0, `${hp0} → ${e.hp}`);
}

// ---------------------------------------------------------------------
// 2. 조이스틱을 기울인 채 평타 시작(joy0): 계속 기울이면 취소 안 되고 맞음, 놓았다가 다시 기울이면 취소
// ---------------------------------------------------------------------
{ const w = mk('darius', 'yi'), p = P(w), e = E(w);
  place(w, 100);
  const hp0 = e.hp;
  Core.step(w, [inp('p1', 1, 0, true)]);            // 조이스틱을 쥔 채 평타 버튼: joy0 = true
  ok('2 준비: 기울인 채 시작(joy0 = true, joyFree = false)', !!p.atk && p.atk.joy0 === true && p.atk.joyFree === false);
  let g = 0;
  while (e.hp === hp0 && g++ < ticks(2)) Core.step(w, [inp('p1', 1, 0, false)]);   // 계속 기울인 채 기다림
  ok('2 계속 기울여도 취소되지 않고 맞음', e.hp < hp0, `${hp0} → ${e.hp}`);
}
{ const w = mk('darius', 'yi'), p = P(w), e = E(w);
  place(w, 100);
  Core.step(w, [inp('p1', 1, 0, true)]);            // joy0 = true로 시작
  Core.step(w, [inp('p1', 0, 0, true)]);            // 조이스틱을 놓음(버튼은 누른 채)
  ok('2 놓은 뒤에는 아직 취소되지 않음(joyFree)', !!p.atk && !p.atk.hit && p.atk.joyFree === true);
  Core.step(w, [inp('p1', 1, 0, false)]);           // 다시 기울임(버튼은 뗌)
  ok('2 놓았다가 다시 기울이면 취소, 대기시간 0', p.atk === null && p.atkCd === 0);
  const hp0 = e.hp;
  steps(w, ticks(0.6));
  ok('2 취소된 평타는 맞지 않음', e.hp === hp0);
}

// ---------------------------------------------------------------------
// 3. 선딜 중 스킬(다리우스 Q): 평타 피해 없음, 대기시간 0, Q는 나감
// ---------------------------------------------------------------------
{ const w = mk('darius', 'yi'), p = P(w), e = E(w);
  giveAll(p); place(w, 100);
  Core.step(w, [inp('p1', 0, 0, true)]); Core.step(w, [inp('p1', 0, 0, false)]);
  ok('3 준비: 선딜 중', !!p.atk && !p.atk.hit);
  const hp0 = e.hp;
  Core.step(w, [cmd('cast', 'p1', { skill: 'q', ang: 0 })]);
  ok('3 선딜 중 Q → 평타 취소, 대기시간 0, Q 준비 시작', p.atk === null && p.atkCd === 0 && p.qPrep !== null);
  steps(w, ticks(0.5));                              // 선딜(0.29초)은 지났지만 Q 준비(0.75초) 중
  ok('3 취소된 평타는 맞지 않음', e.hp === hp0, `${hp0} → ${e.hp}`);
}

// ---------------------------------------------------------------------
// 4. 점멸 → 선딜 취소(대기시간 0). 점화 → 선딜 유지(평타는 맞음)
// ---------------------------------------------------------------------
{ const w = mk('darius', 'yi'), p = P(w);
  place(w, 100);
  Core.step(w, [inp('p1', 0, 0, true)]); Core.step(w, [inp('p1', 0, 0, false)]);
  ok('4 준비: 선딜 중', !!p.atk && !p.atk.hit);
  const x0 = p.x;
  Core.step(w, [cmd('spell', 'p1', { spell: 'flash', ang: Math.PI, aimed: true })]);
  ok('4 점멸 → 선딜 취소, 대기시간 0, 실제로 이동', p.atk === null && p.atkCd === 0 && Math.abs(p.x - x0) > 1, `atkCd=${p.atkCd}, dx=${(p.x - x0).toFixed(1)}`);
}
{ const w = mk('darius', 'yi'), p = P(w), e = E(w);
  place(w, 100);
  Core.step(w, [inp('p1', 0, 0, true)]); Core.step(w, [inp('p1', 0, 0, false)]);
  const hp0 = e.hp;
  Core.step(w, [cmd('spell', 'p1', { spell: 'ignite' })]);
  ok('4 점화 → 선딜 유지(평타 그대로 진행), 점화 성공', !!p.atk && !p.atk.hit && e.ign !== null);
  let g = 0; while (e.hp === hp0 && g++ < ticks(0.6)) Core.step(w, []);
  ok('4 점화 뒤 선딜이 끝나 평타가 맞음', e.hp < hp0, `${hp0} → ${e.hp}`);
}

// ---------------------------------------------------------------------
// 5. 후딜 중 조이스틱: 후딜 끝(atk null), 같은 틱부터 이동, 대기시간은 그대로 흐름
// ---------------------------------------------------------------------
{ const w = mk('darius', 'yi'), p = P(w);
  place(w, 100);
  Core.step(w, [inp('p1', 0, 0, true)]); Core.step(w, [inp('p1', 0, 0, false)]);   // 탭
  let g = 0; while (!(p.atk && p.atk.hit) && g++ < ticks(2)) Core.step(w, []);
  ok('5 준비: 후딜 중', !!p.atk && p.atk.hit);
  const cd0 = p.atkCd, x0 = p.x;
  Core.step(w, [inp('p1', -1, 0, false)]);
  ok('5 후딜 중 조이스틱 → 후딜 끝(atk null)', p.atk === null);
  ok('5 같은 틱에 이동', p.x < x0 - 1e-6, (x0 - p.x).toFixed(3));
  ok('5 대기시간은 남아 있고 한 틱만큼만 줄어듦', p.atkCd > 0.3 && near(p.atkCd, cd0 - TICK, 1e-9), `${cd0.toFixed(4)} → ${p.atkCd.toFixed(4)}`);
}

// ---------------------------------------------------------------------
// 6. 평타 고정 중(추적 대상으로 걸어가 평타가 시작된 상태) 조이스틱 → 고정 해제 + 선딜 취소
// ---------------------------------------------------------------------
{ const w = mk('darius', 'yi'), p = P(w), e = E(w);
  place(w, 300);                                      // 사거리 밖: 누르면 추적 고정만 됨
  Core.step(w, [inp('p1', 0, 0, true)]); Core.step(w, [inp('p1', 0, 0, false)]);
  ok('6 준비: 추적 고정', !!p.lock && p.lock.targetId === 'e1');
  let g = 0;
  while (!p.atk && g++ < ticks(3)) Core.step(w, [inp('p1', 0, 0, false)]);
  ok('6 고정 대상을 쳐서 선딜 중', !!p.atk && !p.atk.hit && !!p.lock);
  const hp0 = e.hp;
  Core.step(w, [inp('p1', 0, 1, false)]);             // 조이스틱
  ok('6 조이스틱 → 고정 해제 + 선딜 취소', p.lock === null && p.atk === null && p.atkCd === 0);
  steps(w, ticks(0.6));
  ok('6 고정이 풀려 더 이상 치지 않음(상대 체력 그대로)', e.hp === hp0 && p.atk === null, `${hp0} → ${e.hp}`);
}

// ---------------------------------------------------------------------
// 7. 공중에 뜸(C2 d·e): 개발자 air 명령과 공중에 뜬 상태 모두 선딜을 취소
// ---------------------------------------------------------------------
{ const w = mk('darius', 'yi'), p = P(w), e = E(w);
  place(w, 100);
  Core.step(w, [inp('p1', 0, 0, true)]); Core.step(w, [inp('p1', 0, 0, false)]);
  Core.step(w, [cmd('dev', 'p1', { op: 'air' })]);
  ok('7 개발자 air → 선딜 취소, 대기시간 0', p.atk === null && p.atkCd === 0);
}
{ const w = mk('darius', 'yi'), p = P(w), e = E(w);
  place(w, 100);
  Core.step(w, [inp('p1', 0, 0, true)]); Core.step(w, [inp('p1', 0, 0, false)]);
  p.air = 0.5; Core.step(w, []);
  ok('7 공중에 뜨면 선딜 취소, 대기시간 0', p.atk === null && p.atkCd === 0);
}

// 결정성 확인용: 취소 경로가 섞인 같은 입력 두 번은 같은 월드 (rune 없음)
{ const script = { 0: [inp('p1', 0, 0, true)], 2: [inp('p1', 0, 0, false)], 40: [inp('p1', -1, 0, false)], 200: [inp('p1', 0, 0, true)], 202: [inp('p1', 0, 0, false)], 230: [cmd('cast', 'p1', { skill: 'q', ang: 0 })] };
  const play = () => { const w = mk('darius', 'yi'); place(w, 100); for (let i = 0; i < 400; i++) Core.step(w, script[i] || []); return w; };
  ok('7 같은 입력 → 같은 월드(취소 포함)', JSON.stringify(play()) === JSON.stringify(play()));
}

const total = pass + fail;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) throw new Error(`${fail} of ${total} checks failed`);
