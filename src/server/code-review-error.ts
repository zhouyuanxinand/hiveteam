import { HttpError } from './http-errors.js'

export class CodeReviewError extends HttpError {
  constructor(
    readonly code:
      | 'review_stale'
      | 'review_unavailable'
      | 'review_superseded'
      | 'review_read_only_required'
      | 'review_file_unavailable',
    message: string,
    status = 409
  ) {
    super(status, message)
    this.name = 'CodeReviewError'
  }
}
