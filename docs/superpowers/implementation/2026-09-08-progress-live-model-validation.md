# Live Codex model validation — 2026-09-08

The built gateway session client completed eight real Codex turns: five independent concurrent sessions, one same-thread continuation, and two semantic context-routing requests. The five initial turns had distinct thread IDs and **16.281 seconds of five-way overlap**, measured from observed app-server turn events; all outputs and both routing classifications passed independent evidence checks.

Dispatch: `task_fc66493b8c53` / `ctx_a6113931a341`. Execution window: **2026-09-08 03:13:32.709–03:14:13.545 UTC**, equivalent to **12:13:32.709–12:14:13.545 Asia/Seoul**. This was one bounded run with no retries.

## Method and isolation

- Imported the workspace's already-built `createCodexSessionClient`, `createModelContextRouter`, and `routerInstructions` directly. No rebuild, source changes, substitute model callbacks, or simulated responses were used.
- One session client received five concurrent `run` calls through `Promise.allSettled`. Each call launched the actual `codex app-server --stdio --strict-config` executable (`codex-cli 0.153.4`) through the production client. All eight thread responses identified model **gpt-6-astra**, provider **openai**; these are actual runtime response fields, not inferred from the coordinator model or a window title.
- A transparent `spawnProcess` observer called real Node `spawn` with unchanged executable, arguments, and options, then passively recorded whitelisted protocol metadata. It did not inject, alter, or suppress model responses. Observation included `turn/started`, `turn/completed`, thread/turn IDs, statuses, item types, and process IDs; raw diagnostics and credentials were not recorded.
- Both clients used `tools: []`. The product configured read-only sandboxing, no approvals, and disabled shell, browser, web search, plugins, and multi-agent features. Fixture tool callbacks threw if invoked. There were **zero tool callbacks and zero observed tool execution items** across all eight turns.
- The working directory was an empty private fixture at `/tmp/orca-progress-live-20260908/empty-project`. A private temporary copy of the existing login file preserved the authentication format; the product's normal auth symlink pointed to that copy. Only this fixture process received the temporary authentication root. The copy was removed after closing both clients, and independent verification confirmed it was absent. No credentials were printed and no original login/configuration or user session storage was modified by the fixture.
- No Orca worker was started. The models only answered synthetic prompts; no production data, repository documents, file changes, external tools, service restarts, installs, or application deployment were involved.

The loaded build identities, captured before invocation:

| Module | Build mtime (UTC) | SHA-256 |
| --- | --- | --- |
| `codex-session.js` | 2026-09-08T03:10:27.607Z | `f5efb94c5924a1f342a3729d12a83397375de113bffb1e7306af6a99159b11a3` |
| `context-router.js` | 2026-09-08T03:10:27.615Z | `bb9440db4cb986c93e57bab6c1b7cbf608ef1b52dedb51f7a4a0a0b10f45d807` |

## Timing and independent identities

All times below are **UTC on 2026-09-08**. Invocation times cover the complete client lifecycle. Turn boundaries are local receipt times of actual app-server notifications; durations and overlap use a monotonic clock.

| Run | Invocation start | Invocation end | Turn started | Turn completed | Turn seconds |
| --- | --- | --- | --- | --- | --- |
| independent-1 | 03:13:32.711 | 03:13:49.716 | 03:13:33.275 | 03:13:49.709 | 16.434 |
| independent-2 | 03:13:32.712 | 03:13:51.662 | 03:13:33.362 | 03:13:51.657 | 18.294 |
| independent-3 | 03:13:32.712 | 03:13:49.651 | 03:13:33.299 | 03:13:49.644 | 16.344 |
| independent-4 | 03:13:32.712 | 03:13:51.576 | 03:13:33.234 | 03:13:51.571 | 18.336 |
| independent-5 | 03:13:32.712 | 03:13:53.252 | 03:13:33.273 | 03:13:53.243 | 19.970 |
| same-thread-followup | 03:13:53.252 | 03:13:58.739 | 03:13:53.331 | 03:13:58.732 | 5.401 |
| route-different-feature | 03:13:58.740 | 03:14:05.442 | 03:13:58.831 | 03:14:05.436 | 6.605 |
| route-followup | 03:14:05.443 | 03:14:13.544 | 03:14:05.529 | 03:14:13.537 | 8.008 |

| Run | Child PID | Thread ID | Turn ID |
| --- | --- | --- | --- |
| independent-1 | 59962 | `01a07f01-b43b-7e31-b308-7f586c3acf30` | `01a07f01-b458-7151-8707-8be1f456cff0` |
| independent-2 | 59972 | `01a07f01-b48a-79b1-bcd4-13160e5e0a81` | `01a07f01-b4a7-7a72-ac7c-3de1ac0545ff` |
| independent-3 | 59982 | `01a07f01-b452-7d93-ba3c-a0d80ba4869b` | `01a07f01-b470-7073-8461-cebec3d5aceb` |
| independent-4 | 60002 | `01a07f01-b420-7240-b449-c3a97e61faf9` | `01a07f01-b42b-7540-b018-229e67acdd83` |
| independent-5 | 59992 | `01a07f01-b439-79a0-8297-d43d04b411b3` | `01a07f01-b455-7143-a528-7689d7c64324` |
| same-thread-followup | 68325 | `01a07f01-b43b-7e31-b308-7f586c3acf30` | `01a07f02-02b2-74c2-9d9f-15956da72416` |
| route-different-feature | 69112 | `01a07f02-180e-7532-8994-15c53a24f115` | `01a07f02-182c-7291-a821-4be741631c8c` |
| route-followup | 70957 | `01a07f02-3238-7c50-bcdc-aed89e1a01ae` | `01a07f02-3255-7e53-a6d7-b0e0fe7813a4` |

Peak active turns: **5**. The common active interval was **03:13:33.362–03:13:49.644 UTC**, with a monotonic intersection of **16,281.089 ms**. The calculation is the earliest completed event minus the latest started event among the five initial turns, with all five matched thread/turn identities and completed statuses verified. Every child process closed with exit code 0.

Each initial prompt supplied its own marker and requested eight arithmetic products plus a bounded fictional observatory description. All five returned their own marker and the exact product vector `[3973,9176,15437,27553,35258,50297,65653,79831]`. The markers were `COPPER-ORBIT-417`, `VELVET-CEDAR-582`, `SILVER-LAGOON-639`, `AMBER-COMET-724`, and `INDIGO-MEADOW-853`. Distinct IDs, successful independent marker-bearing outputs, and matched overlapping turn events provide the evidence; no window count was used.

## Continued same-thread request

After all five initial runs finished, a fresh child process resumed the first thread, `01a07f01-b43b-7e31-b308-7f586c3acf30`. The followup did not repeat its marker or arithmetic operands: it asked for the previous private marker and first product using only conversation history. The returned thread ID matched exactly and the final answer was:

```json
{"marker":"COPPER-ORBIT-417","firstProduct":3973}
```

This verifies history continuity through the production client's resume path across child-process lifetimes, with a new turn ID on the original thread.

## Semantic context routing

Both calls used the real `createModelContextRouter` and exported production `routerInstructions`. Requests had no `contextHint` or explicit `/context` command, so they passed through real model classification and the production decision validator. The transparent client wrapper only recorded timing, identities, and returned text.

The synthetic catalog contained `project_gh_fixture` (GH; aliases GHSSIS and 지에이치) and `project_orbit_fixture` (Orbit; alias 오빗). The two candidates were completed GH 법령 이력관리 review context `ctx_fixture_legal_history`, summarizing unimplemented revision-history comparison and deletion confirmation, and unrelated Orbit settings review context `ctx_fixture_orbit_ui`. Both belonged to the fixture input session. Full candidate objects are in the raw evidence.

**Same project, different feature:** request `GH 자체안전점검 화면을 별도로 검토해줘. 파일은 수정하지 마.` produced a new GH context, preserving the no-edit constraint:

```json
{
  "parts": [
    {
      "action": "new",
      "title": "GH 자체안전점검 화면 검토",
      "objective": "GH 자체안전점검 화면을 별도로 검토하되 파일은 수정하지 않는다.",
      "projectIds": [
        "project_gh_fixture"
      ],
      "text": "GH 자체안전점검 화면을 별도로 검토해줘. 파일은 수정하지 마."
    }
  ]
}
```

**Verification followup:** request `방금 법령 이력관리에서 찾은 미구현 항목을 다시 검증해줘. 파일은 수정하지 마.` continued the existing legal-history context, also preserving the no-edit constraint:

```json
{
  "parts": [
    {
      "action": "continue",
      "contextId": "ctx_fixture_legal_history",
      "text": "방금 법령 이력관리에서 찾은 미구현 항목을 다시 검증해줘. 파일은 수정하지 마."
    }
  ]
}
```

The two router calls themselves used distinct Codex classification threads; the continuation decision identifies the synthetic product context, which is separate from a classifier thread identity.

## Verification artifacts

- Fixture: `/tmp/orca-progress-live-20260908/validate.mjs`.
- Raw evidence: `/tmp/orca-progress-live-20260908/evidence.json`, containing exact prompts, outputs, timestamps, process/thread/turn identities, module hashes, and decisions, with no authentication contents.
- Independent verifier: `/tmp/orca-progress-live-20260908/verify.mjs`.
- Verification command: `node /tmp/orca-progress-live-20260908/verify.mjs` — **exit 0**. It rechecked all five completed turn identities and positive overlap, five distinct threads, exact markers/products, same-thread recall, both classification outcomes, no tool activity, and removal of the temporary auth copy.

## Limits of this evidence

This confirms the real built model-client concurrency/resume boundary and the real semantic router on two specified synthetic requests. App-server active-turn intervals are observed client-side protocol lifetimes; they do not reveal provider-side simultaneous token generation or scheduling. A single successful five-session run is not a throughput, reliability, or routing-accuracy benchmark.

The fixture directly invokes these built modules rather than going through the gateway request queue, context executor, NDJSON stream, progress store, native workers, or Terminal viewers. It therefore does **not** validate a sixth-context FIFO wait, gateway same-context serialization, resource ownership/uncertainty retention, native progress mapping, restart recovery, or end-to-end window behavior. No commentary was emitted for these bounded prompts, so this run does not demonstrate a live commentary progress callback. Those integration behaviors need their own gateway/native evidence; no inference is made from this run.

Only this report and isolated temporary fixture artifacts were created for this dispatch. Other workers can change the workspace build afterward; the hashes above identify the exact modules observed here. No assigned live-model validation remains incomplete.
