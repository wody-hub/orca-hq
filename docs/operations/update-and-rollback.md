# Update, rollback, and safe uninstall

Orca HQ lifecycle operations fail closed around active work and preserve durable state by default. The private-pilot adapter supplies the host-specific source, SQLite, launchd, and filesystem ports; the lifecycle services never discover broader paths or read Keychain values themselves.

## Update safety contract

An update targets one explicit source revision. The adapter must expose the currently installed revision and verify that the requested revision is the intended release before any maintenance window begins.

The update service performs these steps:

1. Read gateway status. Any active dispatch, uncertain dispatch, malformed status, or unavailable status blocks the update with `active_work`.
2. Record the current revision, verify the target revision, and install dependencies with the frozen lockfile option.
3. Run preflight through the read-only port. A failed preflight stops before backup, migration, or launchd changes.
4. Create a timestamped SQLite online backup. Configuration is included; secrets are always excluded because credentials remain in macOS Keychain.
5. Recheck active and uncertain work, then stop only the configured gateway service.
6. Run migrations, start the gateway, and run the machine-readable doctor check.

The second status check closes the gap between preflight and the maintenance window. A backup completed just before that check is safe to retain if new work appeared; the service remains running and migration does not begin.

### Backup receipt

Every backup receipt records:

- the timestamped backup directory and database file;
- the optional configuration snapshot path;
- creation time, source revision, and schema version;
- `includesSecrets: false`.

Keep the receipt in the operator-visible result. It is the exact rollback reference and should be included in any failure report without adding raw command output or credentials.

## Automatic rollback

Any migration, restart, or doctor failure after backup triggers rollback in this order:

1. Stop the new gateway process by its configured service boundary.
2. Restore the prior source revision.
3. Restore the database and configuration from the recorded backup, still excluding secrets.
4. Restart the prior revision.

Rollback attempts every step even if an earlier recovery action fails. The update error reports the backup receipt and `rollbackComplete`; a false value requires operator review before another update. Do not substitute broad process kills, parent-directory deletion, or an unrecorded backup.

For manual recovery, use only the paths and prior revision in the receipt, restore the program before its compatible database/config snapshot, then run the read-only doctor check. Retain a failed-update backup until the prior revision has restarted and doctor reports healthy.

## Reinstall and data preservation

Source installation and frozen-lockfile reinstall operate on the program path only. The SQLite database and user configuration belong under the configured Application Support data path and are not installation targets. Keychain entries are outside both paths and are never copied into an archive.

## Safe uninstall

Default uninstall removes the exact launchd service and configured program path. It preserves the entire Application Support data path, including the SQLite database and configuration, and does not access Keychain credentials.

Data removal is a separate destructive operation. The adapter must display the generated phrase returned for the exact normalized data path and require a byte-for-byte match:

```text
REMOVE ORCA HQ DATA AT /Users/<user>/Library/Application Support/orca-hq
```

A missing or inexact phrase fails before launchd or filesystem mutation. After a correct phrase, removal is limited to the configured data path. Configuration is rejected up front when program and data paths overlap, the database is outside the data path, or any target is relative or a filesystem root.

Before confirming data removal, copy any backup that must survive outside the configured data directory and verify its receipt. Default uninstall is the recovery-friendly choice for reinstalling the program later.
