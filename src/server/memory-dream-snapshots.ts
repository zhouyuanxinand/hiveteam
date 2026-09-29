import { createHash, randomUUID } from 'node:crypto'
import type {
  MemoryDreamOperation,
  MemoryDreamSnapshot,
  MemoryDreamSourceVersion,
  MemoryDreamValue,
} from '../shared/memory-dream-plan.js'
import type { TeamMemoryEntry } from '../shared/team-memory.js'
import { TEAM_MEMORY_BODY_MAX_CHARS } from '../shared/team-memory.js'
import type { TeamMemoryStore, UpdateTeamMemoryInput } from './team-memory-store.js'

export const dreamHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const snapshotDreamMemory = (
  memory: TeamMemoryStore,
  workspaceId: string,
  entry: TeamMemoryEntry
): MemoryDreamSnapshot => {
  if (entry.revision === undefined) throw new Error('Persisted memory revision is required')
  const snapshot = {
    memory_id: entry.id,
    revision: entry.revision,
    workspace_id: entry.workspaceId,
    body: entry.body,
    kind: entry.kind,
    scope: entry.scope,
    procedure_ref: entry.procedureRef,
    tags: entry.tags,
    pinned: entry.pinned,
    disabled: entry.disabled,
    status: entry.status,
    source: entry.source,
    confidence: entry.confidence,
    provenance: memory.sources(workspaceId, entry.id),
  }
  return { ...snapshot, content_hash: dreamHash(snapshot) }
}
export const dreamSourceVersion = (source: MemoryDreamSnapshot): MemoryDreamSourceVersion => ({
  memory_id: source.memory_id,
  expected_revision: source.revision,
  expected_hash: source.content_hash,
})
export const dreamValue = (source: MemoryDreamSnapshot): MemoryDreamValue => ({
  body: source.body,
  kind: source.kind,
  scope: source.scope,
  procedure_ref: source.procedure_ref,
  tags: source.tags,
})
export const restoreDreamMemory = (source: MemoryDreamSnapshot): UpdateTeamMemoryInput => ({
  ...dreamValuePatch(source),
  disabled: source.disabled,
  pinned: source.pinned,
  status: source.status,
})
export const dreamValuePatch = (value: MemoryDreamValue) => ({
  body: value.body,
  kind: value.kind,
  scope: value.scope,
  procedureRef: value.procedure_ref,
  tags: value.tags,
})
export const prepareDreamOperations = (sources: MemoryDreamSnapshot[]): MemoryDreamOperation[] => {
  const groups = new Map<string, MemoryDreamSnapshot[]>()
  for (const source of sources) {
    const key = JSON.stringify([
      source.scope,
      source.kind,
      source.procedure_ref?.type,
      source.procedure_ref?.id,
    ])
    groups.set(key, [...(groups.get(key) ?? []), source])
  }
  const operations: MemoryDreamOperation[] = []
  for (const group of groups.values()) {
    const first = group[0]
    if (!first) continue
    const body = group.map((source) => `- ${source.body}`).join('\n')
    if (group.length > 1 && body.length <= TEAM_MEMORY_BODY_MAX_CHARS) {
      operations.push({
        id: randomUUID(),
        action: 'merge',
        sources: group.map(dreamSourceVersion),
        result: {
          ...dreamValue(first),
          body,
          tags: [...new Set(group.flatMap((source) => source.tags))].slice(0, 20),
        },
      })
    } else {
      // Do not silently truncate a consolidation and then archive its complete sources.
      operations.push(
        ...group.map(
          (source): MemoryDreamOperation => ({
            id: randomUUID(),
            action: 'rewrite',
            sources: [dreamSourceVersion(source)],
            result: dreamValue(source),
          })
        )
      )
    }
  }
  return operations
}
