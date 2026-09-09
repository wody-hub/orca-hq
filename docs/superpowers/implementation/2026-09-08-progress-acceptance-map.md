# Context progress acceptance evidence

This maps the approved design to evidence. It distinguishes deterministic integration, actual model execution, and native desktop observations. Final release status belongs to `2026-09-08-progress-verification.md`.

| Design criterion | Evidence | Boundary |
| --- | --- | --- |
| 1. Prompt acceptance | Installer chat/PTY tests; real PTY accepted consecutive instructions; installed smoke measured 8.125ms durable acceptance | No GUI frame timing claim |
| 2. Elapsed time and connection status | `packages/installer/test/watch.test.ts`, `apps/gateway/test/progress-control.test.ts` | Controlled clocks/streams |
| 3. Same-context reuse | CLI/window lease tests plus actual A viewer PID retained on followup | Actual launcher, viewer and lease; no screenshot inspection |
| 4. New work separation | Router tests, actual semantic model validation, actual distinct A/B viewer processes | Multi-repository routing primarily deterministic |
| 5. Invalid/ambiguous routing and replay | Context-router, progress-runtime, progress-store and agent-tools tests | Model schema validation and durable identities |
| 6. Restart and observer independence | Chaos reopen test, stale coordinator recovery tests, real viewer SIGINT during execution | Actual Orca coordinator recovery was verified earlier; ordinary installed stop/start took 20.519s and retained the result; no forced production crash |
| 7. Native work after HQ response and retry provenance | Runtime/native reservation tests and actual SQLite/socket integration | Native observations injected; independent review prompted extra retry and multipart regressions |
| 8. Viewer failure/backpressure and long work | Window/client/watch/control tests and blocked execution fixture | Long work modeled with gates/timers rather than elapsed minutes |
| 9. Channel compatibility | Existing managed service regressions; window opener runs only in local interactive CLI | No Slack/Telegram test messages sent |
| 10. Untrusted strings | Literal shell-argument and fixed AppleScript tests; terminal sanitization tests | No raw provider arguments in displayed summaries |
| 11. Real concurrency | Five real Codex threads overlap for 16.281s; five-slot actual SQLite/socket runtime tests; two actual PTY fixture executions overlap | Model and native/gateway boundaries verified separately; no claim of five end-to-end real native coding workers |
| 12. Serialization, isolation and responsive control | Context-executor and runtime tests; independent review added guidance-lane regression | Saturated scheduler tested with controlled execution |
| 13. Checkout/external reservations | Execution-reservation and compatibility tests, actual SQLite/socket contention test | Independent review added exact-attempt full-resource retry and crash-window regressions |

## Desktop validation limit

Computer Use rejected `com.apple.Terminal`. The coordinator did not bypass this restriction with another UI automation mechanism. Product launcher execution, actual watch processes, PTY output and viewer leases were verified; Terminal window geometry, screenshots and clicking the close button were not inspected. The viewer-exit check used a verified test process's SIGINT.
