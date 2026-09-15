# Task 1 Independent Spec and Quality Review

Scope: global/shared contract and Task 1 only. Review used the supplied Task 1 report/diff, plan lines 11-80, installed Orca 1.4.203 `--help`, and narrow current-source checks. The reported passing suite was not repeated; two targeted runtime probes exercised uncovered concerns.

## Spec — BLOCK

### PASS

- Process launch remains structured: `runOrca` rejects caller-supplied `--json`, appends one `--json`, uses a bounded environment, `shell:false`, and a timeout (`packages/orca-adapter/src/process.ts:143-154,212-214`; plan:14,17,74).
- Core exports the requested contract/sanitizer modules and preserves the 400/64-KiB sanitizer bounds plus the gateway's 14,000-character bound (`packages/core/src/index.ts:16-17`; `packages/core/src/public-output.ts:1-23`; `apps/gateway/src/progress-events.ts:3-6`).
- Metrics and capacity provenance enforce the unavailable/update-unsupported shape (`packages/core/src/operations.ts:14-20`; plan:23-25,34).

### BLOCK

1. **Public CLI argv is incompatible with the installed CLI.** `capabilities.ts:153-166` emits `dispatch --terminal ... --request-id`, `reply --message ... --request-id`, and `send` without required `--subject`; installed help requires `dispatch --to ... --retry-request`, `reply --id ... --retry-request`, and `send --subject ... --retry-request`. The same wrong retry flag affects stop/retain/release. It also emits `run-show --run` instead of `--id`, unsupported `task-list --limit`, nonexistent `project setup-list`, and unsupported `worktree list --project`; installed commands are `project setups --project` and `worktree list --repo`. `list_projects` still invokes `repo list` (`capabilities.ts:118-119`) although Task 1 requires public project list/setup inventory (plan:40,56,74). **Action:** rebuild every new argv from the installed help, add a constant safe follow-up subject, add a distinct `project list` operation, and remove or locally enforce caps the command cannot accept.
2. **The HQ event/page contract does not preserve the current core contract and permits forbidden links.** Current events include optional `agentId` and `generation`, and pages include `snapshots` (`packages/core/src/progress.ts:127-138`; `apps/gateway/src/progress-store.ts:219-225`), but the new strict schemas omit them (`packages/core/src/operations.ts:22-24`), so a real `worker.ready` event is rejected. Conversely, `receiptLink` is allowed on every kind; the test explicitly allows it on `hq.progress` (`packages/core/test/operations.test.ts:23-28`), contradicting plan:19's `worker.ready|worker.retained`-only rule. **Action:** preserve the existing event/page fields (including original source provenance) and refine links to only the two exact receipt kinds.
3. **New operation receipts are not typed.** `OrcaOperationsReceiptSchema` aliases a success envelope whose `result` is `unknown` (`packages/orca-adapter/src/receipts.ts:7-12,38,273-275`), and `execute` returns it without operation-specific validation (`packages/orca-adapter/src/index.ts:118-134`). Malformed identity, paging, liveness, source, or mutation verdict data therefore crosses the adapter boundary as success. **Action:** define a result schema per new operation, dispatch parsing by `kind`, and verify mutation target/request identity where returned.
4. **The shared output/input schemas are not strict enough for their declared variants.** `OrcaOutputPageSchema` makes both `messages` and `lines` optional (`packages/core/src/operations.ts:35`); a targeted probe confirmed it accepts neither and both instead of transcript XOR terminal. Adapter IDs, cursors, and bodies use only `z.string().min(1)` (`packages/orca-adapter/src/capabilities.ts:12,53-70`), accepting whitespace and unbounded strings despite plan:76's ID/text/limit validation requirement. **Action:** use a discriminated output union and bounded, trimmed field-specific schemas with explicit body limits.

## Quality — BLOCK

### PASS

- Existing timeout/abort tests cover SIGTERM-to-SIGKILL escalation (`packages/orca-adapter/test/capabilities.test.ts:286-383`), and new schema tests cover unavailable metrics and top-level identity separation (`packages/core/test/operations.test.ts:9-35`).
- Credential patterns cover private keys, bearer tokens, GitHub tokens, and AWS access-key IDs (`packages/core/src/public-output.ts:26-33`).

### BLOCK

1. **Redaction truncates before credential removal.** `redactPublicText` first applies the 64-KiB result limit, then looks for a complete private-key block (`packages/core/src/public-output.ts:20-33`). A targeted 70,000-character key-block probe returned length 65,564 with `redacted:false` and secret bytes present because truncation removed the END marker. **Action:** redact on control-stripped full input before final bounding, and add boundary-crossing/private-key-without-terminator tests.
2. **Overflow handling is not a strict process/output bound.** After exceeding the limit, the data handler keeps appending and recomputing `Buffer.byteLength(stdout)` while only sending repeated SIGTERM (`packages/orca-adapter/src/process.ts:156-163,183-185`); overflow does not start the configured SIGKILL grace path, so an ignoring child can keep growing memory until the unrelated command timeout. **Action:** stop retaining bytes at the cap, trigger one shared cancel/escalation path on overflow, and prove the child is gone before rejection.
3. **Task 1 tests validate implementations, not the required behavior.** The argv test asserts every incompatible spelling above (`packages/orca-adapter/test/operations.test.ts:5-27`). The new process test only constructs `OrcaOutputLimitError` and never executes a child (`packages/orca-adapter/test/process.test.ts:5-9`), leaving the overflow bound/escalation untested; receipt result validation and negative input bounds are also absent. **Action:** replace expectations from installed help and add functional fake-child overflow, malformed per-operation receipt, output-union, link-kind, and size/whitespace boundary tests.

## Review verdict

Task 1 is not ready for Task 2 consumption. Correct the exact CLI surface and typed receipt boundary first, then fix redaction/output bounding and strengthen the focused regression suite.
