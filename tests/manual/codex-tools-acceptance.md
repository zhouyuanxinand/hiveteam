# Restricted Codex tool and resume acceptance

This fixture runs the actual pinned Linux Codex CLI against a loopback-only synthetic
Responses server. It never loads the user's home, account configuration, or API key.
The provider receives a synthetic key; no paid model request is made.

Build Hive first, then run inside native Linux or WSL Linux with Node 22 and Python 3.11+:

```sh
pnpm build
python3 tests/manual/codex-tools-acceptance.py \
  --codex /absolute/path/to/verified/native/codex \
  --report /absolute/path/to/codex-tools-acceptance.linux.json
```

The executable must be `codex-cli 0.155.1` with SHA-256
`0753dfe1d8b87a52436deb13eb1c549661ef4c84fee2c5aa688385eebeccb761`.
Each CLI invocation has a 30-second deadline. Synthetic artifacts and captures are
retained in the reported `/var/tmp/hive-codex-tools-*` directory for inspection.

The fixture imports the production profile and Git view builders. Its only profile
overrides select the local provider and disable request compression for the fixture.
It checks actual behavior through `exec_command` and direct `apply_patch` calls:

- Coder writes source and scratch; Reviewer reads source and writes scratch.
- Reviewer resumes the Coder's exact native thread ID under the narrower current profile.
- Outside paths, symlink escapes, project `.env`, CLI credentials, and the parent
  process's `/proc` environment cannot expose synthetic secrets.
- Model authentication reaches the provider but remains absent from tool environments.
- Tool TCP connections fail, while production `dist/bin/team report/status` reaches
  production `createTeamMailboxBroker`, then a real HTTP endpoint that validates the
  bound workspace, agent, and host-owned token before acknowledging delivery.
- Tools cannot forge mailbox responses. The CLI only receives a mailbox placeholder token.
- `git log` and `git diff` work in a real linked worktree using the sanitized read-only
  metadata view, while original Git configuration remains denied.
- Untrusted project settings cannot enable unrestricted permissions, MCP commands,
  or extra tools. The advertised tool set is checked explicitly.

The HTTP receiver is synthetic; Hive's HTTP authorization, dispatch, and SQLite
semantics have separate runtime integration coverage. This evidence is limited to
the recorded Linux binary, model tool metadata, profile, and Git view hashes. It does
not certify Windows/macOS containment or purge secrets already present in Git history.
