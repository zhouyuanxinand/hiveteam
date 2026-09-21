import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import {
  type WorkflowCatalogItem,
  type WorkflowStepDefinition,
  workflowConditions,
} from '../shared/workflows.js'
import { BadRequestError } from './http-errors.js'
import { sanitizePromptData } from './prompt-safety.js'

const WORKFLOW_EXTENSIONS = new Set(['.cjs', '.js', '.json', '.md', '.mjs', '.ts', '.yaml', '.yml'])
const MAX_WORKFLOW_FILES = 100
const MAX_WORKFLOW_STEPS = 20
const MAX_WORKFLOW_SOURCE_BYTES = 128 * 1024
const MAX_TASK_LENGTH = 4_000
const MAX_REPORT_LENGTH = 8_000

interface WorkflowDefinition {
  description: string
  name: string
  steps: WorkflowStepDefinition[]
}

const titleFromFileName = (name: string) =>
  name
    .replace(/\.[^.]+$/, '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ')

const readText = (value: unknown, fallback: string, maxLength: number) =>
  typeof value === 'string' && value.trim() ? sanitizePromptData(value.trim(), maxLength) : fallback

const parseDefinition = (
  value: unknown,
  fallbackName: string
): { definition?: WorkflowDefinition; error?: string } => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'Workflow JSON must contain an object.' }
  }
  const record = value as Record<string, unknown>
  const name = readText(record.name, fallbackName, 100)
  const description = readText(record.description, '', 240)
  if (!Array.isArray(record.steps) || record.steps.length === 0) {
    return { error: 'Workflow JSON must define at least one step.' }
  }
  if (record.steps.length > MAX_WORKFLOW_STEPS) {
    return { error: `Workflow cannot contain more than ${MAX_WORKFLOW_STEPS} steps.` }
  }

  const ids = new Set<string>()
  const steps: WorkflowStepDefinition[] = []
  for (const item of record.steps) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: 'Every workflow step must be an object.' }
    }
    const step = item as Record<string, unknown>
    const id = readText(step.id, '', 100)
    const worker = readText(step.worker, '', 100)
    const task = readText(step.task, '', MAX_TASK_LENGTH)
    if (!id || !worker || !task) {
      return { error: 'Every workflow step needs id, worker, and task.' }
    }
    if (ids.has(id)) return { error: `Workflow step id is duplicated: ${id}` }
    ids.add(id)
    const needsValue = step.needs
    if (needsValue !== undefined && !Array.isArray(needsValue)) {
      return { error: `Workflow step ${id} needs must be an array.` }
    }
    const needs = (Array.isArray(needsValue) ? needsValue : [])
      .filter((need): need is string => typeof need === 'string' && Boolean(need.trim()))
      .map((need) => sanitizePromptData(need.trim(), 100))
    if (needs.length !== (Array.isArray(needsValue) ? needsValue.length : 0)) {
      return { error: `Workflow step ${id} has an invalid dependency.` }
    }
    if (step.quality !== undefined) {
      const quality = step.quality as Record<string, unknown> | null
      if (
        !quality ||
        typeof quality !== 'object' ||
        Array.isArray(quality) ||
        Object.keys(quality).some((key) => key !== 'all_of') ||
        !Array.isArray(quality.all_of) ||
        !quality.all_of.length ||
        quality.all_of.some((condition) => !workflowConditions.includes(condition)) ||
        new Set(quality.all_of).size !== quality.all_of.length
      )
        return {
          error: `Workflow step ${id} quality must contain a nonempty all_of of report_success, review_accepted, verification_passed.`,
        }
    }
    steps.push({
      id,
      needs: [...new Set(needs)],
      task,
      worker,
      ...(step.quality
        ? { quality: step.quality as NonNullable<WorkflowStepDefinition['quality']> }
        : {}),
    })
  }

  const stepIds = new Set(steps.map((step) => step.id))
  for (const step of steps) {
    if (step.needs.some((need) => need === step.id || !stepIds.has(need))) {
      return { error: `Workflow step ${step.id} references an invalid dependency.` }
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(steps.map((step) => [step.id, step]))
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false
    if (visited.has(id)) return true
    visiting.add(id)
    const step = byId.get(id)
    if (!step || step.needs.every(visit)) {
      visiting.delete(id)
      visited.add(id)
      return true
    }
    return false
  }
  if (steps.some((step) => !visit(step.id)))
    return { error: 'Workflow dependencies contain a cycle.' }

  return { definition: { description, name, steps } }
}

const listWorkflowFiles = async (root: string) => {
  const found: string[] = []
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4 || found.length >= MAX_WORKFLOW_FILES) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      if (found.length >= MAX_WORKFLOW_FILES) return
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolutePath, depth + 1)
      else if (entry.isFile() && WORKFLOW_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        found.push(absolutePath)
      }
    }
  }
  await visit(root, 0)
  return found
}

const resolveWorkflowPath = (workflowRoot: string, workflowId: string) => {
  const root = resolve(workflowRoot)
  const candidate = resolve(root, workflowId)
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
    throw new BadRequestError('Workflow path is outside .hive/workflows')
  }
  const normalizedId = relative(root, candidate).replaceAll('\\', '/')
  if (normalizedId !== workflowId) throw new BadRequestError('Workflow path is invalid')
  return candidate
}

const readCatalogItem = async (workflowRoot: string, workspacePath: string, filePath: string) => {
  const source = await readFile(filePath, 'utf8').then((content) => content.slice(0, 12_000))
  const id = relative(workflowRoot, filePath).replaceAll('\\', '/')
  const extension = extname(filePath).toLowerCase()
  let name = titleFromFileName(basename(filePath))
  let description = ''
  let validationError: string | null = null
  if (extension === '.json') {
    try {
      const parsed = parseDefinition(JSON.parse(source), name)
      if (parsed.definition) {
        name = parsed.definition.name
        description = parsed.definition.description
      } else validationError = parsed.error ?? 'Workflow JSON is invalid.'
    } catch {
      validationError = 'Workflow JSON could not be parsed.'
    }
  } else {
    const nameMatch = source.match(/(?:name|title)\s*[:=]\s*['"]([^'"]{1,100})['"]/i)
    const descriptionMatch = source.match(/description\s*[:=]\s*['"]([^'"]{1,240})['"]/i)
    name = readText(nameMatch?.[1], name, 100)
    description = readText(descriptionMatch?.[1], '', 240)
    validationError = 'Only .json workflows are executable; this file is metadata-only.'
  }
  const fileStat = await stat(filePath)
  return {
    description,
    id,
    name,
    path: relative(workspacePath, filePath).replaceAll('\\', '/'),
    runnable: extension === '.json' && validationError === null,
    updatedAt: fileStat.mtimeMs,
    validationError,
  } satisfies WorkflowCatalogItem
}

export {
  listWorkflowFiles,
  MAX_REPORT_LENGTH,
  MAX_TASK_LENGTH,
  MAX_WORKFLOW_SOURCE_BYTES,
  MAX_WORKFLOW_STEPS,
  parseDefinition,
  readCatalogItem,
  resolveWorkflowPath,
  titleFromFileName,
}
