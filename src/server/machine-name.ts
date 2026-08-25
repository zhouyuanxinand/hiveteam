import { hostname } from 'node:os'

const MAX_LEN = 64

export const cleanMachineName = (raw: string): string | null => {
  const cleaned = raw.trim().replace(/\.local$/i, '')
  return cleaned.length === 0 ? null : cleaned.slice(0, MAX_LEN)
}

export const getMachineName = () => cleanMachineName(hostname())
