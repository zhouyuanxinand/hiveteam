# Worker sandbox acceptance

Run this fixture **inside Linux**, using an installed native Codex **0.155.1** binary:

```sh
node tests/manual/worker-sandbox-acceptance.mjs \
  --codex /absolute/path/to/native/codex \
  --report /absolute/path/to/acceptance-result.json
```

The script invokes `codex sandbox`, never a model. It creates a dedicated temporary
CLI home, synthetic credentials, source files, an outside directory, a symlink,
and a local TCP listener. It does not read existing user credentials or CLI
configuration. Fixtures remain in the reported temporary directory for inspection.

The generated JSON records actual permitted and denied operations for a writable
Coder checkout and a read-only Reviewer checkout, plus writable scratch space,
denied outside reads/writes, denied symlink escape, denied direct TCP, and a
successful request/response through a dedicated filesystem mailbox. The mailbox
in this fixture demonstrates transport feasibility; production broker identity,
route authorization, expiry, replay handling and cancellation require integration
coverage against the production implementation.

This fixture validates the native command sandbox. It does **not** certify CLI
model tools, MCP/plugins, credential delivery, Git commit authorization, or native
session resume. Those capabilities need separate evidence. Passing under WSL
does not certify a Windows HiveTeam runtime launching Windows CLIs or Windows Git
worktrees through `wsl.exe`.

Observed Windows preflight on 2026-09-19: native Codex 0.155.1 with `unelevated`
refused a restricted-read profile before executing the synthetic command:
`Restricted read-only access requires the elevated Windows sandbox backend`.
The built-in `:workspace` profile allowed reads outside the workspace and writes
to a sibling system-temp directory. No elevated setup, system account creation,
firewall changes, authentication, or model requests were performed.

References: [Codex permissions](https://learn.chatgpt.com/docs/permissions) and
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

The complete native tool-chain acceptance is separate:

```sh
python3 tests/manual/codex-tools-acceptance.py --help
```

`codex-tools-acceptance.linux.json` records the fixed Linux x64 Codex 0.155.1
artifact, gpt-5.4 tool metadata and a synthetic local Responses provider. It
executes real `exec_command` and `apply_patch`, resumes the same native thread
with Reviewer permissions, checks private environment and `/proc` boundaries,
and runs the production `team` CLI and mailbox broker. Git reads use a read-only
sanitized metadata view; coder commits go through the separately tested
authenticated, expected-HEAD-controlled commit endpoint. The production local
kernel preflight also passed. The Windows HTTP/SQLite/PTY integration suite
checks grants, immutable snapshots, revocation, role checks, expiry and replay.

Strict support is limited to this exact Linux x64 CLI/model combination and
SHA-1 repositories. Coder and Tester require registered isolated worktrees;
Tester can modify its own test checkout but cannot commit the source branch.
Reviewer and Orchestrator source access is read-only. Generated commands have
no network access; the trusted native CLI still accesses its model provider.
CLI authentication uses a separate home displayed by the local policy UI.
Native Windows, macOS, other CLIs/versions/models, custom launch flags, and a
Windows HiveTeam runtime driving WSL remain unsupported for strict execution.
Users can explicitly grant unsafe access to one member, workspace, executable
fingerprint and policy revision; changing those bindings requires a new grant.
Sensitive current files are denied, but previously committed Git history is not
sanitized. Permission snapshots describe the compiled launch policy of the
trusted CLI; they do not turn the same operating-system account into a separate
security principal.
