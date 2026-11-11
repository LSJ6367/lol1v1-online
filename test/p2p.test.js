'use strict';
/* P2PNet 테스트 (WebRTC 없이). 실행: node test/p2p.test.js
   1) 방장 경로: Hub + 루프백 + 메모리 신호 교환. RTCPeerConnection 은 아예 없다.
   2) 참가자 오류(없는 코드, WebRTC 없음)
   3) 방장 + 참가자: 메모리로 흉내 낸 RTCPeerConnection/DataChannel 한 쌍으로 끝까지 연결 → 게임 → 나가기 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Core = require('../shared/core.js');
const P = require('../shared/protocol.js');
const { Hub } = require('../server/hub.js');
const { createP2P, Signal } = require('../client/p2p.js');
const { makeSigMem, signalFrom } = require('./sig_mem.js');

Core.setMap(JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/walk_rle.json'), 'utf8')));

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + String(e && e.message).split('\n').slice(0, 4).join('\n     ')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function waitFor(pred, ms, label) {
  return new Promise((resolve, reject) => {
    const end = Date.now() + ms;
    const t = setInterval(() => {
      let ok = false;
      try { ok = !!pred(); } catch (e) { clearInterval(t); reject(e); return; }
      if (ok) { clearInterval(t); resolve(); }
      else if (Date.now() > end) { clearInterval(t); reject(new Error('timeout: ' + label)); }
    }, 5);
  });
}

/* 받은 메시지를 모두 쌓는다 */
function collect(net) {
  const got = [];
  for (const t of ['welcome', 'room', 'start', 'snap', 'end', 'error', 'pong']) net.on(t, m => got.push(m));
  got.of = t => got.filter(m => m.t === t);
  got.last = t => { const a = got.filter(m => m.t === t); return a[a.length - 1] || null; };
  return got;
}

/* ── 메모리 RTCPeerConnection 한 쌍 ───────────────────────────────
   offer/answer SDP 에 pc 번호를 실어 서로 찾는다. DataChannel 은 메시지를 setTimeout 0 으로 전달(비동기) */
let PCS = new Map(), PC_SEQ = 0;
class FakeDC {
  constructor(label) { this.label = label; this.readyState = 'connecting'; this.peer = null; this.onopen = null; this.onmessage = null; this.onclose = null; }
  send(text) {
    if (this.readyState !== 'open') throw new Error('DataChannel not open');
    const peer = this.peer;
    setTimeout(() => { if (peer && peer.readyState === 'open' && peer.onmessage) peer.onmessage({ data: text }); }, 0);
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    setTimeout(() => { if (this.onclose) this.onclose(); }, 0);
    if (this.peer) this.peer.close();
  }
}
class FakeRTC {
  constructor(cfg) {
    this.id = ++PC_SEQ; this.cfg = cfg; PCS.set(this.id, this);
    this.iceGatheringState = 'new'; this.connectionState = 'new'; this.localDescription = null;
    this.dc = null; this.ondatachannel = null; this.onconnectionstatechange = null; this._l = [];
  }
  addEventListener(t, f) { if (t === 'icegatheringstatechange') this._l.push(f); }
  removeEventListener(t, f) { this._l = this._l.filter(x => x !== f); }
  createDataChannel(label) { this.dc = new FakeDC(label); this.dc.local = true; return this.dc; }
  async createOffer() { return { type: 'offer', sdp: 'OFFER#' + this.id }; }
  async createAnswer() { return { type: 'answer', sdp: 'ANSWER#' + this.id }; }
  async setLocalDescription(d) {
    this.localDescription = { type: d.type, sdp: d.sdp };
    this.iceGatheringState = 'gathering';
    setTimeout(() => { this.iceGatheringState = 'complete'; for (const f of this._l.slice()) f(); }, 1);
  }
  async setRemoteDescription(d) {
    if (d.type === 'offer') {
      const guestPc = PCS.get(Number(d.sdp.split('#')[1]));
      if (!guestPc || !guestPc.dc) throw new Error('offer 를 낸 연결이 없음');
      const hostDc = new FakeDC(guestPc.dc.label);
      hostDc.peer = guestPc.dc; guestPc.dc.peer = hostDc;
      this.dc = hostDc;
      setTimeout(() => { if (this.ondatachannel) this.ondatachannel({ channel: hostDc }); }, 1);
    } else if (d.type === 'answer') {
      const dc = this.dc, hostDc = dc.peer;     // 참가자 쪽 DataChannel 과 방장 쪽 짝
      setTimeout(() => {
        dc.readyState = 'open'; hostDc.readyState = 'open';
        if (dc.onopen) dc.onopen();
        if (hostDc.onopen) hostDc.onopen();
      }, 5);
    }
  }
  close() { if (this.connectionState === 'closed') return; this.connectionState = 'closed'; if (this.dc) this.dc.close(); }
}

const baseEnv = (mem, extra) => Object.assign({
  Hub, P, signal: signalFrom(mem), RTCPeerConnection: FakeRTC, hubOptions: { countdownSec: 0.05 },
}, extra || {});

/* Apps Script 의 google.script.run 흉내: withSuccessHandler / withFailureHandler 체인 + sig* 함수 */
function installFakeGas(mem) {
  const names = ['sigCreate', 'sigJoin', 'sigHostPoll', 'sigAnswer', 'sigGuestPoll', 'sigClose'];
  const runner = (ok, fail) => {
    const r = { withSuccessHandler: f => runner(f, fail), withFailureHandler: f => runner(ok, f) };
    for (const n of names) {
      r[n] = (...args) => setTimeout(() => {
        try { const v = mem[n](...args); if (ok) ok(v); }
        catch (e) { if (fail) fail(e); }
      }, 2);
    }
    return r;
  };
  globalThis.google = { script: { run: runner(null, null) } };
}
function removeFakeGas() { delete globalThis.google; }

(async () => {
  await test('Signal.call: google.script.run 이 없으면 no-gas 로 거절', async () => {
    await assert.rejects(Signal.call('sigCreate'), /no-gas/);
  });

  await test('방장 경로(WebRTC 없음, 실제 Signal.call + 가짜 google.script.run): create → 방 코드 방송, 준비 → 시작 → 프레임 → 스냅샷(ack 증가, 내 챔피언 이동)', async () => {
    const mem = makeSigMem({ codeFn: () => 'ABCD' });
    installFakeGas(mem);
    const net = createP2P(baseEnv(mem, { RTCPeerConnection: null, signal: Signal.call }));
    const got = collect(net);
    await net.connect('방장');
    assert.strictEqual(net.send({ t: 'create', test: true }), true);
    await waitFor(() => got.last('room'), 2000, 'room');
    const room = got.last('room');
    assert.strictEqual(room.code, 'ABCD');
    assert.strictEqual(room.test, true);
    assert.strictEqual(room.players.length, 1);
    assert.strictEqual(net.pid, 'p1');
    assert.ok(mem.rooms.has('ABCD'), '신호 서버에 방이 생겼다');
    await waitFor(() => mem.calls.some(c => c[0] === 'sigHostPoll'), 2000, 'sigHostPoll');

    net.send({ t: 'pick', champ: 'yi' });
    net.send({ t: 'ready', on: true });
    await waitFor(() => got.last('start'), 2000, 'start');
    const st = got.last('start');
    assert.strictEqual(st.you, 'p1');
    const x0 = st.world.champs.find(c => c.id === 'p1').x;
    assert.ok(st.world.champs.some(c => c.id === 'p1' && c.key === 'yi'), '선택한 챔피언');

    let seq = 0;
    for (let i = 0; i < 40; i++) { net.send({ t: 'f', s: ++seq, mx: 1, my: 0, a: 0 }); await sleep(16); }
    await waitFor(() => got.of('snap').length >= 10, 2000, 'snap');
    const snaps = got.of('snap');
    for (let i = 1; i < snaps.length; i++) assert.ok(snaps[i].ack >= snaps[i - 1].ack, 'ack 단조 증가');
    assert.ok(snaps[snaps.length - 1].ack >= 30, '마지막 ack ' + snaps[snaps.length - 1].ack);
    const x1 = snaps[snaps.length - 1].w.champs.find(c => c.id === 'p1').x;
    assert.ok(x1 > x0 + 10, '오른쪽으로 이동 ' + x0 + ' → ' + x1);

    assert.strictEqual(net.send({ t: 'leave' }), true);
    await waitFor(() => !net.open && mem.calls.some(c => c[0] === 'sigClose'), 2000, 'sigClose');
    assert.strictEqual(net.pid, null);
    assert.ok(!mem.rooms.has('ABCD'));
    removeFakeGas();
  });

  await test('방장: google.script.run 이 실패(예외)하면 p2p_failed 오류, 연결 없음(idle)', async () => {
    const mem = makeSigMem();
    mem.sigCreate = () => { throw new Error('down'); };
    installFakeGas(mem);
    const net = createP2P(baseEnv(mem, { RTCPeerConnection: null, signal: Signal.call }));
    const got = collect(net);
    await net.connect('방장');
    net.send({ t: 'create', test: false });
    await waitFor(() => got.last('error'), 2000, 'error');
    assert.strictEqual(got.last('error').code, 'p2p_failed');
    assert.strictEqual(net.open, false);
    assert.strictEqual(net.send({ t: 'ping', c: 1 }), false, 'idle 에서는 보낼 곳이 없음');
    removeFakeGas();
  });

  await test('참가자: 없는 코드 → room_not_found 오류 후 idle(다시 시도 가능)', async () => {
    const mem = makeSigMem();
    const g = createP2P(baseEnv(mem));
    const got = collect(g);
    await g.connect('손님');
    assert.strictEqual(g.send({ t: 'join', code: 'zzzz' }), true);
    await waitFor(() => got.last('error'), 3000, 'error');
    assert.strictEqual(got.last('error').code, 'room_not_found');
    assert.strictEqual(g.open, false);
    assert.strictEqual(g.pid, null);
    assert.strictEqual(g.send({ t: 'ping', c: 1 }), false);
  });

  await test('신호: 방은 한 명만 받는다(offered/answered 상태에서 다른 offer → room_full), 없는 방 → room_not_found', () => {
    const mem = makeSigMem({ codeFn: () => 'WXYZ' });
    const code = mem.sigCreate().code;
    assert.deepStrictEqual(mem.sigJoin(code, 'OFFER#1'), { ok: true });
    assert.deepStrictEqual(mem.sigJoin(code, 'OFFER#2'), { error: 'room_full' });
    assert.deepStrictEqual(mem.sigHostPoll(code), { offer: 'OFFER#1' });
    assert.deepStrictEqual(mem.sigAnswer(code, 'ANSWER#1'), { ok: true });
    assert.deepStrictEqual(mem.sigHostPoll(code), { offer: null });
    assert.deepStrictEqual(mem.sigGuestPoll(code), { answer: 'ANSWER#1' });
    assert.deepStrictEqual(mem.sigJoin('nope', 'x'), { error: 'room_not_found' });
  });

  await test('참가자: WebRTC 가 없는 브라우저면 no_webrtc 오류', async () => {
    const g = createP2P(baseEnv(makeSigMem(), { RTCPeerConnection: null }));
    const got = collect(g);
    await g.connect('손님');
    g.send({ t: 'join', code: 'ABCD' });
    assert.strictEqual(got.last('error').code, 'no_webrtc');
    assert.strictEqual(g.open, false);
  });

  await test('방장 + 참가자(메모리 DataChannel): 연결 → 참가 → 준비 → 시작 → 양쪽 스냅샷 → 참가자 나가기 = 방장 승리', async () => {
    const mem = makeSigMem();
    PCS = new Map();
    const H = createP2P(baseEnv(mem)), G = createP2P(baseEnv(mem));
    const T = createP2P(baseEnv(mem));       // 세 번째 사람: 가득 찬 방
    const hg = collect(H), gg = collect(G), tg = collect(T);
    await H.connect('방장'); await G.connect('손님'); await T.connect('셋째');

    H.send({ t: 'create', test: false });
    await waitFor(() => hg.last('room'), 2000, 'host room');
    const code = hg.last('room').code;
    assert.strictEqual(code.length, P.ROOM_CODE_LEN, '코드 4자리');

    G.send({ t: 'join', code: code.toLowerCase() });
    await waitFor(() => gg.last('room') && gg.last('room').players.length === 2, 6000, 'guest room');
    assert.strictEqual(G.pid, 'p2');
    assert.strictEqual(H.pid, 'p1');
    assert.strictEqual(hg.last('room').players.length, 2, '방장 화면도 두 명');
    assert.strictEqual(G.open, true);

    // 손님이 들어와 DataChannel 이 열리면 방 코드는 닫힌다(sigClose) → 세 번째 사람은 방을 찾지 못함
    T.send({ t: 'join', code });
    await waitFor(() => tg.last('error'), 4000, 'third error');
    assert.strictEqual(tg.last('error').code, 'room_not_found');
    assert.strictEqual(T.open, false);

    H.send({ t: 'ready', on: true });
    G.send({ t: 'ready', on: true });
    await waitFor(() => hg.last('start') && gg.last('start'), 4000, 'start');
    assert.strictEqual(gg.last('start').you, 'p2');
    assert.strictEqual(hg.last('start').you, 'p1');

    let hs = 0, gs = 0;
    for (let i = 0; i < 40; i++) {
      H.send({ t: 'f', s: i + 1, mx: 1, my: 0, a: 0 });
      G.send({ t: 'f', s: i + 1, mx: 0, my: 0, a: 0 });
      await sleep(16);
    }
    await waitFor(() => hg.of('snap').length >= 5 && gg.of('snap').length >= 5, 3000, 'snaps');
    const hsn = hg.of('snap'), gsn = gg.of('snap');
    hs = hsn[hsn.length - 1].ack; gs = gsn[gsn.length - 1].ack;
    assert.ok(hs >= 25 && gs >= 25, 'ack 가 따라옴 ' + hs + ' / ' + gs);
    const seenByGuest = gsn[gsn.length - 1].w.champs.map(c => c.id).sort();
    assert.deepStrictEqual(seenByGuest, ['p1', 'p2']);
    const hostX = hsn[hsn.length - 1].w.champs.find(c => c.id === 'p1').x;
    const hostX0 = hg.last('start').world.champs.find(c => c.id === 'p1').x;
    assert.ok(hostX > hostX0 + 10, '방장 챔피언이 움직임(손님 화면에서도 보임)');
    assert.ok(gsn.every(s => s.t === 'snap'), '스냅샷만 온다');

    await waitFor(() => G.rtt != null, 4000, 'rtt');
    assert.ok(typeof G.rtt === 'number' && G.rtt >= 0, 'rtt ' + G.rtt);

    G.send({ t: 'leave' });
    await waitFor(() => hg.last('end'), 2000, 'end');
    const end = hg.last('end');
    assert.deepStrictEqual({ w: end.winner, r: end.reason }, { w: 0, r: 'disconnect' });
    assert.strictEqual(G.open, false);
    assert.strictEqual(G.pid, null);
    assert.strictEqual(G.rtt, null);
    assert.strictEqual(mem.rooms.size, 0, '연결되면 방 코드는 닫힌다');
    assert.ok(mem.calls.filter(c => c[0] === 'sigClose').length >= 1);

    H.close(); T.close();
    await sleep(20);
  });

  await test('방장 + 참가자: 방장이 나가면 참가자는 onClose(방장과 연결이 끊겼어요)', async () => {
    const mem = makeSigMem();
    PCS = new Map();
    const H = createP2P(baseEnv(mem)), G = createP2P(baseEnv(mem));
    const hg = collect(H), gg = collect(G);
    const reasons = [];
    G.onClose(r => reasons.push(r));
    await H.connect('방장'); await G.connect('손님');
    H.send({ t: 'create', test: false });
    await waitFor(() => hg.last('room'), 2000, 'room');
    G.send({ t: 'join', code: hg.last('room').code });
    await waitFor(() => gg.last('room'), 6000, 'guest room');
    H.send({ t: 'leave' });
    await waitFor(() => reasons.length === 1, 3000, 'guest onClose');
    assert.strictEqual(reasons[0], '방장과 연결이 끊겼어요');
    assert.strictEqual(G.open, false);
    assert.strictEqual(H.open, false);
    await sleep(20);
  });

  await test('방장 + 참가자: 참가자가 DataChannel 로 끊기면 방장 쪽은 방이 남고(상대 연결 끊김 승리)', async () => {
    const mem = makeSigMem();
    PCS = new Map();
    const H = createP2P(baseEnv(mem)), G = createP2P(baseEnv(mem));
    const hg = collect(H), gg = collect(G);
    await H.connect('방장'); await G.connect('손님');
    H.send({ t: 'create', test: false });
    await waitFor(() => hg.last('room'), 2000, 'room');
    G.send({ t: 'join', code: hg.last('room').code });
    await waitFor(() => gg.last('room'), 6000, 'guest room');
    H.send({ t: 'ready', on: true }); G.send({ t: 'ready', on: true });
    await waitFor(() => hg.last('start'), 4000, 'start');
    // 참가자(만든 쪽 DataChannel)를 끊는다 → 방장 쪽 close 이벤트
    const guestPc = [...PCS.values()].find(p => p.dc && p.dc.local && p.dc.readyState === 'open');
    guestPc.dc.close();
    await waitFor(() => hg.last('end'), 3000, 'host end');
    assert.deepStrictEqual({ w: hg.last('end').winner, r: hg.last('end').reason }, { w: 0, r: 'disconnect' });
    assert.strictEqual(H.open, true, '방장은 그대로 연결 상태');
    H.close(); G.close();
    await sleep(20);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
