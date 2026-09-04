/**
 * The installer never invokes `security` itself. A host-specific adapter owns that
 * boundary so setup tests and source-distributed runs cannot accidentally touch a
 * user's Keychain.
 */
export interface KeychainPort {
  set(service: string, account: string, value: string): Promise<void>;
}

export const ORCA_HQ_KEYCHAIN_SERVICE = "orca-hq" as const;
