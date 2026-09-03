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

## 수정 라운드 1/5

### TDD 기록

RED는 `packages/observability/test/redaction.test.ts`에서 정적 `@orca-hq/observability` import로 시작했다. 첫 `pnpm test packages/observability/test/redaction.test.ts`는 배포되지 않은 `dist` entry를 해석하지 못해 0개 테스트로 실패했고, 패키지 내 개발 export와 tsconfig self path를 추가한 뒤에는 최소 diagnostics 호출의 `input.capabilities is not iterable`, 깊이 3·4 및 배열 내부 Pino secret 평문 출력, 모든 error message/code 파기라는 예상된 3개 실패를 확인했다. 이어 일반 `company-*` 자동 redaction을 금지하는 테스트도 `[Redacted]` 실제값으로 RED가 된 것을 확인한 후, 호출자 주입 pattern만 남기는 최소 구현으로 GREEN으로 만들었다.

### Finding별 해결

- Critical 1: `createLogger`의 `formatters.log`가 모든 payload를 `redactDeep`에 통과시키도록 해 Pino path 목록은 보조 방어선으로만 남겼다. 실제 `Writable` destination 바이트 테스트가 깊이 3 authorization, 깊이 4 signed URL, 배열 내부 token의 원문 부재를 검증한다.
- Important 1: 동적 import/catch, optional chaining, 수제 타입 shim을 제거하고 정적 `@orca-hq/observability` import로 교체했다. 새 `packages/observability/tsconfig.json`은 `src`와 `test`를 함께 검사한다.
- Important 2: `COMPANY_DATA_PATTERN`을 제거했다. 실제 절대 워크스페이스 경로와 기존 `company-project-path` 문자열 모두 호출자가 전달한 `secretPatterns`으로 redaction하며, path key는 명시된 `basename` 정책을 적용한다.
- Important 3: diagnostics input에 실제 prompt/transcript 및 nested secret을 넣고 `manifest.health`가 정확히 `{ workspace: "[Redacted]", nested: {} }`임을 단언한다.
- Important 4: `safeErrorSerializer`는 error `name`, `code`, secret pattern 적용 후의 `message`를 보존하며 unknown throw 값은 `Unknown`으로 구분한다.
- Important 5: 패키지 내부 공개 이름 import를 focused test에서 실행하고, 개발 조건 export와 self path를 통해 root alias 수정 없이 source 배포 환경에서 test/typecheck 가능함을 검증했다.
- Important 6: 중복된 `tsc` 플래그를 패키지 `tsconfig.json`으로 이동하고 scripts를 `tsc -p tsconfig.json` 규약으로 통일했다. build 산출물 경로와 exports도 이 설정의 `rootDir: "."`에 맞췄다.

### 검증

실행 명령:

```sh
pnpm test packages/observability/test/redaction.test.ts
pnpm --filter @orca-hq/observability typecheck
pnpm --filter @orca-hq/observability build
pnpm typecheck
pnpm test
git diff --check
```

핵심 출력: focused test 1 파일 12 테스트 통과, observability package typecheck/build 통과, root typecheck 통과, 전체 Vitest 31 파일 543 테스트 통과, `git diff --check` 통과.

### 변경 파일

- `packages/observability/package.json`
- `packages/observability/tsconfig.json`
- `packages/observability/src/diagnostics.ts`
- `packages/observability/src/logger.ts`
- `packages/observability/src/redaction.ts`
- `packages/observability/test/redaction.test.ts`

### 남은 우려사항

진단 staging 디렉터리의 archive 및 정리는 원래 범위대로 후속 명시적 확인 CLI의 책임으로 남아 있다. 이 패키지는 upload/telemetry 경로를 추가하지 않았다.

## 수정 라운드 2/5

### TDD 기록

RED는 `packages/observability/test/redaction.test.ts`의 `lets an external root TypeScript consumer resolve the public name to the source entry`로 시작했다. 이 테스트는 `packages/core/src/observability-consumer.ts`를 consumer 위치로 하여 루트 `tsconfig.json`을 실제 TypeScript resolver에 전달하고, 공개 패키지 이름이 source entry로 해석되는지를 검증한다. 구현 전 `pnpm test packages/observability/test/redaction.test.ts`는 예상대로 `expected undefined to be '/Users/j.jaeyo/orca/workspaces/orca-hq/hq-channels-agents/packages/observability/src/index.ts'`로 실패했다.

`tsconfig.json` paths와 `vitest.config.ts` alias에 `@orca-hq/observability`를 기존 워크스페이스 패키지와 같은 source entry 형식으로 각각 한 건씩 추가한 뒤 GREEN을 확인했다. 함께 추가한 `loads the public name at the Vitest runtime boundary`는 실제 dynamic import로 공개 이름의 Vitest runtime 로드를 검증하며, 설정 소스 문자열을 비교하지 않는다.

### 검증

실행 명령:

```sh
pnpm test packages/observability/test/redaction.test.ts
pnpm --filter @orca-hq/observability typecheck
pnpm typecheck
pnpm test
git diff --check
```

핵심 출력: focused test 1 파일 14 테스트 통과, observability package typecheck 통과, 루트 typecheck 통과, 전체 Vitest 31 파일 545 테스트 통과, `git diff --check` 통과.

### 해결 근거

관측성 패키지의 self-mapping이나 이미 생성된 `dist`에 의존하지 않고, 다른 컴포넌트인 `packages/core/src`를 기준으로 루트 TypeScript resolver가 `packages/observability/src/index.ts`를 반환한다. 같은 공개 이름은 Vitest runtime에서도 실제로 import되어 `redactDeep`의 public API 동작까지 확인한다. 라운드 1의 logger, redaction, diagnostics 및 package 설정은 변경하지 않아 앞선 7개 finding을 되돌리지 않았다.

### 변경 파일

- `tsconfig.json`
- `vitest.config.ts`
- `packages/observability/test/redaction.test.ts`

### 남은 우려사항

관측성 package build가 `dist/test/**`를 산출하는 기존 deferred minor는 이번 공개 이름 resolver finding의 해결에 필요하지 않아 변경하지 않았다.
