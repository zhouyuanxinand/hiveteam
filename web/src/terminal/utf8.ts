// Flow-control acknowledgements need the exact UTF-8 wire size of each chunk.
// Counting directly avoids allocating a fresh TextEncoder and a full Uint8Array
// copy of the output stream on every batch. Lone surrogates encode as U+FFFD
// (3 bytes), matching what TextEncoder would produce.
export const utf8ByteLength = (value: string): number => {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
      continue
    }
    if (code < 0x800) {
      bytes += 2
      continue
    }
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
        continue
      }
    }
    bytes += 3
  }
  return bytes
}
