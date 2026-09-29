import { expect, test } from 'vitest'
import { parseReportArgs, parseSendArgs } from '../../src/cli/team.js'
import { parseMessageArgs, parseMessagesArgs } from '../../src/cli/team-messages.js'

test('message opt-in and explicit seen sequence leave legacy send/report argument shapes unchanged', () => {
  expect(parseSendArgs(['Coder', 'Task'])).toEqual({
    workerName: 'Coder',
    task: 'Task',
    skillName: undefined,
  })
  expect(parseSendArgs(['Coder', 'Task', '--messages'])).toMatchObject({
    messageProtocolVersion: 1,
  })
  expect(parseReportArgs(['Done'])).toEqual({
    result: 'Done',
    artifacts: [],
    dispatchId: undefined,
    useStdin: false,
  })
  expect(parseReportArgs(['--seen-seq', '0', '--dispatch', 'task-id', '--stdin'])).toMatchObject({
    seenSeq: 0,
    dispatchId: 'task-id',
    useStdin: true,
  })
  expect(
    parseMessageArgs([
      '--kind',
      'answer',
      '--dispatch',
      'task-id',
      '--reply-to',
      'question-id',
      '--stdin',
    ])
  ).toEqual({
    dispatchId: 'task-id',
    kind: 'answer',
    replyTo: 'question-id',
    useStdin: true,
    body: null,
  })
  expect(
    parseMessageArgs(['--dispatch', 'task-id', '--kind', 'note', '--', '--literal'])
  ).toMatchObject({ body: '--literal' })
  expect(parseMessagesArgs(['--dispatch', 'task-id', '--after', '4', '--limit', '100'])).toEqual({
    dispatchId: 'task-id',
    after: 4,
    limit: 100,
  })
})

test.each([
  '-1',
  '1.2',
  '1e3',
  '9007199254740992',
  '',
])('invalid sequence %j cannot bypass report or pagination checks', (sequence) => {
  expect(() => parseReportArgs(['Done', '--dispatch', 'task-id', '--seen-seq', sequence])).toThrow(
    'non-negative integer'
  )
  expect(() => parseMessagesArgs(['--dispatch', 'task-id', '--after', sequence])).toThrow()
})

test('message arguments reject ambiguous bodies, unknown kinds, duplicate flags, and invalid answers', () => {
  for (const args of [
    ['--dispatch', 'task-id', '--kind', 'unknown', 'Body'],
    ['--dispatch', 'task-id', '--kind', 'answer', 'Body'],
    ['--dispatch', 'task-id', '--kind', 'note', '--stdin', 'Body'],
    ['--dispatch', 'task-id', '--kind', 'note', 'Body', 'Extra'],
    ['--dispatch', 'task-id', '--dispatch', 'other', '--kind', 'note', 'Body'],
    ['--kind', 'note', 'Body'],
  ])
    expect(() => parseMessageArgs(args)).toThrow()
  expect(() => parseMessagesArgs(['--dispatch', 'task-id', '--limit', '101'])).toThrow('1-100')
  expect(() => parseReportArgs(['Done', '--seen-seq', '1'])).toThrow('requires --dispatch')
  expect(() =>
    parseReportArgs(['Ready', '--dispatch', 'task-id', '--seen-seq', '1'], 'status')
  ).toThrow('team report')
})
