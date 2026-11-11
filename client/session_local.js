/* =====================================================================
   session_local.js — 오프라인 세션 (LocalSession)
   이 브라우저 안에서 Core를 직접 돌립니다. 인터페이스는 DESIGN.md §2 와 같습니다.
   ===================================================================== */
(function () {
'use strict';
const { TICK } = Core;

class LocalSession {
  constructor(players, myId) {
    this.myId = myId;
    this.online = false;
    this.test = true;
    this.ping = null;
    this.world = Core.createWorld({ players, dummy: true, devMode: true });
    this.queue = []; this.acc = 0; this.alpha = 0; this.prev = {};
  }
  send(cmd) { this.queue.push(cmd); }
  update(dt) {   // 고정 간격으로 코어를 진행. 남는 시간은 화면 보간에 사용
    this.acc = Math.min(this.acc + dt, 0.25);
    while (this.acc >= TICK) {
      for (const u of this.world.champs.concat(this.world.dummies)) this.prev[u.id] = [u.x, u.y];
      Core.step(this.world, this.queue); this.queue = []; this.acc -= TICK;
    }
    this.alpha = this.acc / TICK;
  }
  drainEvents() { return Core.drainEvents(this.world); }
  me() { return Core.champOf(this.world, this.myId); }
  pos(u) {       // 틱 사이를 부드럽게 이어서 그릴 위치
    const p = this.prev[u.id]; if (!p) return [u.x, u.y];
    if (Math.hypot(u.x - p[0], u.y - p[1]) > 80) return [u.x, u.y];
    return [p[0] + (u.x - p[0]) * this.alpha, p[1] + (u.y - p[1]) * this.alpha];
  }
}

window.LocalSession = LocalSession;
})();
