/** A host-specific adapter owns the `security` process boundary. */
export interface KeychainPort {
  set(service: string, account: string, value: string): Promise<void>;
}

export const ORCA_HQ_KEYCHAIN_SERVICE = "orca-hq" as const;
