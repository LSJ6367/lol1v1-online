'use strict';
/* =====================================================================
   ws.js — 최소 WebSocket 서버 (RFC 6455, 표준 모듈만 사용)
   - attach(httpServer, {path, onConnection}): 지정 경로의 upgrade만 받고 나머지는 400 후 종료
   - conn: EventEmitter. send(text), close(code, reason), terminate(). 이벤트 'message'(string), 'close'
   - 지원: 텍스트 메시지, 분할(continuation), ping/pong, close 핸드셰이크, 64KB 초과 거부(1009),
           마스크 없는 클라이언트 프레임 거부(1002). 바이너리 메시지는 무시.
   - 하트비트: pingMs마다 ping, timeoutMs 동안 아무 데이터도 없으면 종료.
   ===================================================================== */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 64 * 1024;
const MAX_BUFFERED = 4 * 1024 * 1024;   // 보내지 못하고 쌓인 바이트가 이 이상이면 연결 종료
const OP_CONT = 0, OP_TEXT = 1, OP_BIN = 2, OP_CLOSE = 8, OP_PING = 9, OP_PONG = 10;
const EMPTY = Buffer.alloc(0);
const utf8 = new TextDecoder('utf-8', { fatal: true });

class Conn extends EventEmitter {
  constructor(socket, opts) {
    super();
    this.socket = socket;
    this.closed = false;          // 소켓이 완전히 닫혔음
    this.remoteAddress = socket.remoteAddress || '';
    this._closing = false;        // close 프레임을 이미 보냄
    this._dead = false;           // 더 이상 읽거나 쓰지 않음
    this._buf = EMPTY;            // 아직 해석하지 못한 수신 바이트
    this._frags = null;           // 분할 메시지 진행 상태 {opcode, parts, size}
    this._lastSeen = Date.now();
    this._lastPing = Date.now();
    this._endTimer = null;
    socket.setNoDelay(true);
    socket.setKeepAlive(true);
    socket.on('data', chunk => this._onData(chunk));
    // HTTP 서버가 만든 소켓은 allowHalfOpen 이라, 상대가 FIN 만 보내면 자동으로 닫히지 않는다.
    // 그대로 두면 방 정리가 하트비트 시간(30초) 뒤로 밀리므로 여기서 바로 닫는다.
    socket.on('end', () => this.terminate());
    socket.on('error', () => {});
    socket.on('close', () => this._finish());
    const pingMs = opts.pingMs, timeoutMs = opts.timeoutMs;
    this._pingMs = pingMs; this._timeoutMs = timeoutMs;
    this._timer = setInterval(() => this._heartbeat(), Math.max(10, Math.min(1000, pingMs / 2)));
    this._timer.unref();
  }

  /* 텍스트 메시지 전송. 닫혔거나 밀린 데이터가 너무 많으면 false */
  send(text) {
    if (this._dead || this._closing) return false;
    if (this.socket.writableLength > MAX_BUFFERED) { this.terminate(); return false; }
    return this._write(OP_TEXT, Buffer.from(String(text), 'utf8'));
  }

  /* 정상 종료 핸드셰이크: close 프레임 전송 후 소켓 종료(1초 안에 안 닫히면 강제) */
  close(code, reason) {
    if (this._dead) return;
    this._writeClose(code || 1000, reason || '');
    this._halt();
  }

  /* 즉시 소켓 파기 */
  terminate() {
    this._dead = true;
    if (!this.socket.destroyed) this.socket.destroy();
  }

  _write(op, payload) {
    const s = this.socket;
    if (s.destroyed || !s.writable) return false;
    const n = payload.length;
    let hdr;
    if (n < 126) { hdr = Buffer.alloc(2); hdr[1] = n; }
    else if (n < 65536) { hdr = Buffer.alloc(4); hdr[1] = 126; hdr.writeUInt16BE(n, 2); }
    else { hdr = Buffer.alloc(10); hdr[1] = 127; hdr.writeUInt32BE(Math.floor(n / 4294967296), 2); hdr.writeUInt32BE(n >>> 0, 6); }
    hdr[0] = 0x80 | op;   // FIN=1, 서버 프레임은 마스크하지 않음
    s.write(payload.length ? Buffer.concat([hdr, payload]) : hdr);
    return true;
  }

  _writeClose(code, reason) {
    if (this._closing) return;
    this._closing = true;
    const r = Buffer.from(String(reason), 'utf8').subarray(0, 123);
    this._write(OP_CLOSE, Buffer.concat([Buffer.from([(code >> 8) & 0xff, code & 0xff]), r]));
  }

  /* 더 읽지 않고 소켓을 정상 종료(FIN). 상대가 닫지 않으면 1초 뒤 파기 */
  _halt() {
    this._dead = true;
    if (!this.socket.destroyed) this.socket.end();
    if (!this._endTimer) {
      this._endTimer = setTimeout(() => this.terminate(), 1000);
      this._endTimer.unref();
    }
  }

  _fail(code) {   // 프로토콜 위반: close(code) 후 종료
    if (this._dead) return;
    this._writeClose(code, '');
    this._halt();
  }

  _onData(chunk) {
    if (this._dead) return;
    this._lastSeen = Date.now();
    try {
      this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
      this._parse();
    } catch (e) {
      console.error('[ws] 프레임 처리 오류', e && e.message);
      this._fail(1011);
    }
  }

  _parse() {
    while (!this._dead) {
      const b = this._buf;
      if (b.length < 2) return;
      const b0 = b[0], b1 = b[1];
      if (b0 & 0x70) return this._fail(1002);          // RSV 비트는 협상하지 않으므로 0이어야 함
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f;
      if (!(b1 & 0x80)) return this._fail(1002);       // 클라이언트 프레임은 반드시 마스크
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const hi = b.readUInt32BE(2), lo = b.readUInt32BE(6);
        if (hi !== 0) return this._fail(1009);
        len = lo; off = 10;
      }
      if (opcode >= 8 && (!fin || len > 125)) return this._fail(1002);   // 제어 프레임 규칙
      if (opcode > 10 || (opcode > 2 && opcode < 8)) return this._fail(1002);
      if (len > MAX_MESSAGE) return this._fail(1009);
      if (b.length < off + 4 + len) return;             // 나머지가 아직 도착하지 않음
      const mask = b.subarray(off, off + 4);
      off += 4;
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = b[off + i] ^ mask[i & 3];
      this._buf = b.subarray(off + len);
      this._onFrame(fin, opcode, payload);
    }
  }

  _onFrame(fin, opcode, payload) {
    if (opcode === OP_PING) { if (!this._closing) this._write(OP_PONG, payload); return; }
    if (opcode === OP_PONG) return;
    if (opcode === OP_CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      if (!this._closing) this._writeClose(code, '');
      this._halt();
      return;
    }
    if (opcode === OP_TEXT || opcode === OP_BIN) {
      if (this._frags) return this._fail(1002);        // 분할 메시지 중에는 새 데이터 프레임 불가
      if (fin) return this._message(opcode, payload);
      this._frags = { opcode, parts: [payload], size: payload.length };
      return;
    }
    if (opcode === OP_CONT) {
      const f = this._frags;
      if (!f) return this._fail(1002);
      f.size += payload.length;
      if (f.size > MAX_MESSAGE) return this._fail(1009);
      f.parts.push(payload);
      if (fin) {
        this._frags = null;
        this._message(f.opcode, Buffer.concat(f.parts, f.size));
      }
      return;
    }
    this._fail(1002);
  }

  _message(opcode, buf) {
    if (opcode !== OP_TEXT) return;                    // 바이너리는 무시
    let text;
    try { text = utf8.decode(buf); } catch (e) { return this._fail(1007); }
    try { this.emit('message', text); }
    catch (e) { console.error('[ws] message 핸들러 오류', e && e.message); }
  }

  _heartbeat() {
    if (this._dead || this.closed) return;
    const now = Date.now();
    if (now - this._lastSeen >= this._timeoutMs) return this.terminate();
    if (now - this._lastPing >= this._pingMs) { this._lastPing = now; this._write(OP_PING, EMPTY); }
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    this._dead = true;
    clearInterval(this._timer);
    clearTimeout(this._endTimer);
    this._buf = EMPTY; this._frags = null;
    this.emit('close');
  }
}

/* 지정 경로로 들어온 WebSocket 업그레이드 요청을 받아 Conn을 만든다 */
function attach(httpServer, opts) {
  opts = opts || {};
  const path = opts.path || '/ws';
  const onConnection = opts.onConnection || (() => {});
  const pingMs = opts.pingMs || 15000, timeoutMs = opts.timeoutMs || 30000;

  httpServer.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const reject = () => {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      const t = setTimeout(() => socket.destroy(), 1000); t.unref();
    };
    let pathname = '';
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch (e) { /* 잘못된 URL */ }
    const key = req.headers['sec-websocket-key'];
    const okKey = typeof key === 'string' && Buffer.from(key, 'base64').length === 16;
    const okUpgrade = /(^|[,\s])upgrade([,\s]|$)/i.test(String(req.headers.connection || '')) &&
                      /^websocket$/i.test(String(req.headers.upgrade || ''));
    if (pathname !== path || req.method !== 'GET' || !okUpgrade || req.headers['sec-websocket-version'] !== '13' || !okKey) {
      return reject();
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
                 'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const conn = new Conn(socket, { pingMs, timeoutMs });
    try { onConnection(conn, req); }
    catch (e) { console.error('[ws] onConnection 오류', e && e.message); conn.terminate(); return; }
    if (head && head.length) conn._onData(head);
  });
}

module.exports = { attach, MAX_MESSAGE };
