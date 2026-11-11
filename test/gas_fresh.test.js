'use strict';
/* gas/game.html 이 현재 코드로 다시 만든 결과와 같은지(커밋 전에 node tools/build.js 를 잊지 않게) */
const fs = require('fs'), path = require('path');
const { render } = require('../tools/build.js');
const committed = fs.readFileSync(path.join(__dirname, '..', 'gas', 'game.html'), 'utf8');
if (render({ viewport: false }) !== committed) { console.error('gas/game.html 이 오래됐어요 → node tools/build.js 실행 후 커밋'); process.exit(1); }
console.log('1 passed, 0 failed  (gas/game.html 최신)');
