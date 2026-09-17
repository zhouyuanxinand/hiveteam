export const TERMINAL_IDLE_RETENTION_MS = 30_000
const MAX_PARKED_TERMINALS = 3
const parked = new Map<string, () => void>()

/** Bound retained terminal memory while keeping recent member switches instant. */
export const retainParkedTerminal = (id: string, expire: () => void) => {
  parked.get(id)?.()
  let timer: ReturnType<typeof setTimeout>
  const release = () => {
    clearTimeout(timer)
    if (parked.get(id) === evict) parked.delete(id)
  }
  const evict = () => {
    release()
    expire()
  }
  timer = setTimeout(evict, TERMINAL_IDLE_RETENTION_MS)
  parked.set(id, evict)
  while (parked.size > MAX_PARKED_TERMINALS) parked.values().next().value?.()
  return release
}
