import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const distBin = join(root, 'dist', 'bin')
const distVendor = join(root, 'dist', 'vendor')

const copyRequired = (source, target, mode) => {
  const sourcePath = join(root, source)
  if (!existsSync(sourcePath)) {
    throw new Error(`Missing required build artifact source: ${source}`)
  }
  const targetPath = join(root, target)
  copyFileSync(sourcePath, targetPath)
  if (mode) chmodSync(targetPath, mode)
}

const copyDirRequired = (source, target) => {
  const sourcePath = join(root, source)
  if (!existsSync(sourcePath)) {
    throw new Error(`Missing required build artifact source: ${source}`)
  }
  const targetPath = join(root, target)
  const copyDirectory = (from, to) => {
    mkdirSync(to, { recursive: true })
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const fromPath = join(from, entry.name)
      const toPath = join(to, entry.name)
      if (entry.isDirectory()) {
        copyDirectory(fromPath, toPath)
      } else if (entry.isFile()) {
        copyFileSync(fromPath, toPath)
      }
    }
  }

  // Node's fs.cpSync can crash on Windows while recursively copying the
  // Marketplace bundle. Copying entries explicitly has the same packaged
  // result while keeping `pnpm build` reliable on Windows.
  copyDirectory(sourcePath, targetPath)
}

mkdirSync(distBin, { recursive: true })
copyRequired('bin/team', 'dist/bin/team', 0o755)
copyRequired('bin/team.cmd', 'dist/bin/team.cmd')

mkdirSync(distVendor, { recursive: true })
copyDirRequired('vendor/marketplace', 'dist/vendor/marketplace')
