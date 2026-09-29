import type { MemorySourceReference } from '../shared/memory-provenance.js'
import { BadRequestError } from './http-errors.js'

export const parseMemorySourceReference = (value: unknown): MemorySourceReference | undefined => {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestError('source_ref must be a protocol source reference')
  }
  const ref = value as Record<string, unknown>
  const allowed =
    ref.type === 'dispatch_message'
      ? ['type', 'source_id', 'source_sequence']
      : ['type', 'source_id']
  if (Object.keys(ref).some((key) => !allowed.includes(key))) {
    throw new BadRequestError('Source content and author metadata are resolved by the server')
  }
  if (typeof ref.source_id !== 'string' || !ref.source_id.trim() || ref.source_id.length > 256) {
    throw new BadRequestError('source_id must identify a dispatch in this workspace')
  }
  if (ref.type === 'dispatch') return { type: ref.type, source_id: ref.source_id.trim() }
  if (
    ref.type === 'dispatch_message' &&
    typeof ref.source_sequence === 'number' &&
    Number.isSafeInteger(ref.source_sequence) &&
    ref.source_sequence > 0
  ) {
    return { type: ref.type, source_id: ref.source_id.trim(), source_sequence: ref.source_sequence }
  }
  throw new BadRequestError(
    'Source must be a dispatch report or a dispatch_message with a positive source_sequence'
  )
}
