/* =====================================================================
   p2p.js — 구글 스크립트 모드 네트워크 (DESIGN_GAS.md §3~§4). UMD
   - window.Signal : google.script.run 호출을 Promise로 감싼 것. Signal.call(name, ...args)
   - window.P2PNet : Net(client/net.js)과 같은 겉모습. 방장 모드 / 참가자 모드
       방장(create): sigCreate → 브라우저 안 Hub(루프백 연결으로 자기 자신도 손님처럼 연결) → sigHostPoll 로 손님 기다림
       참가자(join): RTCPeerConnection + DataChannel → sigJoin(offer) → sigGuestPoll(answer) → 열리면 hello + join
   - Node 테스트: const { Signal, createP2P } = require('../client/p2p.js')
       createP2P(env) 의 env: { Hub, P, signal(name, ...args)→Promise, RTCPeerConnection(없으면 WebRTC 없음), hubOptions }
   - 메시지는 항상 문자열(JSON 한 줄)로 주고받는다. 루프백과 DataChannel 모두 같은 규칙.
   ===================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.Signal = api.Signal;
    root.P2PNet = api.createP2P({
      Hub: root.Hub, P: root.Protocol, signal: api.Signal.call, RTCPeerConnection: root.RTCPeerConnection || null,
    });
  }
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const ICE_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const RTT_ALPHA = 0.2, PING_MS = 2000;
const POLL_MS = 1000;            // 신호 폴링 간격(응답을 받은 뒤 1초 쉬고 다시 물음)
const ICE_WAIT_MS = 3000;        // ICE 수집이 complete 가 안 돼도 이 시간이 지나면 지금 SDP를 보냄
const CONNECT_MS = 20000;        // 참가자: 이 안에 DataChannel 이 안 열리면 실패. 방장도 응답 후 같은 시간을 줌
const HOST_LOOP_MS = 4;          // 방장 Hub 루프 주기(실제 경과 시간을 hub.update 에 넘김)
const SIG_TIMEOUT_MS = 15000;    // google.script.run 한 번의 최대 대기

const MSG = {
  connectFail: '직접 연결에 실패했어요. 같은 와이파이인지 확인하거나, 학교 와이파이가 기기 간 연결을 막고 있을 수 있어요',
  hostFail: '상대와 직접 연결하지 못했어요. 방을 다시 만들어 주세요',
  noRtc: '이 브라우저는 직접 연결(WebRTC)을 지원하지 않아요',
  sigFail: '방 정보를 주고받지 못했어요. 인터넷 연결을 확인해 주세요',
  createFail: '방을 만들지 못했어요. 인터넷 연결을 확인해 주세요',
  hostLeft: '방장과 연결이 끊겼어요',
  busy: '연결 중이에요. 잠시만 기다려 주세요',
  badState: '지금은 할 수 없는 동작이에요',
};

/* google.script.run 래퍼. 실패(서버 예외, 네트워크)는 reject, 시간 초과도 reject */
const SILENCE_MS = 6000;   // 상대에게서 6초간 아무 메시지가 없으면 끊긴 것으로 봄(핑이 2초마다 오가므로)
const Signal = {
  /* 구글 스크립트가 잠깐 바쁘면({error:'busy'}) 0.7초 뒤 최대 3번 다시 시도 */
  async call(name, ...args) {
    for (let i = 0; ; i++) {
      const r = await Signal.call1(name, ...args);
      if (!(r && r.error === 'busy') || i >= 3) return r;
      await new Promise(res => setTimeout(res, 700));
    }
  },
  call1(name, ...args) {
    return new Promise((resolve, reject) => {
      const g = globalThis.google;
      if (!g || !g.script || !g.script.run) { reject(new Error('no-gas')); return; }
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('timeout')); } }, SIG_TIMEOUT_MS);
      const settle = fn => v => { if (done) return; done = true; clearTimeout(timer); fn(v); };
      g.script.run.withSuccessHandler(settle(resolve)).withFailureHandler(settle(reject))[name](...args);
    });
  }
};

const defer = fn => queueMicrotask(fn);   // 루프백은 비동기로 전달(같은 순서 유지)
const now = () => performance.now();
const closeQuiet = x => { try { if (x && x.close) x.close(); } catch (e) { /* 이미 닫힘 */ } };
const errText = code => ({ room_not_found: '방을 찾을 수 없어요', room_full: '방이 가득 찼어요' }[code] || MSG.sigFail);

/* ICE 수집이 complete 가 되거나 ms 가 지나면 끝 */
function waitIce(pc, ms) {
  return new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    let t = null;
    const onChg = () => { if (pc.iceGatheringState === 'complete') done(); };
    const done = () => {
      clearTimeout(t);
      if (pc.removeEventListener) pc.removeEventListener('icegatheringstatechange', onChg);
      resolve();
    };
    t = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', onChg);
  });
}

function createP2P(env) {
  const Hub = env.Hub, P = env.P, signal = env.signal, RTC = env.RTCPeerConnection || null;
  const hubOptions = env.hubOptions || {};

  const handlers = {};
  const closeFns = [];
  let mode = 'idle';        // 'idle' | 'host' | 'guest'
  let myName = '';
  let link = null;          // 지금 쓰는 연결 {send(text), isOpen()}. 방장: 루프백, 참가자: DataChannel
  let pingTimer = null;
  let host = null;          // 방장 상태
  let guest = null;         // 참가자 상태

  function emit(m) {
    const hs = handlers[m.t];
    if (hs) for (const h of hs.slice()) { try { h(m); } catch (e) { console.error(e); } }
  }
  function fireClose(reason) {
    for (const f of closeFns.slice()) { try { f(reason); } catch (e) { console.error(e); } }
  }

  /* 연결에서 받은 문자열 1개. welcome·pong·방 상태는 여기서 먼저 처리한 뒤 화면 쪽으로 넘긴다 */
  function onText(text) {
    const m = P.decode(typeof text === 'string' ? text : '');
    if (!m) return;
    if (m.t === 'welcome') { api.pid = m.pid; startPing(); }
    if (m.t === 'pong' && typeof m.c === 'number') {
      const s = now() - m.c;
      api.rtt = api.rtt == null ? s : api.rtt + (s - api.rtt) * RTT_ALPHA;
    }
    if (host && m.t === 'room') host.roomReady = true;
    if (host && !host.roomReady && m.t === 'error') {          // 방을 만들지 못함
      teardown();
      emit(m);
      return;
    }
    if (guest && !guest.joined && m.t === 'room') guest.joined = true;
    if (guest && !guest.joined && m.t === 'error') {            // 방에 들어가지 못함(방 없음·가득 참 등)
      teardown();
      emit(m);
      return;
    }
    emit(m);
  }

  function startPing() {
    clearInterval(pingTimer);
    pingTimer = setInterval(() => api.send({ t: 'ping', c: now() }), PING_MS);
  }
  function stopPing() { clearInterval(pingTimer); pingTimer = null; api.rtt = null; }

  /* 연결로 메시지 보내기(내부용: create/join/leave 규칙을 거치지 않음) */
  function sendRaw(obj) {
    if (!link || !link.isOpen()) return false;
    link.send(P.encode(obj));
    return true;
  }

  /* 모든 상태 정리(화면에 알리지 않음). 방장이면 방 코드도 닫는다 */
  function teardown() {
    const h = host, g = guest;
    host = null; guest = null; link = null; mode = 'idle'; api.pid = null;
    stopPing();
    if (h) {
      h.alive = false;
      clearInterval(h.loopTimer); clearTimeout(h.pollTimer);
      if (h.guest) { clearTimeout(h.guest.failTimer); clearInterval(h.guest.watch); closeQuiet(h.guest.dc); closeQuiet(h.guest.pc); }
      if (h.code && !h.codeClosed) signal('sigClose', h.code).catch(() => {});
    }
    if (g) { clearTimeout(g.joinTimer); clearTimeout(g.pollTimer); clearInterval(g.watch); closeQuiet(g.dc); closeQuiet(g.pc); }
  }

  /* ── 방장 ─────────────────────────────────────────────────────── */
  function startHost(test) {
    mode = 'host';
    const h = host = { code: null, test, hub: null, sess: null, loopTimer: null, pollTimer: null, guest: null, alive: true, roomReady: false, codeClosed: false, last: 0 };
    signal('sigCreate').then(r => {
      if (host !== h) return;
      if (!r || !r.code) throw new Error('no-code');
      h.code = r.code;
      hostOpenRoom(h);
      hostPoll(h);
    }).catch(() => {
      if (host !== h) return;
      teardown();
      emit({ t: 'error', code: 'p2p_failed', msg: MSG.createFail });
    });
  }

  function hostOpenRoom(h) {
    const hub = h.hub = new Hub(Object.assign({}, hubOptions, { fixedCodes: true }));
    // 루프백: 내 화면 → 방장 Hub, Hub → 내 화면 (둘 다 비동기)
    const loopConn = {
      send(text) { defer(() => { if (host === h) onText(text); }); },
      close() { /* Hub 가 연결을 닫으라고 해도(잘못된 hello) 무시: 방장 연결은 방이 끝날 때까지 유지 */ },
    };
    h.sess = hub.connect(loopConn);
    link = {
      send(text) { defer(() => { if (host === h && h.sess) hub.message(h.sess, text); }); },
      isOpen() { return host === h && h.alive; },
    };
    h.last = now();
    h.loopTimer = setInterval(() => {
      if (host !== h) return;
      const t = now(), dt = (t - h.last) / 1000;
      h.last = t;
      hub.update(dt);
    }, HOST_LOOP_MS);
    sendRaw({ t: 'hello', v: P.VERSION, name: myName });
    sendRaw({ t: 'create', test: h.test, code: h.code });
  }

  function hostPoll(h) {
    h.pollTimer = setTimeout(() => {
      h.pollTimer = null;
      if (host !== h || !h.alive || h.guest) return;      // 손님은 한 명만 받는다
      signal('sigHostPoll', h.code).then(r => {
        if (host !== h || !h.alive) return;
        if (r && r.offer && !h.guest) {
          const g = h.guest = { pc: null, dc: null, sess: null, failTimer: null, opened: false, gone: false };
          hostAnswer(h, g, r.offer);
          return;
        }
        hostPoll(h);
      }, () => { if (host === h && h.alive && !h.guest) hostPoll(h); });
    }, POLL_MS);
  }

  async function hostAnswer(h, g, offerSdp) {
    try {
      if (!RTC) throw new Error('no-rtc');
      const pc = g.pc = new RTC(ICE_CONFIG);
      pc.ondatachannel = e => hostAttach(h, g, e.channel);
      pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') hostGuestGone(h, g); };
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitIce(pc, ICE_WAIT_MS);
      if (host !== h) return;
      const r = await signal('sigAnswer', h.code, pc.localDescription.sdp);
      if (host !== h) return;
      if (!r || r.error) throw new Error('answer: ' + (r && r.error));
      if (!g.opened) g.failTimer = setTimeout(() => { if (!g.opened) hostFail(h); }, CONNECT_MS);   // 응답 사이에 이미 열렸을 수 있음
    } catch (err) {
      console.error('[p2p] 손님 연결 준비 실패', err);
      hostFail(h);
    }
  }

  function hostAttach(h, g, dc) {
    g.dc = dc;
    const open = () => {
      if (host !== h || g.opened || g.gone) return;
      g.opened = true;
      clearTimeout(g.failTimer);
      h.codeClosed = true;
      g.sess = h.hub.connect({
        send: s => { if (dc.readyState === 'open') dc.send(s); },
        close: () => closeQuiet(dc),
      });
      g.last = now();
      g.watch = setInterval(() => { if (now() - g.last > SILENCE_MS) hostGuestGone(h, g); }, 1000);
      if (g.pc) g.pc.onconnectionstatechange = () => { if (g.pc.connectionState === 'failed' || g.pc.connectionState === 'closed') hostGuestGone(h, g); };
      dc.onmessage = ev => {
        g.last = now();
        if (host !== h || !g.sess) return;
        try { h.hub.message(g.sess, ev.data); } catch (e) { console.error('[p2p] 손님 메시지 처리 오류', e && e.stack); }
      };
      dc.onclose = () => hostGuestGone(h, g);
      signal('sigClose', h.code).catch(() => {});       // 손님이 들어왔으니 방 코드를 닫는다
    };
    dc.onopen = open;
    if (dc.readyState === 'open') open();
  }

  /* 손님이 나감. 들어온 뒤라면 방은 계속(방장만 남음), 들어오기 전이면 연결 실패 */
  function hostGuestGone(h, g) {
    if (host !== h || g.gone) return;
    g.gone = true;
    clearTimeout(g.failTimer); clearInterval(g.watch);
    if (!g.opened) { hostFail(h); return; }
    const s = g.sess;
    g.sess = null;
    if (s) { try { h.hub.disconnect(s); } catch (e) { console.error(e); } }
    closeQuiet(g.dc); closeQuiet(g.pc);
  }

  /* 손님과 직접 연결 실패: 방을 닫고 로비로 돌아가게 한다 */
  function hostFail(h) {
    if (host !== h) return;
    teardown();
    emit({ t: 'error', code: 'p2p_failed', msg: MSG.hostFail });
    fireClose(null);
  }

  /* ── 참가자 ───────────────────────────────────────────────────── */
  function startGuest(code) {
    mode = 'guest';
    const g = guest = { code, pc: null, dc: null, joinTimer: null, pollTimer: null, joined: false, opened: false, answered: false };
    g.joinTimer = setTimeout(() => guestFail(g, 'p2p_failed', MSG.connectFail, true), CONNECT_MS);
    if (!RTC) { guestFail(g, 'no_webrtc', MSG.noRtc); return; }
    connectGuest(g).catch(() => guestFail(g, 'p2p_failed', MSG.sigFail));
  }

  async function connectGuest(g) {
    const pc = g.pc = new RTC(ICE_CONFIG);
    const dc = g.dc = pc.createDataChannel('game', { ordered: true });
    dc.onopen = () => guestOpened(g);
    dc.onmessage = ev => { g.last = now(); if (guest === g) onText(ev.data); };
    dc.onclose = () => guestLost(g);
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') guestLost(g); };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIce(pc, ICE_WAIT_MS);
    if (guest !== g) return;
    const r = await signal('sigJoin', g.code, pc.localDescription.sdp);
    if (guest !== g) return;
    if (!r || r.error) { guestFail(g, (r && r.error) || 'p2p_failed', errText(r && r.error)); return; }
    guestPoll(g);
  }

  function guestPoll(g) {
    g.pollTimer = setTimeout(() => {
      g.pollTimer = null;
      if (guest !== g || g.answered) return;
      signal('sigGuestPoll', g.code).then(r => {
        if (guest !== g || g.answered) return;
        if (r && r.error) { guestFail(g, r.error, errText(r.error)); return; }
        if (r && r.answer) {
          g.answered = true;
          g.pc.setRemoteDescription({ type: 'answer', sdp: r.answer }).catch(() => guestFail(g, 'p2p_failed', MSG.connectFail, true));
          return;
        }
        guestPoll(g);
      }, () => { if (guest === g && !g.answered) guestPoll(g); });
    }, POLL_MS);
  }

  function guestOpened(g) {
    if (guest !== g || g.opened) return;
    g.opened = true;
    clearTimeout(g.joinTimer); g.joinTimer = null;
    g.last = now();
    g.watch = setInterval(() => { if (now() - g.last > SILENCE_MS) guestLost(g); }, 1000);   // 방장 화면이 꺼지거나 탭이 닫힘
    link = {
      send: s => { if (g.dc.readyState === 'open') g.dc.send(s); },
      isOpen: () => guest === g && g.dc.readyState === 'open',
    };
    sendRaw({ t: 'hello', v: P.VERSION, name: myName });
    sendRaw({ t: 'join', code: g.code });
  }

  /* 방에 든 뒤 연결이 끊김 → 화면에 이유를 알리고 로비로 */
  function guestLost(g) {
    if (guest !== g) return;
    if (!g.joined) { guestFail(g, 'p2p_failed', MSG.connectFail, true); return; }
    teardown();
    fireClose(MSG.hostLeft);
  }

  /* 참가 실패. 화면 오류(error)를 보내고 정리한다. timeoutLike 면 onClose 도 부른다(§4: 20초 초과) */
  function guestFail(g, code, msg, timeoutLike) {
    if (guest !== g) return;
    teardown();
    emit({ t: 'error', code, msg });
    if (timeoutLike) fireClose(null);
  }

  /* ── 공개 API (Net과 같은 의미) ───────────────────────────────── */
  const api = {
    rtt: null,
    pid: null,
    get open() { return !!(link && link.isOpen()); },

    connect(name) {
      if (mode !== 'idle') teardown();
      myName = typeof name === 'string' ? name : '';
      return Promise.resolve(null);      // 즉시 성공: 이름만 저장. 방장/참가자 연결은 방을 만들거나 들어갈 때 생긴다
    },

    send(obj) {
      if (!obj || typeof obj.t !== 'string') return false;
      if (obj.t === 'create' || obj.t === 'join') {
        if (mode !== 'idle') {
          const busy = (host && !host.roomReady) || (guest && !guest.joined);
          emit({ t: 'error', code: busy ? 'busy' : 'bad_state', msg: busy ? MSG.busy : MSG.badState });
          return false;
        }
        if (obj.t === 'create') startHost(obj.test === true);
        else startGuest(typeof obj.code === 'string' ? obj.code.trim().toUpperCase() : '');
        return true;
      }
      if (obj.t === 'leave') {
        if (mode === 'host') { sendRaw(obj); defer(teardown); return true; }   // 방장이 나가면 방이 닫힌다
        if (mode === 'guest') { teardown(); return true; }                     // 참가자가 나가면 연결을 끊는다
        return false;
      }
      return sendRaw(obj);
    },

    on(type, fn) {
      (handlers[type] = handlers[type] || []).push(fn);
      return () => { handlers[type] = (handlers[type] || []).filter(f => f !== fn); };
    },
    onClose(fn) { closeFns.push(fn); },
    close() { teardown(); },
  };
  return api;
}

return { Signal, createP2P };
});
