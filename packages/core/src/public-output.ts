const displayTextLimit = 400;
const resultTextLimit = 64 * 1024;
const escape = String.fromCharCode(0x1b);
const operatingSystemCommand = new RegExp(`${escape}\\][\\s\\S]*?(?:\\u0007|${escape}\\\\|$)`, "g");
const controlSequence = new RegExp(`${escape}\\[[0-9;:?]*[ -/]*[@-~]`, "g");
const remainingEscape = new RegExp(`${escape}[\\s\\S]?`, "g");
const controlCharacters = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g");

function stripControls(value: string, preserveLines: boolean): string {
  return value.replace(operatingSystemCommand, "").replace(controlSequence, "").replace(remainingEscape, "")
    .replace(preserveLines ? /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu : controlCharacters, " ");
}

export function sanitizeDisplayText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = stripControls(value, false).replace(/\s+/gu, " ").trim();
  return text.length <= displayTextLimit ? text : `${text.slice(0, displayTextLimit - 1)}…`;
}

export function sanitizeResultText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = stripControls(value, true).replace(/\r\n?/gu, "\n").trim();
  return boundResultText(text);
}

function redactCredentials(value: string): string {
  return stripControls(value, true)
    .replace(/\r\n?/gu, "\n")
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gu, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/gu, "[REDACTED]")
}

/** Removes credentials before public CLI/HQ output is stored or displayed. */
export function redactPublicText(value: unknown): string {
  if (typeof value !== "string") return "";
  return boundResultText(redactCredentials(value).replace(/\s+/gu, " ").trim());
}

/** Redacts a durable result without rewriting harmless spaces or line breaks. */
export function redactPublicResultText(value: unknown): string {
  if (typeof value !== "string") return "";
  return boundResultText(redactCredentials(value));
}

function boundResultText(text: string): string {
  return text.length <= resultTextLimit
    ? text
    : `${text.slice(0, resultTextLimit)}\n[표시 길이 제한으로 이후 내용을 생략했습니다.]`;
}
