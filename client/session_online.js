/* =====================================================================
   session_online.js — 온라인 세션 (OnlineSession). DESIGN.md §2, §3 구현
   - 내 챔피언: 입력 프레임을 매 틱(1/60초) 서버로 보내고, 같은 프레임을 예측 월드에도 적용.
     스냅샷이 오면 예측 월드를 서버 상태로 맞춘 뒤 아직 ack 안 된 프레임을 재시뮬.
     예측 위치와 재시뮬 결과의 차이는 시각 오프셋으로 흡수(지수 감쇠).
   - 상대/허수아비: 스냅샷 버퍼에서 INTERP_TICKS(4틱≈67ms) 과거 시점을 선형 보간.
   - 이벤트(숫자·이펙트·배너): 서버 스냅샷의 ev만 사용. 예측 월드의 이벤트는 버림.
   UMD: 브라우저는 window.OnlineSession, Node는 module.exports (Core/Protocol은 전역 또는 require).
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root.Core || require('../shared/core.js'), root.Protocol || require('../shared/protocol.js'));
  } else {
    root.OnlineSession = factory(root.Core, root.Protocol);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core, P) {
'use strict';

const TICK = Core.TICK;
const INTERP_TICKS = P.INTERP_TICKS;
const MAX_ACTS_PER_FRAME = 4;
const BUF_KEEP_TICKS = 60;      // 스냅샷 버퍼: 약 1초분
const BUF_KEEP_MS = 1000;
const CLOCK_GAIN = 0.1, CLOCK_SNAP = 30;
const OFF_DECAY = 12;           // 시각 오프셋 감쇠 계수: exp(-12*dt)
const OFF_MAX = 40, FAR = 80;   // 재시뮬 오차 40px 이상이면 순간 이동, 보간 쌍 80px 이상이면 보간 안 함

function findUnit(w, id) {
  if (!w) return null;
  return (w.champs && w.champs.find(c => c.id === id)) || (w.dummies && w.dummies.find(d => d.id === id)) || null;
}

class OnlineSession {
  constructor(net, startMsg, opts) {
    opts = Object.assign({ predict: true, test: false, now: () => performance.now() }, opts || {});
    this.net = net;
    this.myId = startMsg.you;
    this.online = true;
    this.test = !!opts.test;
    this.predict = opts.predict !== false;
    this.now = opts.now;

    this.startWorld = P.restoreWorld(startMsg.world);
    this.pred = this.predict ? P.restoreWorld(structuredClone(startMsg.world)) : null;
    this.latest = null;            // 마지막 스냅샷 { tick, w, ack }
    this.buf = [];                 // 스냅샷 버퍼 { tick, w, recvMs }

    this.seq = 0;
    this.pending = [];             // 보냈지만 ack되지 않은 프레임
    this.acts = [];                // 다음 프레임에 실을 행동
    this.held = { mx: 0, my: 0, atk: false };
    this.acc = 0;
    this.localTick = 0;            // 로컬에서 진행한 틱 수
    this.clockOff = 0;             // 서버틱 ≈ localTick + clockOff
    this.hasClock = false;
    this.off = { x: 0, y: 0 };     // 예측 시각 오프셋
    this.evq = [];                 // 서버 이벤트 대기열

    this._off = (net && typeof net.on === 'function') ? net.on('snap', m => this.onSnap(m)) : null;
  }

  destroy() { if (typeof this._off === 'function') this._off(); this._off = null; }

  get ping() { return (this.net && typeof this.net.rtt === 'number') ? this.net.rtt : null; }

  get world() {
    if (this.predict && this.pred) return this.pred;
    return this.latest ? this.latest.w : this.startWorld;
  }

  me() { return Core.champOf(this.world, this.myId); }

  send(cmd) {
    if (!cmd) return;
    switch (cmd.type) {
      case 'input':
        this.held.mx = Number(cmd.mx) || 0; this.held.my = Number(cmd.my) || 0; this.held.atk = !!cmd.atk; break;
      case 'cast': this.acts.push({ k: 'cast', skill: cmd.skill, ang: cmd.ang }); break;
      case 'levelup': this.acts.push({ k: 'lv', skill: cmd.skill }); break;
      case 'dev': if (this.test) this.acts.push({ k: 'dev', op: cmd.op, sec: cmd.sec }); break;
    }
  }

  update(dt) {
    this.acc = Math.min(this.acc + dt, 0.25);
    while (this.acc >= TICK) { this.acc -= TICK; this.tick(); }
    const k = Math.exp(-OFF_DECAY * dt);
    this.off.x *= k; this.off.y *= k;
  }

  tick() {
    this.localTick++;
    const f = P.sanitizeFrame({
      s: ++this.seq, mx: this.held.mx, my: this.held.my, a: this.held.atk ? 1 : 0,
      acts: this.acts.splice(0, MAX_ACTS_PER_FRAME)
    }, this.test);
    if (!f) return;
    if (this.net) this.net.send(Object.assign({ t: 'f' }, f));
    this.pending.push(f);
    if (this.predict) { Core.step(this.pred, P.frameToCmds(this.myId, f)); Core.drainEvents(this.pred); }
  }

  drainEvents() { const e = this.evq; this.evq = []; return e; }

  onSnap(msg) {
    const recvMs = this.now();
    const w = P.restoreWorld(msg.w);

    // 서버 틱 추정 (DESIGN §3)
    const sample = msg.tick - this.localTick;
    if (!this.hasClock || Math.abs(sample - this.clockOff) > CLOCK_SNAP) { this.clockOff = sample; this.hasClock = true; }
    else this.clockOff += (sample - this.clockOff) * CLOCK_GAIN;

    this.buf.push({ tick: msg.tick, w, recvMs });
    while (this.buf.length > 2 && (this.buf[0].tick < msg.tick - BUF_KEEP_TICKS || recvMs - this.buf[0].recvMs > BUF_KEEP_MS)) this.buf.shift();
    this.latest = { tick: msg.tick, w, ack: msg.ack };

    for (const e of (msg.ev || [])) this.evq.push(e);
    this.pending = this.pending.filter(f => f.s > msg.ack);

    if (this.predict) {
      const before = Core.champOf(this.pred, this.myId);
      const oldX = before ? before.x : null, oldY = before ? before.y : null;
      this.pred = P.restoreWorld(structuredClone(msg.w));
      for (const f of this.pending) { Core.step(this.pred, P.frameToCmds(this.myId, f)); Core.drainEvents(this.pred); }
      const after = Core.champOf(this.pred, this.myId);
      if (oldX !== null && after) {
        const ex = oldX - after.x, ey = oldY - after.y;
        if (Math.hypot(ex, ey) < OFF_MAX) { this.off.x += ex; this.off.y += ey; }
        else { this.off.x = 0; this.off.y = 0; }
      }
    }
  }

  renderTick() {
    return this.localTick + this.acc / TICK + this.clockOff - INTERP_TICKS;
  }

  pos(u) {
    if (u.kind === 'turret') return [u.x, u.y];
    if (this.predict && u.id === this.myId) return [u.x + this.off.x, u.y + this.off.y];
    return this.interp(u);
  }

  interp(u) {
    const buf = this.buf;
    if (!buf.length) return [u.x, u.y];
    const R = this.renderTick();
    const newest = buf[buf.length - 1], oldest = buf[0];
    if (R >= newest.tick) { const n = findUnit(newest.w, u.id); return n ? [n.x, n.y] : [u.x, u.y]; }
    if (R <= oldest.tick) { const o = findUnit(oldest.w, u.id); return o ? [o.x, o.y] : [u.x, u.y]; }
    let i = buf.length - 2;
    while (i > 0 && buf[i].tick > R) i--;
    const a = buf[i], b = buf[i + 1];
    const ua = findUnit(a.w, u.id), ub = findUnit(b.w, u.id);
    if (!ua || !ub) return [u.x, u.y];
    if (Math.hypot(ub.x - ua.x, ub.y - ua.y) > FAR) return [ub.x, ub.y];
    const t = (R - a.tick) / (b.tick - a.tick);
    return [ua.x + (ub.x - ua.x) * t, ua.y + (ub.y - ua.y) * t];
  }
}

return OnlineSession;
});
