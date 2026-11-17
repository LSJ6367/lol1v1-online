/* =====================================================================
   소환사 주문 테스트 (DESIGN_SPELLS.md §0 S1~S8, §1). 점화·점멸 규칙과 프로토콜
   - 점화: 대상(사거리 600 · 챔피언 우선 · 허수아비), 대상 없음, 1초마다 34 × 5, 다시 걸면 갱신,
     처치 점수(가렌 용기 · 아트록스 세계의 종결자), 흡혈 없음, 회복 ×0.6, 사용 조건, 쿨타임 180
   - 점멸: 방향(조준 > 조이스틱 > 마지막 이동), 400 앞, 벽(근처 설 수 있는 곳 · 뒤로 당김 · 얇은 벽 넘기 · 빈자리 없음),
     평타·추적 취소, 아트록스 Q 따라옴, 돌진 중 불가, 다리우스 R 이동 고정, 쿨타임 300
   - 쿨타임은 죽어 있는 동안에도 흐르고 부활해도 남음. 개발 도구 '쿨타임 초기화'가 0으로 만듦
   - 프로토콜 sp 행동, 결정성
   자연 회복은 끄고(quiet), 포탑은 격리. 거리 단위는 유닛, 좌표는 px.
   ===================================================================== */
const Core = require('../shared/core.js');
const P = require('../shared/protocol.js');
const fs = require('fs'), path = require('path');
const REAL_MAP = JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/walk_rle.json'), 'utf8'));
Core.setMap(REAL_MAP);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  → ' + extra : '')); };
const near = (a, b, e = 0.01) => Math.abs(a - b) <= e;
const px = Core.px, TICK = Core.TICK, EPS = 1e-9, PI = Math.PI;
const cmd = (type, id, extra) => Object.assign({ type, id }, extra || {});
const inp = (id, mx, my, atk) => cmd('input', id, { mx, my, atk: !!atk });
const spell = (id, s, extra) => cmd('spell', id, Object.assign({ spell: s }, extra || {}));
const cast = (id, skill, ang) => cmd('cast', id, { skill, ang });
const quiet = c => { c.stats.regen = 0; c.stats.manaRegen = 0; };        // 자연 회복 끄기
const lvl = (w, c, pts) => { for (const [k, n] of Object.entries(pts)) for (let i = 0; i < n; i++) Core.step(w, [cmd('levelup', c.id, { skill: k })]); };
const run = (w, sec, cmds) => { const n = Math.round(sec / TICK); for (let i = 0; i < n; i++) Core.step(w, i === 0 ? cmds : []); };
const fxOf = (w, name) => Core.drainEvents(w).filter(e => e.type === 'fx' && e.fx === name);
const hasText = (w, s) => w.events.some(e => e.type === 'text' && e.txt === s);
const AT = { x: 400, y: 700 }, MAXHP = 1220;                            // 6레벨 아트록스 최대 체력(650 + 114 × 5)
const at = (c, f, s, ang = 0) => ({ x: c.x + px(f) * Math.cos(ang) - px(s) * Math.sin(ang), y: c.y + px(f) * Math.sin(ang) + px(s) * Math.cos(ang) });
const put = (t, c, f, s, ang = 0) => { const p = at(c, f, s, ang); t.x = p.x; t.y = p.y; };   // 기준 c에서 (앞 f, 옆 s) 유닛
const pool = u => u.hp + Core.shieldOf(u);
// 벽 테스트용 맵: x0 ≤ x < x1 열은 모든 줄에서 벽. x1 ≤ x0 이면 빈 맵
const setWallMap = (x0, x1, y0 = 0, y1 = Core.MAP_H) => {   // y0 ≤ y < y1 줄에만 벽(막대). 기본은 전체 줄
  const rows = [];
  for (let y = 0; y < Core.MAP_H; y++) rows.push(x1 > x0 && y >= y0 && y < y1 ? [[0, x0], [x1, Core.MAP_W]] : [[0, Core.MAP_W]]);
  Core.setMap(rows);
};
// p1(팀 0)은 AT에 둔다. enemy: e1(팀 1, 기본 다리우스). dummy: 허수아비(팀 1, 기본 위치). 포탑 격리, 자연 회복 끔
const mk = (o) => {
  o = o || {};
  const players = [{ id: 'p1', key: o.key || 'darius', team: 0 }];
  if (o.enemy) players.push({ id: 'e1', key: o.enemyKey || 'darius', team: 1 });
  const w = Core.createWorld({ players, dummy: o.dummy !== false, runes: o.runes });   // o.runes: 룬 끔 옵션 전달(없으면 기본 켜짐)
  w.turrets.forEach(t => { t.dead = true; });
  w.champs.forEach(quiet);
  const a = w.champs[0];
  a.x = AT.x; a.y = AT.y;
  return { w, a, d: w.dummies[0] || null, e: w.champs[1] || null };
};

// ---------------------------------------------------------------------
// 1. 점화 대상 (S1): 사거리 600(히트박스 끝~끝), 챔피언 우선, 없으면 허수아비, 없으면 대상 없음
// ---------------------------------------------------------------------
{ const { w, a, d } = mk();                                             // 허수아비 반지름 70, 나 55
  put(d, a, 599.5 + 125, 0);
  ok('1 허수아비 히트박스 끝 거리 599.5 → 대상', Core.igniteTarget(w, a) === d);
  put(d, a, 600.5 + 125, 0);
  ok('1 허수아비 히트박스 끝 거리 600.5 → 대상 아님', Core.igniteTarget(w, a) === null); }
{ const { w, a, e } = mk({ enemy: true, dummy: false });               // 챔피언 반지름 55 + 55
  put(e, a, 599.5 + 110, 0);
  ok('1 챔피언 히트박스 끝 거리 599.5 → 대상', Core.igniteTarget(w, a) === e);
  put(e, a, 600.5 + 110, 0);
  ok('1 챔피언 히트박스 끝 거리 600.5 → 대상 아님', Core.igniteTarget(w, a) === null); }
{ const { w, a, d, e } = mk({ enemy: true });
  put(d, a, 100, 0); put(e, a, 400, 0);
  ok('1 챔피언이 허수아비보다 우선(허수아비가 더 가까워도)', Core.igniteTarget(w, a) === e);
  put(e, a, 900, 0);
  ok('1 챔피언이 사거리 밖이면 허수아비', Core.igniteTarget(w, a) === d); }
{ const { w, a } = mk({ dummy: false });                                // 대상 없음: 글자만, 쿨타임 없음
  Core.step(w, [spell('p1', 'ignite')]);
  ok('1 대상 없음 → "사거리 내 대상 없음", 쿨타임 소모 없음', hasText(w, '사거리 내 대상 없음') && a.spCd.ignite === 0, a.spCd.ignite);
  Core.drainEvents(w); }

// ---------------------------------------------------------------------
// 2. 점화 틱 (S2): 시전 뒤 1초마다 34 고정 피해 5번, 5초에 끝남, 다시 걸면 처음부터, 흡혈 없음, 처치 점수
// ---------------------------------------------------------------------
{ const { w, a, e } = mk({ enemy: true, dummy: false });
  put(e, a, 150, 0); e.hp = 1000;
  Core.step(w, [spell('p1', 'ignite')]);                                 // 시전 (첫 호출)
  ok('2 시전 직후 대상에게 점화(시전자 p1), 쿨타임 180 시작', !!e.ign && e.ign.src === 'p1' && e.ign.n === 0 && near(a.spCd.ignite, 180, 0.05), a.spCd.ignite);
  const hits = []; let prev = e.hp, endAt = -1;
  for (let i = 1; i < 320; i++) {
    Core.step(w, []);
    if (e.hp < prev - EPS) hits.push([i, prev - e.hp]);
    prev = e.hp;
    if (endAt < 0 && !e.ign) endAt = i;
  }
  const idx = hits.map(h => h[0]);
  ok('2 틱은 시전 1초 뒤부터 1초마다 5번(호출 60·120·180·240·300번째)', idx.length === 5 && idx.every(i => (i + 1) % 60 === 0), JSON.stringify(idx));
  ok('2 틱 한 번은 정확히 34 고정 피해', hits.every(h => near(h[1], 34, 1e-9)), JSON.stringify(hits.map(h => h[1])));
  ok('2 5초가 지나면 점화가 끝남(마지막 틱과 같은 호출)', endAt === 299 && e.ign === null, endAt);
  ok('2 총 피해 170', near(1000 - e.hp, 170, 1e-6), 1000 - e.hp); }
{ const { w, a, d } = mk(); put(d, a, 150, 0);                           // 허수아비도 같은 틱
  Core.step(w, [spell('p1', 'ignite')]); run(w, 1.02, []);
  ok('2 허수아비 대상: 1초 뒤 첫 틱 34, 점화 남아 있음', d.total === 34 && !!d.ign, d.total); }
{ // 다시 걸면 처음부터(갱신): 0.5초·2.5초에 걸린 뒤 옛 점화 틱은 사라지고 새 점화 틱이 2.5초 뒤부터 옴
  const { w, a, e } = mk({ enemy: true, dummy: false });
  put(e, a, 150, 0); e.hp = 1000;
  const hits = []; let prev = e.hp;
  Core.step(w, [spell('p1', 'ignite')]);
  for (let i = 1; i < 460; i++) {
    const cmds = i === 150 ? [cmd('dev', 'p1', { op: 'ready' }), spell('p1', 'ignite')] : [];   // 2.5초에 쿨타임 초기화 후 다시 걸기
    Core.step(w, cmds);
    if (e.hp < prev - EPS) hits.push(i);
    prev = e.hp;
  }
  ok('2 다시 걸면 갱신: 틱은 옛 점화 2번(59·119) 뒤 새 점화 5번(209·269·329·389·449)', JSON.stringify(hits) === JSON.stringify([59, 119, 209, 269, 329, 389, 449]), JSON.stringify(hits));
  ok('2 갱신 뒤 총 피해 = 7 × 34', near(1000 - e.hp, 238, 1e-6), 1000 - e.hp); }
{ // 가렌 용기: 점화 틱으로 처치하면 처치 점수 +0.2
  const { w, a, e } = mk({ key: 'garen', enemy: true, dummy: false });
  put(e, a, 150, 0); e.hp = 30;
  Core.step(w, [spell('p1', 'ignite')]); run(w, 1.1, []);
  ok('2 점화 틱으로 처치 → 가렌 용기 +0.2(처치 점수)', e.dead && near(a.courage, 0.2, 1e-9), `dead ${e.dead} courage ${a.courage}`);
  ok('2 처치되면 점화도 사라짐', e.ign === null); }
{ // 아트록스 R 처치 연장: 점화 틱으로 처치하면 세계의 종결자 +5초
  const { w, a, e } = mk({ key: 'aatrox', enemy: true, dummy: false });
  lvl(w, a, { r: 1 }); put(e, a, 150, 0); e.hp = 30;
  Core.step(w, [cast('p1', 'r', 0), spell('p1', 'ignite')]); run(w, 1.1, []);
  ok('2 점화 틱으로 처치 → 아트록스 세계의 종결자 +5초', e.dead && a.ar && near(a.ar.dur, 15, 1e-9), a.ar && a.ar.dur); }
{ // 점화 틱은 흡혈 없음: 시전자는 흡혈 20% + 아트록스 E 흡혈 16%를 가져도 틱으로 회복하지 않음
  const { w, a, e } = mk({ key: 'aatrox', enemy: true, dummy: false });
  lvl(w, a, { e: 1 }); a.bonus.omni = 0.5; a.hp = MAXHP - 400;
  put(e, a, 150, 0); e.hp = 1000;
  const h0 = a.hp;
  Core.step(w, [spell('p1', 'ignite')]); run(w, 1.1, []);
  ok('2 점화 틱에는 흡혈 없음(시전자 체력 그대로, 대상은 34 맞음)', near(a.hp, h0, 1e-9) && near(1000 - e.hp, 34, 1e-9), `${a.hp - h0} / ${1000 - e.hp}`); }
{ // 허수아비 처치(체력 초기화)도 점화를 지움
  const { w, a, d } = mk();
  put(d, a, 150, 0); d.hp = 30;
  Core.step(w, [spell('p1', 'ignite')]); run(w, 1.1, []);
  ok('2 허수아비 처치(체력 초기화) 뒤 점화 사라짐', d.ign === null && d.hp === d.maxHp, d.hp); }

// ---------------------------------------------------------------------
// 3. 치유 감소 (S3): 점화 중 대상의 모든 회복 ×0.6. 아트록스 R 회복 증가(×1.5)와 곱함
// ---------------------------------------------------------------------
{ // 체력 재생 10/초 × 0.9초 = 9. 점화 0.6, 세계의 종결자 1.5 → 곱 0.9
  const regen = (withR, ignited) => {
    const { w, a, e } = mk({ key: 'aatrox', enemy: true, dummy: false });
    a.stats.regen = 50; a.hp = MAXHP - 300;
    put(e, a, 150, 0);
    lvl(w, a, { r: 1 });
    const h0 = a.hp;
    const cmds = [];
    if (withR) cmds.push(cast('p1', 'r', 0));
    if (ignited) cmds.push(spell('e1', 'ignite'));
    Core.step(w, cmds); run(w, 0.9 - TICK, []);                           // 첫 호출 포함 54호출 = 0.9초 (틱은 60번째부터)
    return a.hp - h0;
  };
  ok('3 체력 재생: 아무것도 없음 9', near(regen(false, false), 9, 0.02), regen(false, false).toFixed(4));
  ok('3 체력 재생: 점화만 → ×0.6 = 5.4', near(regen(false, true), 5.4, 0.02), regen(false, true).toFixed(4));
  ok('3 체력 재생: R만 → ×1.5 = 13.5', near(regen(true, false), 13.5, 0.02), regen(true, false).toFixed(4));
  ok('3 체력 재생: R + 점화 → ×1.5 × 0.6 = 8.1', near(regen(true, true), 8.1, 0.02), regen(true, true).toFixed(4)); }
{ // 직접 회복: heal 100 (치유 감소는 ign 객체로 확인, 틱 없이 n = 5)
  const hv = (withR, ign) => {
    const { w, a } = mk({ key: 'aatrox', dummy: false });
    lvl(w, a, { r: 1 });
    if (withR) Core.step(w, [cast('p1', 'r', 0)]);
    a.hp = MAXHP - 300;
    a.ign = ign ? { t: 0, src: 'e1', n: 5 } : null;
    return Core.heal(w, a, 100, 'test');
  };
  ok('3 heal: 아무것도 없음 100', near(hv(false, false), 100, 1e-9), hv(false, false));
  ok('3 heal: 점화 0.6 → 60', near(hv(false, true), 60, 1e-9), hv(false, true));
  ok('3 heal: R 1.5 → 150', near(hv(true, false), 150, 1e-9), hv(true, false));
  ok('3 heal: R 1.5 × 점화 0.6 = 0.9 → 90', near(hv(true, true), 90, 1e-9), hv(true, true));
  ok('3 healMul: 곱 0.9, 점화만 0.6', near(Core.healMul(Object.assign(mk({ key: 'aatrox', dummy: false }).a, { ign: { t: 0, src: 'e1', n: 5 } })), 0.6, 1e-12)); }
{ // 흡혈 ×0.6: 시전자(다리우스, 흡혈 20%)가 점화를 받은 상태에서 평타 적중. 기준은 같은 평타를 점화 없이 쳤을 때
  //   (평타 적중 순간에는 다리우스 출혈 틱이 같이 돌아서 허수아비 체력 차이를 그대로 재면 안 됨 → 평타 피해 = 총 공격력으로 확인)
  const lifesteal = (withIgnite) => {
    const { w, a, d, e } = mk({ enemy: true, runes: false });   // 룬 끔: 기존 수치 검사 (DESIGN_RUNES Q7)
    a.bonus.omni = 0.2; a.hp = a.stats.maxHp - 400;                       // 빈 체력이 있어야 흡혈이 보임
    put(d, a, 145, 0); put(e, a, 400, 0, -PI / 2);                        // 허수아비는 평타 사거리 안, e1은 사거리 밖(북쪽 400)
    if (withIgnite) Core.step(w, [spell('e1', 'ignite')]);
    let g = 0;
    while (!a.atk && g++ < 10) Core.step(w, [inp('p1', 0, 0, true)]);
    const h0 = a.hp;
    while (!(a.atk && a.atk.hit) && g++ < 4000) Core.step(w, []);
    const gain = a.hp - h0, ad = Core.curAD(a);
    Core.step(w, [inp('p1', 0, 0, false)]);
    return { gain, ad };
  };
  const plain = lifesteal(false), burnt = lifesteal(true);
  ok('3 흡혈 기준: 점화 없음 = 총 공격력 × 20%', near(plain.gain, 0.2 * plain.ad, 1e-6), `${plain.gain} / ${plain.ad}`);
  ok('3 흡혈 ×0.6: 점화 중 = 총 공격력 × 20% × 0.6', near(burnt.gain, 0.2 * 0.6 * burnt.ad, 1e-6), `${burnt.gain} / ${burnt.ad}`);
}
{ // 점화 중 허수아비 자연 회복도 ×0.6 (허수아비 체력 1000 → 4초 뒤 회복 시작 전이라 idle을 5로 둠)
  const { w, d } = mk();
  d.idle = 5; d.hp = 1000; d.ign = { t: 0, src: 'p1', n: 5 };
  run(w, 1);
  ok('3 허수아비 자연 회복도 ×0.6: 1초에 5000 × 0.6 = 3000', near(d.hp, 4000, 0.5), d.hp.toFixed(3)); }

// ---------------------------------------------------------------------
// 4. 사용 조건 (S6) · 쿨타임 (S7)
// ---------------------------------------------------------------------
{ // 침묵 중에도 두 주문 사용 가능
  const { w, a, d } = mk(); put(d, a, 150, 0);
  Core.addSilence(w, a, 3);
  Core.step(w, [spell('p1', 'ignite')]);
  ok('4 침묵 중 점화 사용: 대상 점화, 쿨타임 시작', !!d.ign && near(a.spCd.ignite, 180, 0.05));
  Core.step(w, [spell('p1', 'flash', { ang: 0, aimed: true })]);
  ok('4 침묵 중 점멸 사용: 이동함', a.spCd.flash > 0 && near(a.x, AT.x + px(400), 1.5), a.x.toFixed(2)); }
{ // 사용 불가: 죽음 · 공중에 뜸 · 끌려오는 중 · 돌진 중 (아무 글자 없이 무시, 쿨타임·위치 변화 없음)
  const cases = [
    ['죽음', c => { c.dead = true; c.respawn = 5; }],
    ['공중에 뜸', c => { c.air = 1; c.airMax = 1; }],
    ['끌려오는 중', c => { c.pull = { t: 0, dur: 1, fx: c.x, fy: c.y, tx: c.x, ty: c.y, src: 'x' }; }],
    ['돌진 중(아트록스 E)', c => { c.dash = { t: 0, dir: 0, x0: c.x, y0: c.y }; }]
  ];
  for (const [name, setup] of cases) {
    const { w, a, d } = mk({ key: name.startsWith('돌진') ? 'aatrox' : 'darius' }); put(d, a, 150, 0);
    setup(a);
    Core.step(w, [spell('p1', 'ignite'), spell('p1', 'flash', { ang: 0, aimed: true })]);
    ok(`4 ${name}: 점화·점멸 모두 사용 안 됨`, a.spCd.ignite === 0 && a.spCd.flash === 0 && !d.ign && fxOf(w, 'flash').length === 0, `${a.spCd.ignite} ${a.spCd.flash} ${!!d.ign}`);
  }
}
{ // 일격필살(마스터 이 Q) 중에는 불가
  const { w, a, d } = mk({ key: 'yi' }); put(d, a, 300, 0);
  lvl(w, a, { q: 1 });
  Core.step(w, [cast('p1', 'q', 0)]);
  ok('4 준비: 일격필살 시작(yq)', !!a.yq);
  Core.step(w, [spell('p1', 'ignite'), spell('p1', 'flash', { ang: PI, aimed: true })]);
  ok('4 일격필살 중 점화·점멸 불가', a.spCd.ignite === 0 && a.spCd.flash === 0 && !d.ign); }
{ // 다른 스킬 시전 중에는 가능: 다리우스 E 시전 중 점멸
  const { w, a, d } = mk(); put(d, a, 100, 0);
  lvl(w, a, { e: 1 });
  Core.step(w, [cast('p1', 'e', 0)]);
  ok('4 준비: 다리우스 E 시전 중', !!a.cast);
  Core.step(w, [spell('p1', 'flash', { ang: -PI / 2, aimed: true })]);
  ok('4 스킬 시전 중에도 점멸 가능', a.spCd.flash > 0 && near(a.y, AT.y - px(400), 1.5), a.y.toFixed(2)); }
{ // 쿨타임: 같은 주문을 다시 쓰면 '재사용 대기 중'
  const { w, a, d } = mk(); put(d, a, 150, 0);
  Core.step(w, [spell('p1', 'ignite')]); Core.drainEvents(w);
  Core.step(w, [spell('p1', 'ignite')]);
  ok('4 점화 쿨타임 중 재사용 → "재사용 대기 중"', hasText(w, '재사용 대기 중')); }
{ // 쿨타임은 죽어 있는 동안에도 흐르고, 부활해도 남음 (점화 180, 점멸 300)
  const { w, a, d, e } = mk({ enemy: true });
  put(d, a, 150, 0);
  Core.step(w, [spell('p1', 'ignite')]);
  Core.step(w, [spell('p1', 'flash', { ang: -PI / 2, aimed: true })]);
  put(e, a, 150, 0, PI);                                                 // 나를 점화로 죽일 적(서쪽 150)
  a.hp = 1;
  let n = 2;
  Core.step(w, [spell('e1', 'ignite')]); n++;
  run(w, 6.2, []); n += Math.round(6.2 / TICK);
  ok('4 점화 받은 나는 죽고 5초 뒤 부활', !a.dead && a.hp > 0, `dead ${a.dead} hp ${a.hp}`);
  ok('4 죽어 있는 동안에도 쿨타임 흐름: 점화 ≈ 180 - 경과, 점멸 ≈ 300 - 경과', near(a.spCd.ignite, 180 - n / 60, 0.05) && near(a.spCd.flash, 300 - n / 60, 0.05), `${a.spCd.ignite.toFixed(3)} ${a.spCd.flash.toFixed(3)}`);
  Core.drainEvents(w);
  Core.step(w, [spell('p1', 'ignite')]);
  ok('4 부활 뒤에도 점화는 쿨타임 중', hasText(w, '재사용 대기 중')); }
{ // 개발 도구 '쿨타임 초기화'(ready): 두 주문 쿨타임 0
  const { w, a, d } = mk(); put(d, a, 150, 0);
  Core.step(w, [spell('p1', 'ignite'), spell('p1', 'flash', { ang: 0, aimed: true })]);
  ok('4 준비: 두 쿨타임 시작', a.spCd.ignite > 170 && a.spCd.flash > 290);
  Core.step(w, [cmd('dev', 'p1', { op: 'ready' })]);
  ok('4 ready: 두 쿨타임 0', a.spCd.ignite === 0 && a.spCd.flash === 0, `${a.spCd.ignite} ${a.spCd.flash}`);
  d.ign = null;
  Core.step(w, [spell('p1', 'ignite')]);
  ok('4 ready 뒤 점화 다시 사용', !!d.ign && a.spCd.ignite > 170); }

// ---------------------------------------------------------------------
// 5. 점멸 방향 (S4): 조준 > 조이스틱 > 마지막 이동 방향(아트록스 E와 같음). 400 앞
// ---------------------------------------------------------------------
{ const { w, a } = mk();
  Core.step(w, [spell('p1', 'flash', { ang: 0.6, aimed: true })]);
  const f = fxOf(w, 'flash')[0];
  const ex = AT.x + px(400) * Math.cos(0.6), ey = AT.y + px(400) * Math.sin(0.6);
  ok('5 조준 방향(0.6 rad) 400 앞에 도착', !!f && near(f.x1, ex, 1e-9) && near(f.y1, ey, 1e-9), f && `${f.x1.toFixed(3)},${f.y1.toFixed(3)}`);
  ok('5 출발점 이벤트(x0,y0)는 원래 자리', !!f && f.x0 === AT.x && f.y0 === AT.y);
  ok('5 점멸 뒤 바라보는 방향 = 점멸 방향(아트록스 E 기본 방향)', near(a.faceAng, 0.6, 1e-9) && a.facing === 1, `${a.faceAng} ${a.facing}`); }
{ const { w } = mk();
  Core.step(w, [inp('p1', 0, 1, false), spell('p1', 'flash')]);                  // 조준 없음, 조이스틱 아래(+y)
  const f = fxOf(w, 'flash')[0];
  ok('5 조준 없으면 조이스틱 방향(아래)', !!f && near(f.x1, AT.x, 1e-9) && near(f.y1, AT.y + px(400), 1e-9), f && `${f.x1},${f.y1}`); }
{ const { w } = mk();
  Core.step(w, [inp('p1', 0, 1, false), spell('p1', 'flash', { ang: 0, aimed: true })]);
  const f = fxOf(w, 'flash')[0];
  ok('5 조준이 조이스틱보다 우선(동쪽)', !!f && near(f.x1, AT.x + px(400), 1e-9) && near(f.y1, AT.y, 1e-9), f && `${f.x1},${f.y1}`); }
{ const { w, a } = mk();
  a.faceAng = PI;                                                              // 마지막으로 움직인 방향: 서쪽
  Core.step(w, [spell('p1', 'flash')]);
  const f = fxOf(w, 'flash')[0];
  ok('5 입력도 조준도 없으면 마지막 이동 방향(서쪽)', !!f && near(f.x1, AT.x - px(400), 1e-9) && near(f.y1, AT.y, 1e-9), f && `${f.x1},${f.y1}`); }
{ const { w, a } = mk();
  const before = JSON.stringify(w);
  const dd = Core.flashDest(w, a, 0.6, true);
  ok('5 flashDest는 월드를 바꾸지 않고 도착점을 돌려줌(미리보기)', JSON.stringify(w) === before && near(dd.x, AT.x + px(400) * Math.cos(0.6), 1e-9)); }

// ---------------------------------------------------------------------
// 6. 점멸 벽 (S5): 도착점이 벽이면 근처(반경 150)에서 가장 가까운 설 수 있는 곳, 없으면 선을 따라 뒤로
// ---------------------------------------------------------------------
{ setWallMap(440, 450);                                                    // 얇은 벽(10px)
  const { w } = mk({ dummy: false });
  Core.step(w, [spell('p1', 'flash', { ang: 0, aimed: true })]);
  const f = fxOf(w, 'flash')[0];
  ok('6 얇은 벽 너머 도착점이 열려 있으면 그대로 넘어감', !!f && near(f.x1, AT.x + px(400), 1e-9), f && f.x1); }
{ setWallMap(480, 600);                                                    // 두꺼운 벽: 도착점(494)이 벽 안
  const { w, a } = mk({ dummy: false });
  Core.step(w, [spell('p1', 'flash', { ang: 0, aimed: true })]);
  const f = fxOf(w, 'flash')[0];
  ok('6 도착점이 벽이면 근처 설 수 있는 곳(앞쪽 벽 가장자리 바깥)', !!f && Core.canStand(f.x1, f.y1) && f.x1 > 460 && f.x1 < 480 && near(f.y1, AT.y, 1e-9), f && `${f.x1.toFixed(2)},${f.y1}`);
  ok('6 벽 안에 끝나지 않음(canStand)', Core.canStand(a.x, a.y)); }
{ setWallMap(455, 600);                                                    // 가장 가까운 곳이 반경 150 밖 → 선을 따라 뒤로
  const { w, a } = mk({ dummy: false });
  Core.step(w, [spell('p1', 'flash', { ang: 0, aimed: true })]);
  const f = fxOf(w, 'flash')[0];
  ok('6 반경 150 안에 없으면 선을 따라 뒤로 당겨 설 수 있는 곳', !!f && Core.canStand(f.x1, f.y1) && near(f.y1, AT.y, 1e-9) && f.x1 > 440 && f.x1 < 446.5, f && f.x1.toFixed(2));
  ok('6 당겨 서도 쿨타임은 시작(300)', near(a.spCd.flash, 300 - 1 / 60, 1e-9), a.spCd.flash); }
{ setWallMap(455, 600, 690, 710);                                        // 막대(y 690~710)가 선을 가로막음: 가장 가까운 곳은 막대 옆
  const { w, a } = mk({ dummy: false });
  Core.step(w, [spell('p1', 'flash', { ang: 0, aimed: true })]);
  const f = fxOf(w, 'flash')[0];
  const dd = f ? Math.hypot(f.x1 - (AT.x + px(400)), f.y1 - AT.y) : 99;
  ok('6 막대 옆이 가장 가까움(뒤로 48px 당기지 않음): 도착점에서 25px 안, 선 위가 아님', !!f && Core.canStand(f.x1, f.y1) && dd <= 25 && Math.abs(f.y1 - AT.y) > 10, f && `${f.x1.toFixed(2)},${f.y1.toFixed(2)} d=${dd.toFixed(1)}`);
  ok('6 막대 옆에서 끝나도 쿨타임은 시작', near(a.spCd.flash, 300 - 1 / 60, 1e-9)); }
{ setWallMap(410, 600);                                                    // 도착점도 선 위도 설 곳이 없음: 취소
  const { w, a } = mk({ dummy: false });
  Core.step(w, [spell('p1', 'flash', { ang: 0, aimed: true })]);
  ok('6 설 곳이 없으면 이동 안 하고 "이동할 곳 없음", 쿨타임 소모 없음', hasText(w, '이동할 곳 없음') && a.x === AT.x && a.y === AT.y && a.spCd.flash === 0); }
setWallMap(0, 0);                                                          // 빈 맵으로 바꾸고 아래 스윕 전까지
{ // 스윕: 실제 맵의 여러 자리에서 여러 방향으로 점멸해도 벽 안에 끝나지 않음(또는 제자리)
  Core.setMap(REAL_MAP);
  const starts = [];
  for (let x = 150; x < 1250 && starts.length < 40; x += 97) for (let y = 200; y < 950 && starts.length < 40; y += 89) if (Core.canStand(x, y)) starts.push({ x, y });
  let bad = 0, tried = 0;
  for (const s of starts) {
    const w = Core.createWorld({ players: [{ id: 'p1', key: 'darius', team: 0 }], dummy: false });
    w.turrets.forEach(t => { t.dead = true; });
    const a = w.champs[0]; a.x = s.x; a.y = s.y;
    for (let k = 0; k < 12; k++) {
      const dd = Core.flashDest(w, a, k * PI / 6, true); tried++;
      if (!(Core.canStand(dd.x, dd.y) || (dd.x === s.x && dd.y === s.y))) bad++;
    }
  }
  ok(`6 스윕: ${starts.length}곳 × 12방향, 벽 안에 끝나는 경우 없음`, bad === 0 && tried > 300, `${bad} bad of ${tried}`); }

// ---------------------------------------------------------------------
// 7. 점멸과 평타 · 추적 · 아트록스 Q · 다리우스 R
// ---------------------------------------------------------------------
{ // 평타 선딜 중 점멸: 평타 취소. 버튼을 떼면 맞는 일 없음
  const { w, a, d } = mk(); put(d, a, 145, 0);
  Core.step(w, [inp('p1', 0, 0, true)]);
  ok('7 준비: 평타 선딜 중', !!a.atk);
  Core.step(w, [inp('p1', 0, 0, false), spell('p1', 'flash', { ang: -PI / 2, aimed: true })]);
  ok('7 점멸은 진행 중인 평타(선딜)를 취소', a.atk === null);
  const t0 = d.total;
  run(w, 1.5, []);
  ok('7 취소된 평타는 맞지 않음', d.total === t0, d.total - t0); }
{ // 자동 추적 중 점멸: 추적 취소, 평타 버튼을 떼고 쏘면 그 자리에서 다시 따라가지 않음(위치 그대로)
  const { w, a, d } = mk(); put(d, a, 350, 0);                             // 평타 사거리(175) 밖, 추적 사거리 안
  Core.step(w, [inp('p1', 0, 0, true)]);
  ok('7 준비: 평타 고정(추적) 중', !!a.lock);
  Core.step(w, [inp('p1', 0, 0, false), spell('p1', 'flash', { ang: -PI / 2, aimed: true })]);
  ok('7 점멸은 평타 고정(추적)을 취소', a.lock === null);
  const x0 = a.x, y0 = a.y;
  run(w, 1.0, []);
  ok('7 추적이 끊겨 뒤따르지 않음(위치 그대로)', a.x === x0 && a.y === y0); }
{ // 아트록스 Q 시전 중 점멸: Q는 점멸 뒤 위치에서 판정 (판정 도형은 아트록스를 따라감)
  const { w, a, d } = mk({ key: 'aatrox' });
  lvl(w, a, { q: 1 });
  Core.step(w, [cast('p1', 'q', 0)]);
  ok('7 준비: 아트록스 Q 시전 중(0.6초)', !!a.aq);
  run(w, 0.1, []);
  const fa = -3 * PI / 4;                                                // 북서쪽: x와 y가 같이 바뀜
  Core.step(w, [spell('p1', 'flash', { ang: fa, aimed: true })]);
  const ex = AT.x + px(400) * Math.cos(fa), ey = AT.y + px(400) * Math.sin(fa);
  ok('7 Q 시전 중 점멸 가능, Q는 계속 진행', near(a.x, ex, 1e-9) && near(a.y, ey, 1e-9) && !!a.aq);
  put(d, { x: ex, y: ey }, 200, 0);                                       // 점멸 뒤 위치 앞 200유닛(Q 1단계 몸통)
  Core.drainEvents(w);
  run(w, 0.6, []);
  const hit = fxOf(w, 'aqHit')[0];
  ok('7 Q 판정 위치 = 점멸 뒤 위치', !!hit && near(hit.x, ex, 1e-9) && near(hit.y, ey, 1e-9), hit && `${hit.x},${hit.y}`);
  ok('7 점멸 뒤 앞의 허수아비가 맞음', d.total > 0, d.total); }
{ // 다리우스 R 시전 중 점멸: 단두대 이동이 도착점에서 멈춤(원래 자리로 되돌아가지 않음)
  const { w, a, d } = mk();
  put(d, a, 200, 0);
  lvl(w, a, { r: 1 });
  Core.step(w, [cast('p1', 'r', 0)]);
  ok('7 준비: 다리우스 R 시전 중', !!a.cast && a.cast.type === 'r');
  const x1 = a.x;                                                        // 돌진 첫 틱으로 조금 움직인 자리에서 점멸
  Core.step(w, [spell('p1', 'flash', { ang: -PI / 2, aimed: true })]);
  const ex = x1, ey = AT.y - px(400);
  run(w, 0.5, []);
  ok('7 R 시전 뒤에도 점멸 도착점에 머묾', near(a.x, ex, 1e-6) && near(a.y, ey, 1e-6), `${a.x.toFixed(3)},${a.y.toFixed(3)}`);
  ok('7 R 단두대는 그래도 적중(허수아비 고정 피해)', d.total > 0, d.total); }

{ // 마스터 이 명상 중 점멸(성공): 명상이 끊기고, 끊긴 뒤 0.5초 피해 감소(명상 레벨 1: 45%)가 유지됨
  const { w, a } = mk({ key: 'yi' });
  lvl(w, a, { w: 1 });
  Core.step(w, [cast('p1', 'w', 0)]);
  ok('7 준비: 마스터 이 명상 중', !!a.med);
  Core.step(w, [spell('p1', 'flash', { ang: 0, aimed: true })]);
  ok('7 점멸(성공)하면 명상 끊김, 0.5초 피해 감소 시작(한 틱 지남)', a.med === null && near(a.medPost, 0.5 - TICK, 1e-9), `med ${a.med} medPost ${a.medPost}`);
  ok('7 끊긴 뒤 피해 감소 55%(받는 피해 ×0.55)', near(Core.dmgTakenMul(a), 0.55, 1e-9), Core.dmgTakenMul(a));
  run(w, 0.6, []);
  ok('7 0.5초가 지나면 피해 감소 끝', a.medPost === 0 && Core.dmgTakenMul(a) === 1, `${a.medPost} ${Core.dmgTakenMul(a)}`); }
{ setWallMap(410, 600);                                                    // 점멸 도착점이 막혀 취소되면 명상은 그대로
  const { w, a } = mk({ key: 'yi', dummy: false });
  lvl(w, a, { w: 1 });
  Core.step(w, [cast('p1', 'w', 0)]);
  Core.step(w, [spell('p1', 'flash', { ang: 0, aimed: true })]);
  ok('7 점멸 취소(설 곳 없음)면 명상은 그대로', !!a.med && hasText(w, '이동할 곳 없음'));
  Core.setMap(REAL_MAP); }

// ---------------------------------------------------------------------
// 8. 이벤트 (화면용): 점화 글자·이펙트, 점멸 이펙트, 쿨타임 안내
// ---------------------------------------------------------------------
{ const { w, a, d } = mk(); put(d, a, 150, 0);
  Core.step(w, [spell('p1', 'ignite')]);
  const fx = fxOf(w, 'ignite')[0];
  ok('8 점화 이펙트 fx {src, targetId}', !!fx && fx.src === 'p1' && fx.targetId === d.id, fx && JSON.stringify(fx));
  Core.drainEvents(w); }
{ const { w, a, d } = mk(); put(d, a, 150, 0);
  Core.step(w, [spell('p1', 'ignite')]);
  ok('8 시전 직후 대상 위 "점화" 글자(text 이벤트)', w.events.some(e => e.type === 'text' && e.txt === '점화' && e.x === d.x));
  Core.drainEvents(w); }

// ---------------------------------------------------------------------
// 9. 프로토콜: sp 행동 검사 · 명령 변환 · 버전
// ---------------------------------------------------------------------
{ ok('9 프로토콜 버전 13 이상(점화·점멸 추가 뒤)', P.VERSION >= 13, P.VERSION);
  ok('9 SPELL_KEYS = ignite, flash', JSON.stringify(P.SPELL_KEYS) === '["ignite","flash"]');
  const f = P.sanitizeFrame({ s: 5, mx: 0, my: 0, acts: [{ k: 'sp', s: 'ignite' }, { k: 'sp', s: 'flash', ang: 1.23456, aimed: true }] });
  ok('9 sp 행동: 점화(ang 없음)와 점멸(ang 반올림, aimed true) 통과', f.acts.length === 2 && f.acts[0].k === 'sp' && f.acts[0].s === 'ignite' && !('ang' in f.acts[0]) && f.acts[1].ang === 1.235 && f.acts[1].aimed === true, JSON.stringify(f.acts));
  const g = P.sanitizeFrame({ s: 6, acts: [{ k: 'sp', s: 'flash', aimed: 'yes', ang: 'x' }] });
  ok('9 sp 행동: aimed는 true만, ang가 숫자가 아니면 없음', g.acts.length === 1 && !('aimed' in g.acts[0]) && !('ang' in g.acts[0]), JSON.stringify(g.acts));
  const bad = P.sanitizeFrame({ s: 7, acts: [{ k: 'sp', s: 'ignite' }, { k: 'sp', s: 'blink' }, { k: 'sp' }, { k: 'sp', s: 'Ignite' }, { k: 'sp', s: 'heal' }] });   // 앞의 4개만 읽음
  ok('9 sp 행동: 없는 주문 이름은 버림(허용 목록)', bad.acts.length === 1 && bad.acts[0].s === 'ignite', JSON.stringify(bad.acts));
  const cmds = P.frameToCmds('p1', P.sanitizeFrame({ s: 8, acts: [{ k: 'sp', s: 'ignite' }, { k: 'sp', s: 'flash', ang: 0.5, aimed: true }, { k: 'sp', s: 'flash', ang: 1 }] }));
  ok('9 명령 변환: {type:spell, id, spell, ang, aimed?}', cmds[1].type === 'spell' && cmds[1].id === 'p1' && cmds[1].spell === 'ignite' && !('ang' in cmds[1]) && cmds[2].spell === 'flash' && cmds[2].ang === 0.5 && cmds[2].aimed === true && cmds[3].ang === 1 && cmds[3].aimed === undefined, JSON.stringify(cmds)); }

// ---------------------------------------------------------------------
// 10. 결정성: 같은 명령 순서 → 같은 월드, 프로토콜 복원(스냅샷 + 프레임 재시뮬)도 같음
// ---------------------------------------------------------------------
{ const play = () => {
    const { w, a, d, e } = mk({ key: 'aatrox', enemy: true });
    lvl(w, a, { q: 1, e: 1, r: 1 }); put(d, a, 150, 0); put(e, a, 300, 40);
    Core.step(w, [spell('p1', 'ignite')]); run(w, 0.8, []);
    Core.step(w, [spell('e1', 'ignite'), inp('p1', 1, 0, false)]); run(w, 0.4, [inp('p1', 0, 0, false)]);
    Core.step(w, [spell('p1', 'flash', { ang: 0.4, aimed: true })]); run(w, 2.0, []);
    Core.step(w, [cast('p1', 'r', 0), spell('p1', 'flash', { ang: 2, aimed: true })]); run(w, 6, []);
    return JSON.stringify(w);
  };
  ok('10 같은 명령 → 같은 월드(JSON 동일, 점화·점멸 포함)', play() === play()); }
{ const players = [{ id: 'p1', key: 'darius', team: 0 }, { id: 'p2', key: 'yi', team: 1 }];
  const server = Core.createWorld({ players, dummy: false, devMode: false });
  server.champs[0].x = 400; server.champs[0].y = 700; server.champs[1].x = 400 + px(150); server.champs[1].y = 700;
  const frames = [];
  for (let s = 1; s <= 320; s++) {
    const raw = { s, mx: Math.cos(s / 20) * 0.5, my: Math.sin(s / 33) * 0.5 };
    if (s === 2) raw.acts = [{ k: 'lv', skill: 'q' }, { k: 'lv', skill: 'e' }];
    if (s === 170) raw.acts = [{ k: 'sp', s: 'ignite' }];
    if (s === 200) raw.acts = [{ k: 'sp', s: 'flash', ang: 1.2, aimed: true }];
    frames.push(P.sanitizeFrame(raw, false));
  }
  let snap = null, ack = 0;
  for (let i = 0; i < 320; i++) {
    Core.step(server, P.frameToCmds('p1', frames[i]).concat(P.frameToCmds('p2', P.sanitizeFrame({ s: i + 1, mx: -0.5, my: 0.5 }))));
    Core.drainEvents(server);
    if (i === 150) { snap = P.slimWorld(server); ack = frames[i].s; }
  }
  const pred = P.restoreWorld(structuredClone(snap));
  for (const fr of frames.filter(x => x.s > ack)) Core.step(pred, P.frameToCmds('p1', fr));
  Core.drainEvents(pred);
  ok('10 프로토콜: 스냅샷 + 프레임 재시뮬 = 서버 (점화·점멸 포함)', JSON.stringify(P.slimWorld(pred)) === JSON.stringify(P.slimWorld(server)));
  ok('10 프로토콜로 들어온 점화·점멸이 서버에서 실제로 사용됨(쿨타임 기록)', server.champs[0].spCd.ignite > 170 && server.champs[0].spCd.flash > 290, `${server.champs[0].spCd.ignite.toFixed(2)} ${server.champs[0].spCd.flash.toFixed(2)}`); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
