# Orca HQ public-source, invitation-only pilot threat model

이 문서는 공개 source repository에서 제공되고 초대된 동료만 macOS 한 대에서 운영하는 pilot의 보안 경계와 잔여 위험을 설명합니다. 공개 SaaS, 24×7 availability, public npm/Homebrew 배포, 일반 공개 운영 지원, Tailscale Funnel은 범위에 없습니다.

## 보호할 자산

- Slack, Telegram, OpenAI credential과 각 도구가 별도로 관리하는 Tailscale, Orca, Codex, Claude Code 인증 상태
- 허용된 project의 source, uncommitted diff, worktree와 sensitive path
- command, transcript metadata, approval, Run/Task/Dispatch, audit와 delivery state가 든 SQLite
- project Registry의 실제 경로, alias, remote, policy와 required check
- approval digest, verifier evidence, backup과 local diagnostic

## 신뢰 경계

```text
untrusted Slack / Telegram / repository / issue content
                         |
                         v
        channel parser + identity allowlist
                         |
                         v
     deterministic route / policy / approval gates
                         |
                         v
 local SQLite <-> Codex HQ <-> Orca supervised lifecycle
                         |
                         v
             Codex or Claude worker sandbox

macOS Keychain ---- runtime-only credential ports
Tailscale tailnet -- private dashboard identity boundary
```

외부 message, 첨부물, transcript, repository 파일, issue 본문은 모두 untrusted data입니다. 이 내용은 policy나 tool permission을 바꾸는 agent instruction이 아닙니다. deterministic code만 identity, idempotency, allowlist, path, lock, risk, approval, retry ceiling, completion gate를 결정합니다.

## 역할과 risk matrix

| Risk | 예 | 자동 실행/승인 | 허용 channel |
| --- | --- | --- | --- |
| L0 | status, log, 문서, read-only 조사 | allowlisted viewer 이상은 자동 | Slack, Telegram, Tailscale |
| L1 | isolated worktree edit와 local test | owner/operator 요청, preview 후 자동 가능 | Slack, Telegram, Tailscale |
| L2 | commit, push, PR 생성 | owner/operator의 explicit approval | Slack 또는 Tailscale만 |
| L3 | merge, deploy, DB mutation, delete, secret/production access | owner의 typed operation phrase | Slack 또는 Tailscale만 |

알 수 없는 operation은 L3로 fail closed합니다. approval은 proposal digest, operation, command digest, 현재 diff hash, target environment와 approver principal/channel에 묶입니다. 변경되면 무효이고, 승인 시점부터 15분 뒤 만료되며, 한 번 소비한 approval은 replay할 수 없습니다.

## 주요 위협과 통제

### Credential 노출

위협: setup 입력, config, log, backup, diagnostic, assignment prompt를 통해 token이 유출될 수 있습니다.

통제:

- setup이 받는 Slack, Telegram, OpenAI credential은 macOS Keychain service `orca-hq`에 저장합니다. Orca, Codex, Claude Code, Tailscale 인증은 각 도구가 macOS에서 관리하며 HQ config로 복사하지 않습니다.
- setup은 secret prompt를 echo하지 않고 provider/Keychain 오류 원문도 CLI에 출력하지 않습니다.
- config에는 credential 값이 아니라 Keychain account 이름만 들어갑니다.
- backup은 `includesSecrets: false`만 허용합니다.
- logger는 authorization, token, cookie, voice URL, signed URL, prompt, transcript와 caller-supplied pattern을 redaction합니다.
- diagnostic은 `includeFullContent: false`만 허용하는 pilot API로 local `manifest.json`을 만들며 자동 업로드하지 않습니다.

잔여 위험: 같은 macOS user 권한을 얻은 악성 process, screen capture, clipboard, provider account 침해는 application redaction으로 막을 수 없습니다. 공용 OS 계정을 사용하지 않고 FileVault, screen lock, provider MFA를 켭니다.

### Prompt injection과 권한 상승

위협: channel message, 첨부물, transcript, repository/issue가 HQ 또는 worker에게 범위를 넓히거나 secret 접근을 지시할 수 있습니다.

통제:

- channel adapter는 shell을 직접 실행하지 않습니다.
- HQ model은 proposal만 만들고 deterministic policy가 operation, role, channel, project allowlist를 검증합니다.
- worker assignment는 exact project/worktree/base/scope/check와 금지 효과를 가집니다.
- L2/L3는 digest-bound approval을 요구하고 Telegram은 승인 권한이 없습니다.
- success는 opposite model family의 passing verifier evidence가 있어야 합니다.

잔여 위험: model과 sandbox 자체 취약점 또는 허용 scope 안의 악성 repository 동작은 남습니다. Registry의 `requiredChecks`, `sensitivePaths`, `setupPolicy`, network/sandbox policy를 사람이 검토합니다.

### Replay, duplicate execution, stale approval

위협: provider 재전송, reconnect, 사용자의 중복 전송, 오래된 approval이 동일 작업을 두 번 실행할 수 있습니다.

통제:

- provider event에서 derive한 idempotency key는 SQLite unique index로 중복 Command를 막습니다.
- Telegram offset과 Slack history cursor는 durable state와 함께 resume합니다.
- approval은 15분 expiry와 single-consume, immutable digest comparison을 사용합니다.
- Outbox는 Task 실행과 분리하고 delivery retry가 Task redispatch가 되지 않게 합니다.

### Path, worktree, destructive operation 혼동

위협: 잘못된 alias/path, dirty checkout, concurrent editor, broad delete가 다른 project나 사용자 data를 손상할 수 있습니다.

통제:

- Registry는 absolute path와 approved Orca project를 비교하고 ambiguous route를 clarification으로 보냅니다.
- editing Dispatch는 `lockKey` lease를 가지며 expiry만으로 worker 종료를 추정하지 않습니다.
- dirty checkout과 branch/worktree conflict는 자동 dispatch를 막습니다.
- update는 full commit SHA, frozen lockfile, 두 번의 active-work check를 요구합니다.
- uninstall은 program/data 분리와 protected path를 검증하고 exact normalized path phrase를 요구합니다. data 삭제는 별도 `--remove-data`가 필요합니다.

### Restart와 불확실한 worker 상태

위협: gateway, Orca, Mac 또는 channel restart 사이에 claim, cursor, lock, worker state가 갈라져 duplicate execution이나 premature release가 생길 수 있습니다.

통제:

- startup은 Outbox claim recovery, channel cursor resume, nonterminal Dispatch exact receipt inspection, expired lock review, Outbox drain 순서로 reconcile합니다.
- `running/active/resumable`은 resume, proven terminal state는 complete, unknown/missing/inconsistent는 `review_required`로 분류합니다.
- timeout, heartbeat 지연, idle만으로 failure를 선언하지 않습니다.
- update/rollback/reinstall은 durable SQLite/config를 program path와 분리합니다.

잔여 위험: Orca와 local DB가 동시에 손상되거나 receipt identity를 증명하지 못하면 자동 복구할 수 없습니다. 이때 mutation, retry, release를 멈추고 operator review가 필요합니다.

### Dashboard와 network 노출

위협: local dashboard가 LAN/Internet에 노출되거나 위조된 identity header로 approval이 실행될 수 있습니다.

통제:

- HTTP listener는 loopback이고 Tailscale Serve configuration을 host observation과 비교합니다.
- Tailscale Funnel과 public bind는 금지합니다.
- mutating route는 tailnet identity와 local session, role, digest validation을 요구합니다.
- Mac이 offline이면 dashboard도 unavailable이며 cloud 상태처럼 표시하지 않습니다.

### Supply chain과 update

위협: dependency drift, branch/tag 이동, 악성 update가 실행될 수 있습니다.

통제:

- source install은 공개 origin의 exact commit과 `pnpm install --frozen-lockfile`을 사용합니다.
- update는 locally resolvable한 exact 40/64-character commit을 검증합니다.
- macOS CI는 test, typecheck, build, isolated doctor JSON/config-data state contract, deterministic acceptance를 실행합니다.
- Dependabot은 공개 repository에 npm과 GitHub Actions update를 제안하므로 maintainer review 없이 신뢰하거나 merge하지 않습니다.

잔여 위험: source repository는 이미 공개되어 있지만 license, release signing, SBOM, public provenance, privacy/support/release policy가 아직 없습니다. 2주 pilot과 보안·운영 gate를 통과하기 전에는 production/general availability로 승격하지 않습니다.

## Private-pilot worker environment 예외

기본 정책 `strict_verified_isolation`은 Orca가 provider child의 effective environment를 증명하지 못하면 launch를 거부합니다. Orca 1.4.195 private pilot은 명시적인 `orca_supervised_private_pilot` 정책과 complete secret-boundary attestation이 있을 때만 `unverified_orca_supervised` worker를 허용합니다.

이 예외는 Orca lifecycle authority, Task/Dispatch fencing, artifact integrity를 유지하지만 임의로 inherited된 provider child environment를 검사하거나 allowlist로 증명하지 못합니다. 자세한 결정과 종료 조건은 [ADR-001](../decisions/ADR-001-private-pilot-worker-environment-boundary.md)에 있습니다. Orca가 requested/effective child environment attestation을 공개하면 strict mode로 migration하고 예외를 제거해야 합니다.

## 운영 가정과 범위 밖 항목

- 초대된 3–5명, 개인별 계정, 정확히 5개 curated project, 한 대의 신뢰할 수 있는 Mac을 가정합니다.
- provider 자체의 보관 정책, 계정 takeover, macOS root compromise, 물리 공격, 장기 offline 상태의 provider queue 소실은 Orca HQ가 보장하지 않습니다.
- telemetry는 비활성입니다. diagnostic 공유는 operator의 명시적 검토와 별도 승인 행위입니다.
- 실제 Slack/Telegram/Tailscale/Keychain 연결을 synthetic test가 증명하지 않습니다. deterministic acceptance의 `pilotReady: false`를 live proof로 해석하지 않습니다.

관련 문서: [data handling](data-handling.md), [운영 runbook](../operations/runbook.md), [Security Policy](../../SECURITY.md).
