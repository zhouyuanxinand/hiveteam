# Tester disposable checkout acceptance

The restricted Tester now captures the registered worktree's committed HEAD before
launch and materializes that SHA in a fresh runtime-owned checkout. The source
worktree is readable but not writable by generated tools. The stable temporary
CWD allows native session resume after the prior checkout and test artifacts have
been removed. Existing sessions captured in the old source CWD fail explicitly;
they are not silently rebound or discarded.

`checkout_head_sha` is persisted in the execution snapshot and exposed in the
active-policy response. Every new run captures its source HEAD again; uncommitted
source edits are not part of the tested snapshot. Native process cleanup completes
before the checkout is removed and the execution reservation is released.

Automated real Git coverage in `execution-tester-checkout.test.ts` verifies pinned
HEAD, source index preservation, artifact isolation, fresh recreation, malicious
hooks/smudge/fsmonitor exclusion, and failure cleanup with preserved error causes.
The initial implementation rejects symlink and submodule entries rather than
claiming they were checked out faithfully. SHA-256 repositories remain unsupported
by the restricted Git profile.

`codex-tester-acceptance.linux.json` records a real Codex 0.155.1 experiment repeated
on 2026-09-21 against a synthetic loopback Responses provider. It uses the current
production checkout helper compiled into `dist` and the unchanged production
permissions profile; the report binds both source files and the CLI binary by
SHA-256. The registered source
is a linked Git worktree with a selected package subdirectory. The temporary CWD
retains that subdirectory; the surrounding temporary repository is read-only.
Both the first run and native resume of the same thread
observed source writes rejected with `EROFS`, source `.env` and CLI authentication
home rejected with `EACCES`, selected checkout subdirectory and scratch writes
allowed, temporary repository-root writes rejected with `EROFS`, and the
previous run's artifact absent. Native `apply_patch` created a checkout artifact
and could not create a source artifact. `git log` reported the pinned SHA, and
checkout cleanup completed after each CLI exit.

Run after compiling the production TypeScript into `dist`:

```sh
python3 tests/manual/codex-tester-acceptance.py \
  --codex /absolute/path/to/pinned/linux/codex \
  --report /absolute/path/to/codex-tester-acceptance.linux.json
```

The fixture uses Linux/WSL, a pinned binary hash and synthetic credentials only.
It does not validate Windows/macOS isolation, spend model tokens, access a user's
authentication files, or repeat the existing Coder/Reviewer network and team
transport acceptance. Those original evidence files and profile hashes remain
unchanged. Existing Git object history can contain previously committed secrets;
this checkout change does not sanitize that history.
