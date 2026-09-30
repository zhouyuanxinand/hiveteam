# Workspace and native session recovery

HiveTeam persists workspace identities, members, launch configuration, dispatches,
and native conversation bindings in its local `runtime.sqlite`. Native conversation
contents remain in the CLI's own storage. Keep both stores when backing up or
moving an installation. Terminal scrollback is not a durable conversation archive,
and shutting down a machine cannot preserve a running process or unwritten output.

## Use the same HiveTeam data directory

All standard launch modes default to `~/.config/hive`. An explicit `HIVE_DATA_DIR`
selects a separate database. Launchers resolve a relative override against the
invocation directory before changing directories, and print the resulting path.
Switching between an acceptance-test directory and the default directory can make
workspaces appear missing even though neither database was deleted.

Stop the corresponding HiveTeam instance and back up its data before changing the
directory. Do not overwrite one database with another to combine workspaces. This
change does not automatically migrate or merge existing directories, and Windows
and WSL are separate native session environments.

## Restart behavior

- Before a normal platform shutdown, HiveTeam commits which runs were active. Their
  PTYs still exit normally and visible agent status remains `stopped`.
- On startup, active-before-shutdown and interrupted runs are recovery candidates.
  The workspace's auto-resume toggle, explicit member stop and repeated-fast-exit
  safeguards still apply. Orchestrators are started before workers.
- A successful new run supersedes old recovery intent. Completed, explicitly
  stopped and never-started members are not restarted just because they exist.
- HiveTeam waits for native session creation for the lifetime of the run, until a
  session is captured. It performs a final capture on exit and cancels observation
  before closing SQLite. An idle worker does not lose capture just because it has
  waited more than thirty seconds for its first task.
- Capture location, working directory, operating system and pre-launch session IDs
  are persisted. Resumed launches use the recorded capture location; in particular,
  Codex receives its original `CODEX_HOME` even if the launching shell changed it.
- An unrecorded Codex or Claude conversation may be reattached only when a unique
  eligible session contains that member's HiveTeam binding marker. A shared project
  directory alone is not proof of ownership. HiveTeam does not guess between multiple
  matching histories or adopt an unrelated desktop conversation.

On Windows, a new session using the Codex preset receives its startup instructions
or recovery summary through Codex's initial prompt argument. Console paste bursts
can lose line breaks or split long text into several composer placeholders, leaving
automatic startup waiting indefinitely. The initial prompt preserves the complete
message, including documents, skills and memory, without typing it into the composer.
HiveTeam resolves the same authorized native executable (or Node launcher), bypasses
shell quoting, and rejects an oversized Windows command line before spawning.
It does not also paste the message after launch. Memory preparation retains the
actual run ID, and native session capture still requires the member binding marker.

A worker's first pending dispatch uses this same initial-prompt path when it has
no native session. HiveTeam claims the original delivery before spawning and persists
its run ID, receipt marker and full-message SHA256. The ordinary delivery scheduler
then reconciles the native journal without also pasting the task. A launch with
uncertain acceptance retains its checkpoint across restart; it is never retried
just because the process stopped. The Windows command-line size check runs before
this handoff, so an oversized task is rejected without sending a truncated task.

Later Windows Codex dispatches and reports encode the complete message as a
single-line JSON string before terminal delivery, preserving line breaks and
quotes without sending them as console key events. Completion checks match all
visible composer text and paste-placeholder lengths; a durable native user-message
receipt must also match the complete wire payload's SHA256. The transport version
and digest are saved before input is written and reused when checking an uncertain
delivery after restart. Older pending pastes keep their original transport and are
never rewritten or pasted again merely because the runtime was upgraded.

Other terminal startup paths check the rendered screen and stop for an existing
draft or confirmation screen. Explicit custom launch commands retain their existing
terminal behavior. Resuming a native session does not inject a new startup message.
Codex configuration flags such as `-c` and `-s` remain launch options when
`resume <id>` is added. Launches supporting `--no-daemon` use it to keep each
member's identity and lifecycle separate from a shared background server.

Native resume requires the CLI's configured resume template and session capture
adapter. Restoring the session is not approval to execute a completed task again;
the existing dispatch ledger remains authoritative.

## Recovery failures

A missing or mismatched saved native session now blocks launch with HTTP 409 rather
than deleting its pointer and silently opening a blank conversation. Restore the
original native files/environment and retry. A native resume process that exits
with an error also retains its session pointer.

If a native CLI reports that another application owns the conversation, release
that conversation in the other application and use HiveTeam's existing session retry
control. Closing a conversation tab may leave the application's background server
holding its writer lock. If the warning persists, finish any active work and quit
the owning application completely before retrying. A readable history does not
mean that its write lock has been released. HiveTeam does not delete native locks or
terminate unrelated applications.

For a member with no native session to resume, the existing recovery summary is a
best-effort fallback, not a copy of the full conversation. Harness-side deletion,
manual conversation switching and cross-OS migration are not made lossless by a
HiveTeam restart. Native ID capture does not preserve unsaved in-flight tool execution.

## Repair a legacy Codex binding

If an older launch never delivered its member marker, its native conversation
may exist without a HiveTeam binding. Stop the platform, back up its data, identify
the intended conversation, and attach that exact ID:

```sh
hive data attach-codex-session --data-dir <directory> --workspace-id <workspace-id> --agent-id <agent-id> --session-id <native-session-id>
```

This offline operation requires the recorded Codex home, platform and workspace
path to match. It refuses an active runtime, a missing native session, another
member's binding, or replacement of an existing binding. It records the explicit
recovery in SQLite and leaves the native conversation file unchanged. Subsequent
starts validate the same native ID and directory and issue `codex resume`.
Automatic scanning still requires a member marker; it never guesses from a shared
working directory.

## Verification

Coverage includes real HTTP, SQLite, PTY start/exit and service close/reopen using
isolated native-CLI fixtures. Tests verify per-member session IDs and retained
conversation content, changed launch homes, delayed capture, same-directory
concurrent members, missing files, explicit stops and repeat restarts. These tests
do not access a user's real native sessions or simulate a physical power failure.
Windows initial-prompt coverage also verifies complete multiline argv, Unicode and
shell metacharacters, document/memory context, recovery summaries and no duplicate
startup message after resuming.
