export interface PlatformRecoveryView {
  managed: boolean
  supervision: {
    state: 'starting' | 'running' | 'restarting' | 'stopping' | 'stopped' | 'failed'
    restart_count: number
    last_error: string | null
    children: Array<{ name: string; pid: number | null }>
  } | null
  auto_start: {
    supported: boolean
    enabled: boolean
    platform: string
    error?: string
  }
}
