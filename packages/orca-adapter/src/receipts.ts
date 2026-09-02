import { z } from "zod";

const OrcaMetaSchema = z.record(z.unknown());

const OrcaSuccessReceiptSchema = z.object({
  id: z.string().min(1),
  ok: z.literal(true),
  result: z.unknown(),
  _meta: OrcaMetaSchema.optional()
}).strict();

const OrcaFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1)
}).passthrough();

const OrcaFailureReceiptSchema = z.union([
  z.object({
    id: z.string().min(1),
    ok: z.literal(false),
    error: OrcaFailureSchema,
    _meta: OrcaMetaSchema.optional()
  }).strict(),
  z.object({
    id: z.string().min(1),
    ok: z.literal(false),
    result: OrcaFailureSchema,
    _meta: OrcaMetaSchema.optional()
  }).strict()
]);

export const OrcaReceiptSchema = z.union([
  OrcaSuccessReceiptSchema,
  OrcaFailureReceiptSchema
]);

export const OrcaStatusReceiptSchema = z.object({
  id: z.string().min(1),
  ok: z.literal(true),
  result: z.object({
    runtime: z.object({
      state: z.string().min(1),
      reachable: z.boolean(),
      appVersion: z.string().min(1),
      capabilities: z.array(z.string().min(1))
    }).passthrough()
  }).passthrough(),
  _meta: OrcaMetaSchema.optional()
}).strict();

export const OrcaSkillResponseSchema = z.object({
  name: z.enum(["orca-cli", "orchestration"]),
  full: z.boolean(),
  markdown: z.string().min(1)
}).passthrough();

const OrcaProjectSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  displayName: z.string().min(1),
  kind: z.string().min(1)
}).passthrough();

const OrcaProjectListReceiptSchema = z.object({
  id: z.string().min(1),
  ok: z.literal(true),
  result: z.object({
    repos: z.array(OrcaProjectSchema)
  }).passthrough(),
  _meta: OrcaMetaSchema.optional()
}).strict();

export type OrcaReceipt = z.infer<typeof OrcaSuccessReceiptSchema>;
export type OrcaReceiptEnvelope = z.infer<typeof OrcaReceiptSchema>;
export type OrcaStatusReceipt = z.infer<typeof OrcaStatusReceiptSchema>;
export type OrcaSkillResponse = z.infer<typeof OrcaSkillResponseSchema>;
export type OrcaProject = Readonly<Pick<
  z.infer<typeof OrcaProjectSchema>,
  "id" | "path" | "displayName" | "kind"
>>;

export class OrcaInvalidReceiptError extends Error {
  readonly code = "invalid_orca_receipt";
  readonly retryable = false;

  constructor() {
    super("Orca returned an invalid JSON receipt");
    this.name = "OrcaInvalidReceiptError";
  }
}

export class OrcaCommandError extends Error {
  readonly code = "orca_command_failed";
  readonly retryable = false;
  readonly orcaCode?: string | undefined;

  constructor(orcaCode?: string) {
    super("Orca rejected the command");
    this.name = "OrcaCommandError";
    if (orcaCode !== undefined && /^[a-z0-9_]{1,80}$/.test(orcaCode)) {
      this.orcaCode = orcaCode;
    }
  }
}

export class OrcaStaleHandleError extends Error {
  readonly code = "orca_stale_handle";
  readonly retryable = false;

  constructor() {
    super("Orca rejected a stale runtime handle");
    this.name = "OrcaStaleHandleError";
  }
}

function invalidReceipt(): never {
  throw new OrcaInvalidReceiptError();
}

export function parseOrcaReceipt(value: unknown): OrcaReceiptEnvelope {
  const parsed = OrcaReceiptSchema.safeParse(value);
  return parsed.success ? parsed.data : invalidReceipt();
}

export function parseOrcaStatusReceipt(value: unknown): OrcaStatusReceipt {
  const parsed = OrcaStatusReceiptSchema.safeParse(value);
  return parsed.success ? parsed.data : invalidReceipt();
}

export function parseOrcaSkillResponse(value: unknown): OrcaSkillResponse {
  const parsed = OrcaSkillResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : invalidReceipt();
}

export function parseOrcaProjects(receipt: OrcaReceipt): readonly OrcaProject[] {
  const parsed = OrcaProjectListReceiptSchema.safeParse(receipt);
  if (!parsed.success) return invalidReceipt();
  return parsed.data.result.repos.map(({ id, path, displayName, kind }) => Object.freeze({
    id,
    path,
    displayName,
    kind
  }));
}

export function assertSuccessfulReceipt(
  receipt: OrcaReceiptEnvelope
): asserts receipt is OrcaReceipt {
  if (receipt.ok) return;
  const failure = "error" in receipt ? receipt.error : receipt.result;
  const orcaCode = failure.code;
  if (orcaCode === "terminal_handle_stale") throw new OrcaStaleHandleError();
  throw new OrcaCommandError(typeof orcaCode === "string" ? orcaCode : undefined);
}
