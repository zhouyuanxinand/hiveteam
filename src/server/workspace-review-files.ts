import { createHash } from 'node:crypto'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { REVIEW_TEXT_LIMIT, type ReviewDocument } from '../shared/workspace-review.js'
import { BadRequestError, ForbiddenError, HttpError } from './http-errors.js'

export const reviewRevision = (content: string) =>
  createHash('sha256').update(content).digest('hex')

const missing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

export const validateReviewPath = (path: string) => {
  if (path.includes('\\') || path.includes(':') || isAbsolute(path) || path.includes('\0')) {
    throw new ForbiddenError('Use a workspace-relative Markdown path')
  }
  const parts = path.split('/')
  if (
    parts.some((part) => !part || part === '..' || part.startsWith('.')) &&
    path !== '.hive/tasks.md'
  ) {
    throw new ForbiddenError('Hidden paths and parent traversal are not allowed')
  }
  if (
    !/\.md$/i.test(path) ||
    (parts.length > 1 && parts[0] !== 'docs' && path !== '.hive/tasks.md')
  ) {
    throw new ForbiddenError('Only root Markdown, docs/**/*.md and .hive/tasks.md are available')
  }
  return path
}

export const readReviewDocument = async (
  workspacePath: string,
  path: string
): Promise<ReviewDocument> => {
  validateReviewPath(path)
  const root = await realpath(workspacePath)
  let target = root
  try {
    const parts = path.split('/')
    for (const [index, part] of parts.entries()) {
      target = join(target, part)
      const metadata = await lstat(target)
      if (metadata.isSymbolicLink()) throw new ForbiddenError('Linked documents are not available')
      if (index === parts.length - 1 && !metadata.isFile())
        throw new BadRequestError('Not a regular Markdown file')
      if (index < parts.length - 1 && !metadata.isDirectory())
        throw new BadRequestError('Document parent is not a directory')
    }
    const resolved = await realpath(target)
    const rel = relative(root, resolved)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new ForbiddenError('Document is outside the workspace')
    const file = await open(resolved, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile()) throw new BadRequestError('Not a regular Markdown file')
      if (stat.size > REVIEW_TEXT_LIMIT) throw new HttpError(413, 'Markdown file exceeds 64 KB')
      const buffer = Buffer.alloc(REVIEW_TEXT_LIMIT + 1)
      let total = 0
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, total)
        if (bytesRead === 0) break
        total += bytesRead
      }
      if (total > REVIEW_TEXT_LIMIT) throw new HttpError(413, 'Markdown file exceeds 64 KB')
      const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total))
      if (content.includes('\0')) throw new BadRequestError('Binary files are not supported')
      return { path, content, revision: reviewRevision(content) }
    } finally {
      await file.close()
    }
  } catch (error) {
    if (missing(error)) throw new HttpError(404, 'Markdown document not found')
    if (
      error instanceof TypeError &&
      'code' in error &&
      error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA'
    ) {
      throw new BadRequestError('Markdown must use UTF-8')
    }
    throw error
  }
}

export const listReviewDocuments = async (workspacePath: string) => {
  const paths: string[] = []
  let visited = 0
  let truncated = false
  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries: string[]
    try {
      entries = await readdir(join(workspacePath, directory))
    } catch (error) {
      if (missing(error) && (directory === 'docs' || directory === '.hive')) return
      throw error
    }
    for (const name of entries.sort()) {
      if (++visited > 1500) {
        truncated = true
        return
      }
      const path = directory ? `${directory}/${name}` : name
      const stat = await lstat(join(workspacePath, path))
      if (stat.isSymbolicLink()) continue
      if (
        stat.isFile() &&
        /\.md$/i.test(name) &&
        !name.startsWith('.') &&
        (directory !== '.hive' || name === 'tasks.md')
      )
        paths.push(path)
      if (
        stat.isDirectory() &&
        !name.startsWith('.') &&
        (directory === '' ? name === 'docs' : directory.startsWith('docs'))
      ) {
        if (depth >= 6) truncated = true
        else await walk(path, depth + 1)
      }
      if (directory === '' && name === '.hive' && stat.isDirectory()) await walk(path, depth + 1)
    }
  }
  await walk('', 0)
  return { paths, truncated }
}
