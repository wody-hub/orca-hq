import { createHash } from "node:crypto";

export function deriveIdempotencyKey(providerIdentity: string, messageId: string): string {
  return createHash("sha256").update(`${providerIdentity}\u0000${messageId}`).digest("hex");
}
