'use strict';
/* =====================================================================
   hub.js — 연결·방 관리 (DESIGN_GAS.md §2). UMD: Node는 require, 브라우저는 window.Hub
   - 서버(server.js)와 방장 브라우저(client/p2p.js)가 똑같이 쓴다. 네트워크·타이머를 직접 다루지 않는다.
     · 연결: hub.connect(conn) → 세션. conn 은 send(string), close(code, reason) 만 있으면 된다.
     · 메시지: hub.message(sess, text). 끊김: hub.disconnect(sess).
     · 시간: hub.update(dt) = 카운트다운 진행 + 고정 60틱(따라잡기 최대 5틱). 바깥 루프가 실제 경과 초를 준다.
   - 메시지·오류 코드·방 규칙은 예전 server.js 와 같다. 차이는 create 의 code 필드뿐이다:
     fixedCodes: true 일 때만 code 를 방 코드로 쓴다(방장 브라우저가 Apps Script에서 받은 코드). 기본값은 무시(WebSocket 서버 동작 그대로).
   ===================================================================== */
(function (root, factory) {
  const api = (typeof module === 'object' && module.exports)
    ? factory(require('../shared/protocol.js'), require('./room.js').Room)
    : factory(root.Protocol, root.Room);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Hub = api.Hub;
})(typeof self !== 'undefined' ? self : this, function (P, Room) {
'use strict';

const MAX_CATCHUP = 5;                 // 한 번의 update 에서 따라잡을 최대 틱 수(넘치면 시간을 버림)
const STEP = 1 / P.TICK_HZ;
const ERR_MSG = {
  bad_version: '버전이 맞지 않습니다. 페이지를 새로고침하세요.',
  room_not_found: '방을 찾을 수 없습니다.',
  room_full: '방이 가득 찼습니다.',
  bad_state: '지금은 할 수 없는 동작입니다.',
  bad_msg: '잘못된 메시지입니다.'
};
const isCode = c => c.length === P.ROOM_CODE_LEN && Array.from(c).every(ch => P.ROOM_CODE_CHARS.includes(ch));

class Hub {
  /* opts.countdownSec: 카운트다운 초(기본 P.COUNTDOWN_SEC). opts.codeFn: 새 방 코드 생성(기본 P.makeRoomCode).
     opts.fixedCodes: create 의 code 필드를 방 코드로 쓸지(기본 false) */
  constructor(opts) {
    opts = opts || {};
    this.countdownSec = opts.countdownSec;
    this.codeFn = opts.codeFn || (() => P.makeRoomCode());
    this.fixedCodes = opts.fixedCodes === true;
    this.rooms = new Map();            // code → Room
    this.sessions = new Set();         // 연결된 세션 {conn, pid, name, room}
    this._pidSeq = 0;
    this._acc = 0;                     // 틱 누적 시간(초)
  }

  connect(conn) {
    const sess = { conn, pid: null, name: null, room: null };
    this.sessions.add(sess);
    return sess;
  }

  disconnect(sess) {
    this.sessions.delete(sess);
    this._leave(sess);
  }

  /* 받은 문자열 1개 처리. 첫 메시지는 반드시 hello */
  message(sess, text) {
    const m = P.decode(text);
    if (!m) return this._reply(sess, 'bad_msg');

    if (!sess.pid) {
      if (m.t !== 'hello') { this._reply(sess, 'bad_msg'); return sess.conn.close(1008, 'hello first'); }
      if (m.v !== P.VERSION) {
        sess.conn.send(P.encode({ t: 'error', code: 'bad_version', msg: ERR_MSG.bad_version }));
        return sess.conn.close(1008, 'bad_version');
      }
      this._pidSeq++;
      sess.pid = 'p' + this._pidSeq;
      sess.name = P.normName(m.name, '플레이어' + this._pidSeq);
      sess.conn.send(P.encode({ t: 'welcome', v: P.VERSION, pid: sess.pid }));
      return;
    }

    switch (m.t) {
      case 'create': return this._create(sess, m);
      case 'join': return this._join(sess, m);
      case 'leave': return this._leave(sess);
      case 'pick': {
        if (!sess.room) return this._reply(sess, 'bad_state');
        const err = sess.room.pick(sess.pid, m.champ);
        if (err) this._reply(sess, err);
        return;
      }
      case 'ready': {
        if (typeof m.on !== 'boolean') return this._reply(sess, 'bad_msg');
        if (!sess.room) return this._reply(sess, 'bad_state');
        const err = sess.room.setReady(sess.pid, m.on);
        if (err) this._reply(sess, err);
        return;
      }
      case 'f': {
        if (sess.room) sess.room.onFrame(sess.pid, m);   // 게임 중이 아니면 조용히 무시
        return;
      }
      case 'ping': return sess.conn.send(P.encode({ t: 'pong', c: m.c }));
      default: return this._reply(sess, 'bad_msg');
    }
  }

  /* 실제 경과 초(dt)로 카운트다운을 진행하고 고정 틱을 돌린다.
     반환값: 다음 틱까지 남은 밀리초(서버 루프가 깨어날 시간. 최소 1) */
  update(dt) {
    for (const room of Array.from(this.rooms.values())) room.update(dt);
    this._acc += dt;
    let n = 0;
    while (this._acc >= STEP && n < MAX_CATCHUP) { this._acc -= STEP; n++; }
    if (this._acc >= STEP) this._acc = 0;     // 너무 밀리면 따라잡기를 포기하고 시간을 버림
    for (const room of Array.from(this.rooms.values())) for (let i = 0; i < n; i++) room.tick();
    return Math.max(1, Math.floor((STEP - this._acc) * 1000));
  }

  /* 서버 종료용: 연결 목록을 돌려주고(호출자가 끊음) 방·세션을 비운다 */
  close() {
    const conns = Array.from(this.sessions, s => s.conn);
    this.sessions.clear();
    this.rooms.clear();
    return conns;
  }

  /* ── 내부 ─────────────────────────────────────────────────────── */
  _reply(sess, code) {
    sess.conn.send(P.encode({ t: 'error', code, msg: ERR_MSG[code] || ERR_MSG.bad_msg }));
  }

  _leave(sess) {
    const room = sess.room;
    if (!room) return;
    sess.room = null;
    room.removePlayer(sess.pid);
    if (room.isEmpty()) this.rooms.delete(room.code);
  }

  _create(sess, m) {
    if (sess.room) return this._reply(sess, 'bad_state');
    let code = null;
    if (this.fixedCodes && typeof m.code === 'string' && m.code) {
      const c = m.code.trim().toUpperCase();
      if (!isCode(c)) return this._reply(sess, 'bad_msg');
      if (this.rooms.has(c)) return this._reply(sess, 'bad_state');   // 같은 코드의 방이 이미 있음
      code = c;
    } else {
      for (let i = 0; i < 200 && !code; i++) {
        const c = this.codeFn();
        if (!this.rooms.has(c)) code = c;
      }
      if (!code) return this._reply(sess, 'bad_state');
    }
    const room = new Room({ code, test: m.test === true, countdownSec: this.countdownSec });
    this.rooms.set(code, room);
    room.addPlayer({ pid: sess.pid, name: sess.name, conn: sess.conn });
    sess.room = room;
    room.broadcastRoom();
  }

  _join(sess, m) {
    if (sess.room) return this._reply(sess, 'bad_state');
    const code = typeof m.code === 'string' ? m.code.trim().toUpperCase() : '';
    const room = this.rooms.get(code);
    if (!room) return this._reply(sess, 'room_not_found');
    const err = room.addPlayer({ pid: sess.pid, name: sess.name, conn: sess.conn });
    if (err) return this._reply(sess, err);
    sess.room = room;
    room.broadcastRoom();
  }
}

return { Hub };
});
