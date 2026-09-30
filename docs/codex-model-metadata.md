# Codex model metadata warnings

`Model metadata for 'gpt-6-sol' not found` comes from the native Codex CLI. A
successful model response does not establish that the CLI has the correct model
instructions, context limits or supported capabilities.

Codex 0.155.1 does not bundle GPT-6 Sol metadata. It can discover that metadata
online, but its model cache expires and is tied to the CLI version and account.
A desktop application and a CLI using the same `CODEX_HOME` can invalidate each
other's cache when their versions differ. When discovery also fails, 0.155.1
uses fallback metadata. Restarting with a warm cache can hide the problem until
the next cold start.

Use an official CLI release that bundles the selected model. For GPT-6 Sol,
Codex **0.158.0** was checked on Windows x64 with an empty CLI home: the model
catalog includes `gpt-6-sol`, its `ultra` reasoning option and image input, and a
first turn does not emit the fallback warning. This check uses no credentials or
paid model generation; it verifies local metadata, not model availability for an
account.

For an npm-managed installation:

```sh
npm install --global @openai/codex@0.158.0
codex --version
```

Check the command HiveTeam actually resolves (`where.exe codex` on Windows or
`command -v codex` on Unix); the desktop application's bundled binary can differ
from the CLI on `PATH`. Finish the current task and restart the affected member
to load the replacement executable. An existing terminal keeps its old process
and warning history until it is restarted. Preserve the saved native session;
do not delete the account's configuration, authentication or conversations.

HiveTeam binds execution grants to executable bytes. A CLI upgrade invalidates the
old grant; review the new CLI in **Execution permissions** before starting it.
Version recognition and the fixed `login status` check do not establish sandbox
support: the restricted Linux profile remains pinned to its separately tested
Codex 0.155.1 artifact. The Windows 0.158.0 recognition applies only to the exact
verified release, not arbitrary binaries claiming that version.

Do not suppress the terminal warning, substitute another model, manufacture
metadata, or copy the desktop application's credentials to work around it.
Custom model providers and custom catalogs must supply metadata for their own
models.

Sources: [Codex 0.155.1 bundled catalog](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/models-manager/models.json),
[Codex 0.158.0 bundled catalog](https://github.com/openai/codex/blob/rust-v0.158.0/codex-rs/models-manager/models.json),
[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
