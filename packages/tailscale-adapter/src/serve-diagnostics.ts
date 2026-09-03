import { isTrustedServePeer } from "./identity.js";

export interface ServeConfiguration {
  readonly funnelEnabled: boolean;
  readonly publicExposure: boolean;
  readonly gatewayBindAddress: string;
  readonly gatewayHttpPort: number;
  readonly upstreamAddress: string;
  readonly httpsEnabled: boolean;
  readonly advertisedHost: string;
  readonly expectedTailnetDnsSuffix: string;
}

export type ServeDiagnosticReason =
  | "funnel_enabled"
  | "public_exposure"
  | "gateway_not_loopback"
  | "upstream_not_loopback"
  | "upstream_port_mismatch"
  | "https_disabled"
  | "unexpected_tailnet_host";

export type ServeDiagnostics = Readonly<{ kind: "valid" }> | Readonly<{
  kind: "invalid";
  reasons: readonly ServeDiagnosticReason[];
}>;

function hostWithinSuffix(host: string, suffix: string): boolean {
  const normalizedHost = host.toLowerCase().replace(/\.$/, "");
  const normalizedSuffix = suffix.toLowerCase().replace(/^\./, "").replace(/\.$/, "");
  return normalizedSuffix.length > 0 &&
    (normalizedHost === normalizedSuffix || normalizedHost.endsWith(`.${normalizedSuffix}`));
}

function portFromAddress(address: string): number | undefined {
  const trimmed = address.trim();
  const bracketed = /^\[[^\]]+]:(\d+)$/.exec(trimmed);
  const ipv4 = /^127\.0\.0\.1:(\d+)$/.exec(trimmed);
  const value = bracketed?.[1] ?? ipv4?.[1];
  if (value === undefined) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : undefined;
}

export function diagnoseServeConfiguration(configuration: ServeConfiguration): ServeDiagnostics {
  const reasons: ServeDiagnosticReason[] = [];
  if (configuration.funnelEnabled) reasons.push("funnel_enabled");
  if (configuration.publicExposure) reasons.push("public_exposure");
  if (!isTrustedServePeer(configuration.gatewayBindAddress)) reasons.push("gateway_not_loopback");
  if (!isTrustedServePeer(configuration.upstreamAddress)) reasons.push("upstream_not_loopback");
  if (portFromAddress(configuration.upstreamAddress) !== configuration.gatewayHttpPort) {
    reasons.push("upstream_port_mismatch");
  }
  if (!configuration.httpsEnabled) reasons.push("https_disabled");
  if (!hostWithinSuffix(configuration.advertisedHost, configuration.expectedTailnetDnsSuffix)) {
    reasons.push("unexpected_tailnet_host");
  }
  return reasons.length === 0 ? { kind: "valid" } : Object.freeze({ kind: "invalid", reasons: Object.freeze(reasons) });
}
