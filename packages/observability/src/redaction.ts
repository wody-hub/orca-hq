export const REDACTED_VALUE = "[Redacted]";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "prompt",
  "signedurl",
  "token",
  "transcript",
  "voiceurl"
]);

export interface RedactionOptions {
  readonly secretPatterns?: readonly RegExp[];
  readonly pathDisclosure?: "basename" | "redact";
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

function isPathKey(key: string): boolean {
  return /(?:path|file|directory|dir)$/i.test(key);
}

function redactString(value: string, secretPatterns: readonly RegExp[]): string {
  let redacted = value;
  for (const pattern of secretPatterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    redacted = redacted.replace(new RegExp(pattern.source, flags), REDACTED_VALUE);
  }
  return redacted;
}

function basename(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  const segment = normalized.slice(normalized.lastIndexOf("/") + 1);
  return segment === "" ? REDACTED_VALUE : segment;
}

export function redactDeep(value: unknown, options: RedactionOptions = {}): unknown {
  const secretPatterns = options.secretPatterns ?? [];

  const visit = (candidate: unknown, key?: string): unknown => {
    if (key !== undefined && isSensitiveKey(key)) return REDACTED_VALUE;
    if (typeof candidate === "string") {
      if (key !== undefined && isPathKey(key)) {
        return options.pathDisclosure === "redact"
          ? REDACTED_VALUE
          : basename(redactString(candidate, secretPatterns));
      }
      return redactString(candidate, secretPatterns);
    }
    if (Array.isArray(candidate)) return candidate.map((item) => visit(item));
    if (candidate !== null && typeof candidate === "object") {
      return Object.fromEntries(Object.entries(candidate).map(([entryKey, entryValue]) => [
        entryKey,
        visit(entryValue, entryKey)
      ]));
    }
    return candidate;
  };

  return visit(value);
}

export function isRedactedField(key: string): boolean {
  return isSensitiveKey(key);
}
