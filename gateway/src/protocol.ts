/**
 * Wire constants shared with the Hive desktop remote tunnel.
 *
 * The gateway must not inspect or transform binary data frames. It only
 * originates the small control band and relays opaque bytes between peers.
 */
export const GW_CONTROL_PREFIX = '\u0000gw:'
export const HB_PING = 'hb:ping'
export const HB_PONG = 'hb:pong'

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

export type RelayRole = 'daemon' | 'device' | 'pair'

export type GatewayControl =
  | { t: 'peer-online'; role: RelayRole; jti?: string }
  | { t: 'peer-offline'; role: RelayRole }
  | { t: 'revoked'; reason: string }
  | { t: 'error'; code: number; message: string }

export const encodeControl = (message: GatewayControl) =>
  `${GW_CONTROL_PREFIX}${JSON.stringify(message)}`
