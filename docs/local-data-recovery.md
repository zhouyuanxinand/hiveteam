# Local backup and recovery

The workspace knowledge drawer offers local backup, inspection, restoration and
dispatch archiving. These controls require the local UI identity; paired remote
devices cannot use them. The same backup and restore operations are available
with `hive data --help`.

```text
hive data backup --data-dir <current-data-directory> --output <new-backup-directory>
hive data inspect --backup <backup-directory>
hive data restore --backup <backup-directory> --target <new-data-directory> --manifest-version <inspection-hash> --bindings <bindings.json> --confirm
```

The output and restore target must not already exist, and their parent directories
must exist. Inspection verifies the database and required attachments before
restoration. `bindings.json` maps every workspace ID in the backup to an existing,
distinct absolute directory on this machine:

```json
{
  "workspace-id-from-manifest": "D:/Projects/restored-project"
}
```

The backup contains a consistent SQLite snapshot, memory revisions and context,
dispatch and recovery records, referenced verification logs, and Skill Pack cache
files. The backup also lists external references. Workspace source files, external
worktrees and arbitrary report artifacts must be backed up separately. CLI
credentials, pairing keys, remote write grants and unsafe execution grants are
excluded. Natural-language history and logs can still contain private information;
store the backup accordingly.

Original CLI sessions are pointers by default. Optional native-session content
requires a certified version profile; no real Cursor/Grok profile is currently
certified. A HiveTeam backup does not guarantee that an external CLI session exists
on another machine.

Restoration writes a new data directory and leaves the original intact. Agents
stay stopped, active work requires review, and old process IDs are discarded.
Reconfigure launch commands and authentication, re-pair remote devices, and verify
the workspace/native-session bindings before starting agents. The running HiveTeam
instance does not switch data directories automatically. Stop it and launch with
`HIVE_DATA_DIR` pointing to the restored directory. To return to the original
data, stop the new instance and launch with the original directory.

Archiving starts with a preview. Only accepted, reported work with confirmed report
delivery and no unresolved delivery, verification, review or active reference can
be selected. Confirmation hides selected records from the delivery view; undo
archive makes them visible again. Archiving reclaims no disk space and does not
delete evidence, attachments or worktrees. There is no automatic TTL deletion.
