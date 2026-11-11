/* 업로드용 단일 파일 서버 만들기: dist/server.js (+ dist/package.json)
   폰/아이패드에서 GitHub에 파일 2개만 올리면 되도록 모든 모듈·페이지·맵을 한 파일에 넣는다. */
const fs = require('fs'), path = require('path');
const R = (...p) => path.join(__dirname, '..', ...p);
require('./build.js').build();
const mods = {
  'shared/core.js': fs.readFileSync(R('shared/core.js'), 'utf8'),
  'shared/protocol.js': fs.readFileSync(R('shared/protocol.js'), 'utf8'),
  'server/ws.js': fs.readFileSync(R('server/ws.js'), 'utf8'),
  'server/room.js': fs.readFileSync(R('server/room.js'), 'utf8'),
  'server/server.js': fs.readFileSync(R('server/server.js'), 'utf8'),
};
let srv = mods['server/server.js'];
const swap = (a, b) => { if (!srv.includes(a)) throw new Error('bundle: 못 찾음 ' + a); srv = srv.replace(a, b); };
swap("Core.setMap(JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'walk_rle.json'), 'utf8')));", 'Core.setMap(__EMBED.walk);');
swap('fs.readFile(PAGE, (err, buf) => {', '((cb) => cb(null, __EMBED.page))((err, buf) => {');
swap('if (opts.build !== false) runBuild();', '');
mods['server/server.js'] = srv;
const resolveId = (from, req) => path.posix.normalize(path.posix.join(path.posix.dirname(from), req));
let out = '#!/usr/bin/env node\n/* 1v1 온라인 서버 (단일 파일 번들, tools/bundle.js로 생성) — 실행: node server.js */\n"use strict";\n';
out += 'const __EMBED = { walk: ' + fs.readFileSync(R('shared/walk_rle.json'), 'utf8').trim() + ', page: ' + JSON.stringify(fs.readFileSync(R('public/index.html'), 'utf8')) + ' };\n';
out += 'const __M = {}, __C = {};\nfunction __req(id) { if (__C[id]) return __C[id].exports; const m = __C[id] = { exports: {} }; __M[id](m, m.exports); return m.exports; }\n';
for (const [id, src] of Object.entries(mods)) {
  const body = src.replace(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g, (_, q, r) => `__req(${JSON.stringify(resolveId(id, r))})`);
  out += `__M[${JSON.stringify(id)}] = function (module, exports) {\nconst require = (n) => (typeof n === 'string' && n.startsWith('__')) ? null : globalThis.__nodeRequire(n);\n${body}\n};\n`;
}
out += 'globalThis.__nodeRequire = require;\n';
out += 'const __s = __req("server/server.js");\nif (require.main === module) __s.start({ port: Number(process.env.PORT) || 8080, host: "0.0.0.0" }).then(s => console.log("1v1 서버 실행 중 · 포트 " + s.port));\n';
fs.mkdirSync(R('dist'), { recursive: true });
fs.writeFileSync(R('dist/server.js'), out);
fs.writeFileSync(R('dist/package.json'), JSON.stringify({ name: 'lol1v1-online', private: true, engines: { node: '>=18' }, scripts: { start: 'node server.js' } }, null, 2) + '\n');
console.log('dist/server.js', (out.length / 1024).toFixed(1) + ' KB');
