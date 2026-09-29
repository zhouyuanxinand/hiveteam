# HiveTeam desktop development entry

The optional Electron shell adds OS-backed folder drag and drop. It starts the
same local HiveTeam runtime and Vite UI used by browser development; ordinary
browser behavior is unchanged.

The runtime requires Node 22.18+ within 22.x, or Node 24.x. Its built-in SQLite
and precompiled PTY do not need native rebuilds. Electron remains a separate
optional dependency installation; the runtime's `--ignore-scripts` package
acceptance does not cover downloading Electron or building the frontend.

From the repository root:

```bash
pnpm desktop:install
pnpm desktop:dev
```

Before starting local services, HiveTeam asks whether to open the Electron
desktop client or the Web interface. Only the selected interface is opened.
Web mode runs from the system tray after the browser closes; use the tray menu
to reopen or exit HiveTeam. Desktop mode confirms before it stops the local
services and closes.

Both modes receive a one-time sign-in link over the private launcher/runtime
IPC channel. The link expires after 60 seconds and the UI removes its fragment
before exchanging it for an HttpOnly cookie. Refreshing an authenticated window
keeps its session until the runtime restarts. After a restart or when opening a
new browser profile, reopen through the tray/desktop launcher. Opening only the
printed localhost URL does not grant a new management session.

`hive` and `pnpm start` open the authenticated browser themselves; enter `o` in
their terminal to request another link. Do not copy a sign-in link into logs or
share it with another user. The launcher does not put UI credentials in worker
environment variables, URLs sent to the HTTP server, or workspace files.

For unattended development or automation, skip the chooser with
`HIVE_DESKTOP_LAUNCH_MODE=desktop` or `HIVE_DESKTOP_LAUNCH_MODE=web`.

Both modes print `Data directory` at startup and use the CLI's default
`<OS home>/.config/hive`, including `%USERPROFILE%\.config\hive` on Windows.
`HIVE_DATA_DIR` overrides the default. Relative overrides are resolved against
the launcher's working directory before child services switch to the install
directory; `pnpm --dir desktop start` starts the launcher in `desktop/`.
Use an absolute override when launching from different directories.
See [Data Locations](../README.md#data-locations) for examples and the separate
Windows / WSL defaults.

Drag exactly one folder from Explorer, Finder, or a Linux file manager anywhere
onto the HiveTeam window. The existing Workspace confirmation dialog opens with
the folder's absolute path.

The renderer remains sandboxed. A preload bridge resolves only a dropped
`File`, and the main process verifies the resulting path through a private,
random-token-protected loopback route.
