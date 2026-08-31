/**
 * Worker avatars are stored locally as compact image data URLs. Keeping the
 * validator in `shared` makes the server the source of truth while allowing
 * browser forms to use the same limits before a request is sent.
 */
export const WORKER_AVATAR_MAX_CHARS = 160_000

type AvatarImageFormat = 'png' | 'jpeg' | 'webp'

const dataUrlPattern = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/

const isPng = (bytes: Uint8Array) =>
  bytes.length >= 8 &&
  bytes[0] === 0x89 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x4e &&
  bytes[3] === 0x47 &&
  bytes[4] === 0x0d &&
  bytes[5] === 0x0a &&
  bytes[6] === 0x1a &&
  bytes[7] === 0x0a

const isJpeg = (bytes: Uint8Array) =>
  bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff

const isWebp = (bytes: Uint8Array) =>
  bytes.length >= 12 &&
  bytes[0] === 0x52 &&
  bytes[1] === 0x49 &&
  bytes[2] === 0x46 &&
  bytes[3] === 0x46 &&
  bytes[8] === 0x57 &&
  bytes[9] === 0x45 &&
  bytes[10] === 0x42 &&
  bytes[11] === 0x50

const hasExpectedImageHeader = (format: AvatarImageFormat, bytes: Uint8Array) => {
  if (format === 'png') return isPng(bytes)
  if (format === 'jpeg') return isJpeg(bytes)
  return isWebp(bytes)
}

const decodeBase64 = (encoded: string): Uint8Array => {
  const decoded = atob(encoded)
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
}

/**
 * Returns a normalized local avatar, `null` for an empty/cleared value, or
 * throws a user-safe error. SVG is deliberately excluded: an avatar should
 * never become an executable document in the local HiveTeam origin.
 */
export const normalizeWorkerAvatar = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new Error('Avatar must be an image file.')
  }

  const avatar = value.trim()
  if (!avatar) return null
  if (avatar.length > WORKER_AVATAR_MAX_CHARS) {
    throw new Error('Avatar is too large. Choose an image under 160 KB.')
  }

  const match = dataUrlPattern.exec(avatar)
  const format = match?.[1] as AvatarImageFormat | undefined
  const encoded = match?.[2]
  if (!format || !encoded) {
    throw new Error('Avatar must be a PNG, JPEG, or WebP image.')
  }

  try {
    const bytes = decodeBase64(encoded)
    if (!hasExpectedImageHeader(format, bytes)) {
      throw new Error('Avatar image data is invalid.')
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Avatar image data is invalid.') {
      throw error
    }
    throw new Error('Avatar image data is invalid.')
  }

  return avatar
}
