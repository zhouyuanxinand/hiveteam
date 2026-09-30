const isRemoteMode = () =>
  typeof window !== 'undefined' &&
  (window as Window & { __HIVE_REMOTE_MODE__?: boolean }).__HIVE_REMOTE_MODE__ === true

let initialization: Promise<void> | null = null

export class UiSessionRequiredError extends Error {
  constructor() {
    super('UI session expired or unavailable. Reopen HiveTeam from its launcher to sign in.')
    this.name = 'UiSessionRequiredError'
  }
}

const initialize = async () => {
  if (isRemoteMode()) return
  const fragment = new URLSearchParams(window.location.hash.slice(1))
  const bootstrap = fragment.get('hive_bootstrap')
  if (bootstrap) {
    fragment.delete('hive_bootstrap')
    const remainder = fragment.toString()
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}${remainder ? `#${remainder}` : ''}`
    )
  }
  const response = await fetch('/api/ui/session', {
    mode: 'same-origin',
    cache: 'no-store',
    ...(bootstrap
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ bootstrap_token: bootstrap }),
        }
      : {}),
  })
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new UiSessionRequiredError()
    throw new Error('Failed to initialize UI session')
  }
}

export const initializeUiSession = (): Promise<void> => {
  initialization ??= initialize().finally(() => {
    initialization = null
  })
  return initialization
}
