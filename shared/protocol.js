/* =====================================================================
   protocol.js — 서버와 클라이언트가 함께 쓰는 통신 약속 (UMD: Node + 브라우저)
   이 파일이 계약입니다. 서버(server/*)와 클라이언트(client/*)는 여기의 상수와 함수만 써서
   메시지를 만들고 해석합니다. 메시지는 모두 JSON 텍스트 한 줄(WebSocket 텍스트 프레임)입니다.

   ── 핵심 규칙 ───────────────────────────────────────────────────────
   1. 서버가 정답(권위 서버). 게임 규칙은 shared/core.js 하나뿐이고 서버가 60틱/초로 돌립니다.
   2. 클라이언트는 매 틱(1/60초)마다 "입력 프레임" 하나를 보냅니다(seq가 1씩 증가).
      서버는 플레이어마다 프레임 큐를 두고, 서버 1틱에 프레임 1개를 적용합니다.
        - 큐가 비면: 아무것도 적용하지 않고 진행(core는 마지막 이동 입력을 유지함). ack는 그대로.
        - 큐가 MAX_QUEUE보다 길면: 오래된 프레임을 버리되, 버린 프레임의 acts는 다음 프레임 앞에 붙여 보존.
   3. 서버는 SNAP_EVERY틱마다(20회/초) 스냅샷을 보냅니다. 스냅샷 = 그 틱 step 직후의 월드 전체(slimWorld).
      ack = 이 스냅샷에 반영된 그 플레이어의 마지막 프레임 seq.
   4. 클라이언트 예측(선택): 스냅샷 월드를 복제한 뒤 seq > ack 인 프레임을 순서대로
      "frameToCmds 적용 + Core.step 1회"씩 다시 돌리면 서버와 같은 계산이 됩니다.
      그래서 클라이언트도 반드시 sanitizeFrame을 통과한 값(반올림된 값)으로 예측해야 합니다.
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Protocol = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const VERSION = 10;   // 10: 가렌 심판 시작 뒤 0.5초 동안 E 취소 무시(연타 방지, 사용자 수정 2026-11-12 22:06) / 9: 다리우스 과다출혈 계수(0.3)·마스터 이 우주류 검술 추가 고정 피해 계수(0.35)를 총 공격력 → 추가 공격력 기준으로 변경(사용자 수정 2026-11-12) / 8: 데마시아의 정의 판정 정정(시전 중 400 밖이면 헛방, 시전이 끝나면 거리와 무관하게 적중, 1000 취소 삭제) / 7: 가렌 추가(결정타·용기·심판·데마시아의 정의, 인내심, 용기 영구 방어력) / 6: 보호막·침묵·강인함·추가 스탯, 다리우스 W 쿨타임 정지·R 계수 변경 / 5: 평타 자동 추적(사거리 밖 평타 → 가까운 대상까지 이동 후 평타)
const TICK_HZ = 60;
const SNAP_EVERY = 2;          // 2틱마다 스냅샷 → 초당 30회
const INTERP_TICKS = 4;        // 다른 유닛은 약 67ms 과거 시점을 보간해서 그림
const MAX_QUEUE = 10;          // 서버 프레임 큐 최대 길이(넘치면 오래된 것부터 버림)
const QUEUE_TARGET = 3;        // 매 틱 큐가 이보다 길면 밀린 프레임을 합쳐서 바로 따라잡음(입력 지연이 쌓이지 않게)
const MAX_FRAMES_PER_SEC = 90; // 이보다 많이 보내면 초과분 무시(남용 방지)
const COUNTDOWN_SEC = 3;       // 둘 다 준비 → 3초 후 시작
const RECONNECT_SEC = 0;       // (다음 단계) 재접속 유예. 지금은 끊기면 상대 승리
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // 헷갈리는 0/O/1/I 제외
const ROOM_CODE_LEN = 4;
const NAME_MAX = 12;
const WIN = { kills: 1, turret: true };   // 승리 조건: 처치 1회 또는 상대 포탑 파괴 (먼저 달성한 쪽)
const CHAMP_KEYS = ['darius', 'yi', 'garen'];
const SKILLS = ['q', 'w', 'e', 'r'];
const DEV_OPS = ['air', 'ready', 'time', 'spawn', 'turretReset', 'dummyReset', 'dummyArmor'];

/* ── 메시지 종류 ─────────────────────────────────────────────────────
   클라이언트 → 서버 (필드 t = 종류)
     {t:'hello',  v:VERSION, name}                       접속 직후 1회
     {t:'create', test:bool}                             방 만들기(test=true면 테스트 모드: 허수아비 + 테스트 도구)
     {t:'join',   code}                                  코드로 참가
     {t:'leave'}                                         방 나가기
     {t:'pick',   champ}                                 챔피언 선택(선택 단계에서만)
     {t:'ready',  on:bool}                               준비/취소
     {t:'f',      s, mx, my, a, acts?}                   입력 프레임(게임 중에만). acts: 아래 참고
     {t:'ping',   c}                                     c = 클라이언트 시각(ms). 서버는 그대로 돌려줌
   서버 → 클라이언트
     {t:'welcome', v:VERSION, pid}                       pid = 이 연결의 플레이어 id (예: 'p3')
     {t:'room',  code, state, test, players:[{pid,name,team,champ,ready,online}], countdown?}
                                                         state: 'select' | 'countdown' | 'playing' | 'ended'
     {t:'start', tick, you, world}                       게임 시작. you = 내 챔피언 id(= pid), world = slimWorld
     {t:'snap',  tick, ack, w, ev}                       ev = 이번 스냅샷 사이에 생긴 core 이벤트(나에게 해당하는 것만)
     {t:'end',   winner, reason, kills:{0:n,1:n}}        winner = 이긴 팀 번호(0|1), reason: 'kill'|'turret'|'disconnect'
     {t:'pong',  c}
     {t:'error', code, msg}                              code: 'bad_version'|'room_not_found'|'room_full'|'bad_state'|'bad_msg'
   ─────────────────────────────────────────────────────────────────── */

/* acts 원소 (한 프레임에 여러 개 가능, 최대 4개)
     {k:'cast', skill, ang}     스킬 시전
     {k:'lv',   skill}          스킬 레벨업
     {k:'dev',  op, sec?}       테스트 도구(테스트 모드 방에서만 서버가 적용) */

const r3 = n => Math.round(n * 1000) / 1000;
const isNum = n => typeof n === 'number' && isFinite(n);

/* 입력 프레임 검사·정규화. 잘못된 값이면 null. 서버는 받은 프레임에, 클라이언트는 보내기/예측 전에 적용 */
function sanitizeFrame(f, allowDev) {
  if (!f || typeof f !== 'object' || !Number.isInteger(f.s) || f.s < 1) return null;
  let mx = isNum(f.mx) ? f.mx : 0, my = isNum(f.my) ? f.my : 0;
  const m = Math.hypot(mx, my);
  if (m > 1) { mx /= m; my /= m; }
  const out = { s: f.s, mx: r3(mx), my: r3(my), a: f.a ? 1 : 0 };
  if (Array.isArray(f.acts) && f.acts.length) {
    const acts = [];
    for (const x of f.acts.slice(0, 4)) {
      if (!x || typeof x !== 'object') continue;
      if (x.k === 'cast' && SKILLS.includes(x.skill)) acts.push({ k: 'cast', skill: x.skill, ang: r3(isNum(x.ang) ? x.ang : 0) });
      else if (x.k === 'lv' && SKILLS.includes(x.skill)) acts.push({ k: 'lv', skill: x.skill });
      else if (x.k === 'dev' && allowDev && DEV_OPS.includes(x.op)) {
        const d = { k: 'dev', op: x.op };
        if (x.op === 'time') d.sec = isNum(x.sec) ? Math.max(0, Math.min(600, x.sec)) : 60;
        acts.push(d);
      }
    }
    if (acts.length) out.acts = acts;
  }
  return out;
}

/* 정규화된 프레임 → core 명령 배열 (서버와 클라이언트 예측이 똑같이 사용) */
function frameToCmds(id, f) {
  const cmds = [{ type: 'input', id, mx: f.mx, my: f.my, atk: !!f.a }];
  if (f.acts) for (const x of f.acts) {
    if (x.k === 'cast') cmds.push({ type: 'cast', id, skill: x.skill, ang: x.ang });
    else if (x.k === 'lv') cmds.push({ type: 'levelup', id, skill: x.skill });
    else if (x.k === 'dev') cmds.push(Object.assign({ type: 'dev', id, op: x.op }, x.sec != null ? { sec: x.sec } : {}));
  }
  return cmds;
}

/* 큐가 넘칠 때: 버릴 프레임의 acts를 다음 프레임으로 옮김 */
function mergeDropped(dropped, next) {
  if (!dropped.acts) return next;
  const acts = dropped.acts.concat(next.acts || []).slice(0, 8);
  return Object.assign({}, next, { acts });
}

/* 스냅샷용 월드 복사본(events 제외). 결과는 JSON으로 보낼 수 있는 새 객체 */
function slimWorld(w) {
  return JSON.parse(JSON.stringify(w, (k, v) => (k === 'events' ? undefined : v)));
}
/* 받은 월드를 core에서 다시 쓸 수 있게 복원(events 배열 보충) */
function restoreWorld(w) { if (!Array.isArray(w.events)) w.events = []; return w; }

/* 이 플레이어에게 보낼 이벤트만 거르기: text 이벤트의 to가 있으면 그 사람에게만.
   테스트 모드가 아니면 core의 'banner' 이벤트(테스트용 문구)는 보내지 않음 */
function eventsFor(events, pid, test) {
  return events.filter(e => (e.type !== 'text' || !e.to || e.to === pid) && (test || e.type !== 'banner'));
}

function makeRoomCode(rand) {
  rand = rand || Math.random;
  let s = '';
  for (let i = 0; i < ROOM_CODE_LEN; i++) s += ROOM_CODE_CHARS[Math.floor(rand() * ROOM_CODE_CHARS.length)];
  return s;
}
function normName(n, fallback) {
  n = typeof n === 'string' ? n.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, NAME_MAX) : '';
  return n || fallback;
}
const encode = msg => JSON.stringify(msg);
function decode(text) { try { const m = JSON.parse(text); return m && typeof m === 'object' && typeof m.t === 'string' ? m : null; } catch (e) { return null; } }

return {
  VERSION, TICK_HZ, SNAP_EVERY, INTERP_TICKS, MAX_QUEUE, QUEUE_TARGET, MAX_FRAMES_PER_SEC, COUNTDOWN_SEC, RECONNECT_SEC,
  ROOM_CODE_CHARS, ROOM_CODE_LEN, NAME_MAX, WIN, CHAMP_KEYS, SKILLS, DEV_OPS,
  sanitizeFrame, frameToCmds, mergeDropped, slimWorld, restoreWorld, eventsFor, makeRoomCode, normName, encode, decode
};
});
