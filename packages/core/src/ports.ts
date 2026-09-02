import type { Channel, CommandEnvelope } from "./command.js";
import {
  PrincipalBindingSchema,
  type PrincipalBinding,
  type PrincipalRole
} from "./identity.js";

export type AuthenticatedPrincipal = Readonly<{
  principalId: string;
  roles: readonly PrincipalRole[];
}>;

export type IdentityResolution = AuthenticatedPrincipal | Readonly<{ kind: "denied" }>;

export interface IdentityResolverOptions {
  readonly bindings: readonly PrincipalBinding[];
  readonly allowedSlackWorkspaceIds: readonly string[];
}

const denied = Object.freeze({ kind: "denied" as const });

function authenticatedPrincipal(binding: PrincipalBinding): AuthenticatedPrincipal {
  return Object.freeze({
    principalId: binding.principalId,
    roles: Object.freeze([...binding.roles])
  });
}

export class IdentityResolver {
  readonly #bindings: readonly PrincipalBinding[];
  readonly #allowedSlackWorkspaceIds: ReadonlySet<string>;

  constructor(options: IdentityResolverOptions) {
    if (options.allowedSlackWorkspaceIds.length !== 1 ||
      options.allowedSlackWorkspaceIds[0]?.length === 0) {
      throw new TypeError("IdentityResolver requires exactly one trusted Slack workspace");
    }
    this.#bindings = options.bindings.map((binding) => PrincipalBindingSchema.parse(binding));
    this.#allowedSlackWorkspaceIds = new Set(options.allowedSlackWorkspaceIds);
  }

  resolve(channel: Channel, userId: string, contextId: string): IdentityResolution {
    const trustedContext = contextId.length > 0;
    if (userId.length === 0 || !trustedContext) return denied;

    const matchingBindings = this.#bindings.filter((binding) => {
      switch (channel) {
        case "slack":
          return this.#allowedSlackWorkspaceIds.has(contextId)
            && binding.slackUserIds.includes(userId);
        case "telegram":
          return binding.telegramUserIds.includes(userId)
            && binding.telegramChatIds.includes(contextId);
        case "tailscale-web":
          return binding.tailscaleLoginNames.includes(userId)
            && binding.principalId === contextId;
      }
    });

    return matchingBindings.length === 1 && matchingBindings[0] !== undefined
      ? authenticatedPrincipal(matchingBindings[0])
      : denied;
  }
}

export interface CommandIngress {
  accept(input: CommandEnvelope): Promise<Readonly<{
    kind: "accepted" | "duplicate";
    commandId: string;
  }>>;
}
