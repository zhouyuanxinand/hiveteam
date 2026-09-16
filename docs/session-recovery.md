# Workspace and native session recovery

Hive persists workspace identities, members, launch configuration, dispatches,
and native conversation bindings in its local `runtime.sqlite`. Native conversation
contents remain in the CLI's own storage. Keep both stores when backing up or
moving an installation. Terminal scrollback is not a durable conversation archive,
and shutting down a machine cannot preserve a running process or unwritten output.

## Use the same Hive data directory

All standard launch modes default to `~/.config/hive`. An explicit `HIVE_DATA_DIR`
selects a separate database. Launchers resolve a relative override against the
invocation directory before changing directories, and print the resulting path.
Switching between an acceptance-test directory and the default directory can make
workspaces appear missing even though neither database was deleted.

Stop the corresponding Hive instance and back up its data before changing the
directory. Do not overwrite one database with another to combine workspaces. This
change does not automatically migrate or merge existing directories, and Windows
and WSL are separate native session environments.

## Restart behavior

- Before a normal platform shutdown, Hive commits which runs were active. Their
  PTYs still exit normally and visible agent status remains `stopped`.
- On startup, active-before-shutdown and interrupted runs are recovery candidates.
  The workspace's auto-resume toggle, explicit member stop and repeated-fast-exit
  safeguards still apply. Orchestrators are started before workers.
- A successful new run supersedes old recovery intent. Completed, explicitly
  stopped and never-started members are not restarted just because they exist.
- Hive waits for native session creation for the lifetime of the run, until a
  session is captured. It performs a final capture on exit and cancels observation
  before closing SQLite. An idle worker does not lose capture just because it has
  waited more than thirty seconds for its first task.
- Capture location, working directory, operating system and pre-launch session IDs
  are persisted. Resumed launches use the recorded capture location; in particular,
  Codex receives its original `CODEX_HOME` even if the launching shell changed it.
- An unrecorded Codex or Claude conversation may be reattached only when a unique
  eligible session contains that member's Hive binding marker. A shared project
  directory alone is not proof of ownership. Hive does not guess between multiple
  matching histories or adopt an unrelated desktop conversation.

Native resume requires the CLI's configured resume template and session capture
adapter. Restoring the session is not approval to execute a completed task again;
the existing dispatch ledger remains authoritative.

## Recovery failures

A missing or mismatched saved native session now blocks launch with HTTP 409 rather
than deleting its pointer and silently opening a blank conversation. Restore the
original native files/environment and retry. A native resume process that exits
with an error also retains its session pointer.

If a native CLI reports that another application owns the conversation, close that
conversation in the other application and use Hive's existing session retry
control. Hive does not delete native locks or terminate unrelated applications.

For a member with no native session to resume, the existing recovery summary is a
best-effort fallback, not a copy of the full conversation. Harness-side deletion,
manual conversation switching and cross-OS migration are not made lossless by a
Hive restart. Native ID capture does not preserve unsaved in-flight tool execution.

## Verification

Coverage includes real HTTP, SQLite, PTY start/exit and service close/reopen using
isolated native-CLI fixtures. Tests verify per-member session IDs and retained
conversation content, changed launch homes, delayed capture, same-directory
concurrent members, missing files, explicit stops and repeat restarts. These tests
do not access a user's real native sessions or simulate a physical power failure.
