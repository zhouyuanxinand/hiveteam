import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { isAbsolute } from 'node:path'

import { type FsProbeResponse, probeDirectory } from './fs-browse.js'

export const DESKTOP_BRIDGE_TOKEN_HEADER = 'x-hive-desktop-token'

const tokensMatch = (provided: string, expected: string): boolean => {
  const providedBuffer = Buffer.from(provided)
  const expectedBuffer = Buffer.from(expected)
  return (
    providedBuffer.byteLength === expectedBuffer.byteLength &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  )
}

export const isDesktopBridgeRequest = (
  request: IncomingMessage,
  expectedToken = process.env.HIVE_DESKTOP_BRIDGE_TOKEN?.trim()
): boolean => {
  const providedToken = request.headers[DESKTOP_BRIDGE_TOKEN_HEADER]
  return (
    typeof expectedToken === 'string' &&
    expectedToken.length > 0 &&
    typeof providedToken === 'string' &&
    tokensMatch(providedToken, expectedToken)
  )
}

export const probeDroppedFolder = async (path: string): Promise<FsProbeResponse | null> => {
  if (!isAbsolute(path)) return null
  return probeDirectory(path, { allowOutsideRoot: true })
}
