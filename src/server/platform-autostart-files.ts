import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

export interface AutostartLaunchConfig {
  project_root: string
  node_executable: string
  data_dir: string
  runtime_port: number
  web_port?: number
  launch_mode: 'runtime' | 'development'
  runtime_entry?: 'source' | 'built'
}

export const readAutostartFile = async (path: string): Promise<string | null> => {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Autostart path is not a regular owned file: ${path}`)
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export const readOwnedAutostartConfig = async (
  path: string,
  expected: AutostartLaunchConfig
): Promise<AutostartLaunchConfig | null> => {
  const content = await readAutostartFile(path)
  if (content === null) return null
  const config: unknown = JSON.parse(content)
  if (
    !config ||
    typeof config !== 'object' ||
    !('project_root' in config) ||
    config.project_root !== expected.project_root ||
    !('data_dir' in config) ||
    config.data_dir !== expected.data_dir
  )
    throw new Error('Autostart configuration belongs to another project or data directory.')
  const keys = [
    'project_root',
    'node_executable',
    'data_dir',
    'runtime_port',
    'web_port',
    'launch_mode',
    'runtime_entry',
  ]
  const saved = config as Record<string, unknown>
  const validPort = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535
  if (
    Object.keys(saved).some((key) => !keys.includes(key)) ||
    typeof saved.node_executable !== 'string' ||
    !isAbsolute(saved.node_executable) ||
    [...saved.node_executable].some((character) => character.charCodeAt(0) < 32) ||
    !validPort(saved.runtime_port) ||
    (saved.web_port !== undefined && !validPort(saved.web_port)) ||
    (saved.launch_mode !== 'runtime' && saved.launch_mode !== 'development') ||
    (saved.runtime_entry !== undefined &&
      saved.runtime_entry !== 'source' &&
      saved.runtime_entry !== 'built')
  )
    throw new Error('Autostart launch configuration is invalid or contains unsupported fields.')
  return config as AutostartLaunchConfig
}

export const writeAutostartFile = async (path: string, content: string) => {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export const xmlString = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&apos;'
    }
  })
