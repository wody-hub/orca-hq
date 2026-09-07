# HQ Project Management and Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Slack, Telegram, 터미널에서 Orca 프로젝트 관리 및 실제 Codex 개발 작업을 실행한다.

**Architecture:** 하나의 영속 command/job 서비스에 세 입력 경로를 연결한다. Orca 프로젝트가 ID/경로의 기준이며 기존 작업자·작업 공간 기능을 재사용한다.

**Tech Stack:** TypeScript, Node 22, SQLite, Orca CLI, Codex subscription CLI, launchd.

## Global Constraints
- 작업 저장소 /Users/j.jaeyo/orca/workspaces/orca-hq/hq-channels-agents; 설치본 /Users/j.jaeyo/Applications/orca-hq.
- 보호 roadmap 파일은 status 표시 외 접근 금지. 기존 변경 전체를 보존한다. stage는 명시적 신규 설계/구현 파일만 사용한다.
- 자격증명 값은 출력 금지. Codex 로그인 구독 사용, 음성 비활성 유지.
- 기존 조회 서비스는 신규 구현의 실제 검증 전 교체하지 않는다.
- 실제 채널 E2E와 설치본 검증 전 전체 완료 금지.

### Task 1: Dynamic project catalog
Files: apps/gateway/src/managed-projects.ts, apps/gateway/test/managed-projects.test.ts.
Interfaces: ManagedProject { id, name, absolutePath, aliases, enabled, sensitivePaths, setupPolicy, defaultBaseRef? }. ProjectCatalog.list(): Promise<ManagedProject[]>; resolve(selector): Promise<ManagedProject>; add(path): Promise<ManagedProject>; alias(selector, alias): Promise<void>; setEnabled(selector, enabled): Promise<void>.
- [ ] RED: fake Orca discovery returns six projects; list exposes all six, disabled metadata persists, ambiguous aliases reject, legacy sensitivePaths survive. `expect(await catalog.list()).toHaveLength(6)`.
- [ ] GREEN: persisted atomic metadata overlays dynamically discovered Orca projects. Validate canonical existing Git paths before `orca repo add --path`. Do not read protected file; preserve legacy registry metadata. Caller supplies `isBusy(id)` for mutation guards.
- [ ] Verify: `pnpm exec vitest run apps/gateway/test/managed-projects.test.ts`.

### Task 2: Durable actual execution
Files: apps/gateway/src/managed-jobs.ts, apps/gateway/src/managed-worker.ts and respective tests.
Interfaces: JobEngine.submit({requestId, project, prompt}): Promise<Job>; list(): Job[]; get(id): Job; stop(id): Promise<Job>; followup(id,prompt,requestId): Promise<Job>; retry(id,requestId): Promise<Job>; start(): Promise<void>; close(): Promise<void>; isBusy(projectId): boolean. Job contains id, projectId, projectName, prompt, state, result?, worktreePath?, createdAt, updatedAt. Factory options databasePath, onUpdate(job), worker ports. Export durable engine with injectable real Orca/Codex ports.
- [ ] RED: duplicate request returns same job; worker mutation starts only once; restart uncertain job enters recovery instead of relaunch; stop owns exact worker; followup is queued for same worktree.
- [ ] GREEN: reuse existing worker lifecycle/provider building blocks as feasible, actual Orca-managed worktree plus Codex subscription execution. Persist worktree/worker identity before mutable steps, enforce per-project editing ownership. Worker result includes modified file and actual validation evidence. Model never gets protected file access. No uncontrolled shell string interpolation.
- [ ] Verify scoped job/worker tests; real isolated synthetic repo execution and stop test before installation.

### Task 3: Shared commands and authenticated terminal input
Files: apps/gateway/src/managed-commands.ts, managed-service.ts, packages/installer/src/control.ts, cli.ts and tests.
Interfaces: execute({id,text,source,userId}): Promise<{text,jobId?}>. Sources slack/telegram/terminal; per-channel ownership resolved before execution. Use owner-only UNIX domain socket for terminal JSON requests, mode 0600.
- [ ] RED: project list/add/alias/exclude/restore and job run/status/stop/retry/followup route correctly, malformed requests reject without side effects; same request IDs cannot execute twice.
- [ ] GREEN: structured commands plus Korean natural language routing; project ambiguity returns actionable list. CLI `hq projects ...`, `hq run --project ... --prompt ...`, `hq jobs ...`, `hq ask ...` send to same live gateway service.
- [ ] Persist original channel destinations for asynchronous status/result delivery and queued outgoing updates. Reconnection only retries delivery, never repeats work.
- [ ] Verify command/socket authorization, channel cross-control, restart delivery and input size tests.

### Task 4: Runtime composition and pilot migration
Files: local-runtime.ts, local-channels.ts, installer doctor/setup/readiness, docs/installation/private-pilot.md and scoped tests.
- [ ] Replace active built-in composition with managed service after owner Slack binding established. Preserve existing text modules/tests as compatibility only.
- [ ] Remove five-project requirements from active setup/doctor; preserve secrets and protected paths; support channel-specific degraded status without disabling working ingress.
- [ ] Update documentation with implemented terminal commands and Korean chat examples.
- [ ] Verify relevant tests, full typecheck/build/test once integrated.

### Task 5: Deployment, actual E2E and report
- [ ] Copy only explicit changed paths into install; build; restart once; doctor --format json, status, health.
- [ ] Verify real isolated code-change job via terminal and each channel with user-originated messages; verify cross-channel followup and returned test evidence. Keep generated smoke artifacts named and reviewable.
- [ ] Configure/verify private Tailscale Serve with bounded CLI timeout, no Funnel.
- [ ] Final independent review, correct material findings; report actual successes and pending user steps without claiming unverified completion.
