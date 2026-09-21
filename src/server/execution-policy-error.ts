import { HttpError } from './http-errors.js'

export class ExecutionPolicyError extends HttpError {
  readonly code = 'execution_policy_denied'
  constructor(
    message: string,
    readonly missingCapabilities: string[]
  ) {
    super(409, message)
    this.name = 'ExecutionPolicyError'
  }
}
