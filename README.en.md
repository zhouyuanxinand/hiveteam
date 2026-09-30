# HiveTeam English README

The English README is now the default GitHub entry point:

[README.md](./README.md)

New workspaces install `matt` and `code-janitor` by default. Both creation dialogs
let you explicitly choose Basic mode to create offline without default packs.
Existing project skills and files are preserved in either mode.

Development setup and verification commands are documented in
[Development](./README.md#development).

Run the published package with `npx --yes hiveteam@latest`, or install
with `npm install -g hiveteam@latest` and start `hive`. See
[Quick Start](./README.md#quick-start) for runtime requirements and updates, and
[npm releases](./docs/npm-release.md) for maintainer publishing instructions.

An **Upgrade to latest** hint beside the page version appears when npm has a
newer release. It provides copyable upgrade commands; stop HiveTeam, upgrade,
and restart it to use the new version.

The shared package artifact, local acceptance command, and CI platform matrix are
documented in [Release artifact verification](./README.md#release-artifact-verification).

Chinese documentation is available here:

[README.zh.md](./README.zh.md)

Windows and macOS sign-in startup is available under **Resources → Platform recovery** and is off by default. The platform launcher also recovers failed services; normal exits stay stopped until the next launch or sign-in. See [Platform recovery and sign-in startup](./docs/platform-recovery.md).

Remote access requires a [self-hosted gateway](./gateway/README.md). HiveTeam has
no default gateway address. First login requires `hive remote login --gateway <url>`;
after the URL is saved, `hive remote login` reuses it.

## License

HiveTeam is distributed under the [MIT License](./LICENSE).
