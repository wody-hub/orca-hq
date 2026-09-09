# Inline job-list lookup regression

Status: fixed, installed and verified on 2026-09-08.

## User-visible symptom and evidence

The user reported no new progress window after entering `지금 돌아가고 있는 작업 내용들 리스트업해줘`, and confirmed this was the affected instruction. Installed request `aaeb6a23-77a9-4b90-99a8-84270e6dd836` in session `80634671-f7a0-4f1d-9796-816700d2304e` recorded only `request.accepted` and aggregate `request.completed`, with no context assignment and no viewer lease.

The response was `현재 제공된 정보에는 진행 중인 작업 목록이 없어, 실행 중인 작업을 확인할 수 없습니다.` No job lookup occurred. This was not evidence of an attempted Terminal launch failing or a native worker starting.

The approved design intentionally keeps greetings, help and global job lists inline without creating a work context/window. The assistant had not explained that exception clearly enough. README now makes it explicit.

## Root cause

`context-router.ts` instructed the tool-free classifier to answer global job lists using `parts:[]` plus `reply`, even though it was not supplied the actual native job catalog. `progress-runtime.ts` persisted this classifier text as the final answer. The lookup route therefore needed a validated read-only action backed by real observations, rather than an invented answer or an unnecessary new work context.

## Ownership

Orca Run `run_13fc633f1cf3`, task `task_8fc4668c3c14`, Dispatch `ctx_75347e35efd5`. Codex `gpt-5.6-sol`, high, owns router/runtime production wiring and focused regressions. Coordinator owns this report, README clarification, installation and actual read-only request verification.

Installed baseline backup: `/Users/j.jaeyo/.config/orca-hq/backups/inline-job-lookup-20260908-134257`.


## Correction and verification

- Added mutually exclusive validated `lookup:{action:"jobs.list"}` routing. The exact reported Korean request uses a narrowly matched lookup phrase; semantic variants can return the same action. Development/review requests mentioning job-list screens continue through normal context routing.
- Added an inline `readJobs` callback. Production reads cached active and recent terminal native-job observations, separates the sections, avoids overlap, and places freshness information before potentially truncated content. Native job update timestamps are labeled as recorded job updates, not the time of a fresh poll. No native lifecycle command is issued by this reader.
- Lookup failure produces explicit unavailable/failed output rather than an empty-list claim. No context, execution slot, model execution or viewer assignment is required; repeated request IDs preserve the existing result.
- Worker verification: 35 focused tests, gateway typecheck and gateway build passed. Coordinator verification: socket/restart suites 8 tests passed; final full suite **86 files / 1076 tests passed**, full repository typecheck passed, and scoped diff checks passed.
- Installed and byte-verified 15 gateway source/build artifacts. Receipt: `~/.config/orca-hq/inline-job-lookup-installed.json`. Ordinary `hq stop` / `hq start` succeeded. Final service PID **16888**, running with Slack and Telegram connected. No channel test message was sent.
- Actual installed request `lookup_verify_1a07f65680d` used the user's exact text. Durable acceptance took **13.536ms**; completion was observed within **1.034s**. Result contained real cached native job IDs and the freshness label, with empty `contextIds`. Stored events were only acceptance and aggregate completion, proving this lookup did not start a context/agent/viewer.
- Local smoke evidence: `/tmp/orca-hq-inline-lookup-smoke.json`. The worker completed and its exact terminal was released with transcript archived. No commit or push was performed.
