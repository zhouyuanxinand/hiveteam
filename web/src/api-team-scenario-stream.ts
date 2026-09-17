import type {
  ScenarioLaunchEvent,
  ScenarioLaunchMember,
  ScenarioLaunchPayload,
} from '../../src/shared/team-scenario-launch.js'

export const readScenarioLaunchStream = async (
  response: Response,
  onProgress: (members: ScenarioLaunchMember[]) => void
): Promise<ScenarioLaunchPayload> => {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Team launch progress stream is unavailable')
  const decoder = new TextDecoder()
  let pending = ''
  let result: ScenarioLaunchPayload | undefined
  const consume = (line: string) => {
    if (!line.trim()) return
    const event = JSON.parse(line) as ScenarioLaunchEvent
    if (event.type === 'error') throw new Error(event.error)
    if (event.type === 'progress') onProgress(event.members)
    if (event.type === 'result') result = event.result
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        consume(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
      if (done) break
    }
    if (pending.trim()) consume(pending)
    if (!result)
      throw new Error(
        'Team launch connection ended before the final result. Check member status before retrying.'
      )
    return result
  } finally {
    reader.releaseLock()
  }
}
