export interface DeviceSession {
  deviceId: string
  keys: {
    d2p: Uint8Array
    p2d: Uint8Array
  }
  devicePublicKey: Uint8Array
}

export interface DeviceSessionProvider {
  get(deviceId: string): DeviceSession | null
  candidates(): DeviceSession[]
}

// The daemon opens phone-to-daemon frames and seals daemon-to-phone frames.
// Keeping these aliases here prevents direction strings from being duplicated
// across the tunnel and frame bridge.
export const DAEMON_OPEN_DIRECTION = 'p2d' as const
export const DAEMON_SEAL_DIRECTION = 'd2p' as const

export class InMemoryDeviceSessionProvider implements DeviceSessionProvider {
  private readonly sessions = new Map<string, DeviceSession>()

  set(session: DeviceSession) {
    this.sessions.set(session.deviceId, session)
  }

  remove(deviceId: string) {
    this.sessions.delete(deviceId)
  }

  get(deviceId: string) {
    return this.sessions.get(deviceId) ?? null
  }

  candidates() {
    return [...this.sessions.values()]
  }
}
