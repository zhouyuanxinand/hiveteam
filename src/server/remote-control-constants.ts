/**
 * Wire constants shared with the Hive remote gateway relay.
 *
 * These strings deliberately stay separate from the encrypted binary data
 * plane. The gateway originates only the control band; all application data
 * remains an opaque E2E frame.
 */
export const GW_CONTROL_PREFIX = '\0gw:'

export const RelayCloseCode = {
  Normal: 1000,
  ProtocolError: 4400,
  Unauthorized: 4401,
  Forbidden: 4403,
  DaemonOffline: 4404,
  Replaced: 4409,
  Revoked: 4410,
  InternalError: 4500,
} as const

export type RelayCloseCode = (typeof RelayCloseCode)[keyof typeof RelayCloseCode]

export type GatewayControl =
  | { t: 'peer-online'; role: 'daemon' | 'device' | 'pair'; jti?: string }
  | { t: 'peer-offline'; role: 'daemon' | 'device' | 'pair' }
  | { t: 'revoked'; reason: string }
  | { t: 'error'; code: number; message: string }

export const HB_PING = 'hb:ping'
export const HB_PONG = 'hb:pong'

export const isAuthFatalCloseCode = (code: number) =>
  code === RelayCloseCode.Unauthorized || code === RelayCloseCode.Revoked
