export const REVIEW_TEXT_LIMIT = 64_000

export interface ReviewDocument {
  path: string
  content: string
  revision: string
}

export interface ReviewDraft {
  path: string
  base_revision: string
  base_content: string
  content: string
  note: string
  version: number
  updated_at: number
}

export interface ReviewSubmission {
  agent_id?: string
  request_id: string
  kind: 'answer' | 'review'
  path: string | null
  status: 'blocked' | 'sending' | 'submitted' | 'uncertain'
  error: string | null
  created_at: number
}

export interface ReviewDocumentState {
  document: ReviewDocument
  draft: ReviewDraft | null
  confirmed_revision: string | null
  submissions: ReviewSubmission[]
}

export interface SaveReviewDraft {
  path: string
  base_revision: string
  content: string
  note: string
  expected_version: number
}

/** One exact replacement hunk, with shared prefix/suffix omitted. */
export const reviewDiff = (before: string, after: string): string => {
  if (before === after) return ''
  const oldLines = before.split('\n')
  const newLines = after.split('\n')
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start])
    start++
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  return [
    `@@ -${start + 1},${oldEnd - start} +${start + 1},${newEnd - start} @@`,
    ...oldLines.slice(start, oldEnd).map((line) => `-${line}`),
    ...newLines.slice(start, newEnd).map((line) => `+${line}`),
  ].join('\n')
}
