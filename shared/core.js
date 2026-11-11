/* =====================================================================
   1v1 게임 규칙 코어 (core.js)
   - 화면, 입력 장치, 브라우저 API를 전혀 쓰지 않는 순수 규칙 코드입니다.
   - 브라우저(클라이언트)와 Node(나중의 서버)에서 똑같이 실행됩니다.
   - 시간은 고정 간격(TICK)으로만 흐르고, 난수와 실제 시계를 쓰지 않습니다.
     같은 월드에 같은 명령을 같은 순서로 넣으면 항상 같은 결과가 나옵니다.
   - 월드(world)는 순수 JSON 객체라서 그대로 스냅샷으로 보내거나 저장할 수 있습니다.

   사용법
     Core.setMap(walkRle)                         // 이동 가능 영역 로드(1회)
     const w = Core.createWorld({ players: [{ id, key, team }], dummy: true })
     Core.step(w, [{ type, id, ... }])            // 1틱(1/60초) 진행
     Core.drainEvents(w)                          // 화면용 이벤트(숫자, 이펙트, 배너) 가져가기

   명령(클라이언트 → 코어). 모든 명령에 id(보낸 챔피언)가 있습니다.
     { type:'input',   id, mx, my, atk }          // 이동 방향(-1~1)과 평타 버튼 상태
     { type:'cast',    id, skill:'q'|'w'|'e'|'r', ang }   // 스킬 시전(ang: 조준 각도, 라디안)
     { type:'levelup', id, skill }
     { type:'dev',     id, op, ... }              // 테스트 도구(world.devMode가 true일 때만)
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* ---------------------------------------------------------------------
   상수 / 데이터
   --------------------------------------------------------------------- */
const TICK = 1 / 60;                  // 고정 시간 간격(초)
const MAP_W = 1377, MAP_H = 1142;     // 맵 이미지 크기(px). 월드 좌표 = 맵 이미지 픽셀
const U = 0.235;                      // 1유닛 = 0.235px
const HIT_R = 55;                     // 챔피언 히트박스 반지름(유닛)
const START_LEVEL = 6;
const RESPAWN_SEC = 5;
const SPAWNS = [{ x: 132, y: 936 }, { x: 1224, y: 202 }];   // 팀 0, 팀 1 스폰 위치(px)
const HOME = { x: 700, y: 500 };      // 더미 기본 위치

const TURRET_CFG = {
  hp: 9000, ad: 182, adMax: 350, adStep: 12, adStart: 30, adEvery: 60,
  range: 775, armor: 60, mr: 60, as: 0.83, pen: 0.30,
  lock: 0.83,            // 사거리에 들어오면 이 시간 동안 경고, 끝나면 공격 시작
  boltTime: 0.2,         // 포탑 투사체가 날아가는 시간
  stackBonus: 0.5, stackMax: 3,
  reduction: 0.85, reductionUntil: 300,
  r: 175                 // 포탑 히트박스 반지름(유닛)
};

const CHAMPS = {
  darius: {
    name: '다리우스',
    b: { hp: 652, hpg: 114, regen: 10, regeng: 0.95, mana: 263, manag: 57.5, mregen: 6.6, mregeng: 0.35,
         ad: 64, adg: 5, as: 0.625, asg: 0.01, armor: 37, armorg: 5.2, mr: 32, mrg: 2.05, range: 175, ms: 340 }
  },
  yi: {
    name: '마스터 이',
    b: { hp: 640, hpg: 105, regen: 7.5, regeng: 0.65, mana: 251, manag: 42, mregen: 7.26, mregeng: 0.45,
         ad: 65, adg: 2.5, as: 0.679, asg: 0.025, armor: 33, armorg: 5, mr: 32, mrg: 2.05, range: 175, ms: 355 }
  }
};

/* 다리우스 패시브: 과다출혈 */
const BLEED = { dur: 5, max: 5, base: 13, perLvl: 1, ratio: 0.3, buffBase: 30, buffPerLvl: 5 };

/* 평타 한 번의 주기(1/공속)에 선딜·후딜이 포함됩니다. 주기 대비 비율 */
const WINDUP = 0.22, BACKSWING = 0.13;

/* 다리우스 액티브 스킬. 배열은 스킬 레벨 순서(1~5). 거리 단위는 유닛 */
const SK = {
  q: { name: '학살', max: 5, prep: 0.75, rIn: 205, rOut: 425, heal: 0.17, healMax: 0.51,
       blade: [50, 80, 110, 140, 170], bladeR: [1.0, 1.1, 1.2, 1.3, 1.4],
       handle: [17.5, 28, 39.5, 49, 59.5], handleR: [0.35, 0.385, 0.42, 0.455, 0.49],
       mana: [25, 30, 35, 40, 45], cd: [9, 7.75, 6.5, 5.25, 4] },
  w: { name: '무력화 일격', max: 5, ratio: [0.4, 0.45, 0.5, 0.55, 0.6], rangeBonus: 25, slow: 0.9, slowT: 1,
       mana: [40, 40, 40, 40, 40], cd: [5, 5, 5, 5, 5], refundCd: 0.5 },
  e: { name: '포획', max: 5, pen: [20, 25, 30, 35, 40], cast: 0.25, angle: 30, range: 535, air: 0.1, slow: 0.4, slowT: 1, pull: 0.2,
       mana: [70, 60, 50, 40, 30], cd: [26, 23.5, 21, 18.6, 16] },
  r: { name: '녹서스의 단두대', max: 1, base: 125, ratio: 0.75, perStack: 0.2, range: 525, cast: 0.36, mana: [100], cd: [120] }
};
const SKILL_KEYS = ['q', 'w', 'e', 'r'];

/* ---------------------------------------------------------------------
   기본 계산
   --------------------------------------------------------------------- */
const px = n => n * U;
const dmgMul = res => 1 / (1 + res * 0.01);          // 방어력/마법저항력 공식
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/* 레벨업 상승치 반영(레벨 L → (L-1)번 상승). 공격속도 상승치는 기본 공격속도에 대한 비율 */
function calcStats(key, level) {
  const b = CHAMPS[key].b, n = level - 1;
  return {
    maxHp: b.hp + b.hpg * n, regen: b.regen + b.regeng * n,
    maxMana: b.mana + b.manag * n, manaRegen: b.mregen + b.mregeng * n,
    ad: b.ad + b.adg * n, ap: 0,
    as: b.as * (1 + b.asg * n),
    armor: b.armor + b.armorg * n, mr: b.mr + b.mrg * n,
    range: b.range, ms: b.ms, pen: 0
  };
}

/* ---------------------------------------------------------------------
   맵 (이동 가능 영역)
   --------------------------------------------------------------------- */
let walk = null;
function setMap(rle) {   // rle[y] = [[시작x, 끝x), ...]
  walk = new Uint8Array(MAP_W * MAP_H);
  rle.forEach((runs, y) => { for (const r of runs) walk.fill(1, y * MAP_W + r[0], y * MAP_W + r[1]); });
}
const isWalk = (x, y) => { const xi = x | 0, yi = y | 0; return !!walk && xi >= 0 && yi >= 0 && xi < MAP_W && yi < MAP_H && walk[yi * MAP_W + xi] === 1; };
const WALL_R = px(HIT_R) * 0.7;
function canStand(x, y) {
  if (!isWalk(x, y)) return false;
  for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; if (!isWalk(x + Math.cos(a) * WALL_R, y + Math.sin(a) * WALL_R)) return false; }
  return true;
}
function safePoint(from, to, ok) {
  for (let s = 1; s >= 0; s -= 0.1) { const x = from.x + (to.x - from.x) * s, y = from.y + (to.y - from.y) * s; if (ok(x, y)) return { x, y }; }
  return { x: from.x, y: from.y };
}

/* ---------------------------------------------------------------------
   월드 / 유닛 생성
   --------------------------------------------------------------------- */
function makeChamp(id, key, team) {
  const st = calcStats(key, START_LEVEL), sp = SPAWNS[team] || SPAWNS[0];
  return {
    kind: 'champ', id, team, key, level: START_LEVEL, stats: st, r: HIT_R,
    x: sp.x, y: sp.y, hp: st.maxHp, mana: st.maxMana, facing: 1,
    in: { mx: 0, my: 0, atk: false, edge: false },
    atkCd: 0, atk: null, noTgt: 0, lunge: 0, lungeDir: [1, 0], moving: false,
    might: 0, sk: { q: 0, w: 0, e: 0, r: 0 }, sp: START_LEVEL, cd: { q: 0, w: 0, e: 0, r: 0 },
    wBuff: false, cast: null, qPrep: null,
    air: 0, airMax: 1, slow: null, pull: null, pendSlow: false, bleed: null,
    dead: false, respawn: 0
  };
}
function makeDummy(id, team) {
  return { kind: 'dummy', id, team, x: HOME.x, y: HOME.y, r: 70, hp: 5000, maxHp: 5000, armor: 0,
           total: 0, hits: [], idle: 0, flash: 0, air: 0, airMax: 0.1, slow: null, pull: null, pendSlow: false, homeT: 0, bleed: null };
}
function makeTurret(id, team, x, y) {
  return { kind: 'turret', id, team, x, y, r: TURRET_CFG.r, hp: TURRET_CFG.hp, maxHp: TURRET_CFG.hp,
           cd: 0, shot: null, warn: 0, locked: false, stacks: 0, targetId: null, dead: false, deadT: 0 };
}
function createWorld(opts) {
  opts = opts || {};
  const w = { time: 0, devT: 0, devMode: opts.devMode !== false, events: [], champs: [], dummies: [], turrets: [] };
  for (const p of (opts.players || [])) w.champs.push(makeChamp(p.id, p.key, p.team || 0));
  w.turrets.push(makeTurret('t_ally', 0, 290, 722), makeTurret('t_foe', 1, 1063, 288));
  if (opts.dummy !== false) w.dummies.push(makeDummy('dummy1', 1));
  return w;
}

/* ---------------------------------------------------------------------
   조회 도우미
   --------------------------------------------------------------------- */
const gameTime = w => w.time + w.devT;
const champOf = (w, id) => w.champs.find(c => c.id === id) || null;
const unitOf = (w, id) => champOf(w, id) || w.dummies.find(d => d.id === id) || w.turrets.find(t => t.id === id) || null;
const isChampLike = u => u.kind === 'champ' || u.kind === 'dummy';      // 과다출혈·끌어당김·회복 대상
const alive = u => !u.dead;
const edgeDist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) - px(a.r) - px(b.r);   // 히트박스 끝 ~ 히트박스 끝
function enemiesOf(w, c) {
  return [].concat(w.champs, w.dummies, w.turrets).filter(u => u.team !== c.team && alive(u));
}
function targetInRange(w, c) {
  const range = px(c.stats.range + (c.wBuff ? SK.w.rangeBonus : 0));
  let best = null, bd = Infinity;
  for (const u of enemiesOf(w, c)) { const d = edgeDist(u, c); if (d <= range && d < bd) { best = u; bd = d; } }
  return best;
}
function ultTarget(w, c) {
  let best = null, bd = Infinity;
  for (const u of enemiesOf(w, c)) { if (!isChampLike(u)) continue; const d = edgeDist(u, c); if (d <= px(SK.r.range) && d < bd) { best = u; bd = d; } }
  return best;
}
function autoAim(w, c, champOnly) {   // 가장 가까운 적 방향, 없으면 바라보는 방향
  let best = null, bd = Infinity;
  for (const u of enemiesOf(w, c)) { if (champOnly && !isChampLike(u)) continue; const d = Math.hypot(u.x - c.x, u.y - c.y); if (d < bd) { bd = d; best = u; } }
  return best ? Math.atan2(best.y - c.y, best.x - c.x) : (c.facing < 0 ? Math.PI : 0);
}
function dummyDps(w, d) { const from = w.time - 5; let s = 0; for (const h of d.hits) if (h.t >= from) s += h.d; return s / 5; }

/* 챔피언 파생 수치 */
const buffAD = c => c.might > 0 ? BLEED.buffBase + BLEED.buffPerLvl * (c.level - 1) : 0;
const curAD = c => c.stats.ad + buffAD(c);
const penPct = c => c.stats.pen + (c.sk.e > 0 ? SK.e.pen[c.sk.e - 1] : 0);   // 물리관통력(%)
const bleedPerStack = c => BLEED.base + BLEED.perLvl * (c.level - 1);
const bleedTotal = (c, n) => n * bleedPerStack(c) + curAD(c) * BLEED.ratio * n;
const skIdx = (k, lv) => Math.min(Math.max(lv, 1), SK[k].mana.length) - 1;
const skMana = (c, k) => SK[k].mana[skIdx(k, c.sk[k])];
const skCd = (c, k) => SK[k].cd[skIdx(k, c.sk[k])];
function turretAD(t) {
  const c = TURRET_CFG;
  if (t < c.adStart) return c.ad;
  return Math.min(c.adMax, c.ad + c.adStep * (Math.floor((t - c.adStart) / c.adEvery) + 1));
}

/* ---------------------------------------------------------------------
   이벤트 (화면 전용. 규칙에는 영향을 주지 않음)
   --------------------------------------------------------------------- */
const emit = (w, ev) => { w.events.push(ev); };
const text = (w, x, y, txt, color, big, to) => emit(w, { type: 'text', x, y, txt, color, big: !!big, to });
const fx = (w, f) => emit(w, Object.assign({ type: 'fx' }, f));
const banner = (w, txt, bad, sec) => emit(w, { type: 'banner', txt, bad: !!bad, sec });
function drainEvents(w) { const e = w.events; w.events = []; return e; }

/* ---------------------------------------------------------------------
   피해 / 처치 / 상태이상
   --------------------------------------------------------------------- */
const armorOf = u => u.kind === 'champ' ? u.stats.armor : u.kind === 'dummy' ? (u.armor || 0) : TURRET_CFG.armor;
function physMulFor(w, target, pen) {   // pen: 물리관통력(%)
  let m = dmgMul(armorOf(target) * (1 - pen / 100));
  if (target.kind === 'turret' && gameTime(w) < TURRET_CFG.reductionUntil) m *= (1 - TURRET_CFG.reduction);
  return m;
}
function hurt(w, t, a) {
  t.hp = Math.max(0, t.hp - a);
  if (t.kind === 'dummy') { t.total += a; t.hits.push({ t: w.time, d: a }); t.idle = 0; t.flash = 0.12; }
  return a;
}
const dealPhys = (w, c, t, raw) => hurt(w, t, raw * physMulFor(w, t, penPct(c)));
const dealTrue = (w, t, raw) => hurt(w, t, raw);     // 고정 피해: 방어력·마법저항력·관통력 모두 무시

function settle(w, t) {     // 체력이 0이면 처치 처리하고 true
  if (t.hp > 0) return false;
  if (t.kind === 'dummy') { t.hp = t.maxHp; t.bleed = null; banner(w, '더미 처치 · 체력 초기화', false, 1.5); }
  else if (t.kind === 'champ') {
    t.dead = true; t.respawn = RESPAWN_SEC; t.atk = null; t.cast = null; t.qPrep = null; t.wBuff = false;
    t.air = 0; t.pull = null; t.slow = null; t.bleed = null; t.pendSlow = false; t.moving = false;
  } else { t.dead = true; t.deadT = 0; t.shot = null; banner(w, '포탑 파괴! 공격 테스트 완료', false, 4); }
  return true;
}
function addSlow(u, pct, sec) { const c = u.slow; u.slow = { pct: Math.max(pct, c ? c.pct : 0), t: Math.max(sec, c ? c.t : 0) }; }

/* 다리우스 패시브: 과다출혈 */
function applyBleed(w, c, t) {
  if (c.key !== 'darius' || !isChampLike(t) || t.dead) return;
  const prev = t.bleed ? t.bleed.stacks : 0;
  const stacks = c.might > 0 ? BLEED.max : Math.min(BLEED.max, prev + 1);
  if (stacks >= BLEED.max && prev < BLEED.max) c.might = BLEED.dur;    // 최대 중첩에 도달하면 공격력 증가 시작
  // 한 번 더 중첩되면 타이머를 5초로 되돌리고, 새 중첩 수 기준 피해를 5초에 나눠 입힘
  t.bleed = { stacks, t: BLEED.dur, total: bleedTotal(c, stacks), acc: 0, txtT: 0, src: c.id, pen: penPct(c) };
}

/* 끌려오기 · 공중에 뜸 · 둔화 · 출혈 진행 (챔피언/더미 공통) */
function tickStatus(w, u, dt) {
  if (u.pull) {
    const pl = u.pull; pl.t += dt;
    const p = Math.min(1, pl.t / pl.dur), e = 1 - (1 - p) * (1 - p);
    u.x = pl.fx + (pl.tx - pl.fx) * e; u.y = pl.fy + (pl.ty - pl.fy) * e;
    if (p >= 1) {
      u.pull = null; u.air = SK.e.air; u.airMax = SK.e.air; u.pendSlow = true; u.homeT = 0;
      text(w, u.x, u.y - px(60), '공중에 뜸', '#cfe8ff');
    }
  }
  if (u.air > 0) { u.air = Math.max(0, u.air - dt); if (u.air <= 0 && u.pendSlow) { u.pendSlow = false; addSlow(u, SK.e.slow, SK.e.slowT); } }
  if (u.slow) { u.slow.t -= dt; if (u.slow.t <= 0) u.slow = null; }
  const b = u.bleed;
  if (b && !u.dead) {
    const use = Math.min(dt, b.t), d = b.total / BLEED.dur * use * dmgMul(armorOf(u) * (1 - b.pen / 100));
    hurt(w, u, d);
    b.acc += d; b.txtT += use; b.t -= dt;
    if (b.txtT >= 1 || b.t <= 0) { if (b.acc >= 1) text(w, u.x + 14, u.y - 62, Math.round(b.acc) + '', '#ff5a6a'); b.acc = 0; b.txtT = 0; }
    if (b.t <= 0) u.bleed = null;
    settle(w, u);
  }
}

/* ---------------------------------------------------------------------
   이동 / 충돌
   --------------------------------------------------------------------- */
function pushOut(w, self, q) {
  for (const t of w.turrets.concat(w.dummies)) {
    if (t.dead || t === self) continue;
    const dx = q.x - t.x, dy = q.y - t.y, d = Math.hypot(dx, dy) || 0.001;
    const min = px(t.r) + px(HIT_R) * 0.8;
    if (d < min) { q.x = t.x + dx / d * min; q.y = t.y + dy / d * min; }
  }
}
function stepMove(w, c, dx, dy) {
  const tryAt = (mx, my) => { const q = { x: c.x + mx, y: c.y + my }; pushOut(w, c, q); return canStand(q.x, q.y) ? q : null; };
  let q = tryAt(dx, dy);
  if (!q) {   // 벽에 막히면 비스듬히 미끄러짐
    const ang = Math.atan2(dy, dx), len = Math.hypot(dx, dy);
    for (const a of [0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4]) {
      q = tryAt(Math.cos(ang + a) * len * Math.cos(a), Math.sin(ang + a) * len * Math.cos(a));
      if (q) break;
    }
  }
  if (q) { c.x = q.x; c.y = q.y; return true; }
  return false;
}

/* ---------------------------------------------------------------------
   평타
   --------------------------------------------------------------------- */
function startAttack(w, c, t) {
  const cyc = 1 / c.stats.as;
  c.atkCd = cyc;
  c.facing = t.x < c.x ? -1 : 1;
  c.atk = { t: 0, wind: cyc * WINDUP, back: cyc * BACKSWING, targetId: t.id, hit: false };
}
function strike(w, c, t) {
  const ad = curAD(c);
  c.facing = t.x < c.x ? -1 : 1;
  const ang = Math.atan2(t.y - c.y, t.x - c.x);
  c.lunge = 1; c.lungeDir = [Math.cos(ang), Math.sin(ang)];
  const ex = t.x - Math.cos(ang) * px(t.r) * 0.85, ey = t.y - Math.sin(ang) * px(t.r) * 0.85 - 22;
  const dmg = dealPhys(w, c, t, ad);
  fx(w, { fx: 'slash', x: ex, y: ey, ang, life: 0.2 });
  text(w, ex, ey - 12, dmg < 10 ? dmg.toFixed(1) : dmg.toFixed(0), '#ffe2a8');
  let wUsed = false;
  if (c.wBuff) {   // 스킬 2: 강화된 기본 공격
    c.wBuff = false; wUsed = true;
    const bonus = dealPhys(w, c, t, SK.w.ratio[c.sk.w - 1] * ad);
    text(w, ex + 12, ey - 28, bonus < 10 ? bonus.toFixed(1) : bonus.toFixed(0), '#ffb04a', true);
    if (isChampLike(t)) addSlow(t, SK.w.slow, SK.w.slowT);
  }
  applyBleed(w, c, t);
  if (settle(w, t) && wUsed) {   // 처치하면 마나 환급 + 남은 재사용 대기시간 50% 감소
    c.mana = Math.min(c.stats.maxMana, c.mana + SK.w.mana[c.sk.w - 1]); c.cd.w *= SK.w.refundCd;
    text(w, c.x, c.y - px(75), '마나 환급 · 재사용 대기 -50%', '#8fd0ff');
  }
}

/* ---------------------------------------------------------------------
   스킬
   --------------------------------------------------------------------- */
function levelUp(w, c, k) {
  if (c.dead || c.key !== 'darius' || !SK[k] || c.sp <= 0 || c.sk[k] >= SK[k].max) return;
  c.sk[k]++; c.sp--;
  text(w, c.x, c.y - px(80), `${SK[k].name} Lv.${c.sk[k]}`, '#ffd23f');
}

function castSkill(w, c, k, ang) {
  if (c.dead || c.key !== 'darius' || !SK[k]) return;
  const say = (m, col) => text(w, c.x, c.y - px(75), m, col || '#b8c4cf', false, c.id);
  const lv = c.sk[k];
  if (c.air > 0 || c.pull) return;
  if (!lv) { say('스킬 레벨 0 · ▲로 레벨업'); return; }
  if (c.cast) return;
  if (c.cd[k] > 0) { say('재사용 대기 중'); return; }
  const cost = skMana(c, k);
  if (c.mana < cost) { say('마나 부족', '#8fb6e8'); return; }
  if (k === 'w' && c.wBuff) { say('이미 강화됨'); return; }
  if (!Number.isFinite(ang)) ang = c.facing < 0 ? Math.PI : 0;
  let tgt = null;
  if (k === 'r') { tgt = ultTarget(w, c); if (!tgt) { say('사거리 내 대상 없음'); return; } }
  c.mana -= cost; c.cd[k] = skCd(c, k);
  c.atk = null;                                       // 스킬을 쓰면 진행 중이던 평타 동작은 취소
  if (k === 'e') c.facing = Math.cos(ang) < 0 ? -1 : 1;
  if (k === 'q') {                                    // 준비 시간 후 휘두름. 준비 중에도 이동 가능
    c.qPrep = { t: 0, dur: SK.q.prep, lv };
  } else if (k === 'w') {
    c.wBuff = true;
  } else if (k === 'e') {
    c.cast = { type: 'e', t: 0, dur: SK.e.cast, ang };
    fx(w, { fx: 'fan', x: c.x, y: c.y, ang, range: px(HIT_R + SK.e.range), half: SK.e.angle / 2 * Math.PI / 180, life: 0.3 });
  } else {
    const d = Math.hypot(tgt.x - c.x, tgt.y - c.y) || 1, stop = px(tgt.r + HIT_R * 0.8 + 12);
    const to = d > stop ? { x: tgt.x - (tgt.x - c.x) / d * stop, y: tgt.y - (tgt.y - c.y) / d * stop } : { x: c.x, y: c.y };
    c.cast = { type: 'r', t: 0, dur: SK.r.cast, targetId: tgt.id, from: { x: c.x, y: c.y }, to: safePoint(c, to, canStand) };
    c.facing = tgt.x < c.x ? -1 : 1;
  }
}

function doDecimate(w, c, lv) {   // 학살: 도끼 자루(안쪽) / 도끼날(바깥 띠). 거리는 내 히트박스 끝부터
  const q = SK.q, ad = curAD(c), Ro = px(HIT_R + q.rOut), Ri = px(HIT_R + q.rIn), i = lv - 1;
  fx(w, { fx: 'sweep', x: c.x, y: c.y, a0: -Math.PI / 2, ro: Ro, ri: Ri, life: 0.3 });
  let bladeChamps = 0;
  for (const t of enemiesOf(w, c)) {
    const d = Math.hypot(t.x - c.x, t.y - c.y);
    if (d - px(t.r) > Ro) continue;
    const ty = t.y - 40;
    if (d <= Ri) {   // 도끼 자루: 과다출혈 없음, 회복 없음
      const v = dealPhys(w, c, t, q.handle[i] + q.handleR[i] * ad);
      text(w, t.x - 10, ty, v < 10 ? v.toFixed(1) : v.toFixed(0), '#ffd08a');
    } else {         // 도끼날: 과다출혈 + 맞힌 챔피언마다 잃은 체력 17% 회복(최대 51%)
      const v = dealPhys(w, c, t, q.blade[i] + q.bladeR[i] * ad);
      text(w, t.x + 10, ty, v < 10 ? v.toFixed(1) : v.toFixed(0), '#ff6b6b', true);
      if (isChampLike(t)) { applyBleed(w, c, t); bladeChamps++; }
    }
    settle(w, t);
  }
  if (bladeChamps > 0 && !c.dead) {
    const heal = (c.stats.maxHp - c.hp) * Math.min(q.healMax, q.heal * bladeChamps);
    if (heal > 0) { c.hp += heal; text(w, c.x, c.y - px(95), '+' + heal.toFixed(0), '#6df0a0', true); }
  }
}

function finishCast(w, c, cast) {
  if (cast.type === 'e') {   // 포획: 부채꼴 30°, 내 히트박스 끝부터 535 안의 적을 끌어당김
    let hit = 0;
    for (const t of enemiesOf(w, c)) {
      if (!isChampLike(t)) continue;
      const dx = t.x - c.x, dy = t.y - c.y, d = Math.hypot(dx, dy) || 1;
      const half = (SK.e.angle / 2) * Math.PI / 180 + Math.asin(Math.min(1, px(t.r) / d));
      if (d - px(t.r) > px(HIT_R + SK.e.range) || angDiff(Math.atan2(dy, dx), cast.ang) > half) continue;
      const stop = px(t.r + HIT_R * 0.8 + 15);
      const dest = safePoint(t, { x: c.x + dx / d * stop, y: c.y + dy / d * stop }, isWalk);
      t.pull = { t: 0, dur: SK.e.pull, fx: t.x, fy: t.y, tx: dest.x, ty: dest.y, src: c.id };
      t.pendSlow = false; t.air = 0;
      applyBleed(w, c, t);                         // 포획도 과다출혈을 중첩시킴
      hit++;
    }
    text(w, c.x, c.y - px(75), hit ? '포획!' : '빗나감', hit ? '#ffb04a' : '#b8c4cf', !!hit);
  } else {                   // 녹서스의 단두대: 반드시 명중, 고정 피해
    const t = unitOf(w, cast.targetId);
    if (!t || t.dead) return;
    const stacks = t.bleed ? t.bleed.stacks : 0;
    const total = (SK.r.base + SK.r.ratio * curAD(c)) * (1 + SK.r.perStack * stacks);
    dealTrue(w, t, total);
    t.bleed = null;                                // 단두대에 맞은 적은 과다출혈 중첩이 모두 사라짐
    fx(w, { fx: 'gui', x: t.x, y: t.y - 30, life: 0.45 });
    text(w, t.x, t.y - 62, `${total.toFixed(0)} 고정 피해`, '#ffffff', true);
    if (settle(w, t)) c.might = BLEED.dur;         // 단두대로 처치하면 공격력 증가
  }
}

/* ---------------------------------------------------------------------
   챔피언 한 틱
   --------------------------------------------------------------------- */
function respawn(w, c) {
  const keep = { sk: c.sk, sp: c.sp, in: c.in };
  Object.assign(c, makeChamp(c.id, c.key, c.team), keep);
}

function updateChamp(w, c, dt) {
  if (c.dead) { c.respawn -= dt; if (c.respawn <= 0) respawn(w, c); return; }
  const s = c.stats;
  c.hp = Math.min(s.maxHp, c.hp + s.regen / 5 * dt);              // 체력 재생: 5초당 수치만큼
  c.mana = Math.min(s.maxMana, c.mana + s.manaRegen / 5 * dt);    // 마나 재생: 5초당 수치만큼
  c.might = Math.max(0, c.might - dt);
  tickStatus(w, c, dt);
  if (c.dead) return;

  // 공중에 뜸 / 끌려오는 중: 하려던 모든 행동이 취소되고 아무 행동도 할 수 없음 (피격은 그대로)
  const locked = c.air > 0 || !!c.pull;
  if (locked) { c.atk = null; c.cast = null; c.qPrep = null; }
  for (const k of SKILL_KEYS) c.cd[k] = Math.max(0, c.cd[k] - dt);

  // 학살 준비 → 휘두르기
  if (c.qPrep) { c.qPrep.t += dt; if (c.qPrep.t >= c.qPrep.dur) { const lv = c.qPrep.lv; c.qPrep = null; doDecimate(w, c, lv); } }
  // 평타 선딜 → 타격 → 후딜
  if (c.atk) {
    const a = c.atk; a.t += dt;
    if (!a.hit && a.t >= a.wind) { a.hit = true; const t = unitOf(w, a.targetId); if (t && !t.dead) strike(w, c, t); }
    if (a.t >= a.wind + a.back) c.atk = null;
  }
  // 시전 시간(포획, 단두대): 시전 중에는 이동 불가
  if (c.cast) {
    const k = c.cast; k.t += dt;
    if (k.type === 'r') { const p = Math.min(1, k.t / k.dur); c.x = k.from.x + (k.to.x - k.from.x) * p; c.y = k.from.y + (k.to.y - k.from.y) * p; }
    if (k.t >= k.dur) { c.cast = null; finishCast(w, c, k); }
  }
  if (c.dead) return;

  // 이동
  let mx = c.in.mx, my = c.in.my;
  if (c.atk || c.cast || locked) { mx = 0; my = 0; }              // 평타·시전 중, 공중에 뜬 동안에는 멈춤
  c.moving = !!(mx || my);
  if (c.moving) {
    const sp = px(s.ms) * (1 - (c.slow ? c.slow.pct : 0)) * dt;
    stepMove(w, c, mx * sp, my * sp);
    if (Math.abs(mx) > 0.15) c.facing = mx < 0 ? -1 : 1;
  }

  // 평타 입력
  c.atkCd = Math.max(0, c.atkCd - dt);
  c.noTgt = Math.max(0, c.noTgt - dt);
  if (!locked && !c.cast && c.in.atk) {
    const t = targetInRange(w, c);
    if (t) { if (c.atkCd <= 0 && !c.atk) startAttack(w, c, t); }
    else if (c.in.edge && c.noTgt <= 0) { text(w, c.x, c.y - px(70), '사거리 내 대상 없음', '#b8c4cf', false, c.id); c.noTgt = 0.8; }
  }
  c.in.edge = false;
  c.lunge = Math.max(0, c.lunge - dt / 0.16);
}

/* ---------------------------------------------------------------------
   더미 / 포탑 한 틱
   --------------------------------------------------------------------- */
function updateDummy(w, d, dt) {
  d.idle += dt; d.flash = Math.max(0, d.flash - dt);
  tickStatus(w, d, dt);
  // 끌려온 뒤 3초가 지나면 제자리로 돌아감
  if (!d.pull && d.air <= 0 && (d.x !== HOME.x || d.y !== HOME.y)) {
    d.homeT += dt;
    if (d.homeT > 3) {
      const dx = HOME.x - d.x, dy = HOME.y - d.y, dd = Math.hypot(dx, dy), sp = px(340) * (1 - (d.slow ? d.slow.pct : 0)) * dt;
      if (dd <= sp) { d.x = HOME.x; d.y = HOME.y; } else { d.x += dx / dd * sp; d.y += dy / dd * sp; }
    }
  }
  while (d.hits.length && d.hits[0].t < w.time - 5) d.hits.shift();
  if (d.idle > 4 && d.hp < d.maxHp) d.hp = Math.min(d.maxHp, d.hp + d.maxHp * dt);   // 4초 동안 안 맞으면 회복
}

function resetTurretLock(t) { t.targetId = null; t.warn = 0; t.locked = false; t.shot = null; t.stacks = 0; }
function updateTurret(w, t, dt) {
  const c = TURRET_CFG;
  if (t.dead) { t.deadT += dt; return; }
  t.cd = Math.max(0, t.cd - dt);
  let tgt = t.targetId ? champOf(w, t.targetId) : null;
  if (tgt && (tgt.dead || edgeDist(t, tgt) > px(c.range))) {
    if (t.warn > 0 && !t.locked && !tgt.dead) text(w, tgt.x, tgt.y - px(40), '회피', '#9fd3ff');
    resetTurretLock(t); tgt = null;
  }
  if (!tgt) {   // 사거리 안의 가장 가까운 적 챔피언을 조준
    let bd = Infinity;
    for (const u of w.champs) {
      if (u.team === t.team || u.dead) continue;
      const d = edgeDist(t, u);
      if (d <= px(c.range) && d < bd) { bd = d; tgt = u; }
    }
    if (!tgt) return;
    resetTurretLock(t); t.targetId = tgt.id;
  }
  // 사거리에 들어오면 먼저 경고(0.83초). 끝나면 그때부터 공격 시작
  if (!t.locked) { t.warn += dt; if (t.warn >= c.lock) { t.locked = true; t.cd = 0; } }
  if (t.locked && t.cd <= 0 && !t.shot) { t.shot = { t: 0 }; t.cd = 1 / c.as; }
  if (t.shot) {
    t.shot.t += dt;
    if (t.shot.t >= c.boltTime) {
      t.shot = null;
      const eff = tgt.stats.armor * (1 - c.pen);
      const dmg = turretAD(gameTime(w)) * (1 + c.stackBonus * t.stacks) * dmgMul(eff);
      hurt(w, tgt, dmg);
      text(w, tgt.x, tgt.y - px(40), dmg.toFixed(0), '#ff6b6b', true);
      t.stacks = Math.min(c.stackMax, t.stacks + 1);
      if (settle(w, tgt)) resetTurretLock(t);
    }
  }
}

/* ---------------------------------------------------------------------
   명령 처리 / 한 틱 진행
   --------------------------------------------------------------------- */
function devOp(w, c, cmd) {
  switch (cmd.op) {
    case 'air': if (!c.dead) { c.air = 1; c.airMax = 1; c.atk = null; c.cast = null; c.qPrep = null; text(w, c.x, c.y - px(75), '공중에 뜸', '#cfe8ff', true); } break;
    case 'ready': for (const k of SKILL_KEYS) c.cd[k] = 0; c.mana = c.stats.maxMana; break;
    case 'time': w.devT += cmd.sec || 0; break;
    case 'spawn': { const sp = SPAWNS[c.team] || SPAWNS[0]; c.x = sp.x; c.y = sp.y; break; }
    case 'turretReset': for (const t of w.turrets) if (t.team !== c.team) { t.hp = t.maxHp; t.dead = false; resetTurretLock(t); t.cd = 0; } break;
    case 'dummyReset': for (const d of w.dummies) { d.x = HOME.x; d.y = HOME.y; d.pull = null; d.air = 0; d.slow = null; d.pendSlow = false; d.bleed = null; d.hp = d.maxHp; d.total = 0; d.hits = []; d.idle = 0; d.flash = 0; } break;
    case 'dummyArmor': for (const d of w.dummies) d.armor = d.armor >= 60 ? 0 : d.armor + 30; break;
  }
}
function applyCommand(w, cmd) {
  const c = cmd && champOf(w, cmd.id);
  if (!c) return;
  switch (cmd.type) {
    case 'input': {
      let mx = Number(cmd.mx) || 0, my = Number(cmd.my) || 0; const m = Math.hypot(mx, my);
      if (m > 1) { mx /= m; my /= m; }
      c.in.mx = mx; c.in.my = my;
      if (cmd.atk && !c.in.atk) c.in.edge = true;
      c.in.atk = !!cmd.atk;
      break;
    }
    case 'cast': castSkill(w, c, cmd.skill, Number(cmd.ang)); break;
    case 'levelup': levelUp(w, c, cmd.skill); break;
    case 'dev': if (w.devMode) devOp(w, c, cmd); break;
  }
}

function step(w, cmds) {
  if (cmds) for (const cmd of cmds) applyCommand(w, cmd);
  const dt = TICK;
  w.time += dt;
  for (const c of w.champs) updateChamp(w, c, dt);
  for (const t of w.turrets) updateTurret(w, t, dt);
  for (const d of w.dummies) updateDummy(w, d, dt);
}

return {
  // 데이터
  TICK, MAP_W, MAP_H, U, HIT_R, START_LEVEL, RESPAWN_SEC, SPAWNS, HOME, TURRET_CFG, CHAMPS, BLEED, WINDUP, BACKSWING, SK, SKILL_KEYS,
  // 규칙
  setMap, isWalk, canStand, createWorld, step, drainEvents, calcStats,
  // 조회
  px, gameTime, champOf, unitOf, isChampLike, edgeDist, enemiesOf, targetInRange, ultTarget, autoAim, dummyDps,
  buffAD, curAD, penPct, bleedPerStack, bleedTotal, skMana, skCd, turretAD
};
});
