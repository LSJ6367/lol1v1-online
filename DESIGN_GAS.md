# 구글 스크립트(Apps Script) + P2P 버전 설계

## 0. 요약
- Apps Script는 실시간 서버를 못 돌린다(연결 유지 불가, 호출당 0.3~1초). 그래서 역할을 둘로 나눈다.
  - **Apps Script**: 게임 페이지 제공 + 방 코드로 두 기기를 소개(WebRTC 신호 교환). 게임 중에는 쓰지 않는다.
  - **방장 브라우저 = 서버**: 지금 Node 서버가 하던 일(방, 60틱 루프, 승패)을 방장 기기 안에서 돌린다.
    참가자는 WebRTC DataChannel로 방장에게 직접 연결한다. 같은 와이파이면 핑 5~20ms.
- 게임 화면·로비·OnlineSession(예측/보간)은 **그대로** 쓴다. 바뀌는 것은 "Net" 한 층뿐이다.
  - WebSocket 버전: `Net` (client/net.js) → Node 서버
  - 구글 스크립트 버전: `P2PNet` (client/p2p.js) → (방장) 브라우저 안 Hub / (참가자) DataChannel → 방장 Hub
- 사용자는 Apps Script에 **Code.gs 한 파일만** 붙여 넣는다. Code.gs가 GitHub(raw)에서 `gas/game.html`을 받아와 내려준다.
  그래서 GitHub에 올리면 구글 스크립트 버전도 자동으로 최신이 된다(raw 캐시 최대 5분).

## 1. 파일
```
server/hub.js        (신규, UMD) 연결·방 관리 로직. server.js에서 꺼낸 것. Node 서버와 방장 브라우저가 같이 씀
server/room.js       (UMD로 변경) 브라우저에서도 window.Room
server/server.js     hub.js를 쓰도록 정리(동작 동일, 기존 테스트 그대로 통과)
client/p2p.js        (신규) P2PNet: Net과 같은 API. 방장 모드 / 참가자 모드
client/lobby.js      구글 스크립트 환경이면 Net 대신 P2PNet 사용 + 안내 문구
tools/build_gas.js   (신규) gas/game.html 생성 (스크립트 목록에 room.js, hub.js, p2p.js 추가)
gas/Code.gs          (신규) Apps Script 서버 코드: doGet + 신호 교환 함수
gas/game.html        (생성물, 저장소에 커밋) Code.gs가 raw.githubusercontent.com에서 받아감
```

## 2. Hub (server/hub.js) 계약
```
const hub = new Hub({ countdownSec, codeFn })      // codeFn(): 새 방 코드 생성(기본 Protocol.makeRoomCode)
const sess = hub.connect(conn)                      // conn = { send(string), close() }  → 세션 객체
hub.message(sess, text)                             // 받은 문자열 1개 처리 (hello/create/join/leave/pick/ready/f/ping)
hub.disconnect(sess)                                // 연결 끊김 처리
hub.update(dt)                                      // 실제 경과 초: 카운트다운 + 고정 60틱(따라잡기 최대 5틱) — server.js의 루프 본문
hub.rooms                                           // Map(code → Room)
옵션: create 메시지에 code 필드가 있으면 그 코드로 방을 만든다(방장 브라우저가 Apps Script에서 받은 코드를 쓰려고). 이미 있으면 'bad_state'.
```
server.js는 HTTP + ws.attach + `setTimeout` 루프에서 `hub.update(dt)`만 호출한다.

## 3. P2PNet (client/p2p.js) 계약 — Net과 같은 겉모습
```
P2PNet.connect(name) → Promise   (즉시 성공. 이름만 저장. 아직 방장/참가자 아님)
P2PNet.send(obj)
  - {t:'create', test}  → 방장 모드 시작: Signal.create()로 코드 받기 → 브라우저 안 Hub 생성(루프 시작)
                          → 내 연결 = 메모리 루프백 conn(비동기 전달) → hello → create{test, code} 를 Hub에 전달
                          → 손님 기다리기(Signal 폴링, 아래 §4)
  - {t:'join', code}    → 참가자 모드: WebRTC 연결(§4) → DataChannel 열리면 hello → join{code} 전송
  - 그 외               → 현재 연결(루프백 또는 DataChannel)로 그대로 전달
P2PNet.on(type, fn) / onClose(fn) / close() / pid / rtt / open   — Net과 동일 의미
```
- 방장 Hub 루프: `setInterval(…, 4)`로 실제 경과 시간을 `hub.update(dt)`에 넘김.
- 방장 쪽에서 DataChannel이 열리면 `hub.connect(dcConn)` 하고, 이후 받은 문자열은 `hub.message`, 닫히면 `hub.disconnect`.
- 방장이 나가기/페이지 닫기 → DataChannel 닫힘 → 참가자는 onClose("방장과 연결이 끊겼어요").
- DataChannel: `{ ordered: true }` (신뢰성 있음). 이름 'game'.
- RTCPeerConnection 설정: `{ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }`.
- ICE는 트리클 없이: ICE 수집이 'complete'가 되거나 3초가 지나면 그때의 `localDescription.sdp`를 한 번에 보낸다.

## 4. 신호 교환 (Apps Script 함수, google.script.run으로 호출)
모든 함수는 JSON으로 바꿀 수 있는 객체를 돌려준다. 저장은 CacheService(스크립트 캐시, 600초), 동시 수정은 LockService.
```
sigCreate()                 → {code}                         새 방(4글자, Protocol.ROOM_CODE_CHARS). 상태 'waiting'
sigJoin(code, offerSdp)     → {ok:true} | {error:'room_not_found'|'room_full'}   'waiting'일 때만 성공 → 'offered'
sigHostPoll(code)           → {offer: string|null} | {error}  방장이 1초마다 호출
sigAnswer(code, answerSdp)  → {ok:true} | {error}             'offered' → 'answered'
sigGuestPoll(code)          → {answer: string|null} | {error} 참가자가 1초마다 호출
sigClose(code)              → {ok:true}                        연결 성공 후 또는 방장이 방을 닫을 때 삭제
```
흐름: 방장 sigCreate → (참가자) offer 만들기 → sigJoin → 방장 sigHostPoll로 offer 받음 → answer 만들기 → sigAnswer
→ 참가자 sigGuestPoll로 answer 받음 → DataChannel 열림 → 방장 sigClose.
- 클라이언트 쪽 호출 래퍼: `Signal.call(name, ...args) → Promise` (google.script.run.withSuccessHandler/withFailureHandler).
- 연결 제한 시간: 참가자 20초 안에 DataChannel이 안 열리면 실패 → "직접 연결에 실패했어요. 같은 와이파이인지 확인하거나, 학교 와이파이가 기기 간 연결을 막고 있을 수 있어요".

## 5. Code.gs
```
const GAME_URL = 'https://raw.githubusercontent.com/LSJ6367/lol1v1-online/main/gas/game.html';
doGet(): game.html 받아오기(UrlFetchApp, 스크립트 캐시에 90KB 조각으로 300초 보관) →
         HtmlService.createHtmlOutput(html).setTitle('1대1 대전')
           .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover')
           .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
         받아오기 실패 시 간단한 오류 페이지.
+ §4의 sig* 함수들.
```

## 6. 범위 밖 / 주의
- 방장 기기 화면이 꺼지거나 앱을 내리면 게임이 멈춘다(브라우저가 타이머를 멈춤).
- 방장 핑 0, 참가자만 지연 → 방장이 약간 유리.
- 모바일 데이터(LTE/5G)끼리는 직접 연결이 실패할 수 있다(중계 서버 없음).
