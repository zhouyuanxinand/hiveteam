import { access, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export const resolveCodexNativeExecutable = async (
  path: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
) => {
  const name = basename(path).toLowerCase()
  if (name === 'codex' || name === 'codex.exe') return path
  if (!/^codex\.(?:js|cmd|ps1)$/u.test(name)) return path
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null
  const system =
    platform === 'win32'
      ? 'pc-windows-msvc'
      : platform === 'darwin'
        ? 'apple-darwin'
        : platform === 'linux'
          ? 'unknown-linux-musl'
          : null
  if (!cpu || !system) return path
  const target = `${cpu}-${system}`
  const filename = platform === 'win32' ? 'codex.exe' : 'codex'
  const roots =
    name === 'codex.js'
      ? [join(dirname(path), '..')]
      : [join(dirname(path), 'node_modules', '@openai', 'codex')]
  for (const root of roots) {
    const candidate = join(
      root,
      'node_modules',
      '@openai',
      `codex-${platform}-${arch}`,
      'vendor',
      target,
      'bin',
      filename
    )
    try {
      await access(candidate)
      return await realpath(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return path
}
