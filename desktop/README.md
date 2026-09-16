# HiveTeam desktop development entry

The optional Electron shell adds OS-backed folder drag and drop. It starts the
same local HiveTeam runtime and Vite UI used by browser development; ordinary
browser behavior is unchanged.

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
