'use strict';
/* =====================================================================
   gas_emulator.js — Apps Script(V8) 실행 환경을 흉내 내는 테스트 도구.
   gas/Code.gs를 vm 컨텍스트에 로드하고, CacheService / LockService / UrlFetchApp / HtmlService를
   실제 API 모양대로 만든 가짜로 채웁니다. 실제와 다른 점:
     - 시간은 clock으로 조절(Date.now를 바꿔 끼움)
     - 함수 결과는 google.script.run처럼 JSON으로 한 번 왕복시켜 돌려줌
     - 네트워크·잠금 경합은 실제로 일어나지 않음 (테스트가 직접 주입)
   사용: const env = load({ fetch, now }); env.gas.sigCreate(); env.clock.advance(300); ...
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CODE_GS = path.join(__dirname, '..', 'gas', 'Code.gs');
const DEFAULT_NOW = 1700000000000;
const CACHE_VALUE_MAX_BYTES = 100 * 1024;   // CacheService 값 한도 (UTF-8 바이트 기준으로 검사)
const CACHE_KEY_MAX = 250;
const CACHE_TTL_MIN = 1;
const CACHE_TTL_MAX = 21600;
const GAS_FUNCTIONS = ['doGet', 'sigCreate', 'sigJoin', 'sigHostPoll', 'sigAnswer', 'sigGuestPoll', 'sigClose'];

function makeClock(start) {
  let t = start;
  return {
    now: () => t,
    advance(sec) { t += sec * 1000; },
    set(ms) { t = ms; },
  };
}

function makeCacheService(clock) {
  const store = new Map();   // key -> { value, expiresAt }
  const calls = [];
  const helpers = { calls, fail: null, raw: null, keys: null };

  function live(key) {
    const e = store.get(key);
    if (!e) return null;
    if (clock.now() >= e.expiresAt) { store.delete(key); return null; }
    return e;
  }
  function op(name, key) {
    calls.push(name);
    if (helpers.fail && helpers.fail(name, key)) throw new Error('Service error: CacheService');
  }
  function checkKey(key) {
    if (typeof key !== 'string') throw new TypeError('Invalid argument: key');
    if (key.length > CACHE_KEY_MAX) throw new Error('Argument too large: key');
  }
  function checkValue(value) {
    if (typeof value !== 'string') throw new TypeError('Invalid argument: value');
    if (Buffer.byteLength(value, 'utf8') > CACHE_VALUE_MAX_BYTES) throw new Error('Argument too large: value');
  }
  function checkTtl(ttl) {
    if (!Number.isInteger(ttl) || ttl < CACHE_TTL_MIN || ttl > CACHE_TTL_MAX) throw new RangeError('Invalid argument: expirationInSeconds');
  }

  // Code.gs가 보는 객체: 실제 Apps Script Cache의 메서드만 둔다 (없는 메서드를 부르면 TypeError)
  const cache = {
    get(key) {
      checkKey(key); op('get', key);
      const e = live(key);
      return e ? e.value : null;
    },
    getAll(keys) {
      if (!Array.isArray(keys)) throw new TypeError('Invalid argument: keys');
      const out = {};
      for (const k of keys) {
        checkKey(k); op('getAll', k);
        const e = live(k);
        if (e) out[k] = e.value;
      }
      return out;
    },
    put(key, value, ttl) {
      checkKey(key); checkValue(value); checkTtl(ttl); op('put', key);
      store.set(key, { value, expiresAt: clock.now() + ttl * 1000 });
    },
    putAll(values, ttl) {
      checkTtl(ttl);
      const keys = Object.keys(values);
      for (const k of keys) { checkKey(k); checkValue(values[k]); }   // 전부 검사한 뒤에만 기록 (원자적)
      op('putAll', keys.join(','));
      for (const k of keys) store.set(k, { value: values[k], expiresAt: clock.now() + ttl * 1000 });
    },
    remove(key) {
      checkKey(key); op('remove', key);
      store.delete(key);
    },
    removeAll(keys) {
      for (const k of keys) { checkKey(k); op('removeAll', k); store.delete(k); }
    },
  };

  helpers.raw = key => { const e = live(key); return e ? e.value : null; };
  helpers.keys = () => [...store.keys()].filter(k => live(k)).sort();
  return { impl: cache, helpers };
}

function makeLockService() {
  let held = false;
  const state = { waits: [], spuriousReleases: 0 };
  const lock = {
    waitLock(ms) {
      state.waits.push(ms);
      if (held) throw new Error('Timed out waiting for lock');
      held = true;
    },
    tryLock(ms) {
      state.waits.push(ms);
      if (held) return false;
      held = true;
      return true;
    },
    releaseLock() {
      if (held) held = false;
      else state.spuriousReleases++;   // 잡지 않은 잠금을 푼 횟수 (0이어야 정상)
    },
    hasLock() { return held; },
  };
  return {
    impl: { getScriptLock: () => lock },
    helpers: {
      waits: state.waits,
      get spuriousReleases() { return state.spuriousReleases; },
      isHeld: () => held,
      force(v) { held = !!v; },   // 다른 실행이 잠금을 쥐고 있는 상황을 흉내
    },
  };
}

function makeUrlFetchApp(state) {
  return {
    fetch(url, params) {
      const p = params || {};
      const u = String(url);
      state.calls.push({ url: u, params: p });
      const r = state.responder(u, p);          // 던지면 네트워크 예외
      const res = typeof r === 'string' ? { code: 200, body: r } : r;
      if (res.code >= 400 && !p.muteHttpExceptions) {
        throw new Error('Request failed for ' + u + ' returned code ' + res.code);
      }
      return {
        getResponseCode: () => res.code,
        getContentText: () => res.body,
      };
    },
  };
}

const XFRAME_MODES = Object.freeze({ DEFAULT: 'DEFAULT', ALLOWALL: 'ALLOWALL', SAMEORIGIN: 'SAMEORIGIN' });

class FakeHtmlOutput {
  constructor(html) {
    this.content = html;
    this.title = null;
    this.metas = [];
    this.xframe = null;
  }
  setTitle(t) { this.title = String(t); return this; }
  addMetaTag(name, content) { this.metas.push({ name: String(name), content: String(content) }); return this; }
  setXFrameOptionsMode(mode) {
    if (!Object.values(XFRAME_MODES).includes(mode)) throw new TypeError('Invalid XFrameOptionsMode');
    this.xframe = mode;
    return this;
  }
}

const HtmlService = {
  createHtmlOutput(html) { return new FakeHtmlOutput(String(html)); },
  XFrameOptionsMode: XFRAME_MODES,
};

function load(opts = {}) {
  const clock = makeClock(typeof opts.now === 'number' ? opts.now : DEFAULT_NOW);
  const cacheFake = makeCacheService(clock);
  const lockFake = makeLockService();
  const fetchState = {
    calls: [],
    responder: opts.fetch || (() => ({ code: 404, body: 'Not Found' })),
  };

  const sandbox = {
    CacheService: { getScriptCache: () => cacheFake.impl },
    LockService: { getScriptLock: lockFake.impl.getScriptLock },
    UrlFetchApp: makeUrlFetchApp(fetchState),
    HtmlService,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext('Date', context).now = () => clock.now();

  const source = fs.readFileSync(CODE_GS, 'utf8');
  vm.runInContext(source, context, { filename: 'Code.gs' });

  const run = expr => vm.runInContext(expr, context);
  const gas = {};
  for (const name of GAS_FUNCTIONS) {
    const fn = run(name);
    gas[name] = name === 'doGet'
      ? (e) => fn(e)                                         // HtmlOutput 객체를 그대로 돌려줌
      : (...args) => JSON.parse(JSON.stringify(fn(...args)));  // google.script.run 직렬화 흉내
  }

  return {
    gas,
    run,
    clock,
    setFetch(fn) { fetchState.responder = fn; },
    setRandom(fn) { run('Math').random = fn; },
    fakes: {
      CacheService: cacheFake.helpers,
      LockService: lockFake.helpers,
      UrlFetchApp: fetchState,
      HtmlService,
    },
  };
}

module.exports = { load, FakeHtmlOutput };
