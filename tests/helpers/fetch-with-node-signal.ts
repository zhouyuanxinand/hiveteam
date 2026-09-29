import { transferableAbortController } from 'node:util'

const nativeFetch = globalThis.fetch
/** jsdom AbortSignal and Node fetch have different realms. Preserve cancellation at the HTTP bridge. */
export const fetchWithNodeSignal = async (input: RequestInfo | URL, init?: RequestInit) => {
  if (!init?.signal) return nativeFetch(input, init)
  const original = init.signal,
    controller = transferableAbortController()
  const abort = () => controller.abort(original.reason)
  original.addEventListener('abort', abort, { once: true })
  if (original.aborted) abort()
  try {
    return await nativeFetch(input, { ...init, signal: controller.signal })
  } finally {
    original.removeEventListener('abort', abort)
  }
}
