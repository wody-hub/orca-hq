# ADR-001: Private-pilot worker environment boundary

- Status: Accepted
- Date: 2026-09-02

## Context

Orca HQ launches Codex and Claude workers through Orca's public, supervised
`worker-start` lifecycle. Orca 1.4.195 does not expose a public contract that
constrains a provider child process to an effective environment allowlist, and
its public receipt does not attest the effective provider child environment.
Bounding the environment of the Orca client subprocess is useful process
hygiene, but it is not evidence that an arbitrary inherited provider child
environment was inspected or isolated.

The default launch policy therefore fails closed when verified provider child
environment isolation is unavailable. A private pilot still needs to exercise
the Orca-supervised Codex and Claude path without turning that operational need
into a false isolation claim.

Slack and Telegram end-to-end channel integration is not connected for this
pilot. When channel composition is introduced, Slack and Telegram tokens must
be Keychain-only at composition. Telegram, Slack, Tailscale, and OpenAI voice
secrets must remain Keychain- or runtime-only throughout the pilot.

## Decision

Worker launch has two explicit policies:

1. `strict_verified_isolation` is the default. It permits a launch only when
   Orca advertises verified effective provider child environment isolation and
   the public start receipt contains a matching effective-environment
   attestation.
2. `orca_supervised_private_pilot` is an explicit, temporary exception. It
   permits `worker-start --agent codex|claude` under Orca lifecycle authority
   even though provider child environment isolation is unsupported and
   unverified.

The private-pilot policy is valid only with a typed secret-boundary attestation
whose literal values assert all of the following:

- Slack, Telegram, Tailscale, and OpenAI voice secrets are Keychain- or
  runtime-only.
- Those secrets are absent from the assignment.
- Those secrets are absent from the prompt and assignment artifact.
- Those secrets are absent from logs and audit data.
- Those secrets are absent from the application-configured provider
  environment.
- Inspection of an arbitrary inherited provider child environment is not
  available.

Missing, malformed, or false attestation fails before artifact staging,
editing-lock acquisition, or any Orca mutation. There is no implicit fallback
from strict mode to the private pilot.

Private-pilot provider receipts and lifecycle audit records state
`unverified_orca_supervised`. They never state or imply
`verified_effective_allowlist`. The private-pilot path does not require the
public Orca start receipt to contain `launch.providerEnvironment`, because Orca
1.4.195 does not provide that contract. Task and Dispatch identity remain
required and are bound before accepting the unverified boundary.

Orca remains the sole worker lifecycle authority. Existing assignment artifact
integrity, Task/Dispatch fencing, cleanup, and intervention behavior remain in
force.

## Alternatives

### Wait for public Orca verified child-environment support

This retains the strongest boundary and remains the default behavior. It was
not selected as the only mode because it would prevent the explicitly approved
private pilot from exercising the supervised provider lifecycle.

### Explicit Orca-supervised private pilot with an unverified boundary

Selected. It makes the exception reviewable in configuration and receipts,
requires the secret-boundary attestation before mutation, and preserves Orca's
lifecycle authority without claiming isolation Orca cannot prove.

### Unsupervised wrapper or direct provider process

Rejected. Launching Codex or Claude outside Orca would abandon Orca lifecycle
authority, public worker receipts, Dispatch fencing, and the established
cleanup path.

## Consequences

- Production and unconfigured callers remain fail-closed.
- Pilot operators must knowingly select the private-pilot policy and supply the
  complete typed attestation.
- Audit consumers can distinguish verified isolation from supervised but
  unverified execution without interpreting prose.
- The attestation establishes the application's handling guarantees; it does
  not prove the contents of an arbitrary inherited provider child environment.
- The pilot accepts the residual risk that Orca 1.4.195 cannot inspect or
  attest that inherited child environment.

## Upgrade Exit Criteria

Retire the private-pilot override after a public Orca release provides both:

1. an Orca-supervised provider child-environment policy that can be requested
   for `worker-start`; and
2. a verifiable public receipt describing the effective provider child
   environment and allowing Orca HQ to compare it with the requested policy.

At that point Orca HQ will map the public capability into
`verified_effective_allowlist`, require a matching receipt in strict mode, move
pilot deployments to strict mode, and remove the private-pilot exception after
migration verification.
