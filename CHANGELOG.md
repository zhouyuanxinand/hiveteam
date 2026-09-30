# Changelog

All notable user-facing changes to HiveTeam are documented in this file.

## 2.1.20 - 2026-09-30

- Checks npm for newer HiveTeam releases and shows a small upgrade hint beside
  the page version, with copyable global-install and `npx` commands.
- Uses HiveTeam consistently in the runtime, web UI, project metadata, and
  documentation.
- Distributes the current HiveTeam project under the MIT License.
- Removes the built-in remote gateway address. First remote login requires
  `hive remote login --gateway <url>` for a self-hosted gateway; subsequent
  logins can reuse the saved URL.

## 2.1.19 - 2026-09-30

First npm release of `hiveteam`.

- Publishes `hiveteam@2.1.19` with the `hive` command. Run it with
  `npx --yes hiveteam@latest`, or install globally with
  `npm install -g hiveteam@latest` and start `hive`.
- Includes the compiled runtime, browser UI, internal `team` command, and
  runtime resources so installation does not require a source checkout or
  frontend build.
- Documents npm installation and upgrades in the README. `hive update` prints
  the npm commands; upgrades remain explicit.
- Publishes the same package archive accepted by the local Windows installation
  checks. Code checks, type checks, build, and the full test suite passed before
  publication. The remote CI platform matrix was not run for this release.
