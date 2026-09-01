# Orca HQ Private Pilot Roadmap

The approved design is implemented through five sequential plans. A plan begins only after the preceding completion gate passes.

| Order | Plan | Testable outcome |
|---:|---|---|
| 1 | [Foundation and Control Plane](./2026-09-01-01-foundation-control-plane.md) | Typed schemas, SQLite durability, curated routing, risk policy, and locks |
| 2 | [Channels and Voice](./2026-09-01-02-channels-and-voice.md) | Slack/Telegram text and Korean voice enter one durable command pipeline |
| 3 | [Orca Agent Execution](./2026-09-01-03-orca-agent-execution.md) | Codex HQ supervises isolated Codex/Claude workers with cross-model verification |
| 4 | [Approvals, Dashboard, and Gateway](./2026-09-01-04-approvals-dashboard-gateway.md) | Digest-bound Slack/Tailscale approvals and private mobile control plane |
| 5 | [Operations and Private Pilot](./2026-09-01-05-operations-private-pilot.md) | Guided install, launchd recovery, safe update/uninstall, chaos gates, and coworker docs |

## Dependency Flow

```text
typed contracts + SQLite
        ↓
authenticated channel ingress/outbox
        ↓
Codex HQ + Orca execution + cross-model verifier
        ↓
Slack/Tailscale approvals + private web dashboard
        ↓
launchd + recovery + installer + private pilot gates
```

## Design Coverage

| Design sections | Implemented by |
|---|---|
| 1–7 Purpose, goals, principles, topology, stack, packages | Plans 1–5 global constraints and composition boundaries |
| 8, 12, 13, 15 Core interfaces, routing, locks, persistence | Plan 1 |
| 9 Channel responsibilities | Plan 2 for Slack/Telegram/voice; Plan 4 for Tailscale web |
| 10 Identity and authorization | Plans 1, 2, and 4 |
| 11 HQ, workers, cross-model verification | Plan 3 |
| 14 Command lifecycle | Plans 2–4 and the Plan 4 end-to-end gateway task |
| 16 Recovery and error handling | Plans 2, 3, and 5 |
| 17 Security | Every plan; Plan 5 threat model and redacted diagnostics |
| 18 Installation and operations commands | Plan 5 |
| 19 Distribution strategy | Plan 5 private-pilot and promotion gates |
| 20 Testing strategy | Unit/contract/integration tests in Plans 1–4; end-to-end/chaos in Plan 5 |
| 21 Pilot acceptance criteria | Plan 5 acceptance harness and clean-machine documentation |
| 22 Implementation phases | The five-plan sequence in this roadmap |
| 23 Deferred extensions | Excluded from these implementation plans |

## Execution Rule

Use a fresh review gate after every task commit. Do not configure real Slack, Telegram, Tailscale, Keychain credentials, or Orca worker sessions until the corresponding fake/fixture tests pass. Keep the repository private through the two-week coworker pilot and complete the promotion gate in Plan 5 before considering public visibility.
