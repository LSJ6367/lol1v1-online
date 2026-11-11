/* =====================================================================
   Code.gs — 1대1 대전 구글 스크립트 서버 (웹 앱)
   · doGet: GitHub(gas/game.html)에서 게임 페이지를 받아 내려줌 (스크립트 캐시 5분)
   · sig*: 방 코드로 두 기기를 소개하는 WebRTC 신호 교환 (게임 중에는 쓰지 않음)
   배포 방법은 gas/README.md 참고. 이 파일을 고쳤을 때만 '새 버전'으로 다시 배포하면 됩니다.
   ===================================================================== */

const GAME_URL = 'https://raw.githubusercontent.com/LSJ6367/lol1v1-online/main/gas/game.html';
const VIEWPORT = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
const PAGE_TTL = 300;         // 게임 페이지 캐시 유지(초)
const CHUNK_CHARS = 90000;    // 캐시 조각 최대 글자 수
const CHUNK_BYTES = 95000;    // 캐시 값 한도(100KB) 안쪽의 UTF-8 바이트 상한 (한글은 글자당 3바이트)
const ROOM_TTL = 600;         // 방 기록 유지(초). 쓸 때마다 600초로 다시 잰다
const SDP_MAX = 20000;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // shared/protocol.js와 같아야 함
const ROOM_CODE_LEN = 4;

/* ── 게임 페이지 ───────────────────────────────────────── */
function doGet(e) {
  const nocache = !!(e && e.parameter && e.parameter.nocache === '1');
  const cache = CacheService.getScriptCache();
  const cached = nocache ? null : readCachedPage(cache);
  if (cached !== null) return pageOutput(cached);

  let html = null, problem = '';
  try {
    const res = UrlFetchApp.fetch(GAME_URL, { muteHttpExceptions: true });
    problem = 'HTTP ' + res.getResponseCode();
    if (res.getResponseCode() === 200) html = res.getContentText('UTF-8');
  } catch (ex) {
    problem = String(ex);
  }
  if (!html) return errorPage(html === '' ? problem + ' (빈 응답)' : problem);
  try { writePageCache(cache, html); } catch (ex) { /* 캐시 실패는 무시: 페이지는 그대로 준다 */ }
  return pageOutput(html);
}

function pageOutput(html) {
  return HtmlService.createHtmlOutput(html)
    .setTitle('1대1 대전')
    .addMetaTag('viewport', VIEWPORT)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function errorPage(detail) {
  const safe = String(detail).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const body = '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
    '<body style="font-family:sans-serif;padding:24px;line-height:1.6">' +
    '<h2>게임 페이지를 불러오지 못했어요</h2>' +
    '<p>상태: ' + safe + '</p>' +
    '<p>잠시 뒤 새로고침해 보세요. 계속 이 화면이면 방장(만든 사람)에게 알려 주세요.</p>' +
    '</body></html>';
  return HtmlService.createHtmlOutput(body)
    .setTitle('1대1 대전 - 오류')
    .addMetaTag('viewport', VIEWPORT)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* 캐시 키: 'game:count' = 조각 수, 'game:0' ~ 'game:N-1' = 페이지 조각 */
function readCachedPage(cache) {
  const n = parseInt(cache.get('game:count'), 10);
  if (!(n > 0)) return null;
  const keys = [];
  for (let i = 0; i < n; i++) keys.push('game:' + i);
  const got = cache.getAll(keys);
  let html = '';
  for (const k of keys) {
    if (typeof got[k] !== 'string') return null;   // 조각이 하나라도 없으면 다시 받기
    html += got[k];
  }
  return html;
}

function writePageCache(cache, html) {
  const parts = splitForCache(html);
  const values = { 'game:count': String(parts.length) };
  parts.forEach((p, i) => { values['game:' + i] = p; });
  cache.putAll(values, PAGE_TTL);
}

/* 90,000자 이하이면서 UTF-8로 CHUNK_BYTES 이하인 조각으로 자른다. 서로게이트 쌍(이모지)은 가르지 않음 */
function splitForCache(s) {
  const parts = [];
  let start = 0;
  while (start < s.length) {
    let end = start, chars = 0, bytes = 0;
    while (end < s.length && chars < CHUNK_CHARS) {
      const c = s.charCodeAt(end);
      // 서로게이트 한 칸은 2바이트(쌍 = 4바이트)
      const b = c < 0x80 ? 1 : (c < 0x800 || (c >= 0xd800 && c <= 0xdfff)) ? 2 : 3;
      if (bytes + b > CHUNK_BYTES) break;
      bytes += b; chars++; end++;
    }
    const last = s.charCodeAt(end - 1);
    if (end < s.length && end - 1 > start && last >= 0xd800 && last <= 0xdbff) end--;
    parts.push(s.slice(start, end));
    start = end;
  }
  return parts;
}

/* ── 신호 교환 ─────────────────────────────────────────
   방 기록(JSON, 키 'room:CODE'): {state:'waiting'|'offered'|'answered', offer, answer, t} */
function roomKey(code) { return 'room:' + code; }

function normCode(code) {
  const s = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (s.length !== ROOM_CODE_LEN) return null;
  return s.split('').every(ch => ROOM_CODE_CHARS.indexOf(ch) >= 0) ? s : null;
}

function validSdp(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= SDP_MAX;
}

function readRoom(code) {
  const raw = CacheService.getScriptCache().get(roomKey(code));
  return raw ? JSON.parse(raw) : null;
}

function writeRoom(code, room) {
  CacheService.getScriptCache().put(roomKey(code), JSON.stringify(room), ROOM_TTL);
}

/* 스크립트 잠금을 잡고 fn 실행. 잠금을 못 잡으면 {error:'busy'}, 잡았으면 항상 finally에서 해제 */
function locked(fn) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (ex) { return { error: 'busy' }; }
  try { return fn(); } finally { lock.releaseLock(); }
}

function randomCode() {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LEN; i++) s += ROOM_CODE_CHARS.charAt(Math.floor(Math.random() * ROOM_CODE_CHARS.length));
  return s;
}

function sigCreate() {
  return locked(() => {
    for (let i = 0; i < 20; i++) {
      const code = randomCode();
      if (readRoom(code) === null) {
        writeRoom(code, { state: 'waiting', offer: null, answer: null, t: Date.now() });
        return { code: code };
      }
    }
    return { error: 'busy' };   // 빈 코드를 20번 찾지 못함
  });
}

function sigJoin(code, offerSdp) {
  const c = normCode(code);
  if (!c) return { error: 'room_not_found' };
  if (!validSdp(offerSdp)) return { error: 'bad_msg' };
  return locked(() => {
    const room = readRoom(c);
    if (!room) return { error: 'room_not_found' };
    if (room.state !== 'waiting') return { error: 'room_full' };
    writeRoom(c, { state: 'offered', offer: offerSdp, answer: null, t: Date.now() });
    return { ok: true };
  });
}

function sigHostPoll(code) {
  const c = normCode(code);
  const room = c && readRoom(c);
  if (!room) return { error: 'room_not_found' };
  return { offer: room.offer };
}

function sigAnswer(code, answerSdp) {
  const c = normCode(code);
  if (!c) return { error: 'room_not_found' };
  if (!validSdp(answerSdp)) return { error: 'bad_msg' };
  return locked(() => {
    const room = readRoom(c);
    if (!room) return { error: 'room_not_found' };
    if (room.state !== 'offered') return { error: 'bad_state' };
    writeRoom(c, { state: 'answered', offer: room.offer, answer: answerSdp, t: Date.now() });
    return { ok: true };
  });
}

function sigGuestPoll(code) {
  const c = normCode(code);
  const room = c && readRoom(c);
  if (!room) return { error: 'room_not_found' };
  return { answer: room.answer };
}

function sigClose(code) {
  const c = normCode(code);
  if (!c) return { ok: true };   // 없는 방 닫기는 성공(멱등)
  return locked(() => {
    CacheService.getScriptCache().remove(roomKey(c));
    return { ok: true };
  });
}
