import { expect, test } from 'vitest'
import { parseDefinition } from '../../src/server/workflow-definition.js'

test.each([
  null,
  [],
  {},
  { all_of: [] },
  { all_of: ['success'] },
  { all_of: ['report_success', 'report_success'] },
  { all_of: ['report_success'], any_of: [] },
])('invalid explicit workflow quality is rejected instead of reverting to legacy behavior (%j)', (quality) => {
  const result = parseDefinition(
    { steps: [{ id: 'a', task: 'Work', worker: 'Builder', quality }] },
    'Workflow'
  )
  expect(result.definition).toBeUndefined()
  expect(result.error).toContain('nonempty all_of')
})

test('legacy tasks retain their missing quality field while explicit report-only tasks remain non-code workflows', () => {
  const legacy = parseDefinition(
    { steps: [{ id: 'a', task: 'Work', worker: 'Researcher' }] },
    'Legacy'
  )
  const explicit = parseDefinition(
    {
      steps: [
        { id: 'a', task: 'Work', worker: 'Researcher', quality: { all_of: ['report_success'] } },
      ],
    },
    'Report'
  )
  expect(legacy.definition?.steps[0]).toEqual({
    id: 'a',
    task: 'Work',
    worker: 'Researcher',
    needs: [],
  })
  expect(explicit.definition?.steps[0]?.quality).toEqual({ all_of: ['report_success'] })
})
