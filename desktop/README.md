# HiveTeam desktop development entry

The optional Electron shell adds OS-backed folder drag and drop. It starts the
same local HiveTeam runtime and Vite UI used by browser development; ordinary
browser behavior is unchanged.

From the repository root:

```bash
pnpm desktop:install
pnpm desktop:dev
```

Drag exactly one folder from Explorer, Finder, or a Linux file manager anywhere
onto the HiveTeam window. The existing Workspace confirmation dialog opens with
the folder's absolute path.

The renderer remains sandboxed. A preload bridge resolves only a dropped
`File`, and the main process verifies the resulting path through a private,
random-token-protected loopback route.
