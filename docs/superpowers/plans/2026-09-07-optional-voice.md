# 음성 선택 설정 구현 계획

목표: OpenAI API 키 없이 새 텍스트 전용 pilot 설정을 저장하고 진단한다.
기술: TypeScript, Zod, Vitest, macOS Keychain.

- [x] `packages/installer/test/host.test.ts`에 새 설치·명시적 비활성·기존 음성 키 누락·설정 유지·음성 재활성 테스트를 추가하고 실패를 확인한다.
- [x] `packages/core/src/pilot-config.ts`에 선택적 `voiceMode`를 추가한다. 필드가 없는 기존 설정의 의미는 유지한다.
- [x] `packages/installer/src/setup.ts`의 `resolveSetupVoiceMode`로 새 입력과 기존 설정의 모드를 결정하고 저장한다. `host.ts`에서 같은 함수를 사용해 preflight와 저장 결과를 일치시킨다.
- [x] `doctor.ts`의 음성 비활성 결과를 명시적 skip으로 표현한다. 다른 필수 검사와 Registry의 skip은 fail로 처리한다.
- [x] `prompt.ts`의 OpenAI 안내에 선택 입력과 기존 모드 유지 의미를 설명한다.
- [x] `cli-process.test.ts`에 실제 빌드된 CLI의 빈 키 입력 → 설정 저장 → doctor 확인 테스트를 추가한다. 모의 외부 프로세스만 사용하며 실제 자격증명을 테스트하지 않는다.
- [x] installer 테스트 114개, typecheck, 전체 47개 파일·704개 테스트와 빌드를 통과했다.
- [x] 설치 문서를 갱신하고 변경 파일 9개만 설치본에 적용했다. 설치본 core·installer 빌드를 통과했다.
- [ ] setup을 재실행해 사용자 자격증명 입력 단계에 둔다. 실제 doctor·gateway·메시지 시험 결과를 이어서 기록한다.

보호 대상: `docs/superpowers/plans/2026-09-01-orca-hq-private-pilot-roadmap.md`의 내용·해시·diff는 취급하지 않는다. 커밋이나 stage 시에도 명시적 파일 목록만 사용한다.
