import { useEffect, useState } from 'react'

import { DEMO_REPLAY_STEPS, type DemoReplaySnapshot } from './demo-fixture.js'

const REPLAY_STEP_DELAY_MS = 2_800

export const useDemoReplay = (enabled: boolean): DemoReplaySnapshot => {
  const [phase, setPhase] = useState(0)

  useEffect(() => {
    if (!enabled) return
    setPhase(0)
    const timer = window.setInterval(() => {
      setPhase((current) => (current + 1) % DEMO_REPLAY_STEPS.length)
    }, REPLAY_STEP_DELAY_MS)
    return () => window.clearInterval(timer)
  }, [enabled])

  const step = DEMO_REPLAY_STEPS[phase] ?? DEMO_REPLAY_STEPS[0]
  if (!step) throw new Error('Demo replay is not configured')
  return { ...step, phase }
}
