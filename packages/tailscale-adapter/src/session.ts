import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const LOCAL_SESSION_COOKIE_NAME = "__Host-orca_hq_session";
export const LOCAL_SESSION_TTL_SECONDS = 900;
const LOCAL_SESSION_TTL_MS = LOCAL_SESSION_TTL_SECONDS * 1_000;

export type LocalSessionPrincipal = Readonly<{
  principalId: string;
  loginName: string;
}>;

type LocalSessionPayload = LocalSessionPrincipal & Readonly<{
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}>;

export type LocalSessionVerification = LocalSessionPayload | Readonly<{ kind: "denied" }>;

export interface LocalSessionService {
  startLocalSession(principal: LocalSessionPrincipal): Readonly<{
    token: string;
    cookie: string;
    expiresAt: string;
  }>;
  verify(token: string, expected: LocalSessionPrincipal): LocalSessionVerification;
}

export interface LocalSessionOptions {
  readonly signingKey: Uint8Array;
  readonly now?: () => Date;
  readonly nonce?: () => string;
}

const denied = Object.freeze({ kind: "denied" as const });

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : undefined;
}

function sameSecret(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function validPrincipal(value: LocalSessionPrincipal): boolean {
  return value.principalId.trim().length > 0 && value.loginName.trim().length > 0 &&
    value.principalId === value.principalId.trim() && value.loginName === value.loginName.trim();
}

function parsePayload(value: Buffer): LocalSessionPayload | undefined {
  try {
    const parsed: unknown = JSON.parse(value.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const payload = parsed as Record<string, unknown>;
    if (typeof payload.principalId !== "string" || typeof payload.loginName !== "string" ||
      typeof payload.issuedAt !== "number" || typeof payload.expiresAt !== "number" ||
      typeof payload.nonce !== "string") return undefined;
    const candidate: LocalSessionPayload = {
      principalId: payload.principalId,
      loginName: payload.loginName,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
      nonce: payload.nonce
    };
    return validPrincipal(candidate) && Number.isSafeInteger(candidate.issuedAt) &&
      Number.isSafeInteger(candidate.expiresAt) && candidate.nonce.length > 0 ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function createLocalSessionService(options: LocalSessionOptions): LocalSessionService {
  const signingKey = Buffer.from(options.signingKey);
  if (signingKey.length < 32) throw new TypeError("Local session signing key requires at least 32 bytes");
  const now = options.now ?? (() => new Date());
  const nonce = options.nonce ?? (() => randomBytes(32).toString("base64url"));
  const sign = (payload: string): string => createHmac("sha256", signingKey).update(payload).digest("base64url");

  const verify = (token: string, expected: LocalSessionPrincipal): LocalSessionVerification => {
    if (!validPrincipal(expected)) return denied;
    const parts = token.split(".");
    const payloadPart = parts[0];
    const signaturePart = parts[1];
    if (parts.length !== 2 || payloadPart === undefined || signaturePart === undefined) return denied;
    const receivedSignature = decodeBase64Url(signaturePart);
    const payloadBytes = decodeBase64Url(payloadPart);
    if (receivedSignature === undefined || payloadBytes === undefined) return denied;
    const expectedSignature = Buffer.from(sign(payloadPart), "base64url");
    if (!sameSecret(receivedSignature, expectedSignature)) return denied;
    const payload = parsePayload(payloadBytes);
    if (payload === undefined || payload.principalId !== expected.principalId ||
      payload.loginName !== expected.loginName) return denied;
    const currentTime = now().getTime();
    if (payload.issuedAt > currentTime || payload.expiresAt <= currentTime ||
      payload.expiresAt - payload.issuedAt !== LOCAL_SESSION_TTL_MS) return denied;
    return payload;
  };

  return Object.freeze({
    startLocalSession(principal: LocalSessionPrincipal) {
      if (!validPrincipal(principal)) throw new TypeError("Local session principal is invalid");
      const issuedAt = now().getTime();
      const nonceValue = nonce();
      if (nonceValue.length === 0) throw new TypeError("Local session nonce is invalid");
      const payload: LocalSessionPayload = {
        principalId: principal.principalId,
        loginName: principal.loginName,
        issuedAt,
        expiresAt: issuedAt + LOCAL_SESSION_TTL_MS,
        nonce: nonceValue
      };
      const payloadPart = base64Url(JSON.stringify(payload));
      const token = `${payloadPart}.${sign(payloadPart)}`;
      return Object.freeze({
        token,
        cookie: `${LOCAL_SESSION_COOKIE_NAME}=${token}; Max-Age=${LOCAL_SESSION_TTL_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Strict`,
        expiresAt: new Date(payload.expiresAt).toISOString()
      });
    },
    verify
  });
}

export function readLocalSessionCookie(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const values = value.split(";").map((part) => part.trim()).filter(Boolean);
  const matches = values.filter((part) => part.startsWith(`${LOCAL_SESSION_COOKIE_NAME}=`));
  if (matches.length !== 1 || matches[0] === undefined) return undefined;
  const token = matches[0].slice(LOCAL_SESSION_COOKIE_NAME.length + 1);
  return token.length > 0 ? token : undefined;
}
