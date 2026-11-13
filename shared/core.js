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
  },
  garen: {                                   // DESIGN_GAREN.md §2-1 (마나 없음: 최대 마나·재생 0)
    name: '가렌',
    b: { hp: 690, hpg: 98, regen: 8, regeng: 0.5, mana: 0, manag: 0, mregen: 0, mregeng: 0,
         ad: 69, adg: 4.5, as: 0.625, asg: 0.0365, armor: 38, armorg: 4.2, mr: 32, mrg: 1.55, range: 175, ms: 340 }
  },
  aatrox: {                                  // DESIGN_AATROX.md §2-1 (원문 docs/spec/aatrox.md). 마나 없음
    name: '아트록스',
    /* 체력 재생 3(+0.5)은 원문 빈칸이라 임시값(DESIGN_AATROX A1). 확정되면 regen/regeng만 고치면 됨 */
    b: { hp: 650, hpg: 114, regen: 3, regeng: 0.5, mana: 0, manag: 0, mregen: 0, mregeng: 0,
         ad: 60, adg: 5, as: 0.651, asg: 0.025, armor: 38, armorg: 4.8, mr: 32, mrg: 2.05, range: 175, ms: 345 }
  }
};

/* 다리우스 패시브: 과다출혈. ratio = 중첩당 추가 공격력 계수(사용자 수정 2026-11-12: 총 공격력 → 추가 공격력) */
const BLEED = { dur: 5, max: 5, base: 13, perLvl: 1, ratio: 0.3, buffBase: 30, buffPerLvl: 5 };

/* 평타 한 번의 주기(1/공속)에 선딜·후딜이 포함됩니다. 주기 대비 비율 */
const WINDUP = 0.22, BACKSWING = 0.13;

/* 평타 자동 추적 (docs/spec/attack-chase.md). search: 찾는 거리(히트박스 끝 기준, 유닛).
   추적 중 대상이 search + 300 유닛보다 멀어지면 포기 */
const CHASE = { search: 1200 };

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

/* 마스터 이 (DESIGN_YI.md §3~§7, 원문 docs/spec/yi.md). 거리 단위는 유닛 */
const YI_PASSIVE = { every: 4, ratio: 0.5, extraDelay: 0.12 };
const SKILLS = {
  darius: SK,
  yi: {
    q: { name: '일격필살', max: 5, range: 600, dmg: [35, 70, 105, 140, 175], ratio: 1.225, share: 0.25,
         first: 0.2, gap: 0.22, hits: 4, appear: 0.9, mana: [50, 55, 60, 65, 70], cd: [20, 19.5, 19, 18.5, 18], cdPerHit: 1 },
    w: { name: '명상', max: 5, dur: 4, heal: [30, 50, 70, 90, 100], apRatio: 0.25, manaBase: 40, manaPct: 0.06,
         cd: [10, 10, 10, 10, 10], drFirst: 0.7, drFirstT: 0.5, dr: [0.45, 0.475, 0.5, 0.525, 0.55], postT: 0.5, turretHalf: 0.5 },
    e: { name: '우주류 검술', max: 5, dur: 5, dmg: [20, 25, 30, 35, 40], ratio: 0.35, mana: [0, 0, 0, 0, 0], cd: [14, 14, 14, 14, 14] },   // ratio: 추가 공격력 계수(사용자 수정 2026-11-12)
    r: { name: '최후의 전사', max: 1, dur: 7, ms: 0.4, as: 0.25, mana: [100], cd: [85] }
  },
  /* 가렌 (DESIGN_GAREN.md §2-3~2-6, 원문 docs/spec/garen.md). 마나 소모는 0(skMana가 garen이면 0을 돌려줌) */
  garen: {
    q: { name: '결정타', max: 5, dmg: [30, 60, 90, 120, 150], ratio: 1.5, silence: 1.5, ms: 0.35,
         msT: [1.4, 1.95, 2.5, 3.05, 3.6], empT: 4.5, cd: [8, 8, 8, 8, 8] },
    w: { name: '용기', max: 5, dur: 4, dr: [0.25, 0.29, 0.33, 0.37, 0.41], shield: [65, 85, 105, 125, 145], shieldBonusHp: 0.18,
         shieldT: 0.75, ten: 0.6, tenT: 0.75, perKill: 0.2, maxBonus: 30, cd: [22, 19.5, 17, 14.5, 12] },
    e: { name: '심판', max: 5, dur: 3, radius: 325, baseSpins: 7, asPerSpin: 0.25, dmg: [4, 7, 10, 13, 16],
         ratio: [0.4, 0.43, 0.46, 0.49, 0.52], nearestBonus: 0.25, shredHits: 6, shred: 0.25, shredT: 6, cancelLock: 0.5, cd: [9, 8.25, 7.5, 6.75, 6] },
    r: { name: '데마시아의 정의', max: 1, range: 400, cast: 0.435, base: [125, 200, 275], missPct: [0.25, 0.3, 0.35],
         cd: [120, 100, 80] }
  },
  /* 아트록스 (DESIGN_AATROX.md §2-3, 원문 docs/spec/aatrox.md). 거리 단위는 유닛. 마나 소모는 모두 0.
     Q 판정 도형 기준점 = 아트록스 중심(A8). 끝부분(sweet) 피해 = sdmg + sratio × 총 공격력(표의 값 그대로) */
  aatrox: {
    q: { name: '다르킨의 검', max: 5, cast: 0.6, window: 3, cd: [14, 12, 10, 8, 6], air: 0.25, mana: [0, 0, 0, 0, 0],
         s1: { len: 625, width: 180, sweetFrom: 450, dmg: [10, 25, 40, 55, 70], ratio: [0.6, 0.675, 0.75, 0.825, 0.9],
               sdmg: [17.5, 43.75, 70, 96.25, 122.5], sratio: [1.05, 1.18, 1.31, 1.44, 1.575] },
         s2: { back: 100, front: 475, wBack: 300, wFront: 450, sweetFrom: 300, dmg: [12.5, 31.25, 50, 68.75, 87.5], ratio: [0.75, 0.844, 0.94, 1.03, 1.125],
               sdmg: [21.9, 54.7, 87.5, 120.3, 153.1], sratio: [1.31, 1.48, 1.64, 1.8, 1.97] },
         s3: { off: 180, r: 300, sweetR: 200, dmg: [15, 37.5, 60, 82.5, 105], ratio: [0.9, 1.01, 1.125, 1.24, 1.35],
               sdmg: [26.25, 65.63, 105, 144.38, 183.75], sratio: [1.575, 1.77, 1.97, 2.17, 2.36] } },
    w: { name: '준비 중', max: 5, mana: [0, 0, 0, 0, 0], cd: [0, 0, 0, 0, 0] },   // 다음 단계에서 구현. 지금은 시전되지 않음
    e: { name: '준비 중', max: 5, mana: [0, 0, 0, 0, 0], cd: [0, 0, 0, 0, 0] },
    r: { name: '준비 중', max: 1, mana: [0], cd: [0] }
  }
};
/* 가렌 인내심(패시브, DESIGN_GAREN.md G5): 마지막 피해 후 8초가 지나면 초당 최대 체력의 0.5% 연속 회복 */
const GAREN_PASSIVE = { idle: 8, perSec: 0.005 };
/* 아트록스 사신 태세(패시브, DESIGN_AATROX.md §2-2). 비율은 소수(0.04 = 4%). 회복량은 마법 피해(마법 저항 적용 뒤)의 100% */
const AATROX_PASSIVE = { cd: 22, range: 50, pctBase: 0.04, pctPerLvl: 0.06 / 17, heal: 1.0, cdrHit: 2, cdrSweet: 4 };
/* 광역기(다리우스 Q, 가렌 E, 아트록스 Q)가 주는 피해의 흡혈 배율 (DESIGN.md §1-1, A9) */
const OMNI_AOE = 0.33;
const EPS = 1e-9;

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
    dead: false, respawn: 0,
    dstack: 0, dhit: null, yq: null, untarget: false, med: null, medPost: 0, medLv: 0, wuju: 0, hl: 0,
    chase: null, chaseHold: false,                    // 평타 자동 추적 대상 {targetId}. chaseHold: 조이스틱·스킬로 취소한 뒤 평타 버튼을 뗄 때까지 재추적 금지
    bonus: { ad: 0, hp: 0, as: 0, armor: 0, mr: 0, omni: 0 },  // 추가 스탯(아이템 등, 지금은 0). omni = 모든 피해 흡혈(0.2 = 20%). 부활해도 유지(respawn에서 보존)
    silence: null, shields: [], tenSrc: [], shred: null,  // 침묵 {t} · 보호막 [{amt,t,src}] · 강인함 [{pct,t}] · 방어력 감소 {t,pct}
    /* 가렌 상태(다른 챔피언에게는 비활성). 부활하면 courage만 남고 나머지는 초기화 */
    persT: 0,                                             // 마지막으로 피해를 받은 뒤 경과 초(인내심)
    gq: null, gqMs: 0, gqMsPct: 0,                        // 결정타 강화 {t,lv} · 결정타 이동속도 남은 초 · 그 비율
    gw: null,                                             // 용기 피해 감소 {t,lv}
    ge: null,                                             // 심판 회전 {t,lv,n,done,hits:{id:횟수}}
    gr: null,                                             // 데마시아의 정의 시전 {t,targetId,lv}
    courage: 0,                                           // 용기 영구 방어력·마법저항력 (0..30, 처치마다 +0.2)
    /* 아트록스 상태(다른 챔피언에게는 비활성). 부활하면 전부 초기화(apCd 0 = 사신 태세 준비됨) */
    apCd: 0,                                              // 사신 태세 재사용 대기 남은 초
    aq: null,                                             // Q 시전 중 {stage, t, ang, lv, x, y}
    aqNext: 1,                                            // 다음 Q 단계(1~3)
    aqWin: 0                                              // Q 재사용 창 남은 초(0이면 창 닫힘)
  };
}
function makeDummy(id, team) {
  return { kind: 'dummy', id, team, x: HOME.x, y: HOME.y, r: 70, hp: 5000, maxHp: 5000, armor: 0,
           total: 0, hits: [], idle: 0, flash: 0, air: 0, airMax: 0.1, slow: null, pull: null, pendSlow: false, homeT: 0, bleed: null, mr: 0,
           silence: null, shields: [], tenSrc: [], shred: null };
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
  return [].concat(w.champs, w.dummies, w.turrets).filter(u => u.team !== c.team && alive(u) && !u.untarget);
}
/* 평타 사거리(픽셀). 대상 선택과 자동 추적이 같이 씀. 아트록스는 사신 태세 준비 중(apCd 0)에 +50 */
const atkRange = c => px(c.stats.range + (c.wBuff ? SK.w.rangeBonus : 0) + (c.key === 'aatrox' && c.apCd <= 0 ? AATROX_PASSIVE.range : 0));
function targetInRange(w, c) {
  const range = atkRange(c);
  let best = null, bd = Infinity;
  for (const u of enemiesOf(w, c)) { const d = edgeDist(u, c); if (d <= range && d < bd) { best = u; bd = d; } }
  return best;
}
/* 자동 추적 대상: 찾는 거리(CHASE.search) 안의 가장 가까운 적 챔피언. 적 챔피언이 하나도 없으면 가장 가까운 더미(연습용) */
function chaseTarget(w, c) {
  const lim = px(CHASE.search);
  let champ = null, bc = Infinity, dummy = null, bdm = Infinity;
  for (const u of enemiesOf(w, c)) {
    const d = edgeDist(u, c);
    if (d > lim) continue;
    if (u.kind === 'champ') { if (d < bc) { champ = u; bc = d; } }
    else if (u.kind === 'dummy') { if (d < bdm) { dummy = u; bdm = d; } }
  }
  return champ || dummy;
}
/* 추적 중 플레이어가 조이스틱·스킬로 취소: 평타 버튼을 뗄 때까지 다시 추적하지 않음(누르고 있는 채로 곧바로 되살아나지 않게) */
function cancelChase(c) { if (c.chase) { c.chase = null; c.chaseHold = true; } }
function ultTarget(w, c) {
  let best = null, bd = Infinity;
  for (const u of enemiesOf(w, c)) { if (!isChampLike(u)) continue; const d = edgeDist(u, c); if (d <= px(SK.r.range) && d < bd) { best = u; bd = d; } }
  return best;
}
function yiQTarget(w, c) {   // 일격필살 자동 대상: 사거리 600 안에서 가장 가까운 대상 지정 가능한 적(없으면 null)
  let best = null, bd = Infinity;
  for (const u of enemiesOf(w, c)) { if (!isChampLike(u)) continue; const d = edgeDist(u, c); if (d <= px(SKILLS.yi.q.range) && d < bd) { best = u; bd = d; } }
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
/* 추가 공격력 = 아이템 등(c.bonus.ad) + 다리우스 패시브 공격력 버프 (기본·레벨로 얻는 공격력은 제외. DESIGN_GAREN.md G1) */
const bonusAD = c => c.bonus.ad + buffAD(c);
const totalAD = c => c.stats.ad + bonusAD(c);         // 총 공격력 = 기본 + 추가
const curAD = totalAD;                                // 기존 이름 유지(같은 값)
const bonusHP = c => c.bonus.hp;
const bonusASPct = c => CHAMPS[c.key].b.asg * (c.level - 1) + c.bonus.as;   // 공격속도 추가 비율(0.05 = +5%): 레벨 성장분 + 아이템
const penPct = c => c.stats.pen + (c.key === 'darius' && c.sk.e > 0 ? SK.e.pen[c.sk.e - 1] : 0);   // 물리관통력(%)
const bleedPerStack = c => BLEED.base + BLEED.perLvl * (c.level - 1);
/* n중첩 총량 = n × ((13+(L-1)) + 0.3 × 추가 공격력). 추가 공격력은 적용 시점 값(버프 포함). 기본 공격력은 계수에 안 들어감(사용자 수정 2026-11-12) */
const bleedTotal = (c, n) => n * bleedPerStack(c) + bonusAD(c) * BLEED.ratio * n;
const skillsOf = c => SKILLS[c.key];
const skIdx = (t, lv) => Math.min(Math.max(lv, 1), t.max) - 1;
const skMana = (c, k) => {
  if (c.key === 'garen') return 0;                                // 가렌: 모든 스킬 마나 소모 0 (DESIGN_GAREN.md §2-1)
  if (c.key === 'yi' && k === 'w') return SKILLS.yi.w.manaBase;   // 명상: 시전 시 40 (명상 중 초당 최대 마나 6% 유지 소모는 yiMedTick)
  const t = SKILLS[c.key][k]; return t.mana[skIdx(t, c.sk[k])];
};
const skCd = (c, k) => { const t = SKILLS[c.key][k]; return t.cd[skIdx(t, c.sk[k])]; };
/* 최후의 전사: 공격속도 = 기본 공속 × (1 + 성장% + 25%), 이동속도 ×1.4 */
const curAS = c => { const b = CHAMPS[c.key].b; return b.as * (1 + bonusASPct(c) + (c.hl > 0 ? SKILLS.yi.r.as : 0)); };
/* 이동속도: 기본 × (마스터 이 궁극기 +40%) × (가렌 결정타 +35%). 둔화는 이동 틱에서 따로 곱함 */
const curMS = c => {
  let m = c.hl > 0 ? c.stats.ms * (1 + SKILLS.yi.r.ms) : c.stats.ms;
  if (c.gqMs > 0) m *= 1 + c.gqMsPct;
  return m;
};
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
const armorOf = u => u.kind === 'champ' ? u.stats.armor + u.bonus.armor + (u.courage || 0) : u.kind === 'dummy' ? (u.armor || 0) : TURRET_CFG.armor;   // 챔피언: 기본 + 추가 방어력 + 용기(가렌 W 영구)
const mrOf = u => u.kind === 'champ' ? u.stats.mr + u.bonus.mr + (u.courage || 0) : u.kind === 'dummy' ? (u.mr || 0) : TURRET_CFG.mr;   // 마법저항력(챔피언: 기본 + 추가 + 용기 / 허수아비 / 포탑)
function physMulFor(w, target, pen) {   // pen: 물리관통력(%). 방어력 감소(target.shred)는 관통 전에 곱한다
  const shredMul = target.shred ? 1 - target.shred.pct : 1;
  let m = dmgMul(armorOf(target) * shredMul * (1 - pen / 100));
  if (target.kind === 'turret' && gameTime(w) < TURRET_CFG.reductionUntil) m *= (1 - TURRET_CFG.reduction);
  return m;
}
/* 피해 적용: 피해 감소 → 보호막(먼저 깎임, 고정 피해도) → 남은 피해는 체력. 돌려주는 값과 허수아비 기록은 보호막이 막은 것까지 포함 */
function hurt(w, t, a, fromTurret) {
  a *= dmgTakenMul(t, !!fromTurret);      // 피해 감소: 모든 피해 경로(평타·스킬·출혈·포탑)가 여기를 지남
  if (a > 0 && t.kind === 'champ') t.persT = 0;   // 인내심: 보호막에 막힌 피해도 포함해서 8초를 다시 셈(DESIGN_GAREN.md G5)
  const rest = t.shields && t.shields.length ? absorbShield(t, a) : a;
  t.hp = Math.max(0, t.hp - rest);
  if (t.kind === 'dummy') { t.total += a; t.hits.push({ t: w.time, d: a }); t.idle = 0; t.flash = 0.12; }
  return a;
}
/* 마법 피해 배율: 마법 저항력 100/(100+MR). 마법 관통은 아직 없음(포탑 감소는 물리와 같게 적용) */
function magicMulFor(w, target) {
  let m = dmgMul(mrOf(target));
  if (target.kind === 'turret' && gameTime(w) < TURRET_CFG.reductionUntil) m *= (1 - TURRET_CFG.reduction);
  return m;
}
/* 가해자가 있는 피해 한 번. hurt 결과를 돌려주고(표시 숫자는 그대로), 체력+보호막에 실제로 들어간 양(초과분 제외)만큼 가해자 흡혈.
   opts.aoe: 광역기면 흡혈 ×0.33 (DESIGN_AATROX A9). 포탑·출혈 피해는 이 함수를 쓰지 않으므로 흡혈이 없음 */
function dealFrom(w, c, t, a, opts) {
  const pool0 = t.hp + shieldOf(t);
  const got = hurt(w, t, a);
  if (c && c.kind === 'champ') omniHeal(w, c, Math.min(got, pool0), !!(opts && opts.aoe));
  return got;
}
const dealPhys = (w, c, t, raw, opts) => dealFrom(w, c, t, raw * physMulFor(w, t, penPct(c)), opts);
const dealMagic = (w, c, t, raw, opts) => dealFrom(w, c, t, raw * magicMulFor(w, t), opts);
/* 받는 피해 배율: 출처마다 따로 계산해 곱한다(서로 다른 출처는 곱, 1-1-6). 명상(마스터 이) × 가렌 W 훅 */
function dmgTakenMul(c, fromTurret) {
  if (!c || c.kind !== 'champ') return 1;
  return medTakenMul(c, !!fromTurret) * gwTakenMul(c);
}
/* 명상 피해 감소(마스터 이): 0.5초까지 70%, 그 뒤 명상 중·종료 후 0.5초는 레벨별 45~55%. 포탑 피해는 절반 */
function medTakenMul(c, fromTurret) {
  if (c.key !== 'yi') return 1;
  const S = SKILLS.yi.w, lvDr = lv => S.dr[Math.min(Math.max(lv, 1), 5) - 1];
  let dr = 0;
  if (c.med) dr = c.med.t < S.drFirstT ? S.drFirst : lvDr(c.med.lv);
  else if (c.medPost > 0) dr = lvDr(c.medLv);
  return dr > 0 ? 1 - dr * (fromTurret ? S.turretHalf : 1) : 1;
}
/* [가렌 W 훅] 용기(가렌 W)의 피해 감소 자리. 가렌을 만들 때 c.gw = {t, lv}가 있으면 1 - 감소율을 돌려주도록 채운다(DESIGN_GAREN.md §2-4). 지금은 항상 1 */
function gwTakenMul(c) {
  if (!c.gw) return 1;
  return 1 - SKILLS.garen.w.dr[clamp(c.gw.lv, 1, SKILLS.garen.w.max) - 1];   // 용기: 4초 동안 받는 피해 25~41% 감소
}
const dealTrue = (w, c, t, raw, opts) => dealFrom(w, c, t, raw, opts);     // 고정 피해: 방어력·마법저항력·관통력 모두 무시

/* 모든 피해 흡혈(DESIGN.md §1-1): 흡혈 = 입힌 피해 × omnivampOf(c) × (광역 ? 0.33 : 1). 최대 체력을 넘지 않음 */
const omnivampOf = c => (c && c.bonus && c.bonus.omni) || 0;   // 아이템 값 (버프 출처는 아직 없음)
function omniHeal(w, c, dealt, aoe) {
  const om = omnivampOf(c);
  if (!(om > 0) || !(dealt > 0)) return;
  healChamp(w, c, dealt * om * (aoe ? OMNI_AOE : 1), false);
}
/* 챔피언 체력 회복(최대 체력 초과 없음, 죽은 챔피언은 안 됨). 회복된 양을 돌려줌 */
function healChamp(w, c, amt, big) {
  if (c.dead || !(amt > 0)) return 0;
  const before = c.hp;
  c.hp = Math.min(c.stats.maxHp, c.hp + amt);
  const gained = c.hp - before;
  if (Math.round(gained) > 0) text(w, c.x + 16, c.y - px(95), '+' + Math.round(gained), '#6df0a0', !!big);
  return gained;
}

/* 처치 처리. killer(챔피언)가 가렌이면 챔피언·허수아비 처치마다 용기 +0.2 (최대 30, DESIGN_GAREN.md G8). 포탑 처치는 세지 않음 */
function settle(w, t, killer) {     // 체력이 0이면 처치 처리하고 true
  if (t.hp > 0) return false;
  if (t.kind === 'dummy') { t.hp = t.maxHp; t.bleed = null; banner(w, '더미 처치 · 체력 초기화', false, 1.5); grantCourage(killer); }
  else if (t.kind === 'champ') {
    const first = !t.dead;
    t.dead = true; t.respawn = RESPAWN_SEC; t.atk = null; t.cast = null; t.qPrep = null; t.wBuff = false;
    t.yq = null; t.untarget = false; t.med = null; t.medPost = 0; t.dhit = null; t.chase = null; t.aq = null;
    t.air = 0; t.pull = null; t.slow = null; t.bleed = null; t.pendSlow = false; t.moving = false;
    t.silence = null; t.shields = []; t.tenSrc = []; t.shred = null;     // 죽으면 보호막·침묵·강인함·방어력 감소도 사라짐
    t.gq = null; t.gqMs = 0; t.gqMsPct = 0; t.gw = null; t.ge = null; t.gr = null;   // 가렌 상태도 사라짐(용기는 부활 뒤에도 유지)
    if (first) grantCourage(killer);
  } else { t.dead = true; t.deadT = 0; t.shot = null; banner(w, '포탑 파괴! 공격 테스트 완료', false, 4); }
  return true;
}
function grantCourage(k) {
  if (!k || k.key !== 'garen' || k.kind !== 'champ') return;
  k.courage = Math.min(SKILLS.garen.w.maxBonus, Math.round((k.courage + SKILLS.garen.w.perKill) * 1e6) / 1e6);   // 0.2 누적 오차를 없애려고 소수 6자리에서 맞춤
}
/* 둔화: 지속시간 × (1 - 강인함). 최후의 전사 중에는 면역. 공중에 뜸·끌려옴은 이 함수를 쓰지 않음(강인함 적용 제외) */
function addSlow(u, pct, sec) {
  if (u.hl > 0) return; /* 최후의 전사 중 둔화 면역 */
  const d = sec * (1 - tenacityOf(u));
  if (!(d > 0)) return;
  const c = u.slow; u.slow = { pct: Math.max(pct, c ? c.pct : 0), t: Math.max(d, c ? c.t : 0) };
}

/* 보호막 · 강인함 · 침묵 (DESIGN_GAREN.md §1-3~1-5, 원문 docs/spec/garen.md). 모두 시간으로 줄어들고, 죽으면 사라짐 */
function addShield(c, amt, sec, src) {      // 보호막 추가(아이템·스킬 효과). 죽은 챔피언에게는 붙지 않음
  if (!c || c.dead || !c.shields || !(amt > 0) || !(sec > 0)) return;
  c.shields.push({ amt, t: sec, src: src || '' });
}
const shieldOf = c => c.shields ? c.shields.reduce((s, x) => s + x.amt, 0) : 0;   // 남은 보호막 합
/* 보호막이 피해를 먼저 흡수: 남은 시간이 짧은 것부터 깎는다(같으면 먼저 넣은 것). 깎고 남은 피해를 돌려준다 */
function absorbShield(t, a) {
  let rest = a;
  for (const s of t.shields.slice().sort((p, q) => p.t - q.t)) {
    if (rest <= 0) break;
    const use = Math.min(s.amt, rest);
    s.amt -= use; rest -= use;
  }
  t.shields = t.shields.filter(s => s.amt > 0);
  return rest;
}
function addTenacity(c, pct, sec) {         // 강인함 출처 추가(예: 가렌 W 60%, 0.75초). 여러 출처는 곱연산으로 합침
  if (!c || c.dead || !c.tenSrc || !(pct > 0) || !(sec > 0)) return;
  c.tenSrc.push({ pct, t: sec });
}
const tenacityOf = c => { let m = 1; for (const s of (c.tenSrc || [])) m *= 1 - s.pct; return 1 - m; };   // 1 - Π(1 - 출처값)
/* 침묵: 지속시간 × (1 - 강인함), 더 긴 쪽 유지. 정신 집중(명상)만 끊음(G2). 시전 중인 스킬·다리우스 Q 준비는 그대로 */
function addSilence(w, u, sec) {
  if (!u || u.dead) return false;
  const d = sec * (1 - tenacityOf(u));
  if (!(d > 0)) return false;
  u.silence = { t: Math.max(d, u.silence ? u.silence.t : 0) };
  if (u.kind === 'champ') endMed(u);       // 명상 끊김: endMed 경로라 끊긴 뒤 0.5초 피해 감소가 유지됨
  text(w, u.x, u.y - px(62), '침묵', '#c9a2ff', true);
  return true;
}

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
  if (u.silence) { u.silence.t -= dt; if (u.silence.t <= 0) u.silence = null; }
  if (u.shred) { u.shred.t -= dt; if (u.shred.t <= 0) u.shred = null; }
  if (u.tenSrc && u.tenSrc.length) { for (const s of u.tenSrc) s.t -= dt; u.tenSrc = u.tenSrc.filter(s => s.t > 0); }
  if (u.shields && u.shields.length) { for (const s of u.shields) s.t -= dt; u.shields = u.shields.filter(s => s.t > 0); }
  const b = u.bleed;
  if (b && !u.dead) {
    const use = Math.min(dt, b.t), d = b.total / BLEED.dur * use * physMulFor(w, u, b.pen);
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
  const cyc = 1 / curAS(c);
  c.atkCd = cyc;
  c.chase = null;                  // 평타가 시작되면 자동 추적은 끝남 (추적으로 시작했든, 사거리 안 대상으로 시작했든)
  c.facing = t.x < c.x ? -1 : 1;
  c.atk = { t: 0, wind: cyc * WINDUP, back: cyc * BACKSWING, targetId: t.id, hit: false };
}
function strike(w, c, t) {
  const ad = curAD(c);
  c.facing = t.x < c.x ? -1 : 1;
  const ang = Math.atan2(t.y - c.y, t.x - c.x);
  c.lunge = 1; c.lungeDir = [Math.cos(ang), Math.sin(ang)];
  const ex = t.x - Math.cos(ang) * px(t.r) * 0.85, ey = t.y - Math.sin(ang) * px(t.r) * 0.85 - 22;
  const q = c.key === 'garen' && c.gq ? c.gq : null;   // 가렌 결정타 강화 평타: 이 타격의 피해 전체를 대체(DESIGN_GAREN.md G6)
  const dmg = q ? dealPhys(w, c, t, SKILLS.garen.q.dmg[q.lv - 1] + SKILLS.garen.q.ratio * ad) : dealPhys(w, c, t, ad);
  fx(w, { fx: 'slash', x: ex, y: ey, ang, key: c.key, life: c.key === 'darius' ? 0.28 : 0.2 });
  text(w, ex, ey - 12, dmg < 10 ? dmg.toFixed(1) : dmg.toFixed(0), '#ffe2a8');
  if (c.key === 'yi') yiOnHit(w, c, t, false);   // 마스터 이: 패시브 스택·2연속 예약·우주류 추가 피해·일격필살 쿨 감소
  let wUsed = false;
  if (c.wBuff) {   // 스킬 2: 강화된 기본 공격
    c.wBuff = false; wUsed = true;
    const bonus = dealPhys(w, c, t, SK.w.ratio[c.sk.w - 1] * ad);
    text(w, ex + 12, ey - 28, bonus < 10 ? bonus.toFixed(1) : bonus.toFixed(0), '#ffb04a', true);
    if (isChampLike(t)) addSlow(t, SK.w.slow, SK.w.slowT);
  }
  /* 아트록스 사신 태세: 챔피언·허수아비를 평타하면 준비된 경우 추가 마법 피해·회복·재사용 22초, 아니면 재사용 -2초(A3, A4). 강화 평타는 감소 없음 */
  if (c.key === 'aatrox' && isChampLike(t)) {
    if (c.apCd <= 0) aatroxProc(w, c, t);
    else c.apCd = Math.max(0, c.apCd - AATROX_PASSIVE.cdrHit);
  }
  applyBleed(w, c, t);
  const killed = settle(w, t, c);
  if (q) {                       // 강화 평타가 나가면 강화 소모 + 대상 1.5초 침묵(챔피언·허수아비, 처치되지 않은 경우)
    c.gq = null;
    if (isChampLike(t) && !t.dead) addSilence(w, t, SKILLS.garen.q.silence);
  }
  if (killed && wUsed) {   // 처치하면 마나 환급 + 남은 재사용 대기시간 50% 감소
    c.mana = Math.min(c.stats.maxMana, c.mana + SK.w.mana[c.sk.w - 1]); c.cd.w *= SK.w.refundCd;
    text(w, c.x, c.y - px(75), '마나 환급 · 재사용 대기 -50%', '#8fd0ff');
  }
}

/* ---------------------------------------------------------------------
   스킬
   --------------------------------------------------------------------- */
function levelUp(w, c, k) {
  const def = SKILL_KEYS.includes(k) && skillsOf(c) ? skillsOf(c)[k] : null;
  if (c.dead || !def || c.sp <= 0 || c.sk[k] >= def.max) return;
  c.sk[k]++; c.sp--;
  text(w, c.x, c.y - px(80), `${def.name} Lv.${c.sk[k]}`, '#ffd23f');
}

/* 마스터 이 명상 끊기/시작 (A5: 이동·평타 입력, 공중에 뜸·끌려옴, 일격필살 시전으로 끊김. 피해·E·R은 끊지 않음) */
function endMed(c) {
  if (!c.med) return;
  c.medPost = SKILLS.yi.w.postT; c.medLv = c.med.lv; c.med = null;
}
function startMed(c) { c.med = { t: 0, lv: c.sk.w, stackT: 0 }; }
function startAlpha(w, c, tgt) {   // 일격필살: 즉시 사라짐(대상 지정 불가). 타격·등장은 yiAlphaTick
  const from = { x: c.x, y: c.y };
  endMed(c);
  c.untarget = true;
  c.yq = { t: 0, targetId: tgt.id, hits: 0, from, lv: c.sk.q };
  fx(w, { fx: 'blink', x: c.x, y: c.y, out: true });
}
function castYi(w, c, k, say) {
  if (c.yq && (k === 'q' || k === 'w')) return;      // 일격필살 중에는 이동·평타·명상·재시전 불가. 우주류 검술·최후의 전사는 가능
  if (k === 'w' && c.med) { say('이미 명상 중'); return; }
  let tgt = null;
  if (k === 'q') { tgt = yiQTarget(w, c); if (!tgt) { say('사거리 내 대상 없음'); return; } }   // 대상이 없으면 마나·쿨타임 소모 없음
  const cost = skMana(c, k);
  if (c.mana < cost) { say('마나 부족', '#8fb6e8'); return; }
  c.mana -= cost; c.cd[k] = skCd(c, k); c.atk = null; cancelChase(c);   // 쿨타임은 시전 즉시 시작. 진행 중이던 평타와 평타 추적은 취소
  if (k === 'q') startAlpha(w, c, tgt);
  else if (k === 'w') startMed(c);
  else if (k === 'e') c.wuju = SKILLS.yi.e.dur;
  else { c.hl = SKILLS.yi.r.dur; c.slow = null; }     // 최후의 전사: 기존 둔화 제거, 지속 중 둔화 면역
}

/* ---------------------------------------------------------------------
   가렌 (DESIGN_GAREN.md §2, 원문 docs/spec/garen.md)
   --------------------------------------------------------------------- */
const maxHpOf = u => u.kind === 'champ' ? u.stats.maxHp : u.maxHp;

/* 데마시아의 정의 대상(G13): 사거리 400(히트박스 끝 기준) 안의 가장 가까운 적 챔피언, 없으면 가장 가까운 허수아비(연습용) */
function garenRTarget(w, c) {
  const lim = px(SKILLS.garen.r.range);
  let champ = null, bc = Infinity, dummy = null, bdm = Infinity;
  for (const u of enemiesOf(w, c)) {
    const d = edgeDist(u, c);
    if (d > lim) continue;
    if (u.kind === 'champ') { if (d < bc) { champ = u; bc = d; } }
    else if (u.kind === 'dummy') { if (d < bdm) { dummy = u; bdm = d; } }
  }
  return champ || dummy;
}

/* 심판 회전 종료 또는 취소: 재사용 대기시간은 이때부터 흐름(G10). 회전 중에는 cd.e가 0이라 버튼이 '취소'로 보임 */
function stopSpin(c) { c.ge = null; c.cd.e = skCd(c, 'e'); }

/* 심판 회전 시작: 회전 수 n = 7 + floor(추가 공속 / 25%) (레벨 성장 공속 포함, G9·DESIGN §2-5) */
function startSpin(c, lv) {
  const E = SKILLS.garen.e;
  const n = E.baseSpins + Math.floor(bonusASPct(c) / E.asPerSpin + EPS);
  c.atk = null; cancelChase(c);
  c.ge = { t: 0, lv, n, done: 0, hits: {} };
}

/* 심판 타격 한 번(G9 시점마다 호출). 반지름 325 안의 적(챔피언·허수아비, 대상 지정 가능)에게 물리 피해.
   거리 판정은 다리우스 Q와 같은 식: (중심 거리 - 상대 반지름) ≤ 내 반지름 + 325. 가장 가까운 적은 ×1.25.
   챔피언은 한 회전에서 6번 맞으면 6초 동안 방어력 25% 감소(관통 전에 적용) */
function garenSpinHit(w, c, S) {
  const E = SKILLS.garen.e, i = S.lv - 1, reach = px(HIT_R + E.radius);
  const list = [];
  for (const t of enemiesOf(w, c)) {
    if (t.kind === 'turret') continue;
    const d = Math.hypot(t.x - c.x, t.y - c.y);
    if (d - px(t.r) > reach) continue;
    list.push(t);
  }
  let nearest = null, bn = Infinity;
  for (const t of list) { const d = edgeDist(t, c); if (d < bn) { bn = d; nearest = t; } }
  for (const t of list) {
    const isNear = t === nearest;
    const raw = (E.dmg[i] + E.ratio[i] * curAD(c)) * (isNear ? 1 + E.nearestBonus : 1);
    const v = dealPhys(w, c, t, raw, { aoe: true });
    text(w, t.x - 10, t.y - px(50), v < 10 ? v.toFixed(1) : v.toFixed(0), isNear ? '#ffd23f' : '#ffe9a3', isNear);
    if (t.kind === 'champ') {
      const n = (S.hits[t.id] || 0) + 1;
      S.hits[t.id] = n;
      if (n === E.shredHits) t.shred = { t: E.shredT, pct: E.shred };   // 6번째 타격에 방어력 감소(다시 맞으면 6초로 갱신)
    }
    settle(w, t, c);
  }
  fx(w, { fx: 'gspin', owner: c.id });
}

/* 심판 한 틱: 3초 동안 회전. 타격은 (k+0.5)×3/n 초에 한 번씩. 공중에 뜸·끌려옴·침묵과 무관하게 계속 돈다 */
function garenSpinTick(w, c, dt) {
  const S = c.ge, E = SKILLS.garen.e;
  S.t += dt;
  while (S.done < S.n && S.t >= (S.done + 0.5) * E.dur / S.n - EPS) { S.done++; garenSpinHit(w, c, S); }
  if (c.ge && S.t >= E.dur - EPS) stopSpin(c);
}

/* 데마시아의 정의 한 틱 (G12, 사용자 정정: 이전 구현은 거리 판정이 반대였음).
   - 대상 지정 불가 · 사망 · 사라짐: 시전 중 언제든 즉시 취소하고 쿨타임 반환('취소됨').
   - 시전 중(0.435초 안) 매 틱 거리 > 400: 즉시 헛방. 시전 종료, 쿨타임 소모, 피해 없음('빗나감').
   - 시전 완료 틱: 거리와 무관하게 무조건 적중. 고정 피해 base + missPct × 잃은 체력(그 순간 기준). */
function garenRTick(w, c, dt) {
  const R = SKILLS.garen.r, g = c.gr;
  g.t += dt;
  const t = unitOf(w, g.targetId);
  if (!t || t.dead || t.untarget) {
    c.gr = null; c.cd.r = 0;
    text(w, c.x, c.y - px(75), '취소됨', '#b8c4cf', false, c.id);
    return;
  }
  if (g.t < R.cast - EPS) {
    if (edgeDist(t, c) > px(R.range)) { c.gr = null; text(w, c.x, c.y - px(75), '빗나감', '#b8c4cf', false, c.id); }
    return;
  }
  c.gr = null;
  const dmg = R.base[g.lv - 1] + R.missPct[g.lv - 1] * (maxHpOf(t) - t.hp);
  fx(w, { fx: 'gsword', x: t.x, y: t.y });
  dealTrue(w, c, t, dmg);
  text(w, t.x, t.y - px(62), `${dmg.toFixed(0)} 고정 피해`, '#ffd23f', true);
  settle(w, t, c);
}

/* 가렌 스킬 시전. 공통 검사(레벨·침묵·쿨타임·공중)는 castSkill에서 끝낸 뒤 호출. 마나는 0이라 소모 없음 */
function castGaren(w, c, k, say) {
  const G = SKILLS.garen, lv = c.sk[k];
  if (k === 'q') {                                                // 결정타: 즉발. 둔화 제거 · 이동속도 · 다음 평타 강화
    c.atk = null; cancelChase(c);
    c.slow = null;
    c.gqMs = G.q.msT[lv - 1]; c.gqMsPct = G.q.ms;
    c.gq = { t: G.q.empT, lv };
    c.cd.q = skCd(c, 'q');                                        // 강화 중에는 updateChamp에서 쿨타임이 멈춰 있음
  } else if (k === 'w') {                                         // 용기: 피해 감소 · 보호막 · 강인함
    c.atk = null; cancelChase(c);
    c.gw = { t: G.w.dur, lv };
    addShield(c, G.w.shield[lv - 1] + G.w.shieldBonusHp * bonusHP(c), G.w.shieldT, 'garenW');
    addTenacity(c, G.w.ten, G.w.tenT);
    c.cd.w = skCd(c, 'w');
  } else if (k === 'e') {                                         // 심판: 다시 누르면 취소. 시작 뒤 cancelLock초 동안은 무시(연타 방지, 비용·글자 없음)
    if (c.ge) { if (c.ge.t >= G.e.cancelLock - EPS) stopSpin(c); return; }
    startSpin(c, lv);
  } else {                                                        // 데마시아의 정의: 대상이 없으면 아무 비용 없음
    const tgt = garenRTarget(w, c);
    if (!tgt) { say('사거리 내 대상 없음'); return; }
    if (c.ge) stopSpin(c);                                        // 회전 즉시 멈추고 궁극기 시전
    c.atk = null; cancelChase(c);
    c.cd.r = skCd(c, 'r');
    c.gr = { t: 0, targetId: tgt.id, lv };
    c.facing = tgt.x < c.x ? -1 : 1;
    fx(w, { fx: 'gmark', targetId: tgt.id, life: G.r.cast });
  }
}

/* ---------------------------------------------------------------------
   아트록스 (DESIGN_AATROX.md §2, 원문 docs/spec/aatrox.md). 이번 범위: 패시브·Q. W·E·R은 준비 중
   --------------------------------------------------------------------- */
/* 사신 태세 적중(준비된 평타): 대상 최대 체력 × (4 + 6/17 × (L-1))% 마법 피해(마법 저항 적용), 그 피해의 100% 회복, 재사용 22초 */
function aatroxProc(w, c, t) {
  const P = AATROX_PASSIVE;
  const raw = maxHpOf(t) * (P.pctBase + P.pctPerLvl * (c.level - 1));
  const pool0 = t.hp + shieldOf(t);
  const got = dealMagic(w, c, t, raw);                    // 흡혈은 dealMagic 안에서 따로 처리(평타 피해이므로 광역 아님)
  text(w, t.x + 12, t.y - px(70), got < 10 ? got.toFixed(1) : got.toFixed(0), '#c9a2ff', true);
  healChamp(w, c, Math.min(got, pool0) * P.heal, true);   // 회복 = 체력+보호막에 실제로 들어간 마법 피해의 100%
  c.apCd = P.cd;
}

/* 점과 볼록 다각형(꼭짓점 순서는 시계/반시계 아무거나), 선분과 점 거리^2 */
function pointInConvex(qx, qy, poly) {
  let pos = false, neg = false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const cr = (b[0] - a[0]) * (qy - a[1]) - (b[1] - a[1]) * (qx - a[0]);
    if (cr > 0) pos = true; else if (cr < 0) neg = true;
    if (pos && neg) return false;
  }
  return true;
}
function segDist2(qx, qy, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L > 0 ? clamp(((qx - a[0]) * dx + (qy - a[1]) * dy) / L, 0, 1) : 0;
  const ex = a[0] + dx * t - qx, ey = a[1] + dy * t - qy;
  return ex * ex + ey * ey;
}
/* 원(반지름 r)과 볼록 다각형이 겹치는지: 중심이 안에 있거나, 가장 가까운 변과의 거리가 r 이하 */
function circleHitsPoly(cx, cy, r, poly) {
  if (pointInConvex(cx, cy, poly)) return true;
  for (let i = 0; i < poly.length; i++) if (segDist2(cx, cy, poly[i], poly[(i + 1) % poly.length]) <= r * r) return true;
  return false;
}
/* 도형(poly 또는 circ 중 하나) 과 원(cx, cy, r)이 겹치는지. 원끼리는 중심 거리 ≤ 두 반지름 합 */
function hitsShape(cx, cy, r, poly, circ) {
  if (poly) return circleHitsPoly(cx, cy, r, poly);
  return !!circ && Math.hypot(cx - circ.x, cy - circ.y) <= r + circ.r;
}

/* Q 판정 도형을 월드 픽셀로. 아트록스 중심(x, y)과 방향 ang 기준(A8). 앞 = (cos, sin), 옆 = (-sin, cos).
   1단계: 중심에서 앞 0~625, 폭 180 사각형. 끝부분 = 앞 450~625.
   2단계: 중심 뒤 100 ~ 앞 475 사다리꼴(뒤 폭 300 → 앞 폭 450). 끝부분 = 앞 300~475(앞쪽 띠).
   3단계: 중심 앞 180에 반지름 300 원. 중앙 = 같은 중심의 반지름 200 원.
   돌려주는 값은 판정과 화면이 함께 쓰는 도형: 없는 모양은 null */
function aatroxQShape(stage, x, y, ang) {
  const Q = SKILLS.aatrox.q, cs = Math.cos(ang), sn = Math.sin(ang);
  const P = (f, s) => [x + px(f) * cs - px(s) * sn, y + px(f) * sn + px(s) * cs];
  const out = { poly: null, sweetPoly: null, circle: null, sweetCircle: null };
  if (stage === 1) {
    const S = Q.s1, h = S.width / 2;
    out.poly = [P(0, -h), P(S.len, -h), P(S.len, h), P(0, h)];
    out.sweetPoly = [P(S.sweetFrom, -h), P(S.len, -h), P(S.len, h), P(S.sweetFrom, h)];
  } else if (stage === 2) {
    const S = Q.s2, hb = S.wBack / 2, hf = S.wFront / 2;
    const hw = f => hb + (hf - hb) * (f + S.back) / (S.front + S.back);   // 뒤 hb → 앞 hf 선형 (앞으로 f)
    out.poly = [P(-S.back, -hb), P(S.front, -hf), P(S.front, hf), P(-S.back, hb)];
    out.sweetPoly = [P(S.sweetFrom, -hw(S.sweetFrom)), P(S.front, -hf), P(S.front, hf), P(S.sweetFrom, hw(S.sweetFrom))];
  } else if (stage === 3) {
    const S = Q.s3, cx = x + px(S.off) * cs, cy = y + px(S.off) * sn;
    out.circle = { x: cx, y: cy, r: px(S.r) };
    out.sweetCircle = { x: cx, y: cy, r: px(S.sweetR) };
  }
  return out;
}
/* 대상 한 명의 판정: 2 = 끝부분(우선), 1 = 몸통, 0 = 안 맞음. 대상 히트박스 반지름은 t.r(유닛) */
function aatroxQHit(sh, t) {
  const r = px(t.r);
  if (hitsShape(t.x, t.y, r, sh.sweetPoly, sh.sweetCircle)) return 2;
  if (hitsShape(t.x, t.y, r, sh.poly, sh.circle)) return 1;
  return 0;
}

/* 다음에 Q를 누르면 나갈 단계(1~3). 못 쓰면 0. 화면 버튼 표시용과 시전 판정이 같이 씀 (A7)
   창이 열려 있으면 재사용 대기와 무관하게 다음 단계, 아니면 쿨타임이 끝난 1단계만 */
function aatroxQStage(c) {
  if (!c || c.key !== 'aatrox' || c.dead || c.aq || c.cast || c.gr || c.air > 0 || c.pull || c.silence || !(c.sk.q > 0)) return 0;
  if (c.aqWin > 0) return c.aqNext;
  return c.cd.q > EPS ? 0 : 1;
}
/* Q 누르기: 단계 결정 → 시전 시작(0.6초). W·E·R은 아직 없음 */
function castAatrox(w, c, k, ang, say) {
  if (c.aq) return;                                       // 시전 중(0.6초)에는 아무 스킬도 안 됨
  if (k !== 'q') { say('준비 중'); return; }
  const stage = aatroxQStage(c);
  if (!stage) { say('재사용 대기 중'); return; }
  if (!Number.isFinite(ang)) ang = c.facing < 0 ? Math.PI : 0;
  startAatroxQ(w, c, stage, ang);
}
function startAatroxQ(w, c, stage, ang) {
  const Q = SKILLS.aatrox.q;
  c.atk = null; cancelChase(c);                           // 평타·평타 추적 취소. 시전 중 이동·평타 불가
  c.cd.q = skCd(c, 'q');                                  // A7: 단계를 시전할 때마다 쿨타임을 처음부터 다시 셈
  c.aq = { stage, t: 0, ang, lv: c.sk.q, x: c.x, y: c.y };   // 방향과 위치는 시전 시작 때 고정
  c.facing = Math.cos(ang) < 0 ? -1 : 1;
  fx(w, { fx: 'aqTele', owner: c.id, stage, ang, x: c.x, y: c.y, life: Q.cast });
}
/* 공중에 뜸·끌려옴으로 Q 시전 취소(A6): 피해 없음. 같은 단계의 재사용 창 3초가 새로 열림(1단계도 쿨타임을 기다리지 않음).
   쿨타임은 환급 없이 시전 시작부터 계속 흐름 */
function cancelAatroxQ(c) {
  if (!c.aq) return;
  c.aqNext = c.aq.stage; c.aqWin = SKILLS.aatrox.q.window;
  c.aq = null;
}
function aatroxQTick(w, c, dt) {
  const A = c.aq;
  A.t += dt;
  if (A.t < SKILLS.aatrox.q.cast - EPS) return;
  c.aq = null;
  aatroxQResolve(w, c, A);
}
/* 판정 (A5, A7, A8). 챔피언·허수아비(포탑 제외)마다 한 번: 끝부분이면 끝부분 피해 + 공중에 뜸, 몸통이면 기본 피해. 광역(흡혈 ×0.33) */
function aatroxQResolve(w, c, A) {
  const Q = SKILLS.aatrox.q, S = Q['s' + A.stage], i = A.lv - 1;
  const sh = aatroxQShape(A.stage, A.x, A.y, A.ang), ad = totalAD(c);
  fx(w, { fx: 'aqHit', owner: c.id, stage: A.stage, ang: A.ang, x: A.x, y: A.y });
  let body = false, sweet = false;
  for (const t of enemiesOf(w, c)) {
    if (!isChampLike(t)) continue;
    const k = aatroxQHit(sh, t);
    if (!k) continue;
    const isSweet = k === 2;
    const v = isSweet
      ? dealPhys(w, c, t, S.sdmg[i] + S.sratio[i] * ad, { aoe: true })
      : dealPhys(w, c, t, S.dmg[i] + S.ratio[i] * ad, { aoe: true });
    text(w, t.x - 10, t.y - px(50), v < 10 ? v.toFixed(1) : v.toFixed(0), isSweet ? '#ff5a3c' : '#ffb070', isSweet);
    if (isSweet) sweet = true; else body = true;
    settle(w, t, c);
    if (isSweet && !t.dead) airUp(w, t, Q.air);           // 끝부분: 0.25초 공중에 뜸 (다리우스 E 착지와 같은 상태)
  }
  // 사신 태세 재사용 대기 감소: 이번 단계 시전마다 한 번. 끝부분에 하나라도 맞으면 -4, 몸통만이면 -2
  if (sweet) c.apCd = Math.max(0, c.apCd - AATROX_PASSIVE.cdrSweet);
  else if (body) c.apCd = Math.max(0, c.apCd - AATROX_PASSIVE.cdrHit);
  // 다음 단계 재사용 창: 1·2단계가 끝나면 다음 단계 3초, 3단계가 끝나면 다음은 1단계
  if (A.stage < 3) { c.aqNext = A.stage + 1; c.aqWin = Q.window; }
  else { c.aqNext = 1; c.aqWin = 0; }
}
/* 공중에 뜸 (다리우스 E 착지와 같은 상태: air = airMax, 공중에 뜸 글자). 둔화는 붙이지 않음 */
function airUp(w, u, sec) {
  u.air = Math.max(u.air, sec); u.airMax = Math.max(u.airMax || 0, sec);
  if (u.kind === 'dummy') u.homeT = 0;
  text(w, u.x, u.y - px(60), '공중에 뜸', '#cfe8ff');
}

function castSkill(w, c, k, ang) {
  if (c.dead || !skillsOf(c) || !SKILL_KEYS.includes(k)) return;
  const say = (m, col) => text(w, c.x, c.y - px(75), m, col || '#b8c4cf', false, c.id);
  const lv = c.sk[k];
  if (c.air > 0 || c.pull) return;
  if (!lv) { say('스킬 레벨 0 · ▲로 레벨업'); return; }
  if (c.cast || c.gr) return;                         // 시전 중(다리우스·마스터 이 시전, 가렌 궁극기)에는 다른 스킬 불가
  if (c.silence) { say('침묵', '#c9a2ff'); return; }   // 침묵: 시전 불가(마나·쿨타임 소모 없음). 레벨업은 위에서처럼 가능
  if (c.key === 'aatrox') { castAatrox(w, c, k, ang, say); return; }   // 아트록스 Q 단계·재사용 창(A7, 쿨타임 검사 포함). W·E·R은 준비 중
  if (k === 'w' && c.wBuff) { say('이미 강화됨'); return; }   // 강화 중에는 W 쿨타임이 멈춰 있으므로 쿨타임 검사보다 먼저 봄
  if (c.cd[k] > 0) { say('재사용 대기 중'); return; }
  if (c.key === 'yi') { castYi(w, c, k, say); return; }
  const cost = skMana(c, k);
  if (c.mana < cost) { say('마나 부족', '#8fb6e8'); return; }
  if (!Number.isFinite(ang)) ang = c.facing < 0 ? Math.PI : 0;
  if (c.key === 'garen') { castGaren(w, c, k, say); return; }   // 가렌: 마나 0, 평타·추적 취소는 castGaren 안에서
  let tgt = null;
  if (k === 'r') { tgt = ultTarget(w, c); if (!tgt) { say('사거리 내 대상 없음'); return; } }
  c.mana -= cost; c.cd[k] = skCd(c, k);
  c.atk = null; cancelChase(c);                       // 스킬을 쓰면 진행 중이던 평타 동작과 평타 추적은 취소
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
      const v = dealPhys(w, c, t, q.handle[i] + q.handleR[i] * ad, { aoe: true });
      text(w, t.x - 10, ty, v < 10 ? v.toFixed(1) : v.toFixed(0), '#ffd08a');
    } else {         // 도끼날: 과다출혈 + 맞힌 챔피언마다 잃은 체력 17% 회복(최대 51%)
      const v = dealPhys(w, c, t, q.blade[i] + q.bladeR[i] * ad, { aoe: true });
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
    if (!t || t.dead || t.untarget) return;     // 시전 중 대상이 대상 지정 불가가 되면 빗나감
    const stacks = t.bleed ? t.bleed.stacks : 0;
    const total = (SK.r.base + SK.r.ratio * bonusAD(c)) * (1 + SK.r.perStack * stacks);   // 추가 공격력 기준(0.75×추가 공격력)
    dealTrue(w, c, t, total);
    t.bleed = null;                                // 단두대에 맞은 적은 과다출혈 중첩이 모두 사라짐
    fx(w, { fx: 'gui', x: t.x, y: t.y - 30, life: 0.45 });
    text(w, t.x, t.y - 62, `${total.toFixed(0)} 고정 피해`, '#ffffff', true);
    if (settle(w, t)) c.might = BLEED.dur;         // 단두대로 처치하면 공격력 증가
  }
}

/* ---------------------------------------------------------------------
   챔피언 한 틱
   --------------------------------------------------------------------- */
/* 마스터 이: 기본 공격 적중 공통 처리(1차 또는 2연속 두 번째). 스택·예약·우주류 추가 고정 피해·일격필살 쿨 감소 */
function yiOnHit(w, c, t, second) {
  if (second) c.dstack = Math.min(3, c.dstack + 1);                        // 두 번째 타격도 기본 공격 → 스택 +1, 예약 없음
  else if (c.dstack >= YI_PASSIVE.every - 1) { c.dstack = 0; c.dhit = { t: YI_PASSIVE.extraDelay, targetId: t.id }; }   // 4번째 공격
  else c.dstack++;
  if (c.wuju > 0 && t.hp > 0) {
    const e = SKILLS.yi.e, v = dealTrue(w, c, t, e.dmg[c.sk.e - 1] + e.ratio * bonusAD(c));   // 추가 고정 피해 = dmg + 0.35 × 추가 공격력(사용자 수정 2026-11-12)
    text(w, t.x + 12, t.y - px(50), v.toFixed(0), '#fff1a8', true);
  }
  if (c.cd.q > 0) c.cd.q = Math.max(0, c.cd.q - SKILLS.yi.q.cdPerHit);
}
/* 2연속 공격의 두 번째 타격: 물리 0.5 × 공격력, 기본 공격으로 판정 */
function yiSecondHit(w, c, t) {
  const ang = Math.atan2(t.y - c.y, t.x - c.x);
  const ex = t.x - Math.cos(ang) * px(t.r) * 0.85, ey = t.y - Math.sin(ang) * px(t.r) * 0.85 - 22;
  const dmg = dealPhys(w, c, t, YI_PASSIVE.ratio * curAD(c));
  fx(w, { fx: 'slash', x: ex, y: ey, ang, key: 'yi', life: 0.2, extra: true });
  text(w, ex, ey - 12, dmg < 10 ? dmg.toFixed(1) : dmg.toFixed(0), '#ffe2a8');
  yiOnHit(w, c, t, true);
  settle(w, t);
}
/* 일격필살 진행: 0.2초부터 0.22초 간격으로 4회, 0.9초에 대상 주변에 나타남 */
function yiAlphaTick(w, c, dt) {
  const Q = SKILLS.yi.q, y = c.yq;
  y.t += dt;
  while (y.hits < Q.hits && y.t >= Q.first + y.hits * Q.gap - EPS) {
    y.hits++;
    const t = unitOf(w, y.targetId);
    if (!t || t.dead) { y.hits = Q.hits; break; }            // 대상이 죽거나 사라지면 남은 타격 취소(등장은 그대로)
    const ang = Math.atan2(t.y - y.from.y, t.x - y.from.x);
    const v = dealPhys(w, c, t, (Q.dmg[y.lv - 1] + Q.ratio * curAD(c)) * Q.share);
    fx(w, { fx: 'yslash', x: t.x, y: t.y - px(20), ang });
    text(w, t.x - 10, t.y - px(60), v < 10 ? v.toFixed(1) : v.toFixed(0), '#ffe2a8', true);
    settle(w, t);
  }
  if (y.t >= Q.appear - EPS) yiAppear(w, c);
}
/* 등장: 시전 위치 반대편 방향으로 대상 히트박스 + 내 히트박스×0.8 + 12 떨어진 곳(걸을 수 있는 곳) */
function yiAppear(w, c) {
  const y = c.yq, t = unitOf(w, y.targetId);
  const tx = t ? t.x : y.from.x, ty = t ? t.y : y.from.y, tr = t ? t.r : 0;
  let dx = tx - y.from.x, dy = ty - y.from.y, d = Math.hypot(dx, dy);
  if (d < 1e-6) { dx = c.facing; dy = 0; d = 1; }
  const stop = px(tr + HIT_R * 0.8 + 12);
  const p = safePoint({ x: tx, y: ty }, { x: tx + dx / d * stop, y: ty + dy / d * stop }, canStand);
  c.x = p.x; c.y = p.y;
  c.untarget = false; c.yq = null;
  c.facing = tx < c.x ? -1 : 1;
  fx(w, { fx: 'blink', x: c.x, y: c.y, out: false });
}
/* 명상 한 틱: 끊김 판정(A5) → 유지 마나 소모(초당 최대 마나 6%) · 마나 0이면 즉시 종료 → 회복 · 1초마다 스택 · 4초 후 종료 */
function yiMedTick(w, c, dt) {
  const S = SKILLS.yi.w, m = c.med;
  if (c.in.mx || c.in.my || c.in.atk || c.air > 0 || c.pull) { endMed(c); return; }
  const drain = S.manaPct * c.stats.maxMana * dt;
  if (c.mana < drain) { c.mana = 0; endMed(c); return; }   // 마나가 0 아래로 내려가면 0으로 맞추고 끊김과 같은 경로로 종료(종료 후 0.5초 피해 감소 유지)
  c.mana -= drain;
  m.t += dt; m.stackT += dt;
  if (m.stackT >= 1 - EPS) { m.stackT -= 1; c.dstack = Math.min(3, c.dstack + 1); }
  const heal = (S.heal[m.lv - 1] + S.apRatio * c.stats.ap) * (1 + (c.stats.maxHp - c.hp) / c.stats.maxHp) * dt;
  c.hp = Math.min(c.stats.maxHp, c.hp + heal);
  if (m.t >= S.dur - EPS) endMed(c);
}

function respawn(w, c) {
  const keep = { sk: c.sk, sp: c.sp, in: c.in, bonus: c.bonus, courage: c.courage };   // 추가 스탯(아이템)·가렌 용기는 부활해도 유지. 스킬 레벨도 유지
  Object.assign(c, makeChamp(c.id, c.key, c.team), keep);
}

/* 평타 추적 한 틱. 취소 조건(조이스틱 입력, 끌려감·공중, 대상 없음·죽음·대상 지정 불가, search+300 밖)이면 추적을 끊고 null
   → 이동은 조이스틱대로. 사거리 안이면 (평타 가능할 때) 평타를 시작하고 추적 종료. 아니면 대상 쪽 단위 방향 {dx,dy}를 돌려줌 */
function chaseTick(w, c, locked) {
  const t = unitOf(w, c.chase.targetId);
  if (c.in.mx || c.in.my) { cancelChase(c); return null; }                         // 조이스틱: 취소(버튼을 뗄 때까지 재추적 금지)
  if (locked || !t || t.dead || t.untarget || edgeDist(t, c) > px(CHASE.search + 300)) { c.chase = null; return null; }
  if (edgeDist(t, c) <= atkRange(c)) {
    if (c.atkCd <= 0 && !c.atk && !c.cast && !c.yq && !c.ge && !c.gr && !c.aq) startAttack(w, c, t);   // 평타 시작과 함께 추적 해제
    return { dx: 0, dy: 0 };
  }
  const dx = t.x - c.x, dy = t.y - c.y, d = Math.hypot(dx, dy) || 1;
  return { dx: dx / d, dy: dy / d };
}

function updateChamp(w, c, dt) {
  if (c.dead) { c.respawn -= dt; if (c.respawn <= 0) respawn(w, c); return; }
  const s = c.stats;
  c.hp = Math.min(s.maxHp, c.hp + s.regen / 5 * dt);              // 체력 재생: 5초당 수치만큼
  c.mana = Math.min(s.maxMana, c.mana + s.manaRegen / 5 * dt);    // 마나 재생: 5초당 수치만큼
  c.might = Math.max(0, c.might - dt);
  c.medPost = Math.max(0, c.medPost - dt);
  c.apCd = Math.max(0, c.apCd - dt);                              // 사신 태세 재사용 대기(실제 시간)
  if (c.aqWin > 0) { c.aqWin -= dt; if (c.aqWin <= EPS) { c.aqWin = 0; c.aqNext = 1; } }   // Q 재사용 창 3초: 끝나면 다음은 1단계
  c.persT += dt;                                                  // 인내심: 마지막 피해 후 경과 시간(피해 받을 때 0으로)
  if (c.key === 'garen' && c.persT >= GAREN_PASSIVE.idle - EPS) c.hp = Math.min(s.maxHp, c.hp + s.maxHp * GAREN_PASSIVE.perSec * dt);
  if (c.gq) { c.gq.t -= dt; if (c.gq.t <= 0) c.gq = null; }          // 결정타 강화 4.5초 (평타가 나가면 strike에서 소모)
  c.gqMs = Math.max(0, c.gqMs - dt);                              // 결정타 이동속도 남은 시간
  if (c.gw) { c.gw.t -= dt; if (c.gw.t <= 0) c.gw = null; }          // 용기 피해 감소 4초
  tickStatus(w, c, dt);
  if (c.dead) return;

  // 공중에 뜸 / 끌려오는 중: 하려던 모든 행동이 취소되고 아무 행동도 할 수 없음 (피격은 그대로)
  const locked = c.air > 0 || !!c.pull;
  if (locked) { c.atk = null; c.cast = null; c.qPrep = null; endMed(c); c.dhit = null; cancelAatroxQ(c); }   // 공중에 뜸·끌려옴: 명상 끊김, 2연속 예약 취소, 아트록스 Q 시전 취소(피해 없음, 같은 단계 재사용 창 새로 열림, A6)
  // 쿨타임. 다리우스 W는 강화(wBuff)가 켜져 있는 동안 멈춰 있다가 강화 평타가 나간 뒤부터 흐름
  // 가렌 Q는 결정타 강화(gq) 동안 멈춰 있다가 강화가 끝나면(평타 또는 만료) 흐름
  for (const k of SKILL_KEYS) if (!(k === 'w' && c.wBuff) && !(k === 'q' && c.gq)) c.cd[k] = Math.max(0, c.cd[k] - dt);

  // 학살 준비 → 휘두르기
  if (c.qPrep) { c.qPrep.t += dt; if (c.qPrep.t >= c.qPrep.dur) { const lv = c.qPrep.lv; c.qPrep = null; doDecimate(w, c, lv); } }
  // 평타 선딜 → 타격 → 후딜
  if (c.atk) {
    const a = c.atk; a.t += dt;
    if (!a.hit && a.t >= a.wind) { a.hit = true; const t = unitOf(w, a.targetId); if (t && !t.dead && !t.untarget) strike(w, c, t); }
    if (a.t >= a.wind + a.back) c.atk = null;
  }
  // 시전 시간(포획, 단두대): 시전 중에는 이동 불가
  if (c.cast) {
    const k = c.cast; k.t += dt;
    if (k.type === 'r') { const p = Math.min(1, k.t / k.dur); c.x = k.from.x + (k.to.x - k.from.x) * p; c.y = k.from.y + (k.to.y - k.from.y) * p; }
    if (k.t >= k.dur) { c.cast = null; finishCast(w, c, k); }
  }
  if (c.dead) return;
  // 가렌: 심판 회전(공중에 뜨거나 끌려가도 계속 돎), 데마시아의 정의 시전
  if (c.ge) garenSpinTick(w, c, dt);
  if (c.gr && !c.dead) garenRTick(w, c, dt);
  if (c.dead) return;
  // 아트록스 Q: 0.6초 시전 뒤 판정
  if (c.aq) aatroxQTick(w, c, dt);

  // 마스터 이: 일격필살 진행 · 2연속 두 번째 타격 대기 · 명상 · 우주류/최후의 전사 타이머
  if (c.yq) yiAlphaTick(w, c, dt);
  if (c.dhit) { c.dhit.t -= dt; if (c.dhit.t <= EPS) { const h = c.dhit; c.dhit = null; const t = unitOf(w, h.targetId); if (t && !t.dead && !t.untarget) yiSecondHit(w, c, t); } }
  if (c.med) yiMedTick(w, c, dt);
  if (c.wuju > 0 && !c.med && !c.yq) c.wuju = Math.max(0, c.wuju - dt);   // 명상·일격필살 중에는 줄지 않음
  c.hl = Math.max(0, c.hl - dt);

  // 평타 쿨타임 · 대상 없음 텍스트 쿨타임 (추적 판정이 쿨타임을 보므로 이동 전에 줄임)
  c.atkCd = Math.max(0, c.atkCd - dt);
  c.noTgt = Math.max(0, c.noTgt - dt);

  // 이동 (평타 추적 중이면 이번 틱 방향은 대상 쪽. 추적이 사거리 안에서 평타를 시작하면 아래 잠금에 의해 멈춤)
  let mx = c.in.mx, my = c.in.my;
  if (c.chase) { const ch = chaseTick(w, c, locked); if (ch) { mx = ch.dx; my = ch.dy; } }
  if (c.atk || c.cast || locked || c.yq || c.med || c.gr || c.aq) { mx = 0; my = 0; }   // 평타·시전·일격필살·명상·데마시아의 정의 시전 중, 공중에 뜬 동안에는 멈춤 (심판 회전 중에는 이동 가능)
  c.moving = !!(mx || my);
  if (c.moving) {
    const sp = px(curMS(c)) * (1 - (c.slow ? c.slow.pct : 0)) * dt;
    stepMove(w, c, mx * sp, my * sp);
    if (Math.abs(mx) > 0.15) c.facing = mx < 0 ? -1 : 1;
  }

  // 평타 입력
  if (!c.in.atk) c.chaseHold = false;                  // 평타 버튼을 떼면 재추적 금지 해제
  if (!locked && !c.cast && !c.yq && !c.ge && !c.gr && !c.aq && c.in.atk) {   // 가렌: 심판 회전·궁극기 시전 중에는 평타·자동 추적 시작 안 함(G11)
    const t = c.chase ? null : targetInRange(w, c);   // 추적 중에는 쫓는 챔피언만 노림(가는 길에 포탑·허수아비가 사거리에 들어와도 무시)
    if (c.chase) { /* chaseTick이 처리 */ }
    else if (t) { if (c.atkCd <= 0 && !c.atk) startAttack(w, c, t); }
    else {
      if (c.in.edge) fx(w, { fx: 'atkRange', owner: c.id, life: 0.6 });   // 사거리 표시: 대상 없이 누른 순간에만 (추적과 무관)
      const g = !c.chase && !c.atk && !c.chaseHold ? chaseTarget(w, c) : null;
      if (g) { if (!(c.in.mx || c.in.my)) c.chase = { targetId: g.id }; }   // 조이스틱을 쥔 채 누르면 추적을 시작하지 않음(곧바로 취소되므로)
      else if (c.in.edge && !c.chase && c.noTgt <= 0) { text(w, c.x, c.y - px(70), '사거리 내 대상 없음', '#b8c4cf', false, c.id); c.noTgt = 0.8; }
    }
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
  if (tgt && (tgt.dead || tgt.untarget || edgeDist(t, tgt) > px(c.range))) {   // 대상 지정 불가가 되면 조준 해제(날아가던 투사체도 사라짐)
    if (t.warn > 0 && !t.locked && !tgt.dead && !tgt.untarget) text(w, tgt.x, tgt.y - px(40), '회피', '#9fd3ff');
    resetTurretLock(t); tgt = null;
  }
  if (!tgt) {   // 사거리 안의 가장 가까운 적 챔피언을 조준
    let bd = Infinity;
    for (const u of w.champs) {
      if (u.team === t.team || u.dead || u.untarget) continue;
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
      const got = hurt(w, tgt, dmg, true);     // 포탑 피해: 명상 피해 감소는 절반
      text(w, tgt.x, tgt.y - px(40), got.toFixed(0), '#ff6b6b', true);
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
    case 'dummyReset': for (const d of w.dummies) { d.x = HOME.x; d.y = HOME.y; d.pull = null; d.air = 0; d.slow = null; d.pendSlow = false; d.bleed = null; d.hp = d.maxHp; d.total = 0; d.hits = []; d.idle = 0; d.flash = 0; d.silence = null; d.shields = []; d.tenSrc = []; d.shred = null; } break;
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
  TICK, MAP_W, MAP_H, U, HIT_R, START_LEVEL, RESPAWN_SEC, SPAWNS, HOME, TURRET_CFG, CHAMPS, BLEED, WINDUP, BACKSWING, SK, SKILL_KEYS, CHASE,
  // 규칙
  setMap, isWalk, canStand, createWorld, step, drainEvents, calcStats,
  // 조회
  px, gameTime, champOf, unitOf, isChampLike, edgeDist, enemiesOf, targetInRange, chaseTarget, ultTarget, autoAim, dummyDps,
  buffAD, curAD, penPct, bleedPerStack, bleedTotal, skMana, skCd, turretAD,
  // 추가 스탯 · 방어력 · 보호막 · 강인함 · 침묵 (DESIGN_GAREN.md §1)
  bonusAD, totalAD, bonusHP, bonusASPct, armorOf, mrOf,
  addShield, shieldOf, addTenacity, tenacityOf, addSilence,
  // 마스터 이 (화면 전용 조회)
  SKILLS, YI_PASSIVE, skillsOf, curAS, curMS, dmgTakenMul, yiQTarget,
  // 가렌 (DESIGN_GAREN.md §2): 데마시아의 정의 대상, 인내심 상수
  GAREN_PASSIVE, garenRTarget,
  // 피해 · 흡혈 (DESIGN.md §1-1): 가해자와 광역 여부를 넘김. 마법 피해(마법 저항 적용)
  dealPhys, dealMagic, dealTrue, omnivampOf, OMNI_AOE,
  // 아트록스 (DESIGN_AATROX.md §2): 사신 태세 상수, Q 도형(화면과 같은 값), Q 단계(버튼 표시)
  AATROX_PASSIVE, aatroxQShape, aatroxQStage, atkRange
};
});
