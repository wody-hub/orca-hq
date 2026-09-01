# Orca HQ Channels and Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept authenticated Slack and Telegram text or Korean voice commands, normalize them once, and deliver durable threaded status messages without granting channel adapters execution authority.

**Architecture:** Channel packages translate provider events into `CommandEnvelope` values and persist them through an ingress port. Outbound delivery consumes the SQLite Outbox; Slack uses Socket Mode and history reconciliation, Telegram uses transactional long-poll offsets, and voice uses a provider-neutral transcription port.

**Tech Stack:** Slack Bolt, grammY, OpenAI audio transcription API, Zod, SQLite, Vitest

## Global Constraints

- Host platform is macOS; Node.js is 22.20 or a compatible Node.js 22 LTS release and pnpm is 9.15 or a compatible pnpm 9.
- Slack connects only with Socket Mode; Telegram connects only with long polling; neither requires inbound ports.
- Telegram can request only L0/L1 and can never approve L2/L3.
- Unknown identities receive no project metadata and no command execution.
- Raw provider payloads are minimized; voice audio is deleted after transcription by default.
- Tokens and credentials live in macOS Keychain and never appear in configuration files or logs.
- Channel adapters cannot invoke Orca, shell commands, Codex, or Claude Code.
- Tests use provider fixtures and fakes; no test contacts a real Slack workspace, Telegram bot, or OpenAI endpoint.

---

### Task 1: Cross-channel principal binding and ingress port

**Files:**
- Create: `packages/core/src/ports.ts`
- Create: `packages/core/src/idempotency.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/persistence/src/store.ts`
- Test: `packages/core/test/identity-resolution.test.ts`

**Interfaces:**
- Consumes: `PrincipalBinding`, `CommandEnvelope`, and `ControlStore` from Plan 1.
- Produces: `IdentityResolver.resolve(channel, userId, contextId)`, `CommandIngress.accept(input)`, and `deriveIdempotencyKey(providerIdentity, messageId)`.

- [ ] **Step 1: Write identity denial and stable-key tests**

```ts
it("maps the owner's Slack and Telegram identities to one principal", () => {
  expect(resolver.resolve("slack", "U123", "T123")).toMatchObject({ principalId: "owner", roles: ["owner"] });
  expect(resolver.resolve("telegram", "7788", "9900")).toMatchObject({ principalId: "owner" });
});

it("reveals no metadata to an unknown identity", () => {
  expect(resolver.resolve("telegram", "unknown", "9900")).toEqual({ kind: "denied" });
});

it("derives the same idempotency key for a redelivered provider message", () => {
  expect(deriveIdempotencyKey("slack:T123", "171.001")).toBe(deriveIdempotencyKey("slack:T123", "171.001"));
});
```

- [ ] **Step 2: Run tests and confirm the ingress boundary is absent**

Run: `pnpm test packages/core/test/identity-resolution.test.ts`

Expected: FAIL because resolver, ingress, and idempotency functions are missing.

- [ ] **Step 3: Implement fail-closed resolution and normalization**

```ts
export function deriveIdempotencyKey(providerIdentity: string, messageId: string): string {
  return createHash("sha256").update(`${providerIdentity}\u0000${messageId}`).digest("hex");
}

export interface CommandIngress {
  accept(input: CommandEnvelope): Promise<{ kind: "accepted" | "duplicate"; commandId: string }>;
}
```

Identity matching must require both Telegram user and allowlisted chat, Slack user and workspace, or Tailscale login and local session. Denied responses must contain no route candidates, filesystem paths, aliases, or project names.

- [ ] **Step 4: Verify identity and duplicate behavior**

Run: `pnpm test packages/core/test/identity-resolution.test.ts packages/persistence/test/store.test.ts && pnpm typecheck`

Expected: one principal spans approved identities and redelivery returns `duplicate` without a second inbox event.

- [ ] **Step 5: Commit**

```bash
git add packages/core packages/persistence
git commit -m "feat(identity): add authenticated command ingress"
```

### Task 2: Slack Socket Mode ingress, threads, actions, and reconciliation

**Files:**
- Create: `packages/slack-adapter/package.json`
- Create: `packages/slack-adapter/src/events.ts`
- Create: `packages/slack-adapter/src/attachments.ts`
- Create: `packages/slack-adapter/src/reconcile.ts`
- Create: `packages/slack-adapter/src/outbound.ts`
- Create: `packages/slack-adapter/src/index.ts`
- Create: `packages/slack-adapter/test/fixtures/message.json`
- Test: `packages/slack-adapter/test/slack-adapter.test.ts`
- Create: `templates/slack-app-manifest.yaml`

**Interfaces:**
- Consumes: `CommandIngress`, `IdentityResolver`, channel cursor store, and outbox delivery receipt port.
- Produces: `createSlackAdapter(config, ports)`, normalized Slack commands and attachment metadata, thread replies, interactive approval events, and `reconcileSlackHistory(cursor)`.

- [ ] **Step 1: Write fixture-based event and cursor tests**

```ts
it("normalizes one channel message and keeps its thread", async () => {
  await adapter.handleEvent(slackMessageFixture);
  expect(ingress.accept).toHaveBeenCalledWith(expect.objectContaining({
    channel: "slack", externalMessageId: "171.001", externalThreadId: "171.001", principalId: "owner"
  }));
});

it("advances the history cursor only after ingress stores the event", async () => {
  ingress.accept.mockRejectedValueOnce(new Error("disk unavailable"));
  await expect(adapter.reconcile()).rejects.toThrow("disk unavailable");
  expect(cursorStore.save).not.toHaveBeenCalled();
});

it("stages a size-limited Slack file without persisting its URL", async () => {
  await adapter.handleEvent(slackMessageWithFileFixture);
  expect(ingress.accept).toHaveBeenCalledWith(expect.objectContaining({
    attachments: [expect.objectContaining({ provider: "slack", name: "requirements.pdf", contentSha256: expect.any(String) })]
  }));
  expect(JSON.stringify(ingress.accept.mock.calls)).not.toContain("https://files.slack.com/");
});
```

- [ ] **Step 2: Run tests and verify adapter absence**

Run: `pnpm test packages/slack-adapter/test/slack-adapter.test.ts`

Expected: FAIL because `createSlackAdapter` does not exist.

- [ ] **Step 3: Implement Socket Mode translation and durable delivery**

```ts
app.event("message", async ({ event }) => {
  const parsed = SlackMessageEventSchema.safeParse(event);
  if (!parsed.success || parsed.data.subtype) return;
  const identity = identities.resolve("slack", parsed.data.user, config.teamId);
  if (identity.kind === "denied") return;
  await ingress.accept(toCommandEnvelope(parsed.data, identity.principalId, config.teamId));
});
```

Outbound sends must use the originating thread. Slack files are capped at the configured byte limit, streamed to the runtime staging directory, hashed, and represented in the Command by metadata only; download URLs and temporary paths are not persisted. File bytes and extracted content are untrusted and are deleted by retention policy. Interactive action payloads are normalized but remain untrusted approval requests; approval validation belongs to the approval service. The manifest must request the minimum Socket Mode scopes required for messages, history reconciliation, files explicitly enabled by the operator, and interactive actions.

- [ ] **Step 4: Verify replay, thread, denial, and retry contracts**

Run: `pnpm test packages/slack-adapter && pnpm typecheck`

Expected: history replay produces no duplicate command, unknown users are silently denied, and failed delivery remains in Outbox.

- [ ] **Step 5: Commit**

```bash
git add packages/slack-adapter templates/slack-app-manifest.yaml pnpm-lock.yaml
git commit -m "feat(slack): add Socket Mode command channel"
```

### Task 3: Telegram long-poll text ingress and transactional offsets

**Files:**
- Create: `packages/telegram-adapter/package.json`
- Create: `packages/telegram-adapter/src/updates.ts`
- Create: `packages/telegram-adapter/src/polling.ts`
- Create: `packages/telegram-adapter/src/outbound.ts`
- Create: `packages/telegram-adapter/src/index.ts`
- Create: `packages/telegram-adapter/test/fixtures/text-update.json`
- Test: `packages/telegram-adapter/test/telegram-adapter.test.ts`

**Interfaces:**
- Consumes: `CommandIngress`, `IdentityResolver`, cursor store, Outbox, and risk request validator.
- Produces: `createTelegramAdapter(config, ports)`, normalized Telegram commands, progress messages, and persisted `update_id + 1` offsets.

- [ ] **Step 1: Write allowlist, offset, and approval-denial tests**

```ts
it("stores an update before advancing its offset", async () => {
  await adapter.handleUpdate(textUpdate);
  expect(ingress.accept.mock.invocationCallOrder[0]).toBeLessThan(cursorStore.save.mock.invocationCallOrder[0]);
  expect(cursorStore.save).toHaveBeenCalledWith("telegram", 501);
});

it("rejects Telegram approval callbacks for L2 and L3", async () => {
  await adapter.handleUpdate(approvalCallback("L2"));
  expect(approvalPort.request).not.toHaveBeenCalled();
  expect(outbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({ template: "approval_channel_not_allowed" }));
});
```

- [ ] **Step 2: Run tests against the missing adapter**

Run: `pnpm test packages/telegram-adapter/test/telegram-adapter.test.ts`

Expected: FAIL because polling and update translation are undefined.

- [ ] **Step 3: Implement allowlisted long polling**

```ts
bot.on("message:text", async (ctx) => {
  const identity = identities.resolve("telegram", String(ctx.from.id), String(ctx.chat.id));
  if (identity.kind === "denied") return;
  await ingress.accept(toTelegramCommand(ctx.update, identity.principalId, config.botIdentity));
  await cursors.save("telegram", ctx.update.update_id + 1);
});
```

The poll loop must start from the persisted offset, cap retries with jittered backoff, stop on abort signal, and never commit an offset for an event that failed durable insertion. Provider 429 retry-after values override local backoff.

- [ ] **Step 4: Verify crash and redelivery semantics**

Run: `pnpm test packages/telegram-adapter && pnpm typecheck`

Expected: a crash between insert and offset save causes safe redelivery and one command; unknown user or chat IDs create no rows.

- [ ] **Step 5: Commit**

```bash
git add packages/telegram-adapter pnpm-lock.yaml
git commit -m "feat(telegram): add long-poll command channel"
```

### Task 4: Korean voice ingestion and retention-safe transcription

**Files:**
- Create: `packages/voice/package.json`
- Create: `packages/voice/src/transcriber.ts`
- Create: `packages/voice/src/openai-transcriber.ts`
- Create: `packages/voice/src/audio-retention.ts`
- Create: `packages/voice/src/index.ts`
- Modify: `packages/telegram-adapter/src/updates.ts`
- Modify: `packages/slack-adapter/src/events.ts`
- Test: `packages/voice/test/transcriber.test.ts`
- Test: `packages/telegram-adapter/test/voice-update.test.ts`

**Interfaces:**
- Consumes: provider media download streams and a Keychain-backed OpenAI credential provider.
- Produces: `VoiceTranscriber.transcribe(input): Promise<Transcript>`, SHA-256 source hash, Korean text, and guaranteed temporary-file cleanup.

- [ ] **Step 1: Write hash, language, and cleanup tests**

```ts
it("requests Korean transcription and deletes audio after success", async () => {
  const result = await service.ingest(fakeAudioStream(), { language: "ko", retain: false });
  expect(openai.transcribe).toHaveBeenCalledWith(expect.objectContaining({ language: "ko" }));
  expect(result.sourceFileSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(await exists(result.temporaryPath)).toBe(false);
});

it("deletes audio after provider failure", async () => {
  openai.transcribe.mockRejectedValueOnce(new Error("provider unavailable"));
  await expect(service.ingest(fakeAudioStream(), { language: "ko", retain: false })).rejects.toThrow();
  expect(await listVoiceTempFiles()).toEqual([]);
});
```

- [ ] **Step 2: Run tests and confirm the provider port is missing**

Run: `pnpm test packages/voice/test/transcriber.test.ts`

Expected: FAIL because voice ingestion is undefined.

- [ ] **Step 3: Implement streaming temp storage and `finally` cleanup**

```ts
export async function ingestVoice(stream: Readable, options: VoiceOptions): Promise<Transcript> {
  const file = await temporaryAudioFile();
  try {
    const sourceFileSha256 = await writeAndHash(stream, file.path);
    const response = await options.transcriber.transcribe({ path: file.path, language: "ko" });
    return TranscriptSchema.parse({ ...response, provider: options.transcriber.id, sourceFileSha256 });
  } finally {
    if (!options.retain) await file.remove();
  }
}
```

Adapters must require an explicit transcript confirmation when confidence is provided below `0.80`; otherwise the transcript becomes command text. Voice download URLs, bytes, and temporary paths must never enter audit data or logs.

- [ ] **Step 4: Verify both channel fixtures and retention rules**

Run: `pnpm test packages/voice packages/slack-adapter packages/telegram-adapter && pnpm typecheck`

Expected: Korean transcript becomes one normalized command, low confidence requests confirmation, and no temporary audio remains after any outcome.

- [ ] **Step 5: Commit**

```bash
git add packages/voice packages/slack-adapter packages/telegram-adapter pnpm-lock.yaml
git commit -m "feat(voice): transcribe Korean channel commands"
```

### Task 5: Shared Outbox dispatcher and channel recovery contract

**Files:**
- Create: `packages/core/src/channel-message.ts`
- Create: `packages/persistence/src/outbox-dispatcher.ts`
- Modify: `packages/slack-adapter/src/outbound.ts`
- Modify: `packages/telegram-adapter/src/outbound.ts`
- Test: `packages/persistence/test/outbox-dispatcher.test.ts`

**Interfaces:**
- Consumes: channel-neutral `OutboundMessage`, provider `deliver()` ports, attempts, and provider retry hints.
- Produces: `OutboxDispatcher.tick(now)`, terminal `delivered` receipts, and visible `pending_delivery` state separate from task completion.

- [ ] **Step 1: Write disconnection and eventual-delivery tests**

```ts
it("keeps completion pending when Slack is disconnected", async () => {
  slack.deliver.mockRejectedValueOnce(retryable("socket_closed"));
  await dispatcher.tick(now);
  expect(store.getOutbox("m1")).toMatchObject({ state: "pending", attempts: 1 });
  expect(store.getTask("t1")).toMatchObject({ state: "completed" });
});

it("marks the same message delivered after reconnect", async () => {
  await dispatcher.tick(nextAttempt);
  expect(store.getOutbox("m1")).toMatchObject({ state: "delivered" });
});
```

- [ ] **Step 2: Run the test and confirm the shared dispatcher is absent**

Run: `pnpm test packages/persistence/test/outbox-dispatcher.test.ts`

Expected: FAIL because `OutboxDispatcher` is not defined.

- [ ] **Step 3: Implement claim, deliver, acknowledge, and retry**

```ts
async tick(now: string): Promise<void> {
  const message = this.store.claimOutbox(now, this.workerId);
  if (!message) return;
  try {
    const receipt = await this.providers[message.channel].deliver(message);
    this.store.markOutboxDelivered(message.id, receipt.providerMessageId);
  } catch (error) {
    this.store.rescheduleOutbox(message.id, retrySchedule(message.attempts + 1, error));
  }
}
```

Provider message IDs must be stored, logs must redact message bodies marked sensitive, and non-retryable provider rejection must create a visible delivery failure audit event without changing the underlying task result.

When Telegram initiates a command classified as company work, the dispatcher must enqueue the redacted final summary to the configured Slack HQ channel as a second idempotent Outbox message while retaining Telegram as the originating response channel.

- [ ] **Step 4: Run the channel delivery suite**

Run: `pnpm test packages/persistence packages/slack-adapter packages/telegram-adapter packages/voice && pnpm typecheck && pnpm build`

Expected: disconnected channels recover, duplicate inbound events stay deduplicated, and adapters have no Orca or shell dependency.

- [ ] **Step 5: Commit**

```bash
git add packages/core packages/persistence packages/slack-adapter packages/telegram-adapter
git commit -m "feat(channels): add durable outbound delivery"
```

## Plan 2 Completion Gate

Run: `pnpm test && pnpm typecheck && pnpm build`

Expected evidence:

- Slack Socket Mode and Telegram long polling normalize fixtures into the same command schema.
- Provider replay creates exactly one command.
- Telegram approval attempts for L2/L3 are denied before approval persistence.
- Voice is transcribed as Korean, hashed, confirmed when low confidence, and removed after processing.
- Channel outage changes delivery state without falsifying task completion state.
