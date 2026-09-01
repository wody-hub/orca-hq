# Orca HQ Design

**Status:** Approved for implementation planning
**Date:** 2026-09-01
**Initial distribution:** Private GitHub pilot for 3–5 coworkers
**Long-term distribution:** Public open source after internal usability and security gates pass

## 1. Purpose

Orca HQ provides one central Codex agent that accepts work instructions through Slack, Telegram, and a private Tailscale web interface. The HQ locates the correct Orca project and worktree, delegates work to isolated Codex or Claude Code workers, supervises questions and failures, requires approval for risky operations, runs cross-model verification, and returns a consolidated report.

The first release runs on a company Mac while that Mac is powered on and connected to the internet. It does not claim 24×7 availability while the Mac is shut down or asleep. Slack and Telegram retain commands while the local service is unavailable; the service reconciles those channels after it restarts.

## 2. Goals

1. Provide one stable HQ identity backed by Codex.
2. Accept Korean text and voice instructions from Slack and Telegram.
3. Provide a private mobile dashboard over Tailscale without port forwarding.
4. Discover Orca projects and route work using explicit aliases, roles, and confidence thresholds.
5. Execute work through Orca Run, Task, Dispatch, and Worker lifecycle contracts.
6. Support both Codex and Claude Code as workers.
7. Verify implementations with a different model family before reporting success.
8. Prevent duplicate execution, project misrouting, concurrent checkout edits, and unapproved external effects.
9. Recover safely after gateway, Orca, model, channel, network, and Mac restarts.
10. Produce an auditable history of commands, decisions, approvals, worker results, and final reports.
11. Support guided installation by several coworkers before public open-source release.

## 3. Non-goals for the Private Pilot

- Continuous operation while the host Mac is powered off or asleep.
- A cloud control plane, Temporal, LangGraph, LangSmith, or n8n.
- Linux or Windows hosting.
- Automatic public Slack application installation.
- Automatic creation of Telegram bots or Tailscale accounts.
- Fully autonomous merge, deployment, database mutation, deletion, or secret access.
- Direct access to Orca's private database or undocumented RPC interfaces.
- Automatic discovery of semantic aliases for all 47 projects without human review.
- A marketplace, billing system, multi-tenant SaaS, or hosted service.

## 4. Design Principles

### 4.1 One authority

Codex HQ is the only component that selects projects, decomposes requests, makes final coordination decisions, and reports to the user. Claude Code never automatically takes over HQ authority. If Codex authentication, quota, or runtime is unavailable, commands remain queued and the user receives a degraded-state notification.

### 4.2 Deterministic control around probabilistic reasoning

Models may interpret intent and propose plans. Deterministic code enforces identity, idempotency, project allowlists, path resolution, locks, risk levels, approval requirements, retry ceilings, and completion gates.

### 4.3 Orca as the execution plane

HQ uses the public, version-matched Orca CLI with JSON output. It loads `orca skills get orca-cli` and `orca skills get orchestration` guidance for the installed version. It does not infer CLI grammar from cached examples and does not access Orca persistence directly.

### 4.4 Verification is separate from worker completion

`worker_done` means the worker has reported an outcome. It is not proof that requirements are satisfied. A separate verifier must inspect the requested scope, changed files, diff, tests, and prohibited effects before HQ reports success.

### 4.5 Local-first data handling

Operational state remains on the Mac. Secrets remain in macOS Keychain. GitHub contains source code, examples, fixtures, and documentation only. Channel messages, transcripts, voice data, company paths, user identifiers, tokens, and the runtime SQLite database are excluded from the repository.

## 5. Runtime Topology

```text
Slack Socket Mode ──────┐
Telegram Long Polling ──┼─> HQ Gateway on company Mac
Tailscale Private Web ──┘          │
                                   ├─> SQLite state and audit
                                   ├─> Project Registry and Policy Engine
                                   ├─> Codex HQ session
                                   └─> Orca Run / Task / Worker execution
                                                │
                                    Codex and Claude Code workers
                                                │
                                      cross-model verifier task
                                                │
                                      consolidated channel report
```

All externally initiated connections are outbound:

- Slack uses Socket Mode over an outbound WebSocket.
- Telegram uses Bot API long polling.
- Tailscale establishes an outbound encrypted tailnet connection.
- No router administration, public IP, inbound firewall rule, or port forwarding is required.
- Tailscale Serve exposes the dashboard only inside the tailnet. Tailscale Funnel is prohibited.

## 6. Technology Stack

### 6.1 Pilot baseline

- macOS host.
- Node.js 22.20 or a compatible Node.js 22 LTS release.
- TypeScript with strict compiler settings.
- pnpm 9.15 or compatible pnpm 9.
- Fastify for the local HTTP service.
- React and Vite for the private progressive web application.
- Slack Bolt for JavaScript in Socket Mode.
- grammY for Telegram long polling.
- SQLite in WAL mode through `better-sqlite3`.
- Zod for every external and persisted schema boundary.
- Pino structured logging with mandatory redaction.
- Vitest for unit and integration tests.
- Playwright for mobile dashboard end-to-end tests.
- macOS `launchd` for startup and restart.
- macOS Keychain for credentials.
- Tailscale Serve for private HTTPS access.
- OpenAI transcription as the default voice-to-text provider; a local Whisper adapter may be added later behind the same interface.

### 6.2 Agent baseline

- HQ agent: Codex CLI, using GPT-5.6 Sol for planning and final decisions.
- Routine classification and summary helper: GPT-5.6 Terra.
- Worker agents: Codex CLI and Claude Code.
- Current development-machine versions are Codex CLI 0.151.0 and Claude Code 2.1.223. The product detects capabilities at runtime rather than hard-coding these versions.
- Orca must be upgraded from the current 1.4.193 installation before implementation. The private pilot requires Orca 1.4.194 or a later compatible version and verifies capabilities at startup.

## 7. Repository and Package Boundaries

The dedicated repository is `/Users/j.jaeyo/Project/ETC/orca-hq` during local development.

```text
apps/
  gateway/                 # launchd-managed process and composition root
  web/                     # Tailscale-only mobile dashboard
packages/
  core/                    # command, task, approval, identity, and policy types
  persistence/             # SQLite schema, migrations, inbox, outbox, audit
  project-registry/        # Orca discovery, aliases, roles, checks, and locks
  orca-adapter/            # public Orca CLI JSON execution and receipt parsing
  codex-hq/                # HQ session lifecycle and structured prompt protocol
  worker-routing/          # Codex/Claude worker selection and verifier pairing
  slack-adapter/           # Socket Mode ingress, threads, approval actions
  telegram-adapter/        # long polling, voice messages, status notifications
  tailscale-adapter/       # Serve diagnostics and private identity context
  voice/                   # transcription interface and OpenAI implementation
  installer/               # setup, doctor, launchd, update, uninstall
  observability/           # redacted logging, metrics, diagnostic bundles
  test-support/            # fake channels, fake Orca CLI, fixtures, sandbox repo
templates/
  projects.example.yaml
  policies.example.yaml
  slack-app-manifest.yaml
docs/
  installation/
  operations/
  security/
  superpowers/
```

Each package exposes a typed interface and cannot import from an application composition root. Channel adapters cannot invoke Orca directly. They only create normalized Commands and consume Outbox messages.

## 8. Core Interfaces

### 8.1 Normalized command

```ts
type Channel = "slack" | "telegram" | "tailscale-web";

interface CommandEnvelope {
  commandId: string;
  idempotencyKey: string;
  channel: Channel;
  externalMessageId: string;
  externalThreadId?: string;
  principalId: string;
  receivedAt: string;
  text: string;
  attachments?: Array<{
    provider: "slack";
    providerFileId: string;
    name: string;
    mimeType?: string;
    sizeBytes?: number;
    contentSha256?: string;
  }>;
  transcript?: {
    provider: "openai" | "local-whisper";
    sourceFileSha256: string;
    confidence?: number;
  };
}
```

`idempotencyKey` is derived from channel, workspace or bot identity, and the provider message ID. The gateway rejects a second insert with the same key.

### 8.2 Project registry entry

```ts
interface ProjectRegistryEntry {
  projectKey: string;
  orcaProjectId: string;
  repoId?: string;
  absolutePath: string;
  canonicalRemote?: string;
  aliases: string[];
  customer?: string;
  product?: string;
  component: "frontend" | "backend" | "batch" | "mobile" | "docs" | "mixed";
  defaultBaseRef?: string;
  instructionsFiles: string[];
  setupPolicy: "run" | "skip" | "inherit";
  allowedOperations: RiskLevel[];
  requiredChecks: string[];
  sensitivePaths: string[];
  lockKey: string;
}
```

The pilot imports Orca project metadata and requires a human to approve aliases, component roles, sensitive paths, setup policy, and checks for the first five projects. It does not infer these values silently.

### 8.3 Risk levels

```ts
type RiskLevel = "L0" | "L1" | "L2" | "L3";
```

- L0: status, logs, documentation, and read-only investigation. Automatic.
- L1: isolated local worktree edits and local tests. HQ posts a route and plan preview, then may proceed automatically.
- L2: commit, push, and pull-request creation. Requires explicit Slack or Tailscale approval.
- L3: merge, deployment, database mutation, deletion, secret access, and production access. Requires a detailed preview and typed confirmation through Slack or Tailscale.
- Telegram cannot grant L2 or L3 approval.

### 8.4 HQ execution proposal

```ts
interface ExecutionProposal {
  proposalId: string;
  commandId: string;
  selectedProjectKey: string;
  routeCandidates: Array<{
    projectKey: string;
    score: number;
    evidence: string[];
  }>;
  baseRef?: string;
  allowedScope: string[];
  prohibitedEffects: string[];
  acceptanceCommands: string[];
  riskLevel: RiskLevel;
  tasks: Array<{
    localId: string;
    title: string;
    dependsOn: string[];
    role: "investigate" | "implement" | "verify" | "summarize";
    preferredAgent: "codex" | "claude";
  }>;
}
```

The policy engine validates an ExecutionProposal before any Orca mutation. The HQ model cannot override a policy rejection through prose.

## 9. Channel Responsibilities

### 9.1 Slack

- Official work record.
- Dedicated HQ channel and one thread per command.
- Text, file, and voice-clip ingestion when permitted by the Slack workspace.
- L2 and L3 approvals through interactive actions and typed confirmation.
- Final summaries for work initiated from Telegram when the command is classified as company work.
- Startup reconciliation using a persisted channel timestamp cursor to recover commands created while the Mac was offline.
- Bring-your-own Slack App created from the repository manifest during the private pilot.

### 9.2 Telegram

- Fast personal text and voice instructions.
- Progress, question, failure, and completion notifications.
- L0 and L1 operation requests.
- No L2 or L3 approval authority.
- Long-poll offset persisted transactionally after an update is stored.
- Only allowlisted bot user IDs and chat IDs are accepted.

### 9.3 Tailscale web

- Complete command and Task DAG overview.
- Project route evidence and confidence display.
- Worker, transcript, diff, test, and verification summaries.
- Stop, retry, and approval actions authorized by tailnet identity and a local session.
- L2 and L3 approvals.
- Private tailnet exposure through Tailscale Serve only.
- Unavailable while the host Mac is off; Slack and Telegram remain command queues.

## 10. Identity and Authorization

One local `principalId` maps the same person across channel identities:

```ts
interface PrincipalBinding {
  principalId: string;
  slackUserIds: string[];
  telegramUserIds: string[];
  telegramChatIds: string[];
  tailscaleLoginNames: string[];
  roles: Array<"owner" | "operator" | "viewer">;
}
```

- The pilot begins with one owner and individually invited coworkers.
- Unknown identities receive no project metadata and no command execution.
- Approval records include principal, channel, operation digest, timestamp, and expiry.
- Viewer can inspect authorized metadata but cannot dispatch or approve. Operator can request L0/L1 and approve L2. Only owner can approve L3.
- An approval is valid only for the immutable operation digest shown to the approver. The operation digest includes the proposal digest, requested operation, command digest, current diff hash when applicable, and target environment when applicable.
- Any change to project, branch, scope, diff, command, or environment invalidates the approval.

## 11. HQ and Model Roles

### 11.1 Codex HQ

Codex HQ:

- Normalizes intent after deterministic channel processing.
- Queries the Registry through a constrained tool interface.
- Produces route candidates and evidence.
- Asks a clarification instead of dispatching when confidence is insufficient.
- Creates a plan and Task DAG.
- Selects Codex or Claude Code workers.
- Supervises Orca questions, heartbeats, escalations, and completion.
- Creates verifier and fix Tasks.
- Produces the final report.

HQ uses one dedicated Orca terminal and one active coordinator identity. The gateway queues new commands while HQ is busy and injects one command at a time using a structured protocol.

### 11.2 Workers

- Codex and Claude Code are equal worker providers.
- A worker receives the exact project, worktree, base, file scope, acceptance commands, prohibited effects, Task ID, and Dispatch ID.
- Workers may not select unrelated projects or broaden scope.
- Workers report exactly once with explicit success or failure.
- Nested worker creation is disabled for the pilot.

### 11.3 Cross-model verification

- Codex implementation is verified by Claude Code.
- Claude Code implementation is verified by Codex.
- A verifier is read-only except for commands necessary to execute tests in the assigned worktree.
- A verifier report cannot modify files.
- Verification failure causes HQ to create a separate Fix Task.
- Two consecutive failed fix-and-verify cycles require user intervention.

## 12. Project Routing

Routing combines deterministic evidence and model judgment:

1. Exact aliases and explicit project keys.
2. Existing Slack thread or linked Task project context.
3. Customer, product, and component tags.
4. Canonical remote and absolute-path confirmation from Orca.
5. Model ranking of remaining candidates with human-readable evidence.

Automatic selection requires both:

- Top candidate score at least 0.85.
- Difference between top and second candidate at least 0.15.

Otherwise HQ asks the user to choose among project name, component, and absolute path. After selection, the Orca adapter resolves the exact selector again before dispatch.

## 13. Locks and Worktree Placement

- Read-only workers may share a checkout when their tools cannot mutate files.
- One editing Dispatch holds an exclusive `lockKey` lease.
- A lock contains command, Task, project, worktree, branch, owner Dispatch, acquisition time, heartbeat time, and expiry.
- Independent edits use a new top-level worktree based on the Registry default base.
- Work dependent on current uncommitted changes requires explicit current-worktree approval.
- HQ checks Orca worktrees and raw Git worktree/branch occupancy before dispatch.
- A dirty checkout, branch already checked out elsewhere, or conflicting lock blocks automatic dispatch.
- Worktree lineage and Git base are treated as separate decisions.

## 14. Command Lifecycle

1. Channel adapter receives text, file, or voice.
2. Voice adapter stores a content hash, transcribes it, and removes the temporary audio according to retention policy.
3. Identity service resolves an allowlisted principal.
4. Persistence inserts the Command using its idempotency key.
5. HQ produces route candidates and an ExecutionProposal.
6. Gateway posts project, base, scope, risk, and checks to the originating channel.
7. Policy engine either authorizes L0/L1, creates an L2/L3 approval request, or rejects the proposal.
8. Orca adapter confirms runtime health and project selectors.
9. HQ creates or selects the Run and creates the independent Tasks before dispatching.
10. Orca starts all ready workers allowed by locks and resource limits.
11. Gateway relays worker questions to the originating thread and persists replies.
12. After implementation `worker_done`, HQ starts a cross-model verifier Task.
13. Verification success produces a final summary. Failure produces a Fix Task or escalates after the retry ceiling.
14. Outbox sends the result to the originating channel and mirrors company-work results to Slack.
15. Settled workers are released using Orca receipts. Worktree deletion is a separate, policy-controlled operation.

## 15. Persistence

SQLite uses WAL mode and foreign keys. Migrations are versioned and transactional.

Required logical tables:

- `principals`
- `principal_bindings`
- `commands`
- `command_payloads`
- `project_registry_entries`
- `project_aliases`
- `execution_proposals`
- `approvals`
- `runs`
- `tasks`
- `dispatches`
- `worktree_locks`
- `channel_cursors`
- `inbox_events`
- `outbox_messages`
- `audit_events`
- `schema_migrations`

Raw provider payloads are minimized. Tokens are never stored. Voice audio is deleted after transcription unless a user explicitly requests retention for a diagnostic case. Transcripts and diffs are stored as references or redacted summaries unless the local retention setting enables full storage.

Slack attachment bytes are staged outside the repository, size-limited, content-hashed, and removed according to the same local retention policy. Provider download URLs and temporary paths are never persisted in Commands or audit events. Attachment content is untrusted input and cannot alter HQ policy or tool permissions.

## 16. Recovery and Error Handling

### 16.1 Gateway restart

`launchd` restarts the process. The gateway runs migrations, validates Keychain access, resumes channel cursors, drains the Outbox, compares nonterminal local Tasks with Orca state, and marks each item as resumable, completed, or requiring review.

### 16.2 Mac offline

- Telegram updates remain available through the Bot API offset mechanism.
- Slack is reconciled from the dedicated channel history cursor on startup.
- Tailscale web is unavailable and displays no misleading cloud status.
- Commands are processed in received order after identity and duplication checks.

### 16.3 Orca unavailable

The gateway does not mutate project state. It records a typed `orca_unavailable` condition, retries health checks with bounded backoff, and notifies channels. It does not open or update Orca while active-worker state is uncertain.

### 16.4 Worker failure

- Timeout, heartbeat, or idle state is not failure.
- A proven launch or process failure permits one fresh retry in a conflict-free placement.
- A second failure requires user intervention.
- Cleanup follows the exact Orca receipt recovery action; it never substitutes broad terminal close or worktree deletion.

### 16.5 Channel failure

Outbound messages remain in the Outbox with attempts, next-attempt time, and provider error. Delivery is idempotent where the provider supports a client message key. The dashboard shows pending delivery separately from Task completion.

### 16.6 HQ Codex failure

No other model assumes HQ authority. New commands remain queued. Active Orca workers may finish and their lifecycle messages remain in Orca. After Codex recovers, HQ reconciles the Run inbox before accepting another command.

### 16.7 Verification failure

The Task remains incomplete from the user's perspective. HQ creates a Fix Task carrying the verifier findings. After two failed cycles, HQ reports evidence and requests a decision.

## 17. Security

- Slack, Telegram, Tailscale, OpenAI, Orca, and agent credentials live in macOS Keychain.
- Logs redact authorization headers, tokens, cookies, voice URLs, signed URLs, prompts marked sensitive, and configured secret patterns.
- Web, Slack, Telegram, email, repository, and issue content is untrusted data, not agent instructions.
- Channel adapters cannot run shell commands.
- HQ tools expose typed operations, not an unrestricted shell, for routing, approvals, and channel delivery.
- Worker filesystem and network permissions remain constrained by their agent sandbox and project policy.
- L2/L3 approvals bind to a digest and expire after 15 minutes.
- L3 confirmation requires typing a generated operation phrase, not pressing one button.
- Tailscale Funnel and public dashboard binding are prohibited.
- The pilot has telemetry disabled.
- Diagnostic export is explicit, redacted, locally generated, and reviewable before sharing.
- Dependency lockfiles, automated secret scanning, dependency review, and release provenance are required before open source.

## 18. Installation and Operations Commands

The pilot provides these CLI commands:

```text
orca-hq setup
orca-hq doctor
orca-hq start
orca-hq stop
orca-hq status
orca-hq logs
orca-hq update
orca-hq uninstall
```

`setup` performs guided checks and never prints secrets. It verifies:

- Supported macOS and CPU architecture.
- Node and pnpm versions for source installation.
- Orca status, version, and required capabilities.
- Codex and Claude Code executables and authenticated readiness.
- Tailscale installation and tailnet connectivity.
- Slack Socket Mode credentials and channel access.
- Telegram bot credentials and allowlisted chat.
- Keychain read/write access.
- SQLite directory permissions.
- launchd installation.
- Orca project discovery and Registry review.

`doctor` is read-only and returns a machine-readable nonzero result for failed requirements. `uninstall` removes the launchd service and program files but preserves user data by default. Destructive data removal requires a separate explicit flag and confirmation.

## 19. Distribution Strategy

### 19.1 Private Pilot

- Private GitHub repository.
- 3–5 coworkers.
- Source installation using `git clone`, `pnpm install`, and `pnpm hq setup`.
- Each user brings their own Orca, Codex, Claude, Slack App, Telegram bot, OpenAI voice credential, and Tailscale account.
- macOS only.
- Company-specific Registry data remains outside Git.
- Pilot feedback is collected through issues and structured interviews.

Pilot promotion criteria:

- Five curated projects per user.
- Two weeks of use.
- Zero duplicate executions.
- Zero L2/L3 approval bypasses.
- At least 95% successful gateway restart recovery in scripted tests.
- At least 90% correct automatic project selection for unambiguous pilot commands.
- Every reported implementation success has verifier evidence.

### 19.2 Internal Beta

- Semantic versions and GitHub Releases.
- Repeatable installer, doctor, update, backup, migration, rollback, and uninstall.
- New user completes setup from documentation in 20 minutes or less.
- Upgrade and reinstall preserve local data.
- Slack manifest and credential instructions are tested from a clean workspace.
- Automated macOS Apple Silicon and Intel checks run in CI where runners are available.

### 19.3 Public Open Source

Before repository visibility changes to public:

- Company names, paths, remotes, aliases, fixtures, screenshots, transcripts, and policies are removed or replaced with synthetic examples.
- Commit history and Git objects pass secret and company-data scans.
- Provider and channel interfaces are documented as public extension contracts.
- License, security policy, code of conduct, contribution guide, support policy, privacy statement, and release policy are published.
- Releases are signed and include checksums, provenance, and an SBOM.
- Telemetry remains opt-in and disabled by default.
- External clean-machine installation, threat-model review, and dependency audit pass.
- Public npm or Homebrew distribution begins only after the source installer is stable.

## 20. Testing Strategy

### 20.1 Unit tests

- Command normalization and idempotency.
- Principal binding and authorization.
- Route thresholds and ambiguity handling.
- Risk classification and channel approval matrix.
- Approval digest changes and expiry.
- Lock acquisition, heartbeat, expiry, and conflict.
- Retry ceilings.
- Secret and log redaction.
- SQLite migration and transaction behavior.

### 20.2 Contract tests

- Versioned Orca JSON success and error receipts.
- Terminal-handle staleness and reacquisition.
- Task, Dispatch, worker completion, question, escalation, and release messages.
- Slack Socket Mode event and interactive-action fixtures.
- Slack history reconciliation.
- Telegram update, voice, and offset fixtures.
- Tailscale identity headers and unauthorized requests.
- Codex HQ structured proposal schema.

### 20.3 Integration tests

- Fake Slack and Telegram adapters write the same normalized Command.
- Gateway restart preserves Command, approval, lock, cursor, and Outbox state.
- A sandbox Git repository runs investigate, implement, verify, and summarize Tasks.
- Codex implementation invokes Claude verification and vice versa.
- A failed verifier creates a Fix Task and does not emit success.
- Provider disconnection leaves a pending Outbox record and later delivers it once.

### 20.4 End-to-end and chaos tests

- Telegram Korean voice command selects the expected sandbox project.
- Duplicate provider delivery creates one Task DAG.
- Telegram L2/L3 approval attempt is rejected.
- Slack and Tailscale approval execute the exact approved digest only.
- Kill gateway during a worker run and reconcile after restart.
- Restart Orca and recover current Run/Task state.
- Remove Codex authentication and confirm commands queue without Claude HQ takeover.
- Fail one worker launch and verify one safe retry.
- Fail two verification cycles and require user intervention.
- Disconnect Slack, Telegram, and Tailscale independently.
- Reboot the Mac and confirm launchd, Inbox reconciliation, and status reporting.

## 21. Pilot Acceptance Criteria

The private pilot is ready only when all of the following are demonstrated on a clean pilot Mac:

1. A coworker follows the documentation without developer intervention.
2. Slack, Telegram, and Tailscale channels all authenticate.
3. A Korean Telegram voice command reaches Codex HQ.
4. HQ shows project route evidence and a plan preview.
5. An unambiguous L1 change runs in an isolated worktree.
6. Codex and Claude Code can each implement a sandbox Task.
7. Each implementation is verified by the other model family.
8. Failed verification cannot generate a success report.
9. Telegram cannot approve commit, push, PR, merge, deployment, database, deletion, or secret operations.
10. Slack and Tailscale approvals are digest-bound and expire.
11. Gateway, Orca, channel, and Mac restarts preserve or safely reconcile state.
12. Every user-visible result links to an audit trail containing route, policy, approval, Dispatch, worker, verifier, and delivery evidence.

## 22. Implementation Phases

1. Repository foundation, package boundaries, schemas, SQLite, and fake adapters.
2. Project discovery, curated Registry, route scoring, policies, locks, and audit.
3. Slack and Telegram text channels, identity allowlists, Inbox, and Outbox.
4. Voice transcription and transcript confirmation.
5. Tailscale private dashboard.
6. Dedicated Codex HQ terminal and Orca read-only Tasks.
7. Isolated L1 implementation Tasks and worker lifecycle supervision.
8. Claude Code worker support and cross-model verification.
9. L2/L3 Slack and Tailscale approvals.
10. launchd, restart reconciliation, diagnostics, update, and uninstall.
11. Five-project private pilot and promotion-metric collection.
12. Internal Beta packaging and, after its gates pass, open-source preparation.

## 23. Deferred Extensions

The following are considered only after measured pilot demand:

- Temporal for workflows that must survive an offline Mac or run for days across hosts.
- LangGraph for more complex supervisor state than the Codex HQ protocol and SQLite state machine provide.
- n8n for additional business connectors beyond Slack and Telegram.
- Remote Orca worker hosts.
- Linux and Windows HQ hosting.
- Public Slack OAuth installation.
- Public npm and Homebrew packages.
- Local Whisper as the default transcription provider.
- Opt-in aggregate telemetry.

These extensions do not alter the pilot's core contracts: one Codex HQ authority, deterministic policy enforcement, Orca execution, cross-model verification, local-first state, and explicit risk approvals.
