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

Drag exactly one folder from Explorer, Finder, or a Linux file manager anywhere
onto the HiveTeam window. The existing Workspace confirmation dialog opens with
the folder's absolute path.

The renderer remains sandboxed. A preload bridge resolves only a dropped
`File`, and the main process verifies the resulting path through a private,
random-token-protected loopback route.
