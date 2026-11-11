/* =====================================================================
   net.js — WebSocket 래퍼 (재접속 없음). window.Net
   connect(name) → 'welcome' 수신 시 resolve. 실패/종료/4초 초과 시 reject.
   file:// 등 http(s)가 아니면 즉시 reject (아티팩트 샌드박스 포함).
   각 소켓의 핸들러는 "지금 쓰는 소켓인지" 확인하고, 옛 소켓의 이벤트는 무시한다.
   ===================================================================== */
(function () {
'use strict';
const P = window.Protocol;
const CONNECT_MS = 4000, PING_MS = 2000, RTT_ALPHA = 0.2;

let ws = null;
let pingTimer = null;
const handlers = {}, closeFns = [];

const Net = {
  rtt: null,           // 평활화된 왕복 지연(ms)
  pid: null,           // welcome으로 받은 내 플레이어 id
  get open() { return !!ws && ws.readyState === 1; },

  connect(name) {
    return new Promise((resolve, reject) => {
      if (!/^https?:$/.test(location.protocol)) { reject(new Error('unsupported-protocol')); return; }
      const url = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws';
      let done = false;
      let sock;
      const fail = err => {
        if (done) return; done = true; clearTimeout(timer);
        try { sock.close(); } catch (e) {}
        if (ws === sock) ws = null;
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('timeout')), CONNECT_MS);
      try { sock = new WebSocket(url); } catch (e) { fail(e); return; }
      ws = sock;
      sock.onopen = () => { if (ws === sock) Net.send({ t: 'hello', v: P.VERSION, name }); };
      sock.onerror = () => fail(new Error('socket-error'));
      sock.onclose = () => {
        const current = ws === sock;   // fail()이 ws를 비우므로 먼저 확인
        fail(new Error('closed'));     // 아직 응답 전이면 connect 실패로 처리 (이미 끝났으면 무시됨)
        if (!current) return;          // 옛 소켓: 종료 알림은 건너뜀
        Net.rtt = null;
        clearInterval(pingTimer); pingTimer = null;
        for (const f of closeFns.slice()) { try { f(); } catch (e) { console.error(e); } }
      };
      sock.onmessage = ev => {
        if (ws !== sock) return;
        const m = P.decode(typeof ev.data === 'string' ? ev.data : '');
        if (!m) return;
        if (m.t === 'welcome' && !done) {
          done = true; clearTimeout(timer); Net.pid = m.pid;
          startPing();
          resolve(m);
        }
        if (m.t === 'pong' && typeof m.c === 'number') {
          const s = performance.now() - m.c;
          Net.rtt = Net.rtt == null ? s : Net.rtt + (s - Net.rtt) * RTT_ALPHA;
        }
        const hs = handlers[m.t];
        if (hs) for (const h of hs.slice()) { try { h(m); } catch (e) { console.error(e); } }
      };
    });
  },

  send(obj) {
    if (!Net.open) return false;
    try { ws.send(P.encode(obj)); return true; } catch (e) { return false; }
  },

  // 메시지 종류별 핸들러 등록. 반환값을 부르면 해제
  on(type, fn) {
    (handlers[type] = handlers[type] || []).push(fn);
    return () => { handlers[type] = (handlers[type] || []).filter(f => f !== fn); };
  },
  onClose(fn) { closeFns.push(fn); },

  close() { try { if (ws) ws.close(); } catch (e) {} },
};

function startPing() {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => Net.send({ t: 'ping', c: performance.now() }), PING_MS);
}

window.Net = Net;
})();
