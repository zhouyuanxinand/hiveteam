import { access, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'

export const resolveCodexNativeExecutable = async (
  path: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
) => {
  const launcher = await realpath(path)
  const name = basename(launcher).toLowerCase()
  if (!/^codex\.(?:js|cmd|ps1)$/u.test(name)) return launcher
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null
  const system =
    platform === 'win32'
      ? 'pc-windows-msvc'
      : platform === 'darwin'
        ? 'apple-darwin'
        : platform === 'linux'
          ? 'unknown-linux-musl'
          : null
  if (!cpu || !system) return launcher
  const target = `${cpu}-${system}`
  const filename = platform === 'win32' ? 'codex.exe' : 'codex'
  const root =
    name === 'codex.js'
      ? join(dirname(launcher), '..')
      : basename(dirname(launcher)).toLowerCase() === '.bin'
        ? join(dirname(launcher), '..', '@openai', 'codex')
        : join(dirname(launcher), 'node_modules', '@openai', 'codex')
  let packageRoot: string
  try {
    packageRoot = await realpath(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return launcher
  }
  // Resolve from the real package location just like Codex's Node launcher.
  // Optional binaries can be nested, hoisted, or linked through pnpm's store.
  let vendorRoot: string
  try {
    const require = createRequire(join(packageRoot, 'bin', 'codex.js'))
    vendorRoot = join(
      dirname(require.resolve(`@openai/codex-${platform}-${arch}/package.json`)),
      'vendor'
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
    vendorRoot = join(packageRoot, 'vendor')
  }
  try {
    const candidate = join(vendorRoot, target, 'bin', filename)
    await access(candidate)
    return await realpath(candidate)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return launcher
}
