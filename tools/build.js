'use strict';
/* 클라이언트를 public/index.html 한 파일로 묶는다.
   - client/client.template.html 의 __ASSETS_JSON__ → 자산 JSON(이미지는 data URI, 이동 영역은 RLE 배열)
   - client/client.template.html 의 __SCRIPTS__ → 스크립트 블록들(순서 고정)
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
  'client/net.js',
  'client/session_local.js',
  'client/session_online.js',
  'client/client.js',
  'client/lobby.js',
];

function build() {
  const tpl = read('client/client.template.html');
  const assets = {
    map: dataUri('assets/map.jpg', 'image/jpeg'),
    darius: dataUri('assets/darius.png', 'image/png'),
    yi: dataUri('assets/yi.png', 'image/png'),
    walk: JSON.parse(read('shared/walk_rle.json')),
  };
  const assetsJson = safeScript(JSON.stringify(assets));
  const scripts = SCRIPTS.map(p => `<script>\n${safeScript(read(p))}\n</script>`).join('\n');
  const body = tpl.replace('__ASSETS_JSON__', () => assetsJson).replace('__SCRIPTS__', () => scripts);
  // 서버가 직접 내려주는 페이지: 문서 골격 + 모바일 화면 설정(viewport) + 기본 초기화
  const head = '<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">\n' +
    '<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="mobile-web-app-capable" content="yes">\n' +
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n' +
    '<style>html,body{margin:0;height:100%;background:#0a1017;-webkit-text-size-adjust:100%}img{max-width:100%}[hidden]{display:none!important}</style>\n</head>\n<body>\n';
  const html = /^\s*<!doctype/i.test(body) ? body : head + body + '\n</body>\n</html>\n';

  const out = abs('public/index.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`built ${out} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
  return out;
}

module.exports = { build };

if (require.main === module) build();
