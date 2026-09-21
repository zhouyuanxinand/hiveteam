export interface AgentStartFailure {
  message: string
  errorCode?: string
  missingCapabilities?: string[]
}

export type OrchestratorStartFailure = string | AgentStartFailure

export class AgentStartError extends Error {
  constructor(readonly failure: AgentStartFailure) {
    super(failure.message)
    this.name = 'AgentStartError'
  }
}

export const readAgentStartError = async (response: Response): Promise<AgentStartError> => {
  let body: {
    error?: unknown
    code?: unknown
    error_code?: unknown
    missing_capabilities?: unknown
  }
  try {
    body = await response.json()
  } catch {
    return new AgentStartError({ message: 'Failed to start agent run' })
  }
  if (!body || typeof body !== 'object')
    return new AgentStartError({ message: 'Failed to start agent run' })
  const code = body.code ?? body.error_code
  return new AgentStartError({
    message:
      typeof body.error === 'string' && body.error.trim()
        ? body.error
        : 'Failed to start agent run',
    ...(typeof code === 'string' ? { errorCode: code } : {}),
    ...(Array.isArray(body.missing_capabilities)
      ? {
          missingCapabilities: body.missing_capabilities.filter(
            (item): item is string => typeof item === 'string'
          ),
        }
      : {}),
  })
}

export const startFailureFromResult = (result: {
  error: string | null
  error_code?: string
  missing_capabilities?: string[]
}): AgentStartFailure | null =>
  result.error
    ? {
        message: result.error,
        ...(result.error_code ? { errorCode: result.error_code } : {}),
        ...(result.missing_capabilities
          ? { missingCapabilities: result.missing_capabilities }
          : {}),
      }
    : null
