import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'
import { describeSkillPackSource } from '../shared/skill-pack-source.js'
import type { SkillPackManifest, SkillPackRelease, SkillPackSource } from '../shared/skill-packs.js'
import { normalizeResolveSkillPackInput } from './skill-pack-source.js'

interface SkillPackReleaseRow {
  cache_key: string
  content_digest: string
  created_at: number
  id: string
  manifest_json: string
  resolved_revision: string
  source_dirty: number
  source_json: string
  source_type: SkillPackSource['type']
  source_uri: string
}

export interface SaveSkillPackReleaseInput {
  cacheKey: string
  contentDigest: string
  manifest: SkillPackManifest
  resolvedRevision: string
  source: SkillPackSource
  sourceDirty: boolean
  sourceUri: string
}

const serializeSource = (source: SkillPackSource) =>
  JSON.stringify(describeSkillPackSource(source).payload)

const sourceFromRow = (row: SkillPackReleaseRow): SkillPackSource => {
  try {
    const source = JSON.parse(row.source_json) as SkillPackSource
    return normalizeResolveSkillPackInput({ packName: 'release', source }).source
  } catch (error) {
    throw new Error(`Persisted Skill Pack source is invalid: ${row.id}`, { cause: error })
  }
}

const fromRow = (row: SkillPackReleaseRow, packName: string): SkillPackRelease => ({
  cacheKey: row.cache_key,
  contentDigest: row.content_digest,
  createdAt: row.created_at,
  id: row.id,
  manifest: JSON.parse(row.manifest_json) as SkillPackManifest,
  packName,
  resolvedRevision: row.resolved_revision,
  source: sourceFromRow(row),
  sourceDirty: row.source_dirty !== 0,
  sourceUri: row.source_uri,
})

const SELECT_RELEASE = `SELECT id, source_type, source_uri, source_json, resolved_revision,
                                content_digest, manifest_json, cache_key,
                                source_dirty, created_at
                         FROM skill_pack_releases`

export const createSkillPackReleaseStore = (db: Database) => {
  const save = (input: SaveSkillPackReleaseInput, packName: string): SkillPackRelease => {
    const id = randomUUID()
    const createdAt = Date.now()
    const sourceJson = serializeSource(input.source)
    db.prepare(
      `INSERT OR IGNORE INTO skill_pack_releases (
         id, source_type, source_uri, source_json, resolved_revision, content_digest,
         manifest_json, cache_key, source_dirty, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.source.type,
      input.sourceUri,
      sourceJson,
      input.resolvedRevision,
      input.contentDigest,
      JSON.stringify(input.manifest),
      input.cacheKey,
      input.sourceDirty ? 1 : 0,
      createdAt
    )
    const row = db
      .prepare(
        `${SELECT_RELEASE}
         WHERE source_type = ? AND source_uri = ? AND source_json = ?
           AND resolved_revision = ? AND content_digest = ?`
      )
      .get(
        input.source.type,
        input.sourceUri,
        sourceJson,
        input.resolvedRevision,
        input.contentDigest
      ) as SkillPackReleaseRow | undefined
    if (!row) throw new Error('Skill Pack release persistence failed')
    return fromRow(row, packName)
  }

  const getById = (releaseId: string, packName = ''): SkillPackRelease | null => {
    const row = db.prepare(`${SELECT_RELEASE} WHERE id = ?`).get(releaseId) as
      | SkillPackReleaseRow
      | undefined
    return row ? fromRow(row, packName) : null
  }

  return { getById, save }
}
