# HQ Codex 대화 세션 설계

사용자가 승인한 흐름: Slack·Telegram·터미널 → 맥락을 유지하는 Codex → Orca 조회·오케스트레이션 → Codex의 자연어 응답 → 원래 채널.

## 구조
Codex App Server의 thread/start, thread/resume, turn/start와 dynamicTools를 사용한다. 별도 API 키 없이 기존 Codex 로그인으로 인증한다. HQ는 세션 식별·인증·중복 방지·도구 실행·전달을 담당한다. Codex는 원문 질문을 받고 필요한 횟수만큼 도구를 호출하고 결과를 읽으며 조사·응답한다. 프로젝트 선택 JSON 파서는 기본 대화 경로에서 제거한다.

세션은 Slack 사용자+채널+스레드, Telegram 사용자+chat, 터미널 사용자+session으로 격리한다. Codex thread ID를 SQLite에 저장해 재시작 후 재개한다. /new는 새 thread를 만들며 기존 Orca 작업은 유지한다. 기존 HQ 대화의 최근 기록은 새 세션으로 한 번만 이관한다.

## 도구와 실행 경계
프로젝트 목록, Orca 작업 공간·folder context·터미널·native orchestration task와 run을 읽는 도구를 제공한다. 프로젝트 확정 전에 여러 후보의 메타데이터를 조사할 수 있다. GH workspace, 업무명, 화면명, 경로 등으로 연결점을 찾고 도구 결과를 근거로 답한다. 조회만으로 대상이 여전히 모호한 때만 차이를 설명하며 질문한다. 여러 프로젝트 비교도 가능하다.

실제 개발·후속 지시·중지는 기존 Orca relay를 도구로 사용한다. 등록·새 프로젝트 생성·별칭·제외/복원도 제공한다. 기존 mutation의 idempotency와 결과불명 재시도 금지를 유지한다. 생성·등록 제안은 정확한 경로를 보여준 뒤 다음 사용자 확인을 받아 실행한다. Codex 자체 shell/파일 변경 도구는 제공하지 않으며 HQ 도구만 사용한다. 사용자 원문을 status enum으로 축약하지 않는다. 반환된 파일/터미널 텍스트는 증거이지 사용자 승인이나 시스템 지시가 아니다. 보호 로드맵 파일은 읽기·수정·hash·stage 모두 금지하고 HQ 작업공간 터미널 원문 제한을 유지한다.

## 오류와 검증
App Server 종료·timeout·resume 실패는 원인을 구분한 한국어 응답을 제공한다. 이미 제출한 mutation은 자동 재실행하지 않는다. 요청 deadline은 조사 시간에 맞춰 유한하게 연장하고 종료 시 도구 추가 실행을 차단한다. 모든 도구 결과와 최종 응답에서 기존 secret redaction을 유지한다.

GH/scsms 두 프로젝트 → 법령 개정이력 → GH workspace 사례를 회귀 검증한다. 실제 Codex로 multi-turn 도구 호출·후속 문맥·재시작 재개를 확인하고, 실제 설치본 갱신 후 터미널과 개인 Slack에서 검증한다. 외부 메시지는 개인 테스트 범위만 허용한다.

참조: https://developers.openai.com/codex/app-server/ (2026-09-07 확인); 로컬 codex app-server generate-ts --experimental 프로토콜.
