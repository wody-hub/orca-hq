# Task 1 관측성 기반 구현 보고서

## 구현 결과

`packages/observability`에 Pino 기반의 redacted logger, 깊은 구조 redaction, 로컬 pilot counter, 그리고 검토 가능한 진단 manifest staging API를 추가했다. 진단 API는 `version`, `capabilities`, `schema`, redacted health, aggregate counter, 사용자가 선택한 audit reference, `manifest.json`만 임시 staging 디렉터리에 기록하고 `stagingPath`와 manifest를 반환한다. archive 또는 upload/telemetry 메서드는 제공하지 않아, 후속 CLI가 이 정보를 먼저 표시하고 별도 명시적 확인을 받도록 경계가 유지된다.

## TDD 기록

### RED

명령:

```sh
pnpm test packages/observability/test/redaction.test.ts
```

핵심 출력: 새 모듈이 없을 때 8개 테스트가 모두 실패했고, `redactDeep` 결과는 `undefined`, diagnostics bundle은 `undefined`, logger destination은 빈 문자열이었다. 이어 local counter 동작을 위한 테스트를 추가한 뒤 구현을 제거한 상태에서 같은 명령을 실행하여 `expected undefined to deeply equal { commandsProcessed: 3 }` 실패를 확인했다.

### GREEN 및 검증

명령:

```sh
pnpm test packages/observability/test/redaction.test.ts
pnpm --filter @orca-hq/observability typecheck
pnpm typecheck
pnpm test
```

핵심 출력: focused test 1 파일 9 테스트 통과, 패키지 및 루트 typecheck 통과, 전체 Vitest 31 파일 540 테스트 통과. Pino의 `redact.paths`가 변경 가능한 배열을 요구해 처음 typecheck가 실패한 것은 원인을 확인한 뒤 readonly 상수를 복사하는 최소 수정으로 해결했다.

## 변경 파일

- `packages/observability/package.json`
- `packages/observability/src/redaction.ts`
- `packages/observability/src/logger.ts`
- `packages/observability/src/diagnostics.ts`
- `packages/observability/src/index.ts`
- `packages/observability/test/redaction.test.ts`
- `pnpm-lock.yaml`

## 자체 리뷰

- authorization, token, cookie, voice/signed URL, prompt, transcript는 깊은 구조와 Pino destination 경계에서 `[Redacted]`가 되는 것을 실제 stream으로 검증했다.
- configured pattern, company 경로, basename path disclosure 및 raw content 배제는 diagnostics text에 원문이 남지 않는 계약으로 검증했다.
- `packages/observability`에서 upload, telemetry, HTTP 호출, 외부 channel/credential 접근 코드는 추가하지 않았고, manifest 파일 목록도 `manifest.json`으로 제한했다.

## 우려사항

현재 staging 디렉터리는 운영체제 임시 경로에 생성되며 정리와 archive 실행은 의도적으로 후속 CLI의 명시적 확인 책임으로 남겨 두었다. Pino의 기본 redaction 설정은 지정 필드와 한 단계 nested 필드를 대상으로 하고, 임의 깊이의 외부 structured event는 `redactDeep`을 통해 producer가 정규화해야 한다.
