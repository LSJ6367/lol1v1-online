'use strict';
/* 클라이언트를 public/index.html 한 파일로 묶는다.
   - client/client.template.html 의 __ASSETS_JSON__ → 자산 JSON(이미지는 data URI, 이동 영역은 RLE 배열)
   - client/client.template.html 의 __SCRIPTS__ → 스크립트 블록들(순서 고정)
   - render({viewport}) 는 문자열만 돌려준다. viewport:false 는 구글 스크립트 페이지용(tools/build_gas.js)
   실행: node tools/build.js   (require 해서 build()를 호출해도 됨) */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const abs = p => path.join(ROOT, p);
const read = p => fs.readFileSync(abs(p), 'utf8');
const dataUri = (p, mime) => `data:${mime};base64,${fs.readFileSync(abs(p)).toString('base64')}`;
const safeScript = s => s.replace(/<\/script/gi, '<\\/script');

const SCRIPTS = [
  'shared/core.js',
  'shared/protocol.js',
  'server/room.js',
  'server/hub.js',
  'client/net.js',
  'client/p2p.js',
  'client/session_local.js',
  'client/session_online.js',
  'client/client.js',
  'client/lobby.js',
];
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">\n';

function render(opts) {
  opts = opts || {};
  const tpl = read('client/client.template.html');
  const assets = {
    map: dataUri('assets/map.jpg', 'image/jpeg'),
    darius: dataUri('assets/darius.png', 'image/png'),
    yi: dataUri('assets/yi.png', 'image/png'),
    garen: dataUri('assets/garen.png', 'image/png'),
    aatrox: dataUri('assets/aatrox.png', 'image/png'),
    aatrox_r: dataUri('assets/aatrox_r.png', 'image/png'),   // 세계의 종결자 중 모습(DESIGN_AATROX §3)
    walk: JSON.parse(read('shared/walk_rle.json')),
  };
  const assetsJson = safeScript(JSON.stringify(assets));
  const scripts = SCRIPTS.map(p => `<script>\n${safeScript(read(p))}\n</script>`).join('\n');
  // 버전 번호: 코드·화면·자산 내용으로 만든 6글자. 내용이 바뀌면 번호도 바뀐다(같은 내용이면 언제 빌드해도 같음)
  const buildId = require('crypto').createHash('sha1').update(tpl).update(scripts).update(assetsJson).digest('hex').slice(0, 6).toUpperCase();
  const body = tpl.replace('__ASSETS_JSON__', () => assetsJson).replace('__SCRIPTS__', () => scripts).replace('__BUILD__', buildId);
  // 문서 골격 + 모바일 화면 설정(viewport, 구글 스크립트 페이지는 Apps Script 가 addMetaTag 로 넣으므로 뺀다) + 기본 초기화
  const head = '<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n' +
    (opts.viewport === false ? '' : VIEWPORT) +
    '<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="mobile-web-app-capable" content="yes">\n' +
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n' +
    '<style>html,body{margin:0;height:100%;background:#0a1017;-webkit-text-size-adjust:100%}img{max-width:100%}[hidden]{display:none!important}</style>\n</head>\n<body>\n';
  return /^\s*<!doctype/i.test(body) ? body : head + body + '\n</body>\n</html>\n';
}

function build() {
  const html = render({ viewport: true });
  const out = abs('public/index.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`built ${out} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
  return out;
}

function buildId() { return (render().match(/버전 <b>([0-9A-F]{6})<\/b>/) || [])[1]; }

module.exports = { build, render, buildId, SCRIPTS };

if (require.main === module) { build(); require('./build_gas.js').build(); console.log('버전 ' + buildId()); }   // 구글 스크립트용 gas/game.html 도 같이
