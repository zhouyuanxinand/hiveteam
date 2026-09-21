import type { NativeSessionErrorCode } from '../shared/native-session.js'
import { HttpError } from './http-errors.js'

export class NativeSessionError extends HttpError {
  constructor(
    readonly code: NativeSessionErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(409, message)
    if (options?.cause !== undefined) this.cause = options.cause
  }
}
