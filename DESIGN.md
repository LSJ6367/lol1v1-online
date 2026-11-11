# 1v1 온라인 설계 (v1)

## 0. 결론 요약
- **권위 서버**: 게임 규칙(`shared/core.js`)은 서버에서만 "정답"으로 돈다. 60틱/초.
- **입력은 틱 단위 프레임**: 클라이언트는 1/60초마다 입력 프레임 1개(seq)를 보내고, 서버는 1틱에 프레임 1개를 적용한다.
- **스냅샷 20회/초**: 서버는 3틱마다 월드 전체(약 1.8KB)와 ack(반영된 마지막 seq)를 보낸다.
- **내 챔피언 = 예측**, **상대 = 100ms 보간**: 스냅샷 + (ack 이후 프레임) 재시뮬로 내 화면은 즉시 반응, 상대는 부드럽게.
- **의존성 0**: Node 18+ 표준 모듈만 사용(WebSocket 서버 직접 구현). `node server/server.js` 하나로 페이지 + 게임 서버.
- **같은 페이지로 오프라인도 가능**: 서버에 연결 못 하면 "혼자 연습(오프라인)"으로 기존 LocalSession 실행.

> 아티팩트(claude.ai 페이지)는 외부 WebSocket 연결이 막혀 있으므로, 온라인 대전은 이 서버가 직접 페이지를 내려줘야 한다.

## 1. 폴더 구조
```
online/
  shared/core.js        게임 규칙 (수정 금지 영역 — 바꾸면 서버·클라 동시 반영)
  shared/protocol.js    통신 계약(메시지 형식, 프레임 정규화, 스냅샷 복사, 승리 조건 상수)
  shared/walk_rle.json  이동 가능 영역
  server/ws.js          최소 WebSocket(RFC 6455) 구현
  server/room.js        방 1개 = 로비 상태 + 게임 루프 + 승패 판정
  server/server.js      HTTP(페이지 제공) + /ws 업그레이드 + 방 관리 + 전역 틱 루프
  client/client.template.html  화면 마크업/CSS (자산·스크립트 자리표시자 포함)
  client/net.js         WebSocket 래퍼(재시도 없음, ping/rtt)
  client/session_local.js   LocalSession (오프라인: 브라우저 안에서 core 실행)
  client/session_online.js  OnlineSession (예측 + 보간)
  client/client.js      화면·입력·HUD (세션 종류를 모름. 세션 인터페이스만 사용)
  client/lobby.js       로비/방/결과 화면 흐름
  tools/build.js        public/index.html 한 파일로 묶기 (자산 base64 인라인)
  test/*.test.js        core / protocol / server / session_online 테스트
```

## 2. 세션 인터페이스 (client.js는 이것만 안다)
```
session.myId            내 챔피언 id
session.world           현재 그릴 월드 (core 월드 형식)
session.send(cmd)       core 명령 형식 {type:'input'|'cast'|'levelup'|'dev', ...}
session.update(dt)      매 프레임 호출(실제 경과 초)
session.drainEvents()   화면용 이벤트 배열(text/fx/banner)
session.me()            내 챔피언 객체
session.pos(u)          유닛 u를 그릴 위치 [x, y] (보간/예측 반영)
session.online          true/false
session.test            테스트 도구 허용 여부 (오프라인은 true)
session.ping            (온라인) 왕복 지연 ms, 오프라인은 null
```

## 3. 틱·프레임·스냅샷 규칙
- 서버: 플레이어별 프레임 큐. 매 틱 하나 꺼내 `frameToCmds` → 모든 플레이어 명령을 모아 `Core.step` 1회.
  - 큐가 비면 적용 없이 step(이동 입력은 core가 유지). ack 그대로.
  - 큐 길이 > `MAX_QUEUE`(10) → 가장 오래된 것 버리고 그 acts는 다음 프레임에 합침(`mergeDropped`).
  - seq가 이미 받은 것 이하이면 무시. 초당 `MAX_FRAMES_PER_SEC` 초과분 무시.
- 서버: `tick % SNAP_EVERY === 0`이면 스냅샷. 월드 JSON은 한 번만 문자열로 만들고 플레이어마다 ack/ev만 다르게.
- 클라(예측 ON):
  1. 매 로컬 틱: 프레임 생성(seq+1, 현재 이동/평타 상태 + 쌓인 acts) → `sanitizeFrame` → 전송 → `pending`에 저장 → 예측 월드에 `frameToCmds` 적용 + `Core.step` 1회 → 예측 월드 이벤트는 버림.
  2. 스냅샷 수신: `pending`에서 seq ≤ ack 제거 → 예측 월드 = 스냅샷 복제 → 남은 pending 순서대로 재시뮬 → 내 위치 차이를 시각 오프셋으로 흡수(40px 미만이면 서서히 0으로, 이상이면 즉시 순간이동).
  3. 화면 이벤트(데미지 숫자 등)는 **서버 스냅샷의 ev만** 사용.
- 클라(보간): 스냅샷 버퍼(최근 1초). 그리는 시점 = 추정 서버 틱 − `INTERP_TICKS`(6틱=100ms). 앞뒤 스냅샷 사이 선형 보간(두 점 거리 80px 초과면 보간 없이 뒤 값).
- 서버 틱 추정: 스냅샷마다 `sample = snap.tick − 로컬경과틱`, `offset += (sample − offset)·0.1`, 차이 30틱 넘으면 즉시 맞춤.

## 4. 방·로비 흐름
```
접속 → hello → welcome(pid)
로비: [방 만들기] [테스트 방 만들기] [코드로 참가 ____] [혼자 연습(오프라인)]
방(state=select): 방 코드 크게 표시, 참가자 목록, 챔피언 카드, [준비] [나가기]
  - 첫 입장 = 팀 0(파랑, 왼쪽 아래), 두 번째 = 팀 1(빨강, 오른쪽 위). 최대 2명.
  - 준비 상태에서는 챔피언 변경 불가.
  - 시작 조건: 방에 있는 모두 준비 && (2명 || 테스트 방)
  - countdown 3초(1초마다 room 메시지) → start
playing: 프레임/스냅샷
승리: 처치 1회 또는 상대 포탑 파괴 (protocol.WIN) → end → 방은 select로 돌아가고 준비 해제 → 결과 화면에서 [다시 하기]/[나가기]
연결 끊김: 게임 중이면 남은 쪽 승리(reason 'disconnect'). 방이 비면 삭제.
테스트 방: 허수아비 + 테스트 도구(dev acts 허용) + core 배너 표시. 일반 방: 허수아비 없음, 테스트 도구 숨김.
```

## 5. 보안·안정성 최소선
- 모든 입력은 `sanitizeFrame`으로 정규화(방향 길이 ≤1, 스킬 이름 화이트리스트, dev는 테스트 방만).
- 메시지 64KB 초과·잘못된 JSON → 무시(반복 시 연결 종료 가능).
- 서버 heartbeat: 15초마다 ping, 30초 무응답이면 종료.

## 6. 다음 단계(이번 범위 밖)
- 재접속 유예(RECONNECT_SEC), 관전, 매치메이킹 대기열, 스냅샷 델타 압축, 서버 배포 자동화.
