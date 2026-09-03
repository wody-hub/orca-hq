import type { AuthenticatedPrincipal, IdentityResolver, PrincipalBinding } from "@orca-hq/core";

import type { LocalSessionService } from "./session.js";

export type RequestHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

export interface TailnetLoginInput {
  readonly remoteAddress: string;
  readonly headers: RequestHeaders;
}

export type TailnetLogin = AuthenticatedPrincipal & Readonly<{ loginName: string }>;
export type TailnetIdentityResult = AuthenticatedPrincipal | Readonly<{ kind: "denied" }>;

export interface TailnetPrincipalInput extends TailnetLoginInput {
  readonly session: string | undefined;
  readonly bindings: readonly PrincipalBinding[];
  readonly resolver: IdentityResolver;
  readonly sessions: LocalSessionService;
}

const denied = Object.freeze({ kind: "denied" as const });

function withoutPort(address: string): string | undefined {
  const trimmed = address.trim();
  const bracketed = /^\[([^\]]+)](?::\d+)?$/.exec(trimmed);
  if (bracketed !== null) return bracketed[1];
  const ipv4WithPort = /^(127\.0\.0\.1)(?::\d+)?$/.exec(trimmed);
  if (ipv4WithPort !== null) return ipv4WithPort[1];
  return trimmed;
}

export function isTrustedServePeer(remoteAddress: string): boolean {
  const normalized = withoutPort(remoteAddress)?.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

function loginHeader(headers: RequestHeaders): string | undefined {
  const entries = Object.entries(headers).filter(([name]) => name.toLowerCase() === "tailscale-user-login");
  if (entries.length !== 1) return undefined;
  const value = entries[0]?.[1];
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes(",")) return undefined;
  return value;
}

function matchingBindings(loginName: string, bindings: readonly PrincipalBinding[]): readonly PrincipalBinding[] {
  return bindings.filter((binding) => binding.tailscaleLoginNames.filter((login) => login === loginName).length === 1);
}

export function resolveTailnetLogin(
  input: TailnetLoginInput,
  bindings: readonly PrincipalBinding[]
): TailnetLogin | Readonly<{ kind: "denied" }> {
  if (!isTrustedServePeer(input.remoteAddress)) return denied;
  const loginName = loginHeader(input.headers);
  if (loginName === undefined) return denied;
  const matches = matchingBindings(loginName, bindings);
  const binding = matches[0];
  if (matches.length !== 1 || binding === undefined) return denied;
  return Object.freeze({
    principalId: binding.principalId,
    roles: Object.freeze([...binding.roles]),
    loginName
  });
}

export function resolveTailnetPrincipal(input: TailnetPrincipalInput): TailnetIdentityResult {
  const login = resolveTailnetLogin(input, input.bindings);
  if ("kind" in login || input.session === undefined) return denied;
  const session = input.sessions.verify(input.session, login);
  if ("kind" in session) return denied;
  const identity = input.resolver.resolve("tailscale-web", login.loginName, session.principalId);
  if ("kind" in identity || identity.principalId !== session.principalId ||
    identity.principalId !== login.principalId) return denied;
  return identity;
}
