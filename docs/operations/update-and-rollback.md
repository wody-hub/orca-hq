# Update, rollback, and safe uninstall

Orca HQ lifecycle operations fail closed around active work and preserve durable state by default. `pnpm hq update` and `pnpm hq uninstall` are wired to the macOS private-pilot lifecycle composition; they no longer use a reserved placeholder branch. The lifecycle services and host adapter never read Keychain values.

The default source-installed layout is exact and bounded:

- program: the repository root containing the installed `hq` command;
- database: the absolute `databasePath` recorded in the non-secret pilot configuration (setup defaults to `~/Library/Application Support/orca-hq/control.sqlite`);
- backups: `~/Library/Application Support/orca-hq/backups`;
- config: `${XDG_CONFIG_HOME}/orca-hq/pilot.json` when `XDG_CONFIG_HOME` is set, otherwise `~/.config/orca-hq/pilot.json`;
- launchd: the single `com.orcahq.gateway` user LaunchAgent and its exact plist.

Setup writes `databasePath` into that pilot configuration. Doctor, gateway composition, update, and uninstall validate the same secret-free configuration: gateway startup rejects a runtime database path that differs from `pilot.json`, and lifecycle commands reject missing, legacy, malformed, relative, or out-of-data-directory database configuration before source, launchd, SQLite, or filesystem mutation.

The read-only doctor distinguishes the exact prior three-field configuration (`schema`, `projectRegistryPath`, and `credentialAccounts`) from missing or arbitrary malformed input. It reports the dedicated `config.pilot-schema` check as `warn` with `Pilot configuration migration is required.` for that legacy shape, while still checking the recorded credential account names and Registry path. Missing or malformed configuration reports this check as `fail`; it is never treated as migratable legacy state.

To migrate, run `pnpm hq setup`, review the non-secret preview, and confirm it. Leaving credential prompts blank preserves the legacy account names without reading, printing, or rewriting their Keychain secret values; credentials newly entered during this run are written to Keychain and merged with those names. Leaving the Registry prompt blank preserves the existing legacy Registry path. The confirmed write keeps those non-secret fields and adds the default `databasePath`; until then, update and uninstall remain fail-closed.

## Update safety contract

Run an update with one full 40- or 64-character commit SHA:

```text
pnpm hq update --revision <full-commit-sha>
```

The adapter resolves that commit exactly before changing source state. A ref name, abbreviated SHA, missing value, or mismatched resolution is rejected.

The update service performs these steps:

1. Read gateway status. Any active dispatch, uncertain dispatch, malformed status, or unavailable status blocks the update with `active_work`.
2. Record the current revision, verify the exact target revision, check it out, and run `pnpm install --frozen-lockfile`.
3. Run the no-emit `pnpm typecheck` preflight. A failed preflight restores the prior revision and frozen dependencies before returning an error.
4. Recheck active and uncertain work. If new or uncertain work appeared, restore the prior program state without stopping launchd.
5. Stop only the configured gateway service, then create a timestamped SQLite online backup. Configuration is included; secrets are always excluded because credentials remain in macOS Keychain.
6. Run the newly installed persistence migration in a child process, start the exact LaunchAgent, and run the machine-readable doctor check.

The second status check closes the gap between preflight and the maintenance window. The gateway is stopped before the online backup, so no gateway write can occur after the rollback point. If backup creation fails, the service restores the prior source/dependencies and restarts the prior gateway without attempting a database/config restore because no receipt exists.

### Backup receipt

Every backup receipt records:

- the timestamped backup directory and database file;
- the optional configuration snapshot path;
- creation time, source revision, and schema version;
- `includesSecrets: false`.

Keep the receipt in the operator-visible result. It is the exact rollback reference and should be included in any failure report without adding raw command output or credentials.

## Automatic rollback

Any migration, restart, or doctor failure after backup triggers full rollback in this order:

1. Stop the new gateway process by its configured service boundary.
2. Restore the prior source revision.
3. Restore the database and configuration from the recorded backup, still excluding secrets.
4. Restart the prior revision.

Rollback attempts every step even if an earlier recovery action fails. The internal update error retains a stable `stage`, the original `cause`, the backup receipt when one exists, and `rollbackComplete`; a false value requires operator review before another update. The CLI deliberately prints fixed messages so provider, process, path, or credential text cannot cross the redaction boundary. A configuration failure prints `Lifecycle configuration is missing or invalid; run hq setup to create or migrate it.`; other lifecycle provider failures retain the generic `Lifecycle operation failed.` message. Invalid update syntax and syntactically impossible uninstall arguments return usage status before loading configuration, while uninstall previews still load the safe lifecycle factory to derive their canonical paths. Do not substitute broad process kills, parent-directory deletion, or an unrecorded backup.

For manual recovery, use only the paths and prior revision in the receipt, restore the program before its compatible database/config snapshot, then run the read-only doctor check. Retain a failed-update backup until the prior revision has restarted and doctor reports healthy.

## Reinstall and data preservation

Source installation and frozen-lockfile reinstall operate on the program path only. The SQLite database and user configuration belong under the configured Application Support data path and are not installation targets. Keychain entries are outside both paths and are never copied into an archive.

## Safe uninstall

Before any uninstall mutation, the command reads the same active-work status used by update. Active, uncertain, malformed, contradictory, or unavailable status returns `active_work` and leaves launchd, program, and data untouched.

Default uninstall is:

```text
pnpm hq uninstall
```

Without confirmation this command is preview-only: it prints the absolute program path, the exact phrase, and the complete re-run command, then exits with usage status without reading launchd or changing program/data state. Confirm only after reviewing the path:

```text
REMOVE ORCA HQ PROGRAM AT /absolute/path/to/orca-hq
pnpm hq uninstall --confirm 'REMOVE ORCA HQ PROGRAM AT /absolute/path/to/orca-hq'
```

The confirmed command removes the exact launchd service/plist and configured program path. It preserves the entire Application Support data path, including the SQLite database and backups, and does not access Keychain credentials. Configuration remains at the separate XDG-aware config path.

Data removal is a separate destructive operation. The adapter must display the generated phrase returned for the exact normalized data path and require a byte-for-byte match:

```text
REMOVE ORCA HQ PROGRAM AT /absolute/path/to/orca-hq AND DATA AT /Users/<user>/Library/Application Support/orca-hq
```

Pass the generated phrase as one quoted argument:

```text
pnpm hq uninstall --remove-data --confirm 'REMOVE ORCA HQ PROGRAM AT /absolute/path/to/orca-hq AND DATA AT /Users/<user>/Library/Application Support/orca-hq'
```

A missing or inexact phrase fails before launchd or filesystem mutation. After a correct phrase, removal is limited to the configured program and data paths. Configuration is rejected up front when program and data paths overlap, the database is outside the data path, or any target resolves to a relative path, filesystem root, top-level directory, home directory, or protected ancestor.

Before confirming data removal, copy any backup that must survive outside the configured data directory and verify its receipt. Default uninstall is the recovery-friendly choice for reinstalling the program later.
