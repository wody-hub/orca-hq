# Relay coordinator recovery

The user confirmed closing and reopening Orca and authorized fixing the stale coordinator failure. Preserve the existing Run, Tasks, Dispatches and conversation history. Recover only the dedicated HQ terminal, never a GH worker terminal.

## Design and execution plan

- [x] Add regression tests using real temporary coordinator files and a fake Orca RPC boundary: recover a restored tab, create a missing dedicated terminal, preserve a Run, refuse offline/ambiguous inventories, and do not repeat a creation whose response was lost.
- [x] Implement `relay-coordinator.ts`: validate the saved handle, migrate placement from the existing terminal receipt, locate the same tab or uniquely named HQ terminal in that workspace, create only on proven stale identity and complete inventory, atomically persist recovery state, and bind the existing Run with `run-use`.
- [x] Integrate a coordinator resolver into relay startup and calls carrying `--from`. Update SQLite metadata only after successful resolution. Preserve the static-handle interface for existing callers. A transport failure must never replay task or worker creation.
- [x] Run focused regression tests, repository type checks and the full test suite. Review the diff and verify the installed runtime with its existing additional changes preserved.

Terminal creation is journaled before sending so uncertain outcomes are reconciled by inventory instead of duplicated. Concurrent resolver calls serialize. A live coordinator belonging to somebody else is not taken over. Missing workspace evidence, offline runtime and truncated inventory fail with an actionable error. The chat prompt cosmetic issue is outside this fix.

## Verification

- Regression reproduced before the fix: persisted Run still sent `term_old` after simulated runtime restart. The corrected relay resolves the current handle before startup and subsequent routed calls.
- Focused suite: 23 tests passed. Full suite: 67 files / 894 tests passed. `pnpm typecheck` and `pnpm build` passed; the installed gateway also built successfully.
- Live recovery preserved `run_b01e6b56d4fe` and rebound it from the stale handle to a newly created dedicated HQ shell. No workers or GH review tasks were started for verification.
- Installed-only conversation changes were preserved through targeted edits; original changed sources were backed up under `~/.config/orca-hq/backups/coordinator-recovery-20260908-105753`.
- The first `hq start` readiness check timed out. Starting through launchd and allowing initialization to finish produced healthy managed service state with both channels connected; a subsequent `hq start` passed. The separate 15-second readiness timeout was not changed.

## Recovery limits

The resolver uses the saved placement, or the original `relay-terminal-receipt.json` for older installations. If that workspace no longer exists or its identity cannot be verified, recovery stops. A terminal creation with an uncertain outcome leaves `creationPending` persisted; inventory can recover a subsequently observed HQ terminal, but the resolver will not repeat the creation blindly. The previous failed user request remains in its original recovery state and is not replayed by this fix.
