import type { MemoryDreamGeneration } from '../shared/memory-dream-generation.js'
import { BadRequestError } from './http-errors.js'
import { parseDreamValue } from './memory-dream-input.js'

/** Validate the entire response before publishing any candidate or consuming evidence. */
export const parseDreamGenerationResult = (
  value: unknown,
  input: MemoryDreamGeneration['input']
) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestError('Dream result must be an object')
  const result = value as Record<string, unknown>
  if (!Array.isArray(result.candidates) || result.candidates.length > 20)
    throw new BadRequestError('candidates must contain at most 20 entries')
  if (typeof result.summary !== 'string' || !result.summary.trim() || result.summary.length > 2000)
    throw new BadRequestError('summary must contain 1 to 2000 characters')
  const sequences = new Set(input.messages.map((message) => message.sequence))
  const candidates = result.candidates.map((item) => {
    const candidate = parseDreamValue(item)
    if (candidate.scope !== 'workspace')
      throw new BadRequestError('Generated candidates must use workspace scope')
    const sources = (item as Record<string, unknown>).source_sequences
    if (
      !Array.isArray(sources) ||
      sources.length < 1 ||
      sources.length > 20 ||
      sources.some((sequence) => !Number.isSafeInteger(sequence) || !sequences.has(sequence))
    )
      throw new BadRequestError('Every candidate must cite message sequences in this frozen window')
    return {
      ...candidate,
      source_sequences: [...new Set(sources as number[])].sort((a, b) => a - b),
    }
  })
  return { candidates, summary: result.summary.trim() }
}
