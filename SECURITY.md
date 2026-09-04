# Security Policy

## 지원 범위

source repository는 공개되어 있지만 현재 지원 대상은 초대된 동료가 최신 `dev`/pilot revision을 source install한 macOS 운영 pilot뿐입니다. public npm, Homebrew, Linux/Windows host, public dashboard, Tailscale Funnel과 일반 공개 사용자는 지원 범위가 아닙니다.

## 취약점은 비공개로 신고하세요

credential 노출, approval bypass, identity confusion, duplicate destructive execution, path escape, unsafe uninstall, diagnostic leak, dashboard exposure, dependency compromise를 발견해도 public issue나 Slack/Telegram work channel에 취약점 상세를 쓰지 마세요. 현재 이 repository의 GitHub private vulnerability reporting은 비활성 상태입니다.

1. 초대된 pilot 동료는 초대에 사용된 기존 사내 비공개 연락 경로에서 maintainer에게 security report channel을 요청하고 그 비공개 channel로만 상세를 보냅니다.
2. 그 연락 경로가 없는 공개 독자는 public issue에 **private security contact requested**라고 연락 연결만 요청합니다. issue에는 취약점 종류·영향·경로·로그·token·재현 단계나 추측을 적지 않습니다.
3. maintainer는 상세를 요청하기 전에 GitHub private vulnerability reporting을 실제로 활성화하거나 reporter에게 별도 비공개 channel을 제공해야 합니다. public issue는 연락 연결용이며 보안 증거 수집 경로가 아닙니다.
4. 비공개 channel에서도 token, raw transcript, raw SQLite, 실제 Registry, 고객/회사 path를 본문에 붙이지 않습니다. 필요한 증거는 최소 redacted reproduction과 synthetic fixture로 만듭니다.

report에는 다음을 포함합니다.

- 영향을 받은 full commit SHA와 macOS/Node/Orca version
- 공격 전제, 영향, 재현 단계, 예상/실제 결과
- L0–L3 risk와 관련 channel/role
- secret 없는 log category, audit reference, redacted diagnostic manifest
- 이미 노출된 credential이 있다면 값 자체가 아닌 provider와 rotation 완료 여부

## 신고 후 처리

maintainer는 private thread에서 수신을 확인하고 severity와 pilot exposure를 분류합니다. active credential 또는 destructive approval 위험이면 먼저 provider credential rotation, gateway stop, affected pilot suspension을 안내합니다. 수정과 disclosure 시점은 reporter와 private하게 조율하며, 실제 secret은 issue history나 commit에 옮기지 않습니다.

## 즉시 containment

credential 노출이 의심되면 해당 provider의 공식 UI에서 사용자가 credential을 revoke/rotate하고 `pnpm hq setup`으로 새 값을 Keychain에 저장합니다. destructive execution 또는 identity/approval 이상이면 새 command를 보내지 말고 gateway를 멈춥니다.

```bash
pnpm hq stop
pnpm hq doctor --format json
```

SQLite, Registry, worktree, approval row를 직접 수정하지 않습니다. [운영 runbook](docs/operations/runbook.md)에서 backup과 receipt review를 수행하고, [data handling](docs/security/data-handling.md)에 따라 최소 diagnostic만 만듭니다.

## production/general-availability promotion gate

source repository는 이미 공개되어 있습니다. 운영 pilot을 production 또는 general availability로 승격하기 전에는 사용자당 5개 curated project로 2주 운영하고 승인 지표를 통과해야 합니다. 현재 없는 license와 code of conduct를 포함해 privacy/support/release policy, Git object 전체의 secret/company-data scan, signed checksum, provenance, SBOM, 외부 clean-machine install, threat-model/dependency audit도 별도로 필요합니다.

보안 경계와 잔여 위험은 [threat model](docs/security/threat-model.md)을 참고하세요.
