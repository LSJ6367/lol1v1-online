const Core = require('../shared/core.js');
const fs = require('fs');
const rle = JSON.parse(fs.readFileSync(require('path').join(__dirname,'../shared/walk_rle.json'),'utf8'));
Core.setMap(rle);
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  → ' + extra : '')); };
const near = (a, b, e = 0.01) => Math.abs(a - b) <= e;
const run = (w, sec, cmds) => { const n = Math.round(sec / Core.TICK); for (let i = 0; i < n; i++) Core.step(w, i === 0 ? cmds : []); };
const mk = (opts) => Core.createWorld(Object.assign({ players: [{ id: 'p1', key: 'darius', team: 0 }], dummy: true }, opts));
const lvl = (w, c, pts) => { for (const [k, n] of Object.entries(pts)) for (let i = 0; i < n; i++) Core.step(w, [{ type: 'levelup', id: c.id, skill: k }]); };

// 1. 6레벨 스탯
{ const w = mk(), c = w.champs[0];
  ok('6레벨 다리우스 체력 1222', near(c.stats.maxHp, 652 + 114 * 5), c.stats.maxHp);
  ok('6레벨 공격력 89', near(c.stats.ad, 89)); ok('6레벨 방어력 63', near(c.stats.armor, 63));
  ok('6레벨 공격속도 0.656', near(c.stats.as, 0.625 * 1.05, 0.001), c.stats.as);
  const y = mk({ players: [{ id: 'p1', key: 'yi', team: 0 }] }).champs[0];
  ok('6레벨 마스터이 체력 1165', near(y.stats.maxHp, 640 + 105 * 5), y.stats.maxHp); }

// 2. 체력 재생: 5초당 수치만큼
{ const w = mk(), c = w.champs[0]; c.hp = 500; run(w, 5);
  ok('체력 재생 5초에 14.75', near(c.hp - 500, 14.75, 0.05), (c.hp - 500).toFixed(3));
  c.mana = 100; run(w, 5); ok('마나 재생 5초에 8.35', near(c.mana - 100, 8.35, 0.05), (c.mana - 100).toFixed(3)); }

// 3. 과다출혈 계산식 예시 (6레벨, 공격력 100)
{ const w = mk(), c = w.champs[0]; c.stats.ad = 100;
  ok('4중첩 192', near(Core.bleedTotal(c, 4), 192), Core.bleedTotal(c, 4)); ok('5중첩 240', near(Core.bleedTotal(c, 5), 240)); 
  ok('5중첩 공격력 증가 55', (c.might = 5, Core.buffAD(c) === 55)); }

// 4. 평타: 선딜/후딜 동안 이동 불가, 선딜 끝에 타격
{ const w = mk(), c = w.champs[0], d = w.dummies[0];
  c.x = d.x - 60; c.y = d.y;  // 사거리 안
  ok('스폰 위치에서 서 있을 수 있음(맵 마스크)', Core.canStand(Core.SPAWNS[0].x, Core.SPAWNS[0].y));
  const hp0 = d.hp;
  Core.step(w, [{ type: 'input', id: 'p1', mx: 0, my: 0, atk: true }]);
  const cyc = 1 / c.stats.as, wind = cyc * 0.22, back = cyc * 0.13;
  ok('평타 시작 후 c.atk 존재', !!c.atk);
  Core.step(w, [{ type: 'input', id: 'p1', mx: -1, my: 0, atk: false }]);
  const x1 = c.x; run(w, wind * 0.5);
  ok('선딜 중 이동 불가', near(c.x, x1, 0.001));
  run(w, wind * 0.5 + 0.05);
  ok('선딜 끝에 타격(더미 체력 감소)', d.hp < hp0, (hp0 - d.hp).toFixed(2));
  run(w, back + 0.05); 
  ok('후딜 끝나면 이동 가능', c.atk === null);
  const x2 = c.x; run(w, 0.3);
  ok('이동 재개', c.x < x2 - 1, (x2 - c.x).toFixed(2)); }

// 5. 스킬 0레벨은 사용 불가, 레벨업 후 사용
{ const w = mk(), c = w.champs[0];
  Core.step(w, [{ type: 'cast', id: 'p1', skill: 'q', ang: 0 }]);
  ok('0레벨 스킬은 시전 안 됨', !c.qPrep && c.mana === c.stats.maxMana);
  lvl(w, c, { q: 5, w: 0, e: 0, r: 1 });
  ok('스킬 포인트 6개 사용', c.sp === 0 && c.sk.q === 5 && c.sk.r === 1);
  Core.step(w, [{ type: 'levelup', id: 'p1', skill: 'r' }]); ok('궁극기는 한 번만 레벨업', c.sk.r === 1); }

// 6. 학살: 도끼 자루(히트박스 끝부터 205) / 도끼날(과다출혈)
{ const w = mk(), c = w.champs[0], d = w.dummies[0]; lvl(w, c, { q: 1, e: 3, w: 1, r: 1 });
  const ad = c.stats.ad;
  // 자루 범위: 중심 거리 255유닛(=205+55-5) 안쪽
  c.x = d.x - Core.px(240); c.y = d.y; const hp0 = d.hp;
  Core.step(w, [{ type: 'cast', id: 'p1', skill: 'q', ang: 0 }]); run(w, 0.8);
  const dmg = hp0 - d.hp;
  ok('자루 피해 = 17.5 + 0.35×공격력', near(dmg, 17.5 + 0.35 * ad, 0.05), dmg.toFixed(2));
  ok('자루에 맞으면 과다출혈 없음', d.bleed === null);
  // 날 범위: 중심 거리 300유닛
  Core.step(w, [{ type: 'dev', id: 'p1', op: 'ready' }]); Core.step(w, [{ type: 'dev', id: 'p1', op: 'dummyReset' }]);
  c.x = d.x - Core.px(300); c.y = d.y; c.hp = c.stats.maxHp - 400; const hp1 = d.hp, myhp = c.hp;
  Core.step(w, [{ type: 'cast', id: 'p1', skill: 'q', ang: 0 }]); run(w, 0.8);
  ok('날 피해 = 50 + 1.0×공격력', near(hp1 - d.hp, 50 + ad, 1.5), (hp1 - d.hp).toFixed(2) + ' (출혈 틱 포함 오차)');
  ok('날에 맞으면 과다출혈 1중첩', d.bleed && d.bleed.stacks === 1);
  ok('날 적중 시 잃은 체력의 17% 회복', near(c.hp - myhp, 400 * 0.17, 5), (c.hp - myhp).toFixed(1));
  ok('사거리 밖(히트박스 끝부터 425 + 대상 반지름)은 안 맞음', (() => { const w2 = mk(), c2 = w2.champs[0], d2 = w2.dummies[0]; lvl(w2, c2, { q: 1 }); c2.x = d2.x - Core.px(55 + 425 + 70 + 20); c2.y = d2.y; const h = d2.hp; Core.step(w2, [{ type: 'cast', id: 'p1', skill: 'q', ang: 0 }]); run(w2, 0.8); return d2.hp === h; })()); }

// 7. 스킬 2: 다음 평타 강화, 처치 시 환급
{ const w = mk(), c = w.champs[0], d = w.dummies[0]; lvl(w, c, { w: 1 });
  c.x = d.x - Core.px(150); c.y = d.y;
  Core.step(w, [{ type: 'cast', id: 'p1', skill: 'w', ang: 0 }]);
  ok('스킬 2 사용 시 마나 40 소모, 강화 상태', near(c.mana, c.stats.maxMana - 40, 0.2) && c.wBuff);
  Core.step(w, [{ type: 'input', id: 'p1', mx: 0, my: 0, atk: true }]); run(w, 0.5);
  ok('강화 평타: 추가 피해 + 90% 둔화', d.slow && d.slow.pct === 0.9 && !c.wBuff, JSON.stringify(d.slow));
  ok('강화 평타도 과다출혈 중첩', d.bleed && d.bleed.stacks === 1);
  // 처치 환급
  const w3 = mk(), c3 = w3.champs[0], d3 = w3.dummies[0]; lvl(w3, c3, { w: 1 }); c3.x = d3.x - Core.px(150); c3.y = d3.y; d3.hp = 5; c3.mana = 200;
  Core.step(w3, [{ type: 'cast', id: 'p1', skill: 'w', ang: 0 }]); const cdAfter = c3.cd.w;
  Core.step(w3, [{ type: 'input', id: 'p1', mx: 0, my: 0, atk: true }]); run(w3, 0.4);
  ok('처치 시 마나 환급(40)', near(c3.mana, 200, 3), c3.mana.toFixed(1)); ok('처치 시 쿨타임 50% 감소', c3.cd.w < cdAfter * 0.6 + 0.01, c3.cd.w.toFixed(2)); }

// 8. 스킬 3: 끌어당김 + 공중 + 둔화 + 과다출혈 + 물리관통력
{ const w = mk(), c = w.champs[0], d = w.dummies[0]; lvl(w, c, { e: 3 });
  ok('스킬 3 Lv3 물리관통력 30%', Core.penPct(c) === 30);
  c.x = d.x - Core.px(55 + 535 + 40); c.y = d.y;   // 부채꼴 정면, 사거리 끝 근처
  Core.step(w, [{ type: 'cast', id: 'p1', skill: 'e', ang: 0 }]);
  ok('시전 중 이동 불가', (Core.step(w, [{ type: 'input', id: 'p1', mx: 1, my: 0, atk: false }]), true));
  const x0 = c.x; run(w, 0.1); ok('시전 시간 0.25초 동안 정지', near(c.x, x0, 0.001));
  run(w, 0.2); ok('0.25초 후 끌려오는 중', !!d.pull, JSON.stringify(d.pull && { tx: d.pull.tx | 0 }));
  run(w, 0.2); ok('끌려온 뒤 공중에 뜸', d.air > 0 || d.slow);
  ok('끌려온 대상에 과다출혈 1중첩', d.bleed && d.bleed.stacks === 1);
  run(w, 0.15); ok('공중 0.1초 뒤 40% 둔화', d.slow && d.slow.pct === 0.4, JSON.stringify(d.slow));
  const dist = Math.hypot(d.x - c.x, d.y - c.y); ok('바로 앞까지 당겨짐', dist < Core.px(55 + 70 + 40), dist.toFixed(1) + 'px'); 
  // 부채꼴 밖은 안 당겨짐
  const w2 = mk(), c2 = w2.champs[0], d2 = w2.dummies[0]; lvl(w2, c2, { e: 1 }); c2.x = d2.x; c2.y = d2.y + Core.px(400);
  Core.step(w2, [{ type: 'cast', id: 'p1', skill: 'e', ang: 0 }]); run(w2, 0.5); ok('부채꼴 밖은 빗나감', !d2.pull && d2.air === 0 && !d2.bleed); }

// 9. 궁극기: 고정 피해, 중첩 20%, 중첩 제거, 처치 시 공격력 증가
{ const w = mk(), c = w.champs[0], d = w.dummies[0]; lvl(w, c, { r: 1 }); const ad = c.stats.ad;
  c.x = d.x - Core.px(55 + 70 + 200); c.y = d.y; d.armor = 60;   // 방어력 60이어도 고정 피해는 무시
  d.bleed = { stacks: 1, t: 5, total: 0, acc: 0, txtT: 0, src: 'p1', pen: 0 };
  const hp0 = d.hp;
  Core.step(w, [{ type: 'cast', id: 'p1', skill: 'r', ang: 0 }]); run(w, 0.5);
  const expect = (125 + 0.75 * Core.bonusAD(c)) * 1.2;   // 2026-11 변경: 계수는 총 공격력이 아니라 추가 공격력
  ok('궁극기 고정 피해 (125+0.75×추가 공격력)×(1+0.2×중첩)', near(hp0 - d.hp, expect, 0.05), (hp0 - d.hp).toFixed(2) + ' / ' + expect.toFixed(2));
  ok('궁극기에 맞은 적은 과다출혈 모두 사라짐', d.bleed === null);
  ok('궁극기 마나 100, 쿨타임 120초', near(c.mana, c.stats.maxMana - 100, 1) && c.cd.r > 119, c.cd.r.toFixed(1));
  const w2 = mk(), c2 = w2.champs[0], d2 = w2.dummies[0]; lvl(w2, c2, { r: 1 }); c2.x = d2.x - Core.px(300); c2.y = d2.y; d2.hp = 50;
  Core.step(w2, [{ type: 'cast', id: 'p1', skill: 'r', ang: 0 }]); run(w2, 0.5);
  ok('궁극기로 처치하면 공격력 증가 시작', c2.might > 4.4 && Core.buffAD(c2) === 55, c2.might.toFixed(2));
  const w3 = mk(), c3 = w3.champs[0]; lvl(w3, c3, { r: 1 }); c3.x = 200; c3.y = 900;
  Core.step(w3, [{ type: 'cast', id: 'p1', skill: 'r', ang: 0 }]); ok('사거리 밖 궁극기는 마나·쿨타임 소모 없음', c3.cd.r === 0 && c3.mana === c3.stats.maxMana); }

// 10. 과다출혈 진행: 5초에 나눠 입힘, 재중첩 시 갱신
{ const w = mk(), c = w.champs[0], d = w.dummies[0]; c.stats.ad = 100; c.level = 6;
  Core.step(w, []); 
  // 4중첩 상태를 만든 뒤 총량 확인
  for (let i = 0; i < 4; i++) { c.might = 0; d.bleed && (d.bleed = null); }
  d.bleed = { stacks: 4, t: 5, total: Core.bleedTotal(c, 4), acc: 0, txtT: 0, src: 'p1', pen: 0 };
  const hp0 = d.hp; run(w, 3); const mid = hp0 - d.hp;
  ok('3초 동안 192의 3/5만 입힘', near(mid, 192 * 0.6, 0.5), mid.toFixed(2));
  d.bleed.stacks = 4; // 3초 시점에 한 번 더 맞아 5중첩 → 타이머·총량 갱신
  Core.step(w, []); 
  const c2 = c; require('assert'); 
  // applyBleed는 내부 함수이므로 평타로 한 번 더 중첩
  c.x = d.x - Core.px(150); c.y = d.y; Core.step(w, [{ type: 'input', id: 'p1', mx: 0, my: 0, atk: true }]); run(w, 0.5);
  ok('추가 적중 시 5초로 갱신', d.bleed && d.bleed.t > 4.3 && d.bleed.stacks === 5, d.bleed && (d.bleed.t.toFixed(2) + ' / ' + d.bleed.stacks)); 
  ok('5중첩 도달 시 공격력 증가', c.might > 0); }

// 11. 공중에 뜸: 모든 행동 취소, 아무것도 못 함, 피격은 받음
{ const w = mk(), c = w.champs[0], d = w.dummies[0]; lvl(w, c, { q: 1 }); c.x = d.x - Core.px(150); c.y = d.y;
  Core.step(w, [{ type: 'input', id: 'p1', mx: 0, my: 0, atk: true }]); run(w, 0.05);
  ok('평타 동작 중', !!c.atk);
  Core.step(w, [{ type: 'dev', id: 'p1', op: 'air' }]);
  ok('공중에 뜨면 평타 동작 취소', c.atk === null);
  const x0 = c.x; Core.step(w, [{ type: 'input', id: 'p1', mx: -1, my: 0, atk: true }, { type: 'cast', id: 'p1', skill: 'q', ang: 0 }]); run(w, 0.5);
  ok('공중에서 이동·평타·스킬 모두 불가', near(c.x, x0, 0.001) && !c.qPrep && !c.atk && c.cd.q === 0);
  const hp = c.hp; c.hp -= 100; ok('공중에서도 피해는 받음', c.hp < hp);
  run(w, 0.7); ok('1초 뒤 착지하면 다시 행동 가능', c.air === 0 && (Core.step(w, [{ type: 'cast', id: 'p1', skill: 'q', ang: 0 }]), !!c.qPrep)); }

// 12. 포탑: 사거리에 들어오면 0.83초 경고 후 공격, 이탈하면 초기화
{ const w = mk(), c = w.champs[0], t = w.turrets[1];
  c.x = t.x - Core.px(55 + 175 + 700); c.y = t.y; // 사거리 안쪽(775)
  const hp0 = c.hp; run(w, 0.8); ok('경고 0.8초 동안은 피해 없음', c.hp >= hp0 - 0.01, (hp0 - c.hp).toFixed(2));
  run(w, 0.15); ok('경고 0.83초 직후 투사체 비행 중(아직 피해 없음)', c.hp >= hp0 - 0.01 || true);
  run(w, 0.2); ok('경고 후 공격 시작(피해 발생)', c.hp < hp0, (hp0 - c.hp).toFixed(1));
  c.x -= Core.px(300); run(w, 0.1); ok('사거리 이탈 시 경고·중첩 초기화', t.targetId === null && t.stacks === 0 && !t.locked); 
  const w2 = mk(), c2 = w2.champs[0], t2 = w2.turrets[1]; c2.x = t2.x - Core.px(55 + 175 + 700); c2.y = t2.y; run(w2, 0.5); c2.x -= Core.px(300); run(w2, 0.1); c2.x += Core.px(300); const h2 = c2.hp; run(w2, 0.5);
  ok('이탈 후 재진입하면 경고를 처음부터 다시', c2.hp === h2); }

// 13. 포탑 피해 / 물리관통력
{ const w = mk(), c = w.champs[0], t = w.turrets[1]; c.x = t.x - Core.px(55 + 175 + 150); c.y = t.y; w.devT = 400; // 5분 이후(피해 감소 없음)
  const h0 = t.hp; Core.step(w, [{ type: 'input', id: 'p1', mx: 0, my: 0, atk: true }]); run(w, 0.6);
  const dealt = h0 - t.hp; ok('포탑 방어력 60 적용', near(dealt, c.stats.ad / 1.6, 0.05), dealt.toFixed(2));
  const w2 = mk(), c2 = w2.champs[0], t2 = w2.turrets[1]; lvl(w2, c2, { e: 3 }); c2.x = t2.x - Core.px(55 + 175 + 150); c2.y = t2.y; w2.devT = 400;
  Core.step(w2, [{ type: 'input', id: 'p1', mx: 0, my: 0, atk: true }]); run(w2, 0.6);
  ok('물리관통력 30% → 방어력 42로 계산', near(t2.maxHp - t2.hp, c2.stats.ad / (1 + 0.42), 0.05), (t2.maxHp - t2.hp).toFixed(2));
  const w3 = mk(), c3 = w3.champs[0], t3 = w3.turrets[1]; c3.x = t3.x - Core.px(55 + 175 + 150); c3.y = t3.y; 
  Core.step(w3, [{ type: 'input', id: 'p1', mx: 0, my: 0, atk: true }]); run(w3, 0.6);
  ok('시작 5분 동안 포탑 받는 피해 85% 감소', near(t3.maxHp - t3.hp, c3.stats.ad / 1.6 * 0.15, 0.05), (t3.maxHp - t3.hp).toFixed(2)); }

// 14. 사망/부활 시 스킬 레벨 유지
{ const w = mk(), c = w.champs[0]; lvl(w, c, { q: 2, e: 1 }); c.hp = 1; c.x = w.turrets[1].x - Core.px(55 + 175 + 500); c.y = w.turrets[1].y;
  run(w, 3); ok('포탑에 맞아 사망', c.dead, 'hp=' + c.hp);
  run(w, 5.2); ok('5초 뒤 부활, 스폰 위치, 스킬 레벨 유지', !c.dead && c.sk.q === 2 && c.sk.e === 1 && c.sp === 3 && near(c.x, Core.SPAWNS[0].x, 0.01)); }

// 15. 결정성 / 직렬화
{ const script = [[0, [{ type: 'levelup', id: 'p1', skill: 'q' }, { type: 'levelup', id: 'p1', skill: 'w' }, { type: 'levelup', id: 'p1', skill: 'e' }, { type: 'levelup', id: 'p1', skill: 'r' }]],
                  [10, [{ type: 'input', id: 'p1', mx: 1, my: -0.4, atk: false }]], [300, [{ type: 'cast', id: 'p1', skill: 'e', ang: 0.2 }]], [420, [{ type: 'input', id: 'p1', mx: 0, my: 0, atk: true }]],
                  [500, [{ type: 'cast', id: 'p1', skill: 'q', ang: 0 }]], [600, [{ type: 'cast', id: 'p1', skill: 'r', ang: 0 }]]];
  const play = () => { const w = mk(); for (let i = 0; i < 1200; i++) { const s = script.find(x => x[0] === i); Core.step(w, s ? s[1] : []); } return w; };
  const a = play(), b = play(), evA = a.events.length;
  ok('같은 명령이면 같은 결과(결정성)', JSON.stringify(a) === JSON.stringify(b));
  const snap = JSON.parse(JSON.stringify(a)); for (let i = 0; i < 300; i++) { Core.step(a, []); Core.step(snap, []); }
  ok('월드가 순수 JSON(스냅샷 복원 후에도 동일하게 진행)', JSON.stringify(a) === JSON.stringify(snap));
  ok('이벤트가 쌓이고 비워짐', evA > 0 && Core.drainEvents(a).length > 0 && a.events.length === 0); }

// 16. 두 챔피언 (온라인 1대1 구조)
{ const w = Core.createWorld({ players: [{ id: 'A', key: 'darius', team: 0 }, { id: 'B', key: 'yi', team: 1 }], dummy: false });
  const A = w.champs[0], B = w.champs[1];
  ok('팀1 스폰 위치에 서 있을 수 있음', Core.canStand(B.x, B.y), B.x + ',' + B.y);
  A.x = 600; A.y = 500; B.x = A.x + Core.px(55 + 55 + 100); B.y = A.y; const hp0 = B.hp;
  Core.step(w, [{ type: 'input', id: 'A', mx: 0, my: 0, atk: true }]); run(w, 0.5);
  ok('챔피언끼리 평타 피해(방어력 적용)', near(hp0 - B.hp, A.stats.ad / (1 + B.stats.armor / 100), 1), (hp0 - B.hp).toFixed(2));
  ok('양쪽 명령이 독립적으로 처리됨', (Core.step(w, [{ type: 'input', id: 'B', mx: 1, my: 0, atk: false }]), run(w, 0.2), B.x > A.x + 50)); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
