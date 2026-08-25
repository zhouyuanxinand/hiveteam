import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'

import { getRequiredParam, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const WORKFLOW_EXTENSIONS = new Set(['.cjs', '.js', '.json', '.md', '.mjs', '.ts', '.yaml', '.yml'])
const MAX_WORKFLOW_FILES = 100

const extensionOf = (name: string) => {
  const index = name.lastIndexOf('.')
  return index < 0 ? '' : name.slice(index).toLowerCase()
}

const titleFromFileName = (name: string) => {
  const withoutExtension = name.replace(/\.[^.]+$/, '')
  return withoutExtension
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

const extractMetadata = (source: string, fallbackName: string) => {
  const nameMatch = source.match(/(?:name|title)\s*[:=]\s*['"]([^'"]{1,100})['"]/i)
  const descriptionMatch = source.match(/description\s*[:=]\s*['"]([^'"]{1,240})['"]/i)
  return {
    description: descriptionMatch?.[1]?.trim() ?? '',
    name: nameMatch?.[1]?.trim() ?? titleFromFileName(fallbackName),
  }
}

const listWorkflowFiles = async (root: string) => {
  const found: string[] = []
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4 || found.length >= MAX_WORKFLOW_FILES) return
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      if (found.length >= MAX_WORKFLOW_FILES) return
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(absolutePath, depth + 1)
      } else if (entry.isFile() && WORKFLOW_EXTENSIONS.has(extensionOf(entry.name))) {
        found.push(absolutePath)
      }
    }
  }
  await visit(root, 0)
  return found
}

export const workflowRoutes: RouteDefinition[] = [
  route('GET', '/api/ui/workspaces/:workspaceId/workflows', async (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const workspaceId = getRequiredParam(
      context.response,
      context.params,
      'workspaceId',
      'Workspace id is required'
    )
    if (!workspaceId) return
    const workspace = context.store.getWorkspaceSnapshot(workspaceId).summary
    const workflowRoot = join(workspace.path, '.hive', 'workflows')
    const files = await listWorkflowFiles(workflowRoot)
    const workflows = await Promise.all(
      files.map(async (filePath) => {
        const [fileStat, source] = await Promise.all([
          stat(filePath),
          readFile(filePath, 'utf8').then((content) => content.slice(0, 12_000)),
        ])
        const metadata = extractMetadata(source, basename(filePath))
        return {
          description: metadata.description,
          id: relative(workflowRoot, filePath).replaceAll('\\', '/'),
          name: metadata.name,
          path: relative(workspace.path, filePath).replaceAll('\\', '/'),
          updated_at: fileStat.mtimeMs,
        }
      })
    )
    workflows.sort((left, right) => right.updated_at - left.updated_at)
    sendJson(context.response, 200, { runs: [], schedules: [], workflows })
  }),
]
