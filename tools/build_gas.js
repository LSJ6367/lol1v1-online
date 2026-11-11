'use strict';
/* 구글 스크립트(Apps Script)가 받아 내려주는 게임 페이지 gas/game.html 을 만든다.
   public/index.html 과 같은 내용이지만 viewport 메타 태그는 뺀다(Code.gs 가 addMetaTag 로 넣는다).
   결과물은 저장소에 커밋한다(Code.gs 가 GitHub raw 에서 받아감). 실행: node tools/build_gas.js */
const fs = require('fs');
const path = require('path');
const { render } = require('./build.js');

const ROOT = path.join(__dirname, '..');

function build() {
  const html = render({ viewport: false });
  const out = path.join(ROOT, 'gas', 'game.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`built ${out} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
  return out;
}

module.exports = { build };

if (require.main === module) build();
