(() => {
'use strict';
/* =====================================================================
   클라이언트: 화면 그리기 + 입력 + HUD
   게임 규칙은 전부 core.js(Core)에 있고, 여기서는 규칙을 직접 계산하지 않습니다.
     입력 → 명령(session.send) → 코어가 계산 → 월드 상태를 읽어서 그림
   층 구조
     Core(규칙) ← Session(진행을 맡는 층) ← Client(화면·입력)
   세션은 두 종류: LocalSession(session_local.js, 이 브라우저에서 Core 실행)과 OnlineSession(session_online.js, 서버와 예측·보간).
   이 파일은 세션 인터페이스만 쓰고, 화면 흐름은 lobby.js가 Game(window.Game)으로 제어합니다.
   ===================================================================== */
const { TICK, MAP_W, MAP_H, HIT_R, SK, BLEED, TURRET_CFG, CHAMPS, SKILL_KEYS, px } = Core;
const VIEW_H = 576, VIEW_MIN_W = 816;                 // 컨셉 화면 기준 카메라 영역(px)
const SPRITE_H = { darius: 56, yi: 58 };              // 스프라이트 높이(px)
const SPRITE_AX = { darius: 0.60, yi: 0.50 };         // 발 위치(가로 비율)
const fmt = (n, d = 0) => Number(n).toFixed(d);
const dmgTxt = n => n < 10 ? fmt(n, 1) : fmt(n, 0);

const $ = s => document.querySelector(s);
const app = $('#app'), cv = $('#cv'), ctx = cv.getContext('2d');
const A = window.ASSETS;
Core.setMap(A.walk);

const imgs = {};
function loadImg(k, src) { return new Promise(res => { const i = new Image(); i.onload = () => { imgs[k] = i; res(); }; i.src = src; }); }
const ready = Promise.all([loadImg('map', A.map), loadImg('darius', A.darius), loadImg('yi', A.yi)]);

/* 세션(LocalSession / OnlineSession)은 session_local.js, session_online.js 에 있다. 여기서는 인터페이스만 사용 */
let session = null;      // null이면 챔피언 선택 화면
let phase = 'idle';       // idle(화면 밖) | play | paused(결과 화면 동안)
let onExit = null;       // 테스트 도구 '챔피언 다시 선택' 버튼이 부르는 콜백(로비가 정함)
let selKey = 'darius';
let dbg = false;
const fxList = [], texts = [];
const cam = { x: Core.SPAWNS[0].x + 300, y: Core.SPAWNS[0].y - 220 };
const W = () => session.world;
const ME = () => session ? session.me() : null;
const P2 = u => session.pos(u);

/* =====================================================================
   입력 → 명령
   ===================================================================== */
const input = { jx: 0, jy: 0, atkTouch: false, atkKey: false, keys: new Set() };
let lastSent = '';
function sendInput() {
  const me = ME(); if (!me) return;
  let mx = input.jx, my = input.jy;
  if (!mx && !my) {
    const k = input.keys; mx = (k.has('r') ? 1 : 0) - (k.has('l') ? 1 : 0); my = (k.has('d') ? 1 : 0) - (k.has('u') ? 1 : 0);
    const m = Math.hypot(mx, my); if (m) { mx /= m; my /= m; }
  }
  const atk = input.atkTouch || input.atkKey;
  const sig = `${mx.toFixed(3)},${my.toFixed(3)},${atk ? 1 : 0}`;
  if (sig !== lastSent) { lastSent = sig; session.send({ type: 'input', id: session.myId, mx, my, atk }); }
}
function castSkill(k, ang) { const me = ME(); if (me && phase === 'play') session.send({ type: 'cast', id: me.id, skill: k, ang }); }
function levelUp(k) { const me = ME(); if (me) session.send({ type: 'levelup', id: me.id, skill: k }); }
function dev(op, extra) { const me = ME(); if (me) session.send(Object.assign({ type: 'dev', id: me.id, op }, extra)); }
const autoAng = champOnly => Core.autoAim(W(), ME(), champOnly);

const joy = $('#joy'), knob = $('#knob'), atk = $('#atk');
let joyId = null;
function updJoy(e) {
  const r = joy.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let dx = e.clientX - cx, dy = e.clientY - cy;
  const max = r.width / 2 - 8, d = Math.hypot(dx, dy) || 1, k = d > max ? max / d : 1;
  dx *= k; dy *= k;
  knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  const m = Math.hypot(dx, dy) / max;
  if (m < 0.18) { input.jx = 0; input.jy = 0; } else { input.jx = dx / Math.hypot(dx, dy); input.jy = dy / Math.hypot(dx, dy); }
}
function joyEnd(e) { if (e.pointerId !== joyId) return; joyId = null; input.jx = 0; input.jy = 0; knob.style.transform = 'translate(-50%, -50%)'; }
joy.addEventListener('pointerdown', e => { joyId = e.pointerId; joy.setPointerCapture(e.pointerId); updJoy(e); e.preventDefault(); });
joy.addEventListener('pointermove', e => { if (e.pointerId === joyId) updJoy(e); });
joy.addEventListener('pointerup', joyEnd); joy.addEventListener('pointercancel', joyEnd);

let atkId = null;
atk.addEventListener('pointerdown', e => { atkId = e.pointerId; atk.setPointerCapture(e.pointerId); input.atkTouch = true; atk.classList.add('down'); e.preventDefault(); });
const atkEnd = e => { if (e.pointerId !== atkId) return; atkId = null; input.atkTouch = false; atk.classList.remove('down'); };
atk.addEventListener('pointerup', atkEnd); atk.addEventListener('pointercancel', atkEnd);

const MOVE_KEYS = { KeyW: 'u', ArrowUp: 'u', KeyS: 'd', ArrowDown: 'd', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' };
window.addEventListener('keydown', e => {
  if (phase !== 'play') return;
  if (MOVE_KEYS[e.code]) { input.keys.add(MOVE_KEYS[e.code]); e.preventDefault(); }
  else if (/^Digit[1-4]$/.test(e.code)) { const k = SKILL_KEYS[+e.code.slice(5) - 1]; if (e.shiftKey) levelUp(k); else castSkill(k, autoAng(k === 'e')); e.preventDefault(); }
  else if (e.code === 'Space' || e.code === 'KeyJ') { input.atkKey = true; atk.classList.add('down'); e.preventDefault(); }
});
window.addEventListener('keyup', e => {
  if (MOVE_KEYS[e.code]) input.keys.delete(MOVE_KEYS[e.code]);
  else if (e.code === 'Space' || e.code === 'KeyJ') { input.atkKey = false; if (!input.atkTouch) atk.classList.remove('down'); }
});
window.addEventListener('blur', () => { input.keys.clear(); input.atkKey = false; });

/* =====================================================================
   HUD / 스탯 패널 / 선택 화면
   ===================================================================== */
const hud = $('#hud'), sel = $('#select'), statBtn = $('#statBtn'), panel = $('#statPanel'), banner = $('#banner');
let bannerT = 0;
function showBanner(txt, bad, sec) { banner.textContent = txt; banner.className = bad ? 'bad' : ''; banner.hidden = false; bannerT = sec || 3; }

statBtn.addEventListener('click', () => {
  const open = panel.hidden;
  panel.hidden = !open; statBtn.setAttribute('aria-expanded', String(open));
  if (open) refreshPanel();
});

const ROWS = [
  ['lv', '레벨'], ['hp', '체력'], ['regen', '체력 재생'], ['mana', '마나'], ['mregen', '마나 재생'],
  ['ad', '공격력'], ['ap', '주문력'], ['as', '공격속도'], ['armor', '방어력'], ['mr', '마법저항력'],
  ['pen', '물리관통력'], ['range', '사거리'], ['ms', '이동속도'], ['sp', '스킬 포인트']
];
$('#spRows').innerHTML = ROWS.map(([k, l]) => `<dt>${l}</dt><dd id="sp_${k}">-</dd>`).join('');
function refreshPanel() {
  const me = ME(); if (!me || panel.hidden) return;
  const s = me.stats, set = (k, v) => { const el = $('#sp_' + k); if (el.textContent !== v) el.textContent = v; };
  $('#spName').textContent = CHAMPS[me.key].name + ' 스탯';
  set('lv', String(me.level));
  set('hp', `${fmt(me.hp, 0)} / ${fmt(s.maxHp, 0)}`);
  set('regen', `${fmt(s.regen, 2)} /5초`);
  set('mana', `${fmt(me.mana, 0)} / ${fmt(s.maxMana, 0)}`);
  set('mregen', `${fmt(s.manaRegen, 2)} /5초`);
  set('ad', me.might > 0 ? `${fmt(Core.curAD(me), 1)} (+${Core.buffAD(me)})` : fmt(s.ad, 1)); set('ap', fmt(s.ap, 0));
  const cas = Core.curAS(me), cms = Core.curMS(me);   // 최후의 전사 중에는 공격속도·이동속도 버프를 괄호로 표시
  set('as', Math.abs(cas - s.as) > 1e-9 ? `${fmt(cas, 3)} /초 (+${fmt(cas - s.as, 3)})` : `${fmt(s.as, 3)} /초`);
  set('armor', fmt(s.armor, 1)); set('mr', fmt(s.mr, 1));
  set('pen', `${fmt(Core.penPct(me), 0)}%`); set('range', `${s.range + (me.wBuff ? SK.w.rangeBonus : 0)} 유닛`); set('ms', Math.abs(cms - s.ms) > 1e-9 ? `${fmt(cms, 0)} (+${fmt(cms - s.ms, 0)})` : String(s.ms)); set('sp', String(me.sp));
}
setInterval(refreshPanel, 120);

/* ---------- 챔피언별 패시브 표시 (아이콘·이름·설명). 여기 없는 챔피언은 패시브 아이콘이 없음 ---------- */
const PASSIVE_UI = {
  darius: {
    label: '패시브 과다출혈. 누르고 있으면 설명이 보입니다',
    title: '패시브 · 과다출혈',
    desc: '다리우스의 기본 공격과 공격 스킬이 상대에게 과다출혈을 일으켜 5초에 걸쳐 물리 피해를 입힙니다. 이 효과는 최대 5번까지 중첩됩니다. 적이 최대로 중첩되거나 녹서스의 단두대로 처치되면, 5초 동안 다리우스의 공격력이 증가하고 모든 기본 공격과 스킬 공격 사용 시 과다출혈 중첩이 5번 적용됩니다.',
    icon: '<path d="M12 2.5C12 2.5 5 10.2 5 15a7 7 0 0 0 14 0c0-4.8-7-12.5-7-12.5z" fill="#d4182f" stroke="#f3c4c8" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 15.5a3 3 0 0 0 2.4 2.9" fill="none" stroke="#ffb3ba" stroke-width="1.4" stroke-linecap="round"/>'
  },
  yi: {
    label: '패시브 2연속 공격. 누르고 있으면 설명이 보입니다',
    title: '패시브 · 2연속 공격',
    desc: '매 4번째 기본 공격마다 2번 연속 공격합니다. 두 번째 공격은 공격력의 50% 물리 피해 (기본 공격 판정)',
    icon: '<path d="M5.5 5C9.5 9.5 12 14.5 18.5 19.5" fill="none" stroke="#eefcff" stroke-width="2.4" stroke-linecap="round"/><path d="M10.5 3.5C13.5 8.5 15.5 13 20.5 16.5" fill="none" stroke="#7fdcff" stroke-width="2" stroke-linecap="round"/>'
  }
};
const pBtn = $('#passiveBtn'), pTip = $('#passiveTip'), pIco = $('#pIco'), pTipH = $('#pTipH'), pTipP = $('#pTipP');
const mightT = $('#mightT'), stackN = $('#stackN'), tipRows = $('#tipRows');
const YI_STACK_MAX = Core.YI_PASSIVE.every - 1;   // 패시브 스택 최대(3). 4번째 기본 공격이 2연속 공격
function setTxt(el, v) { if (el.textContent !== v) el.textContent = v; }
function refreshPassive() {
  const me = ME(); if (!me || !PASSIVE_UI[me.key]) return;
  if (me.key === 'yi') { refreshYiPassive(me); return; }
  const on = me.might > 0;
  pBtn.classList.toggle('on', on); mightT.hidden = !on; if (on) mightT.textContent = fmt(me.might, 1) + 's';
  if (pTip.hidden) return;
  tipRows.innerHTML = [
    ['1중첩당 피해', `${Core.bleedPerStack(me)} + 공격력 × 30%`],
    ['5중첩 총 피해', `${fmt(Core.bleedTotal(me, 5), 0)} (5초)`],
    ['공격력 증가', `+${BLEED.buffBase + BLEED.buffPerLvl * (me.level - 1)} (5초)`],
    ['현재 공격력', fmt(Core.curAD(me), 1)]
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}
function refreshYiPassive(me) {   // 스택 0~3을 아이콘 위에 표시. 3이면 다음 기본 공격이 2연속 공격이라 강조
  const n = me.dstack, full = n >= YI_STACK_MAX;
  setTxt(stackN, String(n)); stackN.classList.toggle('full', full); pBtn.classList.toggle('ready', full);
  if (pTip.hidden) return;
  const e = Core.SKILLS.yi.e, rows = [['현재 스택', `${n}/${YI_STACK_MAX}`], ['두 번째 공격 피해', fmt(Core.YI_PASSIVE.ratio * Core.curAD(me), 1)]];
  if (me.wuju > 0) rows.push(['추가 고정 피해', fmt(e.dmg[Math.max(1, me.sk.e) - 1] + e.ratio * Core.curAD(me), 1)]);
  tipRows.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}
let tipId = null;
pBtn.addEventListener('pointerdown', e => { tipId = e.pointerId; pBtn.setPointerCapture(e.pointerId); pTip.hidden = false; refreshPassive(); e.preventDefault(); });
const tipOff = e => { if (e.pointerId !== tipId) return; tipId = null; pTip.hidden = true; };
pBtn.addEventListener('pointerup', tipOff); pBtn.addEventListener('pointercancel', tipOff);
pBtn.addEventListener('contextmenu', e => e.preventDefault());

/* ---------- 스킬 버튼 (탭: 즉시 시전 / 길게 누름: 범위 표시 후 손을 떼면 시전) ---------- */
const skCancel = $('#skCancel');
function overCancel(x, y) {   // X 아이콘 위인지(손가락이라 12px 여유)
  if (skCancel.hidden) return false;
  const r = skCancel.getBoundingClientRect(), m = 12;
  return x >= r.left - m && x <= r.right + m && y >= r.top - m && y <= r.bottom + m;
}
const held = {};   // 누르고 있는 스킬 버튼 { id, sx, sy, t, dragged, ang, show }  (조준은 클라이언트에서만)
const skW = {};
for (const k of SKILL_KEYS) {
  const w = document.querySelector(`.skw[data-k="${k}"]`);
  skW[k] = { w, b: w.querySelector('.sk'), up: w.querySelector('.lvup'), dotBox: w.querySelector('.dots'), dots: [], cdT: null, s: {} };
  const b = skW[k].b;
  b.addEventListener('pointerdown', e => {
    const me = ME(); if (!me || me.dead) return;
    held[k] = { id: e.pointerId, sx: e.clientX, sy: e.clientY, t: performance.now(), dragged: false, ang: 0, show: false, cancel: false };
    b.setPointerCapture(e.pointerId); e.preventDefault();
  });
  b.addEventListener('pointermove', e => {
    const h = held[k]; if (!h || h.id !== e.pointerId) return;
    const dx = e.clientX - h.sx, dy = e.clientY - h.sy;
    if (Math.hypot(dx, dy) > 14) { h.dragged = true; h.ang = Math.atan2(dy, dx); }
    h.cancel = overCancel(e.clientX, e.clientY);
  });
  const up = (e, cancel) => {
    const h = held[k]; if (!h || h.id !== e.pointerId) return;
    delete held[k];
    if (!cancel && !overCancel(e.clientX, e.clientY)) castSkill(k, h.dragged ? h.ang : autoAng(k === 'e'));
  };
  b.addEventListener('pointerup', e => up(e, false)); b.addEventListener('pointercancel', e => up(e, true));
  b.addEventListener('contextmenu', e => e.preventDefault());
  skW[k].up.addEventListener('pointerdown', e => { levelUp(k); e.preventDefault(); e.stopPropagation(); });
}
/* 챔피언별 스킬 버튼: 아이콘(SVG)과 이름(aria), 레벨 점 개수(SKILLS[key][k].max). 다리우스 아이콘은 예전 그대로 */
const ICON = {
  darius: {
    q: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20 15 9"/><path d="M13 3.5 20.5 11 17 14.5 9.5 7z"/></svg>',
    w: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20 14 10"/><path d="M14 10l5-6 1 1-6 5"/><path d="M18 14l1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/></svg>',
    e: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v8"/><path d="M12 11a4 4 0 1 0 4 4"/><path d="M16 15l2-2.5M16 15l-2.5-1"/></svg>',
    r: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v13"/><path d="M6 11l6 7 6-7"/><path d="M5 21h14"/></svg>'
  },
  yi: {   // 일격필살: 칼 대쉬 · 명상: 연꽃 · 우주류 검술: 빛나는 검 · 최후의 전사: 솟구치는 꺾쇠
    q: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 3 10 14"/><path d="M13.5 6.5l4 4"/><path d="M10 14l-2.5 2.5"/><path d="M4 9.5h4M3 13.5h5M5 17.5h3"/></svg>',
    w: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 18c-4.5 0-8-2.4-9-6 3.2.4 5.4 1.4 9 6z"/><path d="M12 18c4.5 0 8-2.4 9-6-3.2.4-5.4 1.4-9 6z"/><path d="M12 18c-2.4-3.2-2.4-8.6 0-13 2.4 4.4 2.4 9.8 0 13z"/><path d="M7 21h10"/></svg>',
    e: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 14.2 13h-4.4z" fill="currentColor" fill-opacity=".25"/><path d="M8 13.5h8"/><path d="M12 13.5V19"/><circle cx="12" cy="20.5" r="1.2"/><path d="M4.5 5.5v3M3 7h3"/><path d="M19.5 9v3M18 10.5h3"/></svg>',
    r: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 13l6-6 6 6"/><path d="M6 19l6-6 6 6"/></svg>'
  }
};
let skinKey = null;   // 지금 버튼에 그려진 챔피언
function applySkin(key) {
  const def = Core.SKILLS[key];
  SKILL_KEYS.forEach((k, i) => {
    const o = skW[k], label = (k === 'r' ? '궁극기 · ' : `스킬 ${i + 1} · `) + def[k].name;
    o.b.innerHTML = ICON[key][k] + '<span class="cdT"></span>';
    o.cdT = o.b.querySelector('.cdT');
    o.b.setAttribute('aria-label', label); o.up.setAttribute('aria-label', label + ' 레벨업');
    o.dotBox.innerHTML = ''; o.dots = [];
    for (let n = 0; n < (k === 'r' ? 3 : def[k].max); n++)   // 궁극기 점은 3개(원래 명세 5/5/5/3), 지금은 1레벨까지만 찍힘
    { const d = document.createElement('i'); o.dotBox.appendChild(d); o.dots.push(d); }
    o.s = {};
  });
  pIco.innerHTML = PASSIVE_UI[key].icon;
  pBtn.setAttribute('aria-label', PASSIVE_UI[key].label);
  pBtn.classList.remove('on', 'ready'); pBtn.classList.toggle('yi', key === 'yi');
  mightT.hidden = true; stackN.hidden = key !== 'yi';
  pTipH.textContent = PASSIVE_UI[key].title; pTipP.textContent = PASSIVE_UI[key].desc;
  skinKey = key;
}
function refreshSkills() {
  const me = ME(), on = !!me && !!Core.skillsOf(me);
  if (on && skinKey !== me.key) applySkin(me.key);
  for (const k of SKILL_KEYS) {
    const o = skW[k]; o.w.hidden = !on;
    if (!on) continue;
    const lv = me.sk[k], max = Core.SKILLS[me.key][k].max, set = (name, v, fn) => { if (o.s[name] !== v) { o.s[name] = v; fn(v); } };
    set('lv', lv, v => { o.b.dataset.lv = v; o.dots.forEach((d, i) => d.classList.toggle('on', i < v)); });
    set('up', me.sp > 0 && lv < max && !me.dead, v => { o.up.hidden = !v; });
    const cdv = me.cd[k], frac = cdv > 0 ? cdv / Core.skCd(me, k) : 0;
    set('cdf', frac.toFixed(3), v => o.b.style.setProperty('--cd', v));
    set('cdt', cdv > 0 ? (cdv >= 10 ? String(Math.ceil(cdv)) : fmt(cdv, 1)) : '', v => { o.cdT.textContent = v; });
    set('nm', lv > 0 && me.mana < Core.skMana(me, k), v => o.b.classList.toggle('nomana', v));
    set('hold', !!(held[k] && held[k].show), v => o.b.classList.toggle('hold', v));
  }
  // 스킬을 누른 채 조준 중일 때만 X(취소) 표시
  let aiming = false, inX = false;
  for (const k in held) { const h = held[k]; if (h.show || h.dragged) aiming = true; if (h.cancel) inX = true; }
  if (skCancel.hidden === aiming) skCancel.hidden = !aiming;
  skCancel.classList.toggle('over', aiming && inX);
}

/* ---------- 테스트 도구 ---------- */
$('#tDbg').addEventListener('click', e => { dbg = !dbg; e.currentTarget.setAttribute('aria-pressed', String(dbg)); });
$('#tPlus1').addEventListener('click', () => dev('time', { sec: 60 }));
$('#tPlus5').addEventListener('click', () => dev('time', { sec: 300 }));
$('#tTurret').addEventListener('click', () => { dev('turretReset'); banner.hidden = true; });
$('#tDummy').addEventListener('click', () => dev('dummyReset'));
$('#tDmArmor').addEventListener('click', () => dev('dummyArmor'));
$('#tAir').addEventListener('click', () => dev('air'));
$('#tReset').addEventListener('click', () => dev('ready'));
$('#tSpawn').addEventListener('click', () => { dev('spawn'); });
$('#tReselect').addEventListener('click', () => { if (onExit) onExit(); });

const cardsEl = $('#cards');
cardsEl.innerHTML = Object.keys(CHAMPS).map(k => {
  const s = Core.calcStats(k, Core.START_LEVEL);
  return `<button type="button" class="card" data-key="${k}" aria-pressed="${k === selKey}">
    <span class="art"><img alt="${CHAMPS[k].name}" src="${A[k]}"></span>
    <span><h2>${CHAMPS[k].name}</h2>
    <dl><dt>체력</dt><dd>${fmt(s.maxHp, 0)}</dd><dt>공격력</dt><dd>${fmt(s.ad, 0)}</dd><dt>공격속도</dt><dd>${fmt(s.as, 3)}</dd>
    <dt>방어력</dt><dd>${fmt(s.armor, 1)}</dd><dt>이동속도</dt><dd>${s.ms}</dd><dt>사거리</dt><dd>${s.range}</dd></dl></span>
  </button>`;
}).join('');
cardsEl.addEventListener('click', e => {
  const b = e.target.closest('.card'); if (!b) return;
  selKey = b.dataset.key;
  cardsEl.querySelectorAll('.card').forEach(c => c.setAttribute('aria-pressed', String(c === b)));
});
/* =====================================================================
   Game: 로비(lobby.js)가 쓰는 공개 API
   start(session, {onExit}) 시작 · pause(on) 결과 화면 동안 정지 · stop() 화면 정리 · selected() 선택 챔피언
   ===================================================================== */
function setTestTools(on) { $('#testH').hidden = !on; $('#testTools').hidden = !on; }
function clearInputs() {
  input.keys.clear(); input.jx = input.jy = 0; input.atkTouch = input.atkKey = false; atk.classList.remove('down');
  for (const k in held) delete held[k];
  lastSent = '';
}
window.Game = {
  start(sess, opts) {
    session = sess; onExit = (opts && opts.onExit) || null;
    clearInputs(); fxList.length = 0; texts.length = 0; banner.hidden = true;
    panel.hidden = true; statBtn.setAttribute('aria-expanded', 'false');
    phase = 'play'; hud.hidden = false;
    snapCam();
    const me = ME(); pBtn.hidden = !me || !PASSIVE_UI[me.key]; pTip.hidden = true;
    if (me && skinKey !== me.key) applySkin(me.key);
    prevPos.clear();
    setTestTools(!!sess.test);
    $('#tReselect').textContent = sess.online ? '방 나가기' : '챔피언 다시 선택';
    $('#pingT').hidden = !sess.online;
    refreshPanel();
  },
  pause(on) { if (session) { phase = on ? 'paused' : 'play'; clearInputs(); } },
  stop() {
    session = null; onExit = null; phase = 'idle';
    hud.hidden = true; panel.hidden = true; statBtn.setAttribute('aria-expanded', 'false');
    banner.hidden = true; pTip.hidden = true; clearInputs();
  },
  selected() { return selKey; },
  get session() { return session; },   // 읽기 전용(점검·디버그용)
};

/* =====================================================================
   코어 이벤트 → 화면 효과
   ===================================================================== */
const FX_LIFE = { blink: 0.36, yslash: 0.18 };   // 코어가 수명(life)을 주지 않는 이펙트의 기본 수명(초)
function handleEvents() {
  const myId = session.myId;
  for (const ev of session.drainEvents()) {
    if (ev.type === 'text') { if (!ev.to || ev.to === myId) texts.push({ x: ev.x, y: ev.y, txt: ev.txt, color: ev.color, big: ev.big, t: 0, life: 0.9, dx: (Math.random() - .5) * 10 }); }
    else if (ev.type === 'fx') fxList.push(Object.assign({}, ev, { t: 0, life: ev.life || FX_LIFE[ev.fx] || 0.3 }));
    else if (ev.type === 'banner') showBanner(ev.txt, ev.bad, ev.sec);
  }
}

/* =====================================================================
   카메라
   ===================================================================== */
let cssW = 1, cssH = 1, dpr = 1, zoom = 1;
function resize() {
  const r = app.getBoundingClientRect();
  cssW = Math.max(1, r.width); cssH = Math.max(1, r.height); dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
  zoom = Math.min(cssH / VIEW_H, cssW / VIEW_MIN_W);
}
new ResizeObserver(resize).observe(app); resize();
function clampCam(x, y) {
  const vw = cssW / zoom, vh = cssH / zoom;
  return [vw >= MAP_W ? MAP_W / 2 : Math.min(Math.max(x, vw / 2), MAP_W - vw / 2),
          vh >= MAP_H ? MAP_H / 2 : Math.min(Math.max(y, vh / 2), MAP_H - vh / 2)];
}
function snapCam() { const me = ME(); if (!me) return; const [cx, cy] = clampCam(me.x, me.y - 8); cam.x = cx; cam.y = cy; }
function updateCamera(dt) {
  let tx, ty;
  const me = ME();
  if (session && me) { const p = P2(me); tx = p[0]; ty = p[1] - 8; } else { tx = Core.SPAWNS[0].x + 330; ty = Core.SPAWNS[0].y - 250; }
  const [cx, cy] = clampCam(tx, ty), k = 1 - Math.exp(-11 * dt);
  cam.x += (cx - cam.x) * k; cam.y += (cy - cam.y) * k;
}

/* =====================================================================
   그리기
   ===================================================================== */
function rr(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
const FONT = '"Do Hyeon", "Noto Sans KR", system-ui, sans-serif';
let clockT = 0;   // 화면 효과용 시계(초)

function drawLevelBadge(x, y, lvl) {
  ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.fillStyle = '#05080b'; ctx.fill();
  ctx.lineWidth = 1.4; ctx.strokeStyle = '#f0e6d2'; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = `700 10px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(lvl), x, y + 0.5);
}
/* 챔피언 체력바: 한 칸 = 체력 100. 아래에 칸 없는 얇은 마나바 */
function drawChampBar(c, cx, bottomY) {
  const SEG = 100, SW = 7, h = 9, MH = 4, maxHp = c.stats.maxHp, n = maxHp / SEG, w = n * SW, x0 = cx - w / 2 + 6, y0 = bottomY - h - MH - 2;
  const fill = c.dead ? '#556' : (c.team === ME().team ? '#3fd07a' : '#e5484d'), back = c.team === ME().team ? '#1f3a2b' : '#3a1618';
  ctx.fillStyle = 'rgba(5,8,11,.9)'; rr(x0 - 1.5, y0 - 1.5, w + 3, h + 3, 2); ctx.fill();
  for (let i = 0; i < Math.ceil(n); i++) {
    const sw = Math.min(SW, w - i * SW), frac = Math.max(0, Math.min(1, (c.hp - i * SEG) / SEG)), gap = i < Math.ceil(n) - 1 ? 1 : 0;
    ctx.fillStyle = back; ctx.fillRect(x0 + i * SW, y0, sw - gap, h);
    if (frac > 0) { ctx.fillStyle = fill; ctx.fillRect(x0 + i * SW, y0, (sw - gap) * frac, h); }
  }
  ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fillRect(x0, y0, w, 2);
  const my = y0 + h + 2;
  ctx.fillStyle = 'rgba(5,8,11,.9)'; rr(x0 - 1.5, my - 1.5, w + 3, MH + 3, 2); ctx.fill();
  ctx.fillStyle = '#12284a'; ctx.fillRect(x0, my, w, MH);
  ctx.fillStyle = '#3d9bff'; ctx.fillRect(x0, my, w * Math.max(0, Math.min(1, c.mana / c.stats.maxMana)), MH);
  ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fillRect(x0, my, w, 1);
  drawLevelBadge(x0 - 4, y0 + h / 2, c.level);
}
function drawTurretBar(t) {
  const w = 96, h = 10, x0 = t.x - w / 2, y0 = t.y - px(t.r) - 78;
  ctx.fillStyle = 'rgba(5,8,11,.9)'; rr(x0 - 1.5, y0 - 1.5, w + 3, h + 3, 2); ctx.fill();
  ctx.fillStyle = '#3a1618'; ctx.fillRect(x0, y0, w, h);
  ctx.fillStyle = '#e5484d'; ctx.fillRect(x0, y0, w * (t.hp / t.maxHp), h);
  ctx.fillStyle = 'rgba(0,0,0,.55)'; for (let i = 1; i < 9; i++) ctx.fillRect(x0 + w * i / 9 - 0.5, y0, 1, h);
  ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fillRect(x0, y0, w, 2);
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.font = `700 9.5px ${FONT}`; ctx.fillStyle = '#fff';
  ctx.fillText(`${fmt(t.hp, 0)} / ${t.maxHp}`, t.x, y0 - 14);
  const gt = Core.gameTime(W()); let sub = `포탑 공격력 ${Core.turretAD(gt)}`;
  if (gt < TURRET_CFG.reductionUntil) { const left = Math.ceil(TURRET_CFG.reductionUntil - gt); sub += ` · 받는 피해 85% 감소 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; }
  ctx.font = `500 8.5px ${FONT}`; ctx.fillStyle = '#ffb3b5';
  ctx.fillText(sub, t.x, y0 - 4);
}

function liftOf(c) {
  return (c.air > 0 ? Math.sin(Math.PI * Math.min(1, 1 - c.air / c.airMax)) * 20 + 6 : 0) +
         (c.cast && c.cast.type === 'r' ? Math.sin(Math.PI * Math.min(1, c.cast.t / c.cast.dur)) * 30 : 0);
}
/* 챔피언 효과: 명상(초록 아우라 · 발밑 링 · 올라가는 입자), 최후의 전사(붉은 아우라 · 뒤쪽 속도선), 우주류 검술(금색 반짝임) */
const prevPos = new Map();   // 챔피언별 직전 프레임 위치(속도선 방향용)
function auraGlow(x, cy, R, sx, rgb, a) {   // 세로로 살짝 눌린 원형 빛
  ctx.save(); ctx.translate(x, cy); ctx.scale(sx, 1);
  const g = ctx.createRadialGradient(0, 0, 2, 0, 0, R);
  g.addColorStop(0, `rgba(${rgb},${a})`); g.addColorStop(0.55, `rgba(${rgb},${a * 0.5})`); g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R, 0, 7); ctx.fill();
  ctx.restore();
}
function drawAuraBack(c, x, y, sw, sh, lift, vx, vy) {   // 몸 뒤에 그림
  const cy = y - lift - sh * 0.5;
  if (c.med) {   // 명상: 모든 플레이어에게 보임
    const pu = 1 + 0.06 * Math.sin(clockT * 4);
    auraGlow(x, cy, sh * 0.8 * pu, 0.62, '130,255,170', 0.72);
    ctx.lineWidth = 2; ctx.strokeStyle = `rgba(170,255,190,${0.6 + 0.3 * Math.sin(clockT * 4)})`;
    ctx.beginPath(); ctx.ellipse(x, y, sw * 0.6 * pu, 7 * pu, 0, 0, 7); ctx.stroke();
  }
  if (c.hl > 0) {   // 최후의 전사: 붉은 주황 아우라 + 움직일 때 뒤쪽 속도선
    const pu = 1 + 0.05 * Math.sin(clockT * 7);
    auraGlow(x, cy, sh * 0.82 * pu, 0.62, '255,80,30', 0.7);
    const sp = Math.hypot(vx, vy);
    if (c.moving && sp > 0.3 && sp < 25) {
      const dx = -vx / sp, dy = -vy / sp, nx = -dy, ny = dx;   // 뒤쪽 방향과 그 법선
      ctx.lineCap = 'round';
      for (let i = 0; i < 5; i++) {
        const off = (i - 2) * 7, back = 20 + (i % 2) * 5 + 3 * Math.sin(clockT * 16 + i), L = 18 + 8 * Math.sin(clockT * 12 + i * 1.7);
        const sx = x + nx * off + dx * back, sy = cy + ny * off + dy * back;
        const mid = i === 2;   // 가운데 줄이 가장 진하고 굵음
        ctx.strokeStyle = `rgba(255,${150 + i * 12},80,${mid ? 0.9 : 0.75})`; ctx.lineWidth = mid ? 3.2 : 2.7;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + dx * L, sy + dy * L); ctx.stroke();
      }
    }
  }
}
function drawAuraFront(c, x, y, sw, sh, lift) {   // 몸 앞에 그림
  if (c.med) {   // 명상: 초록 입자가 위로 올라감
    for (let i = 0; i < 7; i++) {
      const ph = (clockT * 0.55 + i / 7) % 1, qx = x + Math.sin(i * 2.7 + clockT * 2) * sw * 0.3, qy = y - lift - ph * sh * 0.95;
      ctx.fillStyle = `rgba(175,255,195,${Math.sin(ph * Math.PI) * 0.9})`;
      ctx.beginPath(); ctx.arc(qx, qy, 1.2 + (1 - ph) * 1.2, 0, 7); ctx.fill();
    }
  }
  if (c.wuju > 0) {   // 우주류 검술: 금색 검기 반짝임 (Darius W의 주황 반짝임과 같은 방식)
    for (let i = 0; i < 6; i++) {
      const a = clockT * 2.6 + i * 1.047, tw = 0.5 + 0.5 * Math.sin(clockT * 10 + i * 2.3), r = 2.6 + tw * 2.6;
      const gx = x + Math.cos(a) * sw * 0.45, gy = y - lift - sh * 0.5 + Math.sin(a * 1.4 + i) * sh * 0.42;
      ctx.fillStyle = `rgba(255,${205 + tw * 40 | 0},${80 + tw * 70 | 0},${0.45 + 0.55 * tw})`;
      ctx.beginPath(); ctx.moveTo(gx, gy - r); ctx.lineTo(gx + r * 0.55, gy); ctx.lineTo(gx, gy + r); ctx.lineTo(gx - r * 0.55, gy); ctx.closePath(); ctx.fill();
    }
  }
}
/* 나에게만: 명상 발밑 진행 바(4초, 줄어듦) · 피해 감소 %, 우주류 검술 남은 시간 */
function drawSelfInfo(me) {
  const [x, y] = P2(me), red = Math.round((1 - Core.dmgTakenMul(me, false)) * 100), w = 60, h = 5, x0 = x - w / 2, y0 = y + 10;
  if (me.med) {
    const S = Core.SKILLS.yi.w, frac = Math.max(0, Math.min(1, (S.dur - me.med.t) / S.dur));
    ctx.fillStyle = 'rgba(5,8,11,.9)'; rr(x0 - 1.5, y0 - 1.5, w + 3, h + 3, 2); ctx.fill();
    ctx.fillStyle = '#17361f'; ctx.fillRect(x0, y0, w, h);
    ctx.fillStyle = '#5ff08c'; ctx.fillRect(x0, y0, w * frac, h);
    ctx.fillStyle = 'rgba(255,255,255,.3)'; ctx.fillRect(x0, y0, w * frac, 1);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.75)';
  ctx.font = `700 9.5px ${FONT}`;
  if (red > 0) { const t = `피해 감소 ${red}%`; ctx.fillStyle = '#b9ffcf'; ctx.strokeText(t, x, y0 + 16); ctx.fillText(t, x, y0 + 16); }
  if (me.wuju > 0) { const t = `우주류 검술 ${fmt(me.wuju, 1)}초`, ty = red > 0 ? y0 + 27 : y0 + 16; ctx.fillStyle = '#ffe27a'; ctx.strokeText(t, x, ty); ctx.fillText(t, x, ty); }   // 발밑(머리 위는 상대 체력 정보와 겹침)
}
function drawChamp(c) {
  const [x, y] = P2(c);
  const img = imgs[c.key], sh = SPRITE_H[c.key], sw = sh * img.width / img.height, ax = SPRITE_AX[c.key];
  const pp = prevPos.get(c.id), vx = pp ? x - pp.x : 0, vy = pp ? y - pp.y : 0;
  prevPos.set(c.id, { x, y });
  ctx.fillStyle = 'rgba(0,0,0,.38)'; ctx.beginPath(); ctx.ellipse(x, y, sw * 0.30, 5.5, 0, 0, 7); ctx.fill();
  if (c.might > 0 && !c.dead) {
    ctx.beginPath(); ctx.ellipse(x, y, sw * 0.36, 7.5, 0, 0, 7);
    ctx.lineWidth = 2; ctx.strokeStyle = `rgba(255,70,80,${0.55 + 0.3 * Math.sin(clockT * 9)})`; ctx.stroke();
  }
  const lift = liftOf(c);
  if (!c.dead) drawAuraBack(c, x, y, sw, sh, lift, vx, vy);
  const bob = c.moving && !c.dead ? Math.abs(Math.sin(clockT * 11)) * 1.6 : 0;
  const lg = Math.sin(c.lunge * Math.PI) * 4;
  ctx.save();
  ctx.globalAlpha = c.dead ? 0.35 : 1;
  ctx.translate(x + c.lungeDir[0] * lg, y - bob - lift + c.lungeDir[1] * lg);
  if (c.facing < 0) ctx.scale(-1, 1);
  ctx.drawImage(img, -ax * sw, -sh, sw, sh);
  ctx.restore();
  if (!c.dead) drawAuraFront(c, x, y, sw, sh, lift);
  if (c.wBuff && !c.dead) {   // 스킬 2: 주황색으로 반짝이는 이펙트
    for (let i = 0; i < 6; i++) {
      const a = clockT * 3 + i * 1.05, tw = 0.5 + 0.5 * Math.sin(clockT * 9 + i * 2.1), r = 2.4 + tw * 2.2;
      const sx = x + Math.cos(a) * sw * 0.34, sy = y - lift - sh * 0.5 + Math.sin(a * 1.3 + i) * sh * 0.38;
      ctx.fillStyle = `rgba(255,${150 + tw * 70 | 0},40,${0.45 + 0.55 * tw})`;
      ctx.beginPath(); ctx.moveTo(sx, sy - r); ctx.lineTo(sx + r * 0.55, sy); ctx.lineTo(sx, sy + r); ctx.lineTo(sx - r * 0.55, sy); ctx.closePath(); ctx.fill();
    }
  }
}

function drawDummy(d) {
  const [x, y] = P2(d), fl = d.flash > 0;
  const lift = d.air > 0 ? Math.sin(Math.PI * Math.min(1, Math.max(0, 1 - d.air / d.airMax))) * 22 + 4 : 0;
  ctx.fillStyle = 'rgba(0,0,0,.38)'; ctx.beginPath(); ctx.ellipse(x, y, 17, 6, 0, 0, 7); ctx.fill();
  if (d.slow) { ctx.beginPath(); ctx.ellipse(x, y, 22, 8, 0, 0, 7); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(127,212,255,.9)'; ctx.stroke(); }
  ctx.save(); ctx.translate(0, -lift);
  ctx.fillStyle = '#6b4a2b'; ctx.fillRect(x - 3, y - 36, 6, 36);
  ctx.fillRect(x - 17, y - 30, 34, 5);
  ctx.fillStyle = fl ? '#fff' : '#d8b86a'; ctx.strokeStyle = '#5a3f1c'; ctx.lineWidth = 1.5;
  rr(x - 11, y - 52, 22, 28, 7); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y - 58, 8, 0, 7); ctx.fillStyle = fl ? '#fff' : '#e6c985'; ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y - 38, 7, 0, 7); ctx.fillStyle = '#e5484d'; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y - 38, 4.2, 0, 7); ctx.fillStyle = '#f3ead6'; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y - 38, 1.8, 0, 7); ctx.fillStyle = '#e5484d'; ctx.fill();
  ctx.restore();
}
function drawDrop(x, y) {
  ctx.beginPath(); ctx.moveTo(x, y - 5.5);
  ctx.bezierCurveTo(x + 4.2, y - 0.5, x + 3.8, y + 4.2, x, y + 4.2);
  ctx.bezierCurveTo(x - 3.8, y + 4.2, x - 4.2, y - 0.5, x, y - 5.5);
  ctx.fillStyle = '#d4182f'; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(50,0,8,.9)'; ctx.stroke();
  ctx.fillStyle = 'rgba(255,190,195,.85)'; ctx.beginPath(); ctx.ellipse(x - 1.2, y + 0.8, 0.9, 1.7, 0, 0, 7); ctx.fill();
}
function drawBleedOrbs(u, front) {   // 과다출혈 1중첩마다 핏방울 하나가 위성처럼 돎
  const b = u.bleed; if (!b || u.dead) return;
  const [x, y] = P2(u), cy = y - (u.kind === 'dummy' ? 34 : SPRITE_H[u.key] * 0.5), rx = u.kind === 'dummy' ? 25 : 22;
  for (let i = 0; i < b.stacks; i++) {
    const a = clockT * 3 + i * Math.PI * 2 / b.stacks, s = Math.sin(a);
    if ((s > 0) !== front) continue;
    drawDrop(x + Math.cos(a) * rx, cy + s * 9);
  }
}
function drawDummyBar(d) {
  const [x, y] = P2(d), w = 84, h = 9, x0 = x - w / 2, y0 = y - 98;
  ctx.fillStyle = 'rgba(5,8,11,.9)'; rr(x0 - 1.5, y0 - 1.5, w + 3, h + 3, 2); ctx.fill();
  ctx.fillStyle = '#3a2c12'; ctx.fillRect(x0, y0, w, h);
  ctx.fillStyle = '#e0a43a'; ctx.fillRect(x0, y0, w * (d.hp / d.maxHp), h);
  ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fillRect(x0, y0, w, 2);
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.font = `700 9.5px ${FONT}`; ctx.fillStyle = '#fff';
  ctx.fillText(`허수아비 ${fmt(d.hp, 0)} / ${d.maxHp}${d.armor ? ' · 방어력 ' + d.armor : ''}`, x, y0 - 16);
  if (d.bleed) { ctx.fillStyle = '#ff8a94'; ctx.fillText(`과다출혈 ${d.bleed.stacks}중첩 · ${fmt(d.bleed.t, 1)}초`, x, y0 - 27); ctx.fillStyle = '#fff'; }
  const st = []; if (d.air > 0 || d.pull) st.push('공중에 뜸'); if (d.slow) st.push(`둔화 ${fmt(d.slow.pct * 100, 0)}% ${fmt(d.slow.t, 1)}초`);
  if (st.length) { ctx.fillStyle = '#9fd8ff'; ctx.fillText(st.join(' · '), x, y0 - 38); }
  ctx.font = `500 9px ${FONT}`; ctx.fillStyle = '#ffe2a8';
  ctx.fillText(`총 피해 ${fmt(d.total, 0)} · 최근 5초 DPS ${fmt(Core.dummyDps(W(), d), 1)}`, x, y0 - 5);
}

/* 스킬 범위 표시 */
function aimInfo(me) {   // 길게 누르는 중인 스킬의 예상 범위
  for (const k in held) if (held[k].show && me.sk[k] > 0) return { k, ang: held[k].dragged ? held[k].ang : autoAng(k === 'e'), cancel: held[k].cancel };
  return null;
}
function drawSkillWorld(me) {
  const Ro = px(HIT_R + SK.q.rOut), Ri = px(HIT_R + SK.q.rIn);
  for (const c of W().champs) {   // 학살 준비 시간: 상대에게도 보이는 붉은 발동 범위
    if (c.dead || !c.qPrep) continue;
    const [x, y] = P2(c), p = Math.min(1, c.qPrep.t / c.qPrep.dur);
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, Ro, 0, 7); ctx.fillStyle = 'rgba(220,40,50,.10)'; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, Ri, 0, 7); ctx.fillStyle = 'rgba(220,40,50,.16)'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,70,80,.6)';
    ctx.beginPath(); ctx.arc(x, y, Ro, 0, 7); ctx.stroke(); ctx.beginPath(); ctx.arc(x, y, Ri, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, Ro * p, 0, 7); ctx.fillStyle = 'rgba(255,60,70,.10)'; ctx.fill();
    ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(255,100,110,.95)'; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(x, y, Ro, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  if (me.dead) return;
  const a = aimInfo(me); if (!a) return;
  if (me.yq && (a.k === 'q' || a.k === 'w')) return;   // 일격필살 중에는 Q·W를 쓸 수 없으므로 조준 표시도 없음
  const [x, y] = P2(me);
  ctx.save();
  ctx.strokeStyle = 'rgba(120,215,255,.95)'; ctx.lineWidth = 2.2; ctx.fillStyle = 'rgba(120,215,255,.10)';
  if (a.cancel) { ctx.strokeStyle = 'rgba(255,90,100,.9)'; ctx.fillStyle = 'rgba(255,60,70,.10)'; ctx.setLineDash([6, 5]); }   // 취소 위: 빨간 점선
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `600 9px ${FONT}`;
  if (me.key === 'yi') {   // 마스터 이: Q = 사거리 600 원 + 대상 강조, W/E/R = 자기 자신 주변 작은 원
    if (a.k === 'q') {
      ctx.beginPath(); ctx.arc(x, y, px(HIT_R + Core.SKILLS.yi.q.range), 0, 7); ctx.fill(); ctx.stroke();
      const t = Core.yiQTarget(W(), me);
      if (t) { const [tx, ty] = P2(t); ctx.setLineDash([]); ctx.beginPath(); ctx.arc(tx, ty, px(t.r) + 5, 0, 7); ctx.lineWidth = 3; ctx.strokeStyle = '#ffd23f'; ctx.stroke(); }
    } else {
      ctx.beginPath(); ctx.ellipse(x, y, px(HIT_R) + 5, px(HIT_R) * 0.5 + 2.5, 0, 0, 7); ctx.fill(); ctx.stroke();
    }
  } else if (a.k === 'q') {   // 안쪽 = 도끼 자루, 바깥 띠 = 도끼날
    ctx.beginPath(); ctx.arc(x, y, Ro, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(120,215,255,.18)'; ctx.beginPath(); ctx.arc(x, y, Ri, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#d6f3ff'; ctx.fillText('도끼 자루', x, y - Ri + 11); ctx.fillText('도끼날 (과다출혈 · 회복)', x, y - (Ri + Ro) / 2);
  } else if (a.k === 'e') {
    const R = px(HIT_R + SK.e.range), h = SK.e.angle / 2 * Math.PI / 180;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, R, a.ang - h, a.ang + h); ctx.closePath(); ctx.fill(); ctx.stroke();
  } else if (a.k === 'w') {
    ctx.beginPath(); ctx.arc(x, y, px(HIT_R + me.stats.range + SK.w.rangeBonus), 0, 7); ctx.fill(); ctx.stroke();
  } else if (a.k === 'r') {
    ctx.beginPath(); ctx.arc(x, y, px(HIT_R + SK.r.range), 0, 7); ctx.fill(); ctx.stroke();
    const t = Core.ultTarget(W(), me);
    if (t) { const [tx, ty] = P2(t); ctx.beginPath(); ctx.arc(tx, ty, px(t.r) + 4, 0, 7); ctx.lineWidth = 3; ctx.strokeStyle = '#ff6b6b'; ctx.stroke(); }
  }
  ctx.restore();
}
function drawFx() {
  for (const f of fxList) {
    const p = f.t / f.life; ctx.save(); ctx.lineCap = 'round'; ctx.globalAlpha = 1 - p;
    if (f.fx === 'slash' && f.key === 'darius') {   // 다리우스 평타: 붉은 도끼 베기(굵은 초승달 + 피 튀김)
      const a0 = f.ang - 1.25, sw = 2.5 * Math.min(1, p * 2.2), R = 24;
      ctx.translate(f.x, f.y); ctx.globalAlpha = 1 - p * p;
      ctx.lineWidth = 11; ctx.strokeStyle = 'rgba(150,0,15,.55)';
      ctx.beginPath(); ctx.arc(0, 0, R, a0, a0 + sw); ctx.stroke();
      ctx.lineWidth = 6; ctx.strokeStyle = '#ff2b3d';
      ctx.beginPath(); ctx.arc(0, 0, R, a0, a0 + sw); ctx.stroke();
      ctx.lineWidth = 2; ctx.strokeStyle = '#ffd6d9';
      ctx.beginPath(); ctx.arc(0, 0, R - 1, a0 + sw * 0.25, a0 + sw); ctx.stroke();
      if (p > 0.15) {   // 맞은 자리에서 튀는 핏방울
        const q = (p - 0.15) / 0.85;
        ctx.fillStyle = '#e0142a';
        for (let i = 0; i < 6; i++) {
          const a = f.ang + (i - 2.5) * 0.32, d = 6 + q * (14 + (i % 3) * 6), r = 2.6 * (1 - q) + 0.6;
          ctx.beginPath(); ctx.arc(Math.cos(a) * d, Math.sin(a) * d + q * q * 6, r, 0, 7); ctx.fill();
        }
      }
    } else if (f.fx === 'slash' && f.key === 'yi') {   // 마스터 이 평타: 청백색 얇은 이중 호. 2연속 두 번째 타격은 반대 방향 거울상
      // 호는 공격자 쪽(목표 앞)에 그림. 2연속 두 번째 타격은 공격 방향 축에 대해 거울상(위아래 반대쪽 + 반대 방향으로 그어짐)
      const dir = f.extra ? -1 : 1, s = Math.min(1, p * 2) * 2.0, c0 = f.ang + Math.PI, a0 = c0 - dir * 1.0;
      const side = dir * 5;
      ctx.translate(f.x - Math.sin(f.ang) * side, f.y + Math.cos(f.ang) * side);
      ctx.beginPath(); ctx.arc(0, 0, 19, a0, a0 + dir * s, dir < 0); ctx.lineWidth = 2.2; ctx.strokeStyle = '#f2fdff'; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, 24, a0, a0 + dir * s * 0.9, dir < 0); ctx.lineWidth = 1.3; ctx.strokeStyle = 'rgba(120,225,255,.95)'; ctx.stroke();
    } else if (f.fx === 'yslash') {   // 일격필살 타격: 밝은 노란색 X자 베기(두 줄 + 빛), 0.18초
      const L = 27 * (0.5 + 0.5 * Math.min(1, p * 4));
      ctx.translate(f.x, f.y); ctx.globalAlpha = 1 - p * p;
      for (const da of [Math.PI / 4, -Math.PI / 4]) {
        const ux = Math.cos(f.ang + da) * L, uy = Math.sin(f.ang + da) * L;
        ctx.beginPath(); ctx.moveTo(-ux, -uy); ctx.lineTo(ux, uy);
        ctx.lineWidth = 9; ctx.strokeStyle = 'rgba(255,205,40,.32)'; ctx.stroke();
        ctx.lineWidth = 3.2; ctx.strokeStyle = '#ffe420'; ctx.stroke();
        ctx.lineWidth = 1.1; ctx.strokeStyle = '#fffbe2'; ctx.stroke();
      }
      ctx.fillStyle = '#fff6a6'; ctx.beginPath(); ctx.arc(0, 0, 1.5 + 3 * (1 - p), 0, 7); ctx.fill();
    } else if (f.fx === 'blink') {   // 사라짐: 잔상(반투명 본체가 떠오르며 흐려짐) + 빛 퍼프. 나타남: 빛 퍼프만
      ctx.translate(f.x, f.y);
      if (f.out && imgs.yi) {   // 블링크는 마스터 이만 씀
        const sh = SPRITE_H.yi, sw = sh * imgs.yi.width / imgs.yi.height;
        ctx.globalAlpha = (1 - p) * 0.5; ctx.translate(0, -p * 8);
        ctx.drawImage(imgs.yi, -SPRITE_AX.yi * sw, -sh, sw, sh);
        ctx.translate(0, p * 8);
      }
      ctx.globalAlpha = 1 - p;
      const g = ctx.createRadialGradient(0, -22, 1, 0, -22, 8 + 22 * p);
      g.addColorStop(0, 'rgba(235,252,255,.9)'); g.addColorStop(0.5, 'rgba(120,220,255,.35)'); g.addColorStop(1, 'rgba(120,220,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, -22, 8 + 22 * p, 0, 7); ctx.fill();
      ctx.lineWidth = 1.8; ctx.strokeStyle = 'rgba(170,235,255,.85)';
      ctx.beginPath(); ctx.ellipse(0, 0, 10 + 16 * p, 4 + 6 * p, 0, 0, 7); ctx.stroke();
    } else if (f.fx === 'slash') {
      ctx.translate(f.x, f.y); ctx.lineWidth = 3.2; ctx.strokeStyle = '#fff2c9';
      ctx.beginPath(); ctx.arc(0, 0, 17, f.ang - 1.0, f.ang - 1.0 + 2.0 * Math.min(1, p * 1.6)); ctx.stroke();
    } else if (f.fx === 'sweep') {   // 학살: 빨간 이펙트로 한 바퀴
      const sw = Math.min(1, p * 3) * Math.PI * 2;
      ctx.globalAlpha = 1 - p * p; ctx.translate(f.x, f.y);
      ctx.fillStyle = 'rgba(255,60,70,.13)'; ctx.beginPath(); ctx.arc(0, 0, f.ro, 0, 7); ctx.fill();
      ctx.lineWidth = 16; ctx.strokeStyle = 'rgba(255,60,70,.85)'; ctx.beginPath(); ctx.arc(0, 0, f.ro - 9, f.a0, f.a0 + sw); ctx.stroke();
      ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(255,205,175,.85)'; ctx.beginPath(); ctx.arc(0, 0, f.ri, f.a0, f.a0 + sw); ctx.stroke();
    } else if (f.fx === 'fan') {     // 포획: 도끼를 던지는 부채꼴
      ctx.translate(f.x, f.y); ctx.fillStyle = 'rgba(255,170,60,.25)'; ctx.strokeStyle = 'rgba(255,190,90,.9)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, f.range * Math.min(1, p * 2.5), f.ang - f.half, f.ang + f.half); ctx.closePath(); ctx.fill(); ctx.stroke();
    } else if (f.fx === 'gui') {     // 단두대
      ctx.translate(f.x, f.y); ctx.strokeStyle = '#ff4d5a'; ctx.lineWidth = 4;
      for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(i * 14 - 18, -30 + p * 30 - 20); ctx.lineTo(i * 14 + 18, 30 - 20); ctx.stroke(); }
      ctx.lineWidth = 2.5; ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 0, 10 + p * 46, 0, 7); ctx.stroke();
    }
    ctx.restore();
  }
  for (const u of W().champs.concat(W().dummies)) {   // 끌려오는 동안의 사슬
    if (!u.pull) continue;
    const src = Core.champOf(W(), u.pull.src); if (!src) continue;
    const [sx, sy] = P2(src), [ux, uy] = P2(u);
    ctx.save(); ctx.strokeStyle = 'rgba(210,190,150,.95)'; ctx.lineWidth = 2.4; ctx.setLineDash([5, 3]);
    ctx.beginPath(); ctx.moveTo(sx, sy - 24); ctx.lineTo(ux, uy - 34); ctx.stroke(); ctx.restore();
  }
}

/* 포탑이 조준한 챔피언에게 경고(0.83초) / 공격 중 표시 */
function drawTurretWarning(t, now) {
  const tgt = t.targetId && Core.champOf(W(), t.targetId);
  if (!tgt || tgt.dead || t.dead || !(t.warn > 0 || t.locked)) return;
  const [x, y] = P2(tgt), pulse = 0.5 + 0.5 * Math.sin(now / 70), rx = px(HIT_R) * 1.5, ry = px(HIT_R) * 0.8;
  ctx.save();
  if (!t.locked) {
    const p = Math.min(1, t.warn / TURRET_CFG.lock);
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, 7); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,80,80,.35)'; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2); ctx.lineWidth = 3.2; ctx.strokeStyle = '#ff5560'; ctx.stroke();
    ctx.setLineDash([4, 4]); ctx.lineWidth = 1.2; ctx.strokeStyle = `rgba(255,90,90,${0.3 + 0.35 * pulse})`;
    ctx.beginPath(); ctx.moveTo(t.x, t.y - 60); ctx.lineTo(x, y - 20); ctx.stroke(); ctx.setLineDash([]);
    const wy = y - SPRITE_H[tgt.key] - 36;
    ctx.beginPath(); ctx.moveTo(x, wy - 11); ctx.lineTo(x + 11, wy + 8); ctx.lineTo(x - 11, wy + 8); ctx.closePath();
    ctx.fillStyle = `rgba(255,70,80,${0.75 + 0.25 * pulse})`; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = `700 12px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('!', x, wy + 2.5);
    ctx.font = `700 10px ${FONT}`; ctx.fillStyle = '#ffd5d6'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(fmt(Math.max(0, TURRET_CFG.lock - t.warn), 2) + 's', x, wy - 15);
  } else {
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, 7); ctx.lineWidth = 2; ctx.strokeStyle = `rgba(255,80,80,${0.5 + 0.4 * pulse})`; ctx.stroke();
  }
  if (t.shot) {
    const p = t.shot.t / TURRET_CFG.boltTime, sx = t.x, sy = t.y - 70, ex = x, ey = y - 22, ox = sx + (ex - sx) * p, oy = sy + (ey - sy) * p;
    const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, 9);
    g.addColorStop(0, '#fff'); g.addColorStop(0.35, '#ff7a6e'); g.addColorStop(1, 'rgba(255,60,60,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(ox, oy, 9, 0, 7); ctx.fill();
  }
  ctx.restore();
}

function render(now) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0a1017'; ctx.fillRect(0, 0, cv.width, cv.height);
  if (!imgs.map) return;
  const sc = zoom * dpr;
  ctx.setTransform(sc, 0, 0, sc, cv.width / 2 - cam.x * sc, cv.height / 2 - cam.y * sc);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(imgs.map, 0, 0);
  const me = ME();
  if (!me) return;
  const w = W(), [mx, my] = P2(me);

  // 적 포탑 사거리 링 / 파괴된 포탑
  for (const t of w.turrets) {
    if (t.team === me.team) continue;
    if (!t.dead) {
      const R = px(TURRET_CFG.range) + px(t.r), d = Math.hypot(mx - t.x, my - t.y);
      const a = dbg ? 1 : Math.max(0, Math.min(1, (R + 150 - d) / 150));
      if (a > 0) {
        ctx.save(); ctx.globalAlpha = a;
        ctx.beginPath(); ctx.arc(t.x, t.y, R, 0, 7); ctx.fillStyle = 'rgba(229,72,77,.07)'; ctx.fill();
        ctx.setLineDash([7, 5]); ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(255,110,115,.75)'; ctx.stroke();
        ctx.restore();
      }
    } else {
      ctx.fillStyle = 'rgba(8,10,12,.55)'; ctx.beginPath(); ctx.ellipse(t.x, t.y, px(t.r) * 0.95, px(t.r) * 0.55, 0, 0, 7); ctx.fill();
    }
  }

  // 히트박스·사거리 디버그
  if (dbg) {
    ctx.lineWidth = 1.2;
    for (const t of w.turrets.concat(w.dummies)) { const [x, y] = t.kind === 'dummy' ? P2(t) : [t.x, t.y]; ctx.beginPath(); ctx.arc(x, y, px(t.r), 0, 7); ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.setLineDash([3, 3]); ctx.stroke(); }
    ctx.setLineDash([]);
    for (const c of w.champs) {
      const [x, y] = P2(c);
      ctx.beginPath(); ctx.arc(x, y, px(HIT_R), 0, 7); ctx.strokeStyle = '#3fd07a'; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, px(HIT_R + c.stats.range), 0, 7); ctx.strokeStyle = 'rgba(77,163,255,.9)'; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  for (const t of w.turrets) drawTurretWarning(t, now);
  drawSkillWorld(me);

  for (const d of w.dummies) drawBleedOrbs(d, false);
  for (const d of w.dummies) drawDummy(d);
  for (const d of w.dummies) drawBleedOrbs(d, true);
  for (const c of w.champs) { if (c.yq) continue; drawBleedOrbs(c, false); drawChamp(c); drawBleedOrbs(c, true); }   // 일격필살 중에는 안 보임(모두에게)
  drawFx();

  // 체력바
  for (const t of w.turrets) if (!t.dead && t.team !== me.team) drawTurretBar(t);
  for (const d of w.dummies) drawDummyBar(d);
  for (const c of w.champs) { if (c.yq) continue; const [x, y] = P2(c); drawChampBar(c, x, y - SPRITE_H[c.key] - 7); }
  if (!me.dead && !me.yq) drawSelfInfo(me);   // 나에게만: 명상 바·피해 감소 %, 우주류 검술 남은 시간

  // 떠오르는 숫자
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  for (const t of texts) {
    const p = t.t / t.life;
    ctx.save(); ctx.globalAlpha = 1 - p * p;
    ctx.font = `${t.big ? 700 : 600} ${t.big ? 15 : 12}px ${FONT}`;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.fillStyle = t.color;
    const x = t.x + t.dx * p, y = t.y - 24 * p;
    ctx.strokeText(t.txt, x, y); ctx.fillText(t.txt, x, y);
    ctx.restore();
  }
}

/* =====================================================================
   매 프레임
   ===================================================================== */
let wasDead = false, lastArmor = null;
function refreshHud() {
  const me = ME(); if (!me) return;
  const gt = Core.gameTime(W()), m = Math.floor(gt / 60), sec = Math.floor(gt % 60);
  const ck = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  const ce = $('#clockT'); if (ce.textContent !== ck) ce.textContent = ck;
  if (session.online) { const pg = session.ping, pt = pg == null ? '-- ms' : Math.round(pg) + ' ms', pe = $('#pingT'); if (pe.textContent !== pt) pe.textContent = pt; }
  atk.style.setProperty('--cd', me.dead ? 0 : (me.atkCd > 0 ? me.atkCd * me.stats.as : 0).toFixed(3));
  refreshPassive();   // 매 프레임: 스택 숫자가 밀리지 않게
  if (me.dead) showBanner(`사망 · ${Math.max(0, Math.ceil(me.respawn))}초 후 부활`, true, 0.3);
  if (wasDead && !me.dead) { snapCam(); banner.hidden = true; }
  wasDead = me.dead;
  const d = W().dummies[0];
  if (d && d.armor !== lastArmor) { lastArmor = d.armor; $('#tDmArmor').textContent = `더미 방어력: ${d.armor}`; }
  refreshSkills();
}
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000); last = now;
  clockT += dt;
  if (phase === 'play' && session) {
    const me = ME();
    if (me && (me.dead || me.air > 0 || me.pull)) for (const k in held) delete held[k];
    const nowMs = performance.now(); for (const k in held) if (!held[k].show && nowMs - held[k].t > 180) held[k].show = true;
    sendInput();
    session.update(dt);
    handleEvents();
    refreshHud();
  }
  for (const f of fxList) f.t += dt;
  for (let i = fxList.length - 1; i >= 0; i--) if (fxList[i].t >= fxList[i].life) fxList.splice(i, 1);
  for (const t of texts) t.t += dt;
  for (let i = texts.length - 1; i >= 0; i--) if (texts[i].t >= texts[i].life) texts.splice(i, 1);
  if (bannerT > 0) { bannerT -= dt; const me = ME(); if (bannerT <= 0 && !(me && me.dead)) banner.hidden = true; }
  updateCamera(dt); render(now);
  requestAnimationFrame(frame);
}
ready.then(() => { requestAnimationFrame(t => { last = t; frame(t); }); });
})();
