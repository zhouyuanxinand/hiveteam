import {
  MEMORY_DREAM_MAX_OPERATIONS,
  type MemoryDreamAction,
  type MemoryDreamOperation,
  type MemoryDreamValue,
} from '../shared/memory-dream-plan.js'
import {
  isTeamMemoryKind,
  isTeamMemoryScope,
  normalizeTeamMemoryProcedureRef,
  TEAM_MEMORY_BODY_MAX_CHARS,
} from '../shared/team-memory.js'
import { BadRequestError } from './http-errors.js'

const object = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestError(`${name} must be an object`)
  return value as Record<string, unknown>
}
export const requireDreamRevision = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new BadRequestError('expected_revision must be a positive integer')
  return value
}
export const parseDreamValue = (input: unknown): MemoryDreamValue => {
  const value = object(input, 'Operation result')
  if (
    typeof value.body !== 'string' ||
    !value.body.trim() ||
    value.body.trim().length > TEAM_MEMORY_BODY_MAX_CHARS
  )
    throw new BadRequestError('Dream result body must contain 1 to 4000 characters')
  if (!isTeamMemoryKind(value.kind) || !isTeamMemoryScope(value.scope))
    throw new BadRequestError('Invalid Dream result kind or scope')
  if (
    !Array.isArray(value.tags) ||
    value.tags.length > 20 ||
    value.tags.some((tag) => typeof tag !== 'string' || tag.length > 64)
  )
    throw new BadRequestError(
      'Dream result tags must contain at most 20 strings of 64 characters or fewer'
    )
  let procedureRef: MemoryDreamValue['procedure_ref']
  try {
    procedureRef = normalizeTeamMemoryProcedureRef(value.procedure_ref)
  } catch (cause) {
    throw new BadRequestError(cause instanceof Error ? cause.message : String(cause))
  }
  if (value.kind === 'procedure_ref' && !procedureRef)
    throw new BadRequestError('procedure_ref is required when kind is procedure_ref')
  return {
    body: value.body.trim(),
    kind: value.kind,
    scope: value.scope,
    procedure_ref: procedureRef,
    tags: [...new Set((value.tags as string[]).map((tag) => tag.trim()).filter(Boolean))],
  }
}
export const parseDreamOperations = (value: unknown): MemoryDreamOperation[] => {
  if (!Array.isArray(value) || value.length > MEMORY_DREAM_MAX_OPERATIONS)
    throw new BadRequestError('operations must be an array of at most 50 explicit operations')
  const ids = new Set<string>()
  const touched = new Set<string>()
  return value.map((item) => {
    const operation = object(item, 'Dream operation')
    if (
      typeof operation.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(operation.id) ||
      ids.has(operation.id)
    )
      throw new BadRequestError('Each Dream operation must have a unique UUID')
    ids.add(operation.id)
    if (!['add', 'rewrite', 'merge', 'archive'].includes(String(operation.action)))
      throw new BadRequestError('Dream action must be add, rewrite, merge or archive')
    const action = operation.action as MemoryDreamAction
    if (!Array.isArray(operation.sources) || operation.sources.length > 50)
      throw new BadRequestError('Operation sources must contain at most 50 versioned references')
    const sourceIds = new Set<string>()
    const sources = operation.sources.map((item) => {
      const source = object(item, 'Dream source')
      if (
        typeof source.memory_id !== 'string' ||
        !source.memory_id ||
        source.memory_id.length > 256 ||
        sourceIds.has(source.memory_id)
      )
        throw new BadRequestError('Operation sources must have unique memory IDs')
      sourceIds.add(source.memory_id)
      if (typeof source.expected_hash !== 'string' || !/^[a-f0-9]{64}$/u.test(source.expected_hash))
        throw new BadRequestError('A captured source hash is required')
      if (action !== 'add') {
        if (touched.has(source.memory_id))
          throw new BadRequestError(
            'A memory cannot be changed by multiple operations in one Dream'
          )
        touched.add(source.memory_id)
      }
      return {
        memory_id: source.memory_id,
        expected_revision: requireDreamRevision(source.expected_revision),
        expected_hash: source.expected_hash,
      }
    })
    if (
      (action === 'rewrite' && sources.length !== 1) ||
      (action === 'merge' && sources.length < 2) ||
      (action === 'archive' && sources.length < 1)
    )
      throw new BadRequestError(
        'rewrite needs one source, merge needs at least two, and archive needs at least one'
      )
    if (action === 'archive' && operation.result !== null)
      throw new BadRequestError('Archive operations must have a null result')
    let messageSources: number[] | undefined
    if (operation.message_sources !== undefined) {
      if (
        !Array.isArray(operation.message_sources) ||
        operation.message_sources.length > 20 ||
        operation.message_sources.some(
          (sequence) => !Number.isSafeInteger(sequence) || sequence < 1
        )
      )
        throw new BadRequestError(
          'message_sources must contain at most 20 positive sequence numbers'
        )
      messageSources = [...new Set(operation.message_sources as number[])]
    }
    return {
      ...(messageSources ? { message_sources: messageSources } : {}),
      id: operation.id,
      action,
      sources,
      result: action === 'archive' ? null : parseDreamValue(operation.result),
    }
  })
}
