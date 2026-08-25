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
