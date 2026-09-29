import { rename, rm } from 'node:fs/promises'
import { create } from 'tar'

// Windows filesystems cannot retain chmod's executable bit. Set it on the
// archive entry so the same package also works on Unix with scripts disabled.
export const preparePackagePermissions = async (archive) => {
  const prepared = `${archive}.prepared`
  try {
    await create(
      {
        file: prepared,
        sync: true,
        gzip: true,
        strict: true,
        portable: true,
        filter(path, entry) {
          if (path === 'package/dist/bin/team' && entry.type === 'File') entry.mode = 0o755
          return true
        },
      },
      [`@${archive}`]
    )
    await rename(prepared, archive)
  } finally {
    await rm(prepared, { force: true })
  }
}
