'use strict';
/* 신호 교환(DESIGN_GAS.md §4)의 메모리 구현. 테스트 전용.
   Node 테스트(p2p.test.js)와 브라우저 e2e 서버(p2p_e2e.js)가 같이 쓴다.
   상태: waiting → (sigJoin) offered → (sigAnswer) answered → (sigClose 또는 만료) 삭제 */
const P = require('../shared/protocol.js');

const TTL_MS = 600000;   // Apps Script 캐시 600초와 같은 만료

function makeSigMem(opts) {
  opts = opts || {};
  const rooms = new Map();     // code → {state, offer, answer, born}
  const calls = [];            // 호출 기록 [name, ...args]
  const nowFn = opts.now || Date.now;
  const codeFn = opts.codeFn || (() => P.makeRoomCode());

  function live(code) {
    const r = rooms.get(String(code || '').toUpperCase());
    if (!r) return null;
    if (nowFn() - r.born > TTL_MS) { rooms.delete(String(code).toUpperCase()); return null; }
    return r;
  }

  const api = {
    rooms, calls,
    sigCreate() {
      calls.push(['sigCreate']);
      let code = null;
      for (let i = 0; i < 100 && !code; i++) { const c = codeFn(); if (!rooms.has(c)) code = c; }
      rooms.set(code, { state: 'waiting', offer: null, answer: null, born: nowFn() });
      return { code };
    },
    sigJoin(code, offerSdp) {
      calls.push(['sigJoin', code]);
      const r = live(code);
      if (!r) return { error: 'room_not_found' };
      if (r.state !== 'waiting') return { error: 'room_full' };
      r.offer = offerSdp; r.state = 'offered';
      return { ok: true };
    },
    sigHostPoll(code) {
      calls.push(['sigHostPoll', code]);
      const r = live(code);
      if (!r) return { error: 'room_not_found' };
      return { offer: r.state === 'offered' ? r.offer : null };
    },
    sigAnswer(code, answerSdp) {
      calls.push(['sigAnswer', code]);
      const r = live(code);
      if (!r) return { error: 'room_not_found' };
      if (r.state !== 'offered') return { error: 'bad_state' };
      r.answer = answerSdp; r.state = 'answered';
      return { ok: true };
    },
    sigGuestPoll(code) {
      const r = live(code);
      if (!r) return { error: 'room_not_found' };
      return { answer: r.state === 'answered' ? r.answer : null };
    },
    sigClose(code) {
      calls.push(['sigClose', code]);
      rooms.delete(String(code || '').toUpperCase());
      return { ok: true };
    },
  };
  return api;
}

/* p2p.js 의 env.signal 자리에 넣는 어댑터: 비동기(짧은 지연)로 메모리 구현을 부른다 */
function signalFrom(mem, delayMs) {
  return (name, ...args) => new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        if (typeof mem[name] !== 'function') throw new Error('no such sig: ' + name);
        resolve(mem[name](...args));
      } catch (e) { reject(e); }
    }, delayMs == null ? 2 : delayMs);
  });
}

module.exports = { makeSigMem, signalFrom };
