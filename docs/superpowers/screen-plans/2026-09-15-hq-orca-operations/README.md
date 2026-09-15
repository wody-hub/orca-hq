# HQ / Orca Operations — 화면기획 시안

단일 파일 HTML 시안입니다. **모든 데이터는 시뮬레이션**이며 실제 HQ/Orca 요청을 보내지 않습니다.
근거는 [`research.md`](./research.md) (동일 디렉터리)만 사용했습니다.

## 여는 방법

```sh
open "docs/superpowers/screen-plans/2026-09-15-hq-orca-operations/index.html"
```

또는 파일을 파인더/탐색기에서 더블클릭해 기본 브라우저로 엽니다. `file://`로 직접 열리며
외부 네트워크·CDN·서버가 필요 없습니다 (인라인 CSS/JS/SVG, 시스템 폰트만 사용).

## 파일 구성

| 파일 | 설명 |
|---|---|
| `index.html` | 화면기획 시안 본체 (8개 화면, 해시 라우팅 SPA) |
| `research.md` | 원본 리서치 (변경 없음) |
| `screenshots/overview.png` | 운영 개요 화면, 데스크톱 1440px |
| `screenshots/detail.png` | 업무 상세 화면 (liveness vs PTY 구분 포함), 데스크톱 1440px |

## 화면 8개

1. 운영 개요 — HQ/Orca 분리 요약, 관심함, 최신 활동, 예시 10슬롯 용량
2. 업무 목록 — HQ/Orca 탭, 검색+상태 필터, 행 클릭 시 상세 진입
3. 새 지시 — HQ 업무 요청 vs Orca 직접 실행(브리지 설계) 모드, 검토→제출, CLI 읽기 전용 미리보기
4. 질문함 — HQ clarification / Orca 질문 메시지, 답변 후에도 pending 유지
5. 업무 상세 — 개요/타임라인/로그 탭, 정지 확인 모달, 정산 후에만 해제 가능
6. 프로젝트/터미널 — project→worktree→terminal 계층, "열기"는 브리지 부재 알림만
7. 운영 설정 — 용량 read-only, 비용/토큰 "수집되지 않음"
8. 리서치·기획 — 결론, 외부 근거 7건, 대안 3안, capability matrix, 구현 순서

## 테스트한 상호작용 (Playwright, 로컬 `python -m http.server`로 QA 후 정리)

- 사이드바 라우팅 (해시 변경 시 8개 화면 전환)
- 업무 목록: HQ/Orca 탭 전환, 검색어 입력, 상태 필터 select
- 행 클릭 → 업무 상세 진입, 개요/타임라인/로그 탭 전환
- 정지 요청 확인 모달 열기/Escape로 닫기/확인 시 상태 갱신 및 해제 버튼 활성화 전환
- 새 지시: 모드 전환(HQ↔Orca), 8,000자 카운터, 검토 단계, 제출 → "queued" 접수 receipt 생성(완료 아님) → 업무 목록에 신규 행 반영
- 질문함 답변 전송 (상태 전이, pending 유지 문구 확인)
- 프로젝트/터미널 "열기" → 시뮬레이션 토스트만 발생 확인
- 운영 설정 용량 선택 → "제안됨(미적용, 데모)" 문구 노출 확인
- 시나리오 선택자(정상/연결 끊김/불확실/데이터 없음)로 전체 화면 상태 전환 확인
- 데스크톱 1440px, 랩톱 1280px, 모바일 390px에서 `document.body.scrollWidth`로 가로 스크롤 없음 확인 (표/코드 블록만 자체 컨테이너에서 스크롤)
- 모바일 390px에서 사이드바 내비게이션이 줄바꿈되어 전체 노출되는지 확인 (최초 구현은 가로 스크롤에 숨어 있어 CSS 수정함)
- 콘솔 에러 확인: `favicon.ico` 404 1건만 있음 (기능에 영향 없음)

## 후속 수정 (2026-09-15)

- liveness 사실값 정정: Orca 원본은 `projection.liveness.verdict`와 `observation.status`를 각각 `live|exited|unverifiable` enum으로 표시합니다. 화면의 연결됨/종료됨/판정 불가 라벨은 이 원본 필드를 바탕으로 한 사용자 표현이며, 내부 `state:"stopped"` 결과 상태와 혼동하지 않습니다.
- 정지·해제 안전성 정정: 두 liveness 값이 모두 `live`일 때만 정지 요청을 열 수 있고, `unverifiable`/비-live 상태는 버튼과 핸들러 모두 차단하며 최신 상태 확인을 안내합니다. 성공한 정지 데모는 두 원본 값을 `exited`로 갱신하고 정지 접수와 별도의 synthetic stop+settlement receipt를 남긴 뒤 해제를 활성화합니다.

- CLI 근거 표기 정정: 공개 fleet verdict 값은 `projection.liveness.verdict=live`이며 `running`이 아닙니다. 카드에는 사용자용 라벨("실행 중")을 표시하고, 정확한 원본 값은 각 상세 화면의 "기획 해설" 접힘 블록에 `projection.liveness.verdict=live` 형태로 노출합니다.
- HQ 용량 수치 정정: 운영 개요와 운영 설정의 "HQ 용량"/점유 수치는 하드코딩 대신 데모 fixture에서 `source==="hq"`인 항목만 집계(`active`/`unknown`)해 계산합니다. Orca 외부 run/dispatch는 이 집계에서 명시적으로 제외됩니다.

## 확인 도구와 한계

- **사용 도구**: Playwright MCP(`mcp__plugin_playwright_playwright__*`, 로컬에 이미 연결된 도구, 별도 설치 없음).
- **한계**: 이 플러그인의 브라우저 샌드박스가 `file://` 프로토콜 접속을 차단해서, QA 동안에만 `python3 -m http.server`로 같은 디렉터리를 `127.0.0.1`에 임시로 서빙해 확인했습니다(퍼블리싱/호스팅 아님, QA 종료 후 서버 프로세스 종료함). 결과물 자체는 `file://`로 정상 동작하도록 외부 리소스 없이 작성되어 있습니다.
- 전체 제품 테스트는 실행하지 않았습니다 (요청 범위 밖).
