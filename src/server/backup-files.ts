import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { BadRequestError } from './http-errors.js'

export const backupHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export const backupPath = (root: string, name: string) => {
  if (
    !name ||
    name.includes('\\') ||
    name.includes(':') ||
    name.includes('\0') ||
    isAbsolute(name) ||
    name.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new BadRequestError('Invalid backup member path')
  const path = resolve(root, name),
    rel = relative(resolve(root), path)
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel))
    throw new BadRequestError('Backup member escapes its directory')
  return path
}
export const privateBackupDirectory = async (path: string) => {
  await mkdir(path, { mode: 0o700 })
  if (process.platform === 'win32')
    await promisify(execFile)(
      'icacls.exe',
      [path, '/inheritance:r', '/grant:r', `${userInfo().username}:(OI)(CI)F`],
      { windowsHide: true }
    )
}
export const readBackupFile = async (
  root: string,
  name: string,
  maxBytes = 256 * 1024 * 1024,
  prefixBytes?: number
) => {
  const path = backupPath(root, name)
  let current = resolve(root)
  if ((await lstat(current)).isSymbolicLink())
    throw new BadRequestError('Backup root must not be a symbolic link')
  for (const part of name.split('/')) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink())
      throw new BadRequestError('Backup members must not be symbolic links')
  }
  if ((await realpath(path)) !== path) throw new BadRequestError('Backup member was redirected')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await file.stat(),
      size = prefixBytes ?? before.size
    if (!before.isFile() || before.nlink !== 1 || size > maxBytes || size < 0 || size > before.size)
      throw new BadRequestError('Invalid backup member size or file type')
    const bytes = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const read = await file.read(bytes, offset, size - offset, offset)
      if (!read.bytesRead) throw new BadRequestError('Backup member changed while reading')
      offset += read.bytesRead
    }
    const after = await file.stat()
    if (
      prefixBytes === undefined &&
      (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
    )
      throw new BadRequestError('Backup member changed while reading')
    return bytes
  } finally {
    await file.close()
  }
}
/** Only remove an exact directory we created directly inside its recorded parent. */
export const removeOwnedBackupDirectory = async (parent: string, path: string) => {
  if (
    resolve(join(parent, relative(parent, path))) !== resolve(path) ||
    relative(parent, path).includes(sep) ||
    relative(parent, path).startsWith('..')
  )
    throw new Error('Invalid owned backup cleanup path')
  await rm(path, { recursive: true, force: true })
}
