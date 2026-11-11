'use strict';
/* =====================================================================
   room.js — 방 1개 = 로비 상태 + 게임 루프(틱) + 승패 판정 (DESIGN.md §3~§5)
   - 연결(conn)은 send(string)만 있으면 된다. 서버 테스트에서는 가짜 conn을 넣는다.
   - 시간은 바깥(server.js의 전역 루프)이 준다: update(dt)=카운트다운 진행, tick()=게임 1틱.
   - 메서드 실패는 오류 코드 문자열을 돌려준다(성공은 null). 서버가 {t:'error'}로 바꿔 보낸다.
   ===================================================================== */
const Core = require('../shared/core.js');
const P = require('../shared/protocol.js');

class Room {
  constructor(opts) {
    opts = opts || {};
    this.code = opts.code;
    this.test = !!opts.test;
    this.countdownSec = opts.countdownSec ?? P.COUNTDOWN_SEC;
    this.state = 'select';        // 'select' | 'countdown' | 'playing'
    this.players = [];
    this.world = null;
    this.gameTick = 0;            // 게임 틱 번호(0 = 시작 직후)
    this.buf = [];                // 스냅샷 사이에 생긴 core 이벤트
    this.kills = { 0: 0, 1: 0 };
    this.countdownLeft = 0;
    this._lastShown = undefined;   // 마지막으로 보낸 카운트다운 숫자
  }

  find(pid) { return this.players.find(p => p.pid === pid) || null; }
  isEmpty() { return this.players.length === 0; }

  /* 방 입장. 실패 시 'room_full' | 'bad_state' */
  addPlayer({ pid, name, conn }) {
    if (this.players.length >= 2) return 'room_full';
    if (this.state !== 'select') return 'bad_state';
    const team = this.players.some(p => p.team === 0) ? 1 : 0;
    this.players.push({
      pid, name, team, champ: 'darius', ready: false, conn,
      queue: [], lastSeq: 0, lastRecv: 0, rate: []
    });
    return null;
  }

  /* 나가거나 연결이 끊김. 게임 중이면 남은 쪽 승리(disconnect) */
  removePlayer(pid) {
    const i = this.players.findIndex(p => p.pid === pid);
    if (i < 0) return;
    this.players.splice(i, 1);
    if (this.state === 'playing') {
      const remain = this.players[0];
      if (remain) this._endGame(remain.team, 'disconnect');
      else this._toSelect();
    } else if (this.state === 'countdown') {
      this._toSelect();
    }
    this.broadcastRoom();
  }

  /* 챔피언 선택: 선택 단계에서, 준비 전에만 */
  pick(pid, champ) {
    const p = this.find(pid);
    if (!p) return 'bad_msg';
    if (!P.CHAMP_KEYS.includes(champ)) return 'bad_msg';
    if (this.state !== 'select' || p.ready) return 'bad_state';
    p.champ = champ;
    this.broadcastRoom();
    return null;
  }

  /* 준비/취소. 카운트다운 중 취소하면 선택 단계로 돌아간다 */
  setReady(pid, on) {
    const p = this.find(pid);
    if (!p) return 'bad_msg';
    if (this.state === 'playing') return 'bad_state';
    if (this.state === 'countdown') {
      if (on) return null;                      // 이미 시작 대기 중
      p.ready = false;
      this._toSelect();
      this.broadcastRoom();
      return null;
    }
    p.ready = !!on;
    if (this._canStart()) this._startCountdown();
    else this.broadcastRoom();
    return null;
  }

  /* 프레임 수신(게임 중에만). 정규화 → seq 중복 무시 → 초당 제한 → 큐 */
  onFrame(pid, msg) {
    if (this.state !== 'playing') return;
    const p = this.find(pid);
    if (!p) return;
    const f = P.sanitizeFrame(msg, this.test);
    if (!f || f.s <= p.lastRecv) return;
    const now = Date.now();
    const cutoff = now - 1000;
    while (p.rate.length && p.rate[0] <= cutoff) p.rate.shift();
    if (p.rate.length >= P.MAX_FRAMES_PER_SEC) return;
    p.rate.push(now);
    p.lastRecv = f.s;
    p.queue.push(f);
    if (p.queue.length > P.MAX_QUEUE) {
      const d = p.queue.shift();
      p.queue[0] = P.mergeDropped(d, p.queue[0]);
    }
  }

  /* 카운트다운 진행(실제 초). 서버 루프가 매 반복마다 호출 */
  update(dt) {
    if (this.state !== 'countdown') return;
    this.countdownLeft -= dt;
    if (this.countdownLeft <= 0) { this._startGame(); return; }
    if (this._shownCount() !== this._lastShown) this.broadcastRoom();
  }

  /* 게임 1틱 (1/60초). 서버 루프가 호출. 게임 중이 아니면 아무 일도 없음 */
  tick() {
    if (this.state !== 'playing') return;
    const world = this.world;
    const cmds = [];
    for (const p of this.players) {
      if (p.queue.length) {
        const f = p.queue.shift();
        for (const c of P.frameToCmds(p.pid, f)) cmds.push(c);
        p.lastSeq = f.s;
      }
    }
    const champDead = world.champs.map(c => c.dead);
    const turretDead = world.turrets.map(t => t.dead);
    Core.step(world, cmds);
    for (const e of Core.drainEvents(world)) this.buf.push(e);
    this.gameTick++;

    // 승패 판정: 처치(플래그 false→true) 또는 포탑 파괴. 포탑이 우선(같은 틱이면)
    world.champs.forEach((c, i) => { if (!champDead[i] && c.dead) this.kills[1 - c.team]++; });
    let winner = null, reason = null;
    if (P.WIN.turret) {
      world.turrets.forEach((t, i) => { if (winner === null && !turretDead[i] && t.dead) { winner = 1 - t.team; reason = 'turret'; } });
    }
    if (winner === null) {
      for (const team of [0, 1]) {
        if (this.kills[team] >= P.WIN.kills) { winner = team; reason = 'kill'; break; }
      }
    }

    // 혼자 하는 테스트 방은 승패 없이 계속 연습(죽어도 부활)
    if (this.test && this.players.length < 2) winner = null;
    if (this.gameTick % P.SNAP_EVERY === 0) this._snapshot();
    if (winner !== null) this._endGame(winner, reason);
  }

  broadcastRoom() {
    const msg = {
      t: 'room', code: this.code, state: this.state, test: this.test,
      players: this.players.map(p => ({ pid: p.pid, name: p.name, team: p.team, champ: p.champ, ready: p.ready, online: true }))
    };
    if (this.state === 'countdown') {
      msg.countdown = this._shownCount();
      this._lastShown = msg.countdown;
    }
    const s = P.encode(msg);
    for (const p of this.players) this._sendRaw(p, s);
  }

  /* ── 내부 ─────────────────────────────────────────────────────── */
  _canStart() {
    return this.players.length > 0 && this.players.every(p => p.ready) && (this.players.length === 2 || this.test);
  }

  _shownCount() { return Math.max(0, Math.ceil(this.countdownLeft)); }

  _startCountdown() {
    this.state = 'countdown';
    this.countdownLeft = this.countdownSec;
    if (this.countdownSec <= 0) { this._startGame(); return; }
    this.broadcastRoom();
  }

  _toSelect() {
    this.state = 'select';
    this.countdownLeft = 0;
    this._lastShown = undefined;   // 마지막으로 보낸 카운트다운 숫자
    this.world = null;
    this.buf = [];
  }

  _startGame() {
    const players = this.players.map(p => ({ id: p.pid, key: p.champ, team: p.team }));
    this.world = Core.createWorld({ players, dummy: this.test, devMode: this.test });
    for (const p of this.players) { p.queue = []; p.lastSeq = 0; p.lastRecv = 0; p.rate = []; }
    this.gameTick = 0;
    this.buf = [];
    this.kills = { 0: 0, 1: 0 };
    this.state = 'playing';
    this._lastShown = undefined;
    for (const p of this.players) {
      this._send(p, { t: 'start', tick: 0, you: p.pid, world: P.slimWorld(this.world) });
    }
    this.broadcastRoom();
  }

  /* 스냅샷: 월드 JSON은 한 번만 만들고, 플레이어마다 ack/ev만 붙인다 */
  _snapshot() {
    const worldStr = JSON.stringify(P.slimWorld(this.world));
    const evs = this.buf;
    this.buf = [];
    for (const p of this.players) {
      const s = '{"t":"snap","tick":' + this.gameTick + ',"ack":' + p.lastSeq +
                ',"ev":' + JSON.stringify(P.eventsFor(evs, p.pid, this.test)) + ',"w":' + worldStr + '}';
      this._sendRaw(p, s);
    }
  }

  /* 게임 종료: end 전송 → 선택 단계로 복귀, 준비 해제 */
  _endGame(winner, reason) {
    const s = P.encode({ t: 'end', winner, reason, kills: { 0: this.kills[0], 1: this.kills[1] } });
    for (const p of this.players) this._sendRaw(p, s);
    this._toSelect();
    this.gameTick = 0;
    for (const p of this.players) { p.ready = false; p.queue = []; }
    this.broadcastRoom();
  }

  _send(p, obj) { this._sendRaw(p, P.encode(obj)); }
  _sendRaw(p, s) { if (p.conn) p.conn.send(s); }
}

module.exports = { Room };
