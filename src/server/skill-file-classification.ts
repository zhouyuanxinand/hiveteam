import { extname } from 'node:path'

const SCRIPT_EXTENSIONS = new Set([
  '.bash',
  '.bat',
  '.cjs',
  '.cmd',
  '.com',
  '.exe',
  '.js',
  '.mjs',
  '.pl',
  '.ps1',
  '.py',
  '.rb',
  '.sh',
  '.zsh',
])

const EXECUTABLE_MODE_MASK = 0o111

export const isSkillScriptOrExecutable = (relativePath: string, mode?: number) => {
  const normalizedPath = relativePath.replaceAll('\\', '/')
  const segments = normalizedPath.split('/')
  return (
    segments.some((segment) => segment.toLocaleLowerCase('en-US') === 'scripts') ||
    SCRIPT_EXTENSIONS.has(extname(normalizedPath).toLocaleLowerCase('en-US')) ||
    (mode !== undefined && (mode & EXECUTABLE_MODE_MASK) !== 0)
  )
}
