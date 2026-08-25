export const PAIRING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const PAIRING_CODE_CHARS = 12
export const PAIRING_CODE_RANDOM_BYTES = 8
export const PAIRING_CODE_SECRET_CONTEXT = 'hive-remote-pairing-code-v1:'

export const normalizePairingCode = (input: string): string | null => {
  const normalized = input
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (normalized.length !== PAIRING_CODE_CHARS) return null
  if ([...normalized].some((character) => !PAIRING_CODE_ALPHABET.includes(character))) return null
  return normalized
}

export const formatPairingCode = (input: string): string => {
  const normalized = normalizePairingCode(input) ?? input.replace(/[\s-]+/g, '').toUpperCase()
  const groups: string[] = []
  for (let index = 0; index < normalized.length; index += 4) {
    groups.push(normalized.slice(index, index + 4))
  }
  return groups.join('-')
}

export const generatePairingCode = (randomBytes: (length: number) => Uint8Array): string => {
  const bytes = randomBytes(PAIRING_CODE_RANDOM_BYTES)
  if (bytes.length < PAIRING_CODE_RANDOM_BYTES) {
    throw new RangeError(`pairing code requires ${PAIRING_CODE_RANDOM_BYTES} random bytes`)
  }
  let accumulator = 0
  let bits = 0
  let output = ''
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5 && output.length < PAIRING_CODE_CHARS) {
      bits -= 5
      output += PAIRING_CODE_ALPHABET[(accumulator >> bits) & 31]
    }
    if (output.length === PAIRING_CODE_CHARS) break
  }
  return output
}
