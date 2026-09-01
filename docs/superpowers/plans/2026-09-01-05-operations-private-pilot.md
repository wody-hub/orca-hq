# Orca HQ Operations and Private Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Orca HQ installable, recoverable, diagnosable, and safely shareable with 3–5 coworkers through a private GitHub pilot.

**Architecture:** A source-distributed CLI performs guided setup while credentials remain in Keychain and runtime data remains in Application Support. `launchd` supervises the gateway; startup reconciliation compares durable state with Orca, diagnostics are redacted, and clean-machine/chaos tests gate the private pilot.

**Tech Stack:** Node.js CLI, macOS Keychain, launchd, Tailscale Serve, SQLite backup API, Pino, Vitest, Playwright, GitHub Actions

## Global Constraints

- The pilot supports macOS only and runs only while the host Mac is powered on, awake, and connected.
- Source installation is `git clone`, `pnpm install`, and `pnpm hq setup`; public npm and Homebrew distribution are excluded.
- Each user brings their own Orca, Codex, Claude Code, Slack App, Telegram bot, OpenAI voice credential, and Tailscale account.
- Setup never prints secrets; credentials live in macOS Keychain.
- `doctor` is read-only and machine-readable with nonzero exit status on failed requirements.
- `uninstall` preserves user data by default; data removal requires a separate explicit flag and confirmation.
- Upgrade, reinstall, migration, backup, rollback, and restart preserve or safely classify durable state.
- Telemetry is disabled; diagnostic export is explicit, redacted, local, and reviewable.

---

### Task 1: Redacted logging, metrics, and diagnostic bundle

**Files:**
- Create: `packages/observability/package.json`
- Create: `packages/observability/src/logger.ts`
- Create: `packages/observability/src/redaction.ts`
- Create: `packages/observability/src/diagnostics.ts`
- Create: `packages/observability/src/index.ts`
- Test: `packages/observability/test/redaction.test.ts`

**Interfaces:**
- Consumes: structured events, configured secret patterns, file/path disclosure policy, health summaries, and audit references.
- Produces: `createLogger`, `redactDeep`, local diagnostic archive manifest, and pilot counters without telemetry upload.

- [ ] **Step 1: Write secret and company-data redaction tests**

```ts
it.each(["authorization", "token", "cookie", "voiceUrl", "signedUrl"])("redacts %s", key => {
  expect(redactDeep({ [key]: "secret-value" })).toEqual({ [key]: "[Redacted]" });
});

it("exports a reviewable manifest without raw prompts or transcripts", async () => {
  const bundle = await diagnostics.create({ includeFullContent: false });
  expect(bundle.manifest.files).not.toContain("runtime.sqlite");
  expect(bundle.text()).not.toContain("company-project-path");
});
```

- [ ] **Step 2: Run tests and confirm observability package absence**

Run: `pnpm test packages/observability/test/redaction.test.ts`

Expected: FAIL because redaction and diagnostics are undefined.

- [ ] **Step 3: Implement mandatory Pino redaction and local metrics**

```ts
export function createLogger(destination?: DestinationStream): Logger {
  return pino({
    redact: { paths: REDACT_PATHS, censor: "[Redacted]" },
    serializers: { err: safeErrorSerializer },
    base: { service: "orca-hq" }
  }, destination);
}
```

Diagnostic creation must stage only version, capability, schema, redacted health, aggregate counters, and user-selected audit references. The CLI prints the staging path and manifest before archive confirmation; no upload method exists.

- [ ] **Step 4: Scan fixtures and verify no secret reaches logs**

Run: `pnpm test packages/observability && pnpm typecheck`

Expected: authorization headers, tokens, cookies, voice/signed URLs, sensitive prompts, configured patterns, company paths, and transcripts are absent.

- [ ] **Step 5: Commit**

```bash
git add packages/observability pnpm-lock.yaml
git commit -m "feat(observability): add redacted diagnostics"
```

### Task 2: Guided setup, Keychain, doctor, and command-line contract

**Files:**
- Create: `packages/installer/package.json`
- Create: `packages/installer/src/cli.ts`
- Create: `packages/installer/src/keychain.ts`
- Create: `packages/installer/src/setup.ts`
- Create: `packages/installer/src/doctor.ts`
- Create: `packages/installer/src/config-files.ts`
- Create: `packages/installer/src/index.ts`
- Modify: `package.json`
- Test: `packages/installer/test/setup.test.ts`
- Test: `packages/installer/test/doctor.test.ts`

**Interfaces:**
- Consumes: macOS/CPU information, executable capability probes, Keychain adapter, Tailscale status, channel probes, and Registry review UI.
- Produces: `pnpm hq setup|doctor|start|stop|status|logs|update|uninstall`, config files without secrets, and JSON doctor report.

- [ ] **Step 1: Write secret-output and read-only doctor tests**

```ts
it("stores credentials in Keychain and never prints values", async () => {
  await setup.run(fakeAnswersWithSecrets);
  expect(keychain.set).toHaveBeenCalledWith("orca-hq", "slack-app-token", "xapp-secret");
  expect(output.text()).not.toContain("xapp-secret");
  expect(configFile.text()).not.toContain("xapp-secret");
});

it("doctor does not mutate machine state", async () => {
  const result = await doctor.run({ format: "json" });
  expect(machine.mutations).toEqual([]);
  expect(result.checks.map(c => c.id)).toContain("orca.capabilities");
});
```

- [ ] **Step 2: Run tests and confirm CLI absence**

Run: `pnpm test packages/installer/test/setup.test.ts packages/installer/test/doctor.test.ts`

Expected: FAIL because setup and doctor commands are not defined.

- [ ] **Step 3: Implement guided checks and stable result codes**

```ts
export const DoctorResultSchema = z.object({
  ok: z.boolean(),
  checks: z.array(z.object({ id: z.string(), status: z.enum(["pass", "warn", "fail"]), message: z.string(), remediation: z.string().optional() }))
});

export async function doctorExitCode(result: DoctorResult): Promise<number> {
  return result.checks.some(check => check.status === "fail") ? 1 : 0;
}
```

Setup checks supported macOS/CPU, Node/pnpm, Orca version/capabilities, Codex/Claude authentication readiness, Tailscale tailnet, Slack Socket Mode/channel, Telegram allowlisted chat, OpenAI voice, Keychain, SQLite directory, launchd, project discovery, and five-project Registry curation. It may write config only after showing the path and planned changes.

- [ ] **Step 4: Verify success, warning, and failure fixtures**

Run: `pnpm test packages/installer && pnpm hq doctor --format json; test $? -le 1`

Expected: JSON always validates, failures exit 1, warnings do not expose secrets, and doctor performs no write.

- [ ] **Step 5: Commit**

```bash
git add packages/installer package.json pnpm-lock.yaml
git commit -m "feat(installer): add setup and doctor commands"
```

### Task 3: launchd supervision and startup reconciliation

**Files:**
- Create: `packages/installer/src/launchd.ts`
- Create: `templates/com.orcahq.gateway.plist`
- Create: `apps/gateway/src/reconcile.ts`
- Modify: `apps/gateway/src/lifecycle.ts`
- Test: `packages/installer/test/launchd.test.ts`
- Test: `apps/gateway/test/reconcile.test.ts`

**Interfaces:**
- Consumes: installation paths, launchd user domain, nonterminal local state, Orca Run/Task/Dispatch state, cursors, locks, and Outbox.
- Produces: install/start/stop/status operations and reconciliation classifications `resumable | completed | review_required`.

- [ ] **Step 1: Write plist safety and reconciliation tests**

```ts
it("renders a user LaunchAgent with explicit paths and restart policy", () => {
  const plist = renderLaunchAgent(paths);
  expect(plist).toContain("<key>KeepAlive</key>");
  expect(plist).not.toContain("~");
  expect(plist).not.toContain("TOKEN");
});

it("marks uncertain worker state for review without cleanup", async () => {
  orca.inspectDispatch.mockResolvedValue({ kind: "unknown" });
  expect(await reconciler.run()).toContainEqual(expect.objectContaining({ state: "review_required" }));
  expect(orca.releaseWorker).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests and confirm supervision/reconciliation absence**

Run: `pnpm test packages/installer/test/launchd.test.ts apps/gateway/test/reconcile.test.ts`

Expected: FAIL because launchd and restart recovery are undefined.

- [ ] **Step 3: Implement explicit LaunchAgent and ordered reconciliation**

```ts
export async function reconcileStartup(ports: ReconcilePorts): Promise<ReconcileReport> {
  await ports.store.recoverOutboxClaims();
  await ports.channels.resumeCursors();
  const items = await ports.store.listNonterminalDispatches();
  return classifyAgainstOrca(items, await ports.orca.inspectMany(items.map(item => item.receipt)));
}
```

The gateway runs migrations, validates Keychain, recovers claims, resumes cursors, reconciles Orca, reviews expired locks, and drains Outbox before accepting a new HQ command. Cleanup uses exact Orca receipt recovery actions; it never substitutes broad terminal close or worktree deletion.

- [ ] **Step 4: Verify process kill, restart, and Mac-login fixtures**

Run: `pnpm test packages/installer apps/gateway/test/reconcile.test.ts && pnpm typecheck`

Expected: restart neither duplicates work nor releases uncertain workers, and the LaunchAgent contains no secrets.

- [ ] **Step 5: Commit**

```bash
git add packages/installer templates/com.orcahq.gateway.plist apps/gateway
git commit -m "feat(operations): add launchd restart recovery"
```

### Task 4: Backup, migration rollback, update, and safe uninstall

**Files:**
- Create: `packages/installer/src/backup.ts`
- Create: `packages/installer/src/update.ts`
- Create: `packages/installer/src/uninstall.ts`
- Test: `packages/installer/test/lifecycle-commands.test.ts`
- Create: `docs/operations/update-and-rollback.md`

**Interfaces:**
- Consumes: release/source revision, SQLite online backup, schema version, active-worker status, launchd control, and explicit confirmation input.
- Produces: timestamped backup, guarded source update, rollback, program uninstall, and separately confirmed data removal.

- [ ] **Step 1: Write active-worker, rollback, and data-preservation tests**

```ts
it("refuses update while worker state is active or uncertain", async () => {
  status.nonterminalDispatches = 1;
  await expect(update.run()).rejects.toMatchObject({ code: "active_work" });
});

it("preserves Application Support data on default uninstall", async () => {
  await uninstall.run({ removeData: false });
  expect(files.exists(paths.database)).toBe(true);
  expect(launchd.isInstalled()).toBe(false);
});
```

- [ ] **Step 2: Run lifecycle command tests and confirm absence**

Run: `pnpm test packages/installer/test/lifecycle-commands.test.ts`

Expected: FAIL because backup, update, and uninstall services are missing.

- [ ] **Step 3: Implement guarded lifecycle commands**

```ts
export async function prepareUpdate(context: UpdateContext): Promise<BackupReceipt> {
  const status = await context.gateway.status();
  if (status.activeOrUncertainDispatches > 0) throw new UpdateBlockedError("active_work");
  await context.gateway.stop();
  return context.backups.createOnlineBackup({ includeConfig: true, includeSecrets: false });
}
```

Update verifies the intended revision, installs with a frozen lockfile, runs read-only preflight, backs up data, stops gateway, migrates, starts, and runs doctor. Failure stops the new process, restores compatible program/config/database state, restarts the prior revision, and reports the backup receipt. `--remove-data` requires the exact generated path phrase.

- [ ] **Step 4: Verify upgrade/reinstall preservation and rollback**

Run: `pnpm test packages/installer && pnpm typecheck`

Expected: source reinstall preserves state, failed migration restores the backup, active work blocks update, and default uninstall preserves all user data.

- [ ] **Step 5: Commit**

```bash
git add packages/installer docs/operations/update-and-rollback.md
git commit -m "feat(operations): add safe update and uninstall"
```

### Task 5: End-to-end chaos suite and pilot acceptance harness

**Files:**
- Create: `tests/e2e/private-pilot.spec.ts`
- Create: `tests/chaos/restart.spec.ts`
- Create: `tests/chaos/provider-failures.spec.ts`
- Create: `packages/test-support/src/fake-slack.ts`
- Create: `packages/test-support/src/fake-telegram.ts`
- Create: `packages/test-support/src/fake-agents.ts`
- Create: `scripts/run-pilot-acceptance.mjs`
- Test: `tests/e2e/private-pilot.spec.ts`

**Interfaces:**
- Consumes: built gateway/web/CLI, fake providers, sandbox repositories, kill/restart harness, and synthetic Korean fixtures.
- Produces: machine-readable acceptance report covering all 12 pilot criteria and restart recovery rate.

- [ ] **Step 1: Write the pilot scenarios as failing tests**

```ts
test("Korean Telegram voice reaches verified L1 completion", async ({ pilot }) => {
  await pilot.telegram.sendVoice("fixtures/ko-change.ogg");
  await pilot.approveTranscript("샌드박스 프런트엔드 테스트를 수정해줘");
  await pilot.expectRoute("sandbox-web");
  await pilot.expectWorkerPair("codex", "claude");
  await pilot.expectFinalState("verified_success");
});

test("gateway kill during worker reconciles without duplicate dispatch", async ({ pilot }) => {
  await pilot.startL1();
  await pilot.killGatewayDuring("worker_running");
  await pilot.restartGateway();
  expect(await pilot.dispatchCount()).toBe(1);
});
```

- [ ] **Step 2: Run the full suite and capture the first failing contract**

Run: `pnpm build && pnpm test tests/e2e tests/chaos`

Expected: FAIL until the harness and all scenario seams are connected.

- [ ] **Step 3: Implement deterministic fakes and acceptance report**

```ts
export interface PilotAcceptanceReport {
  generatedAt: string;
  scenarios: Array<{ id: string; status: "pass" | "fail"; evidence: string[] }>;
  restartRecoveryRate: number;
  duplicateExecutions: number;
  approvalBypasses: number;
  verifiedSuccessCoverage: number;
}
```

Scenarios must cover duplicate delivery, Slack/Tailscale exact approval, Telegram approval denial, gateway/Orca/Mac/channel restart, Codex authentication loss without Claude takeover, one launch retry, two verification failures, wrong-project ambiguity, dirty checkout, and pending Outbox recovery.

- [ ] **Step 4: Run acceptance and chaos gates repeatedly**

Run: `pnpm test && node scripts/run-pilot-acceptance.mjs --runs 20 --output .artifacts/pilot-report.json`

Expected: zero duplicate executions, zero approval bypasses, 100% verifier evidence on success, and at least 95% scripted restart recovery.

- [ ] **Step 5: Commit**

```bash
git add tests packages/test-support scripts/run-pilot-acceptance.mjs
git commit -m "test: add private pilot acceptance harness"
```

### Task 6: Coworker installation docs, security docs, and private CI

**Files:**
- Create: `README.md`
- Create: `docs/installation/private-pilot.md`
- Create: `docs/operations/runbook.md`
- Create: `docs/security/threat-model.md`
- Create: `docs/security/data-handling.md`
- Create: `SECURITY.md`
- Create: `CONTRIBUTING.md`
- Create: `.github/workflows/ci.yml`
- Create: `.github/dependabot.yml`
- Test: `packages/installer/test/documented-commands.test.ts`

**Interfaces:**
- Consumes: final CLI help, clean-machine setup flow, risk matrix, recovery commands, and acceptance harness.
- Produces: a 20-minute private-pilot guide, operator runbook, security boundaries, issue template guidance, and macOS CI.

- [ ] **Step 1: Write executable documentation-command tests**

```ts
it("keeps documented CLI commands in sync with help output", async () => {
  const docs = await readFile("docs/installation/private-pilot.md", "utf8");
  const commands = extractShellCommands(docs).filter(command => command.startsWith("pnpm hq"));
  expect(commands).toEqual(expect.arrayContaining(["pnpm hq setup", "pnpm hq doctor", "pnpm hq start", "pnpm hq status"]));
  for (const command of commands) expect(await cliRecognizes(command)).toBe(true);
});
```

- [ ] **Step 2: Run the documentation test and confirm files are absent**

Run: `pnpm test packages/installer/test/documented-commands.test.ts`

Expected: FAIL because installation and operations documentation do not exist.

- [ ] **Step 3: Write clean-room setup, operation, and security guidance**

```bash
git remote get-url origin
corepack enable
pnpm install --frozen-lockfile
pnpm hq setup
pnpm hq doctor
pnpm hq start
```

Use the exact private origin returned by `git remote get-url origin` in the installation guide's clone command. The installation guide must separate actions users perform themselves: creating a Slack App from the manifest, creating a Telegram bot, authorizing Tailscale, authenticating Codex/Claude/Orca, and storing OpenAI voice credentials. The runbook must cover offline Mac, Orca unavailable, queued commands, approval expiry, restart review, backup/rollback, logs, diagnostics, update, and uninstall.

- [ ] **Step 4: Run CI-equivalent and clean-install documentation checks**

Run: `pnpm install --frozen-lockfile && pnpm test && pnpm typecheck && pnpm build && pnpm hq doctor --format json`

Expected: code checks pass; doctor returns structured environment-specific results; documentation test recognizes every command; repository scan contains no company path, token, transcript, or real Registry data.

- [ ] **Step 5: Commit**

```bash
git add README.md docs SECURITY.md CONTRIBUTING.md .github packages/installer/test/documented-commands.test.ts
git commit -m "docs: prepare private coworker pilot"
```

## Plan 5 Completion Gate

Run: `pnpm install --frozen-lockfile && pnpm test && pnpm typecheck && pnpm build && node scripts/run-pilot-acceptance.mjs --runs 20`

Expected evidence:

- A clean coworker Mac can complete documented setup in 20 minutes or less.
- Gateway and Mac restart safely reconcile commands, locks, workers, cursors, and Outbox.
- Update, rollback, reinstall, backup, and uninstall preserve local data by default.
- Diagnostic artifacts contain no secrets or company-specific data.
- The private pilot meets zero duplicate executions, zero approval bypasses, at least 95% restart recovery, and verifier evidence for every success.

## Internal Beta and Open-Source Promotion Gate

Do not change repository visibility until the private pilot has run for two weeks with five curated projects per user and the approved metrics pass. Before public release, replace company names, paths, remotes, aliases, fixtures, screenshots, transcripts, and policies with synthetic data; scan the full Git object database; add license, code of conduct, privacy/support/release policies; publish signed checksums, provenance, and an SBOM; and pass an external clean-machine install plus threat-model and dependency audits.
