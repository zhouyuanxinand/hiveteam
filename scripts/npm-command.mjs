import { existsSync, realpathSync } from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'

const activeNodeDirectory = dirname(process.execPath)

const findNpmCli = () => {
  const candidates = [
    join(activeNodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(activeNodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    process.env.npm_execpath,
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, 'npm')),
  ]
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue
    const resolved = realpathSync(candidate)
    if (basename(resolved) === 'npm-cli.js') return resolved
  }
  throw new Error(`Cannot locate npm-cli.js for Node at ${process.execPath}`)
}

export const npmCommand = (args, options = {}) => {
  const env = { ...process.env, ...options.env }
  env.PATH = [activeNodeDirectory, env.PATH].filter(Boolean).join(delimiter)
  return {
    file: process.execPath,
    args: [findNpmCli(), ...args],
    options: { ...options, env, windowsHide: true },
  }
}
