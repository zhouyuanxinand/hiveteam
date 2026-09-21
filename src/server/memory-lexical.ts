import type { TeamMemoryEntry } from '../shared/team-memory.js'

/** Deterministic lexical fragments, not semantic or embedding similarity. */
export const memoryTokens = (query: string) => {
  const text = query
    .slice(0, 8000)
    .replace(/([a-z])([A-Z])/gu, '$1 $2')
    .toLowerCase()
  const tokens = new Set<string>()
  for (const word of text.match(/[a-z0-9]+(?:[_-][a-z0-9]+)*|\p{Script=Han}+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(word)) {
      for (let size = 2; size <= 3; size += 1)
        for (let i = 0; i + size <= word.length; i += 1) tokens.add(word.slice(i, i + size))
      if (word.length === 1) tokens.add(word)
    } else if (word.length > 1 && !['the', 'and', 'for', 'with', 'this', 'that'].includes(word)) {
      tokens.add(word)
      for (const part of word.split(/[_-]/u)) if (part.length > 1) tokens.add(part)
    }
  }
  return [...tokens].slice(0, 256)
}

export const rankMemory = (
  entries: TeamMemoryEntry[],
  query: string,
  staleSource: (id: string) => boolean = () => false
) => {
  const tokens = memoryTokens(query)
  return entries
    .map((entry) => {
      const fields = {
        body: entry.body,
        tags: entry.tags.join(' '),
        reference: `${entry.procedureRef?.id ?? ''} ${entry.procedureRef?.title ?? ''}`,
      }
      const hits = Object.entries(fields).flatMap(([field, value]) =>
        tokens
          .filter((token) => value.toLowerCase().includes(token))
          .map((token) => ({ field, token }))
      )
      const count = new Set(hits.map((hit) => hit.token)).size
      const stale = staleSource(entry.id)
      const score =
        count * 10 +
        hits.reduce((sum, hit) => sum + (hit.field === 'body' ? 1 : 3), 0) +
        (entry.pinned ? 5 : 0) -
        (stale ? 3 : 0)
      const eligible = entry.status === 'active' && !entry.disabled
      return {
        entry,
        score,
        matched_tokens: count,
        hits,
        eligible,
        reasons: [
          ...(stale ? ['stale_source_penalty'] : []),
          entry.disabled
            ? 'disabled'
            : entry.status !== 'active'
              ? `status_${entry.status}`
              : count
                ? 'lexical_match'
                : entry.pinned
                  ? 'pinned'
                  : 'no_match',
          ...(entry.pinned ? ['pinned_priority'] : []),
        ],
      }
    })
    .sort(
      (a, b) =>
        Number(b.eligible) - Number(a.eligible) ||
        b.score - a.score ||
        b.entry.updatedAt - a.entry.updatedAt ||
        a.entry.id.localeCompare(b.entry.id, 'en')
    )
}
