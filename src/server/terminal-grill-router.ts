import { randomUUID } from 'node:crypto'
import type { TerminalGrillHandoff } from '../shared/terminal-grill.js'
import { ConflictError } from './http-errors.js'
import type { RuntimeStore } from './runtime-store.js'
import {
  isTerminalGrillCompletionPrefix,
  parseTerminalGrill,
  readTerminalGrillComposer,
  TerminalGrillInput,
} from './terminal-grill-input.js'
import { isTerminalReplyOnly } from './terminal-input-classification.js'
import type { TerminalStateMirror } from './terminal-state-mirror.js'

interface InputOwner {
  write: (input: Buffer | string) => void
  assertHandoff: () => void
  isCurrent: () => boolean
  hivePort: string
}

const findContext = (store: RuntimeStore, runId: string) => {
  const run = store.getLiveRun(runId)
  for (const workspace of store.listWorkspaces()) {
    const actor = store
      .getWorkspaceSnapshot(workspace.id)
      .agents.find((item) => item.id === run.agentId)
    if (!actor || actor.role !== 'orchestrator') continue
    const config = store.peekAgentLaunchConfig(workspace.id, actor.id)
    const executable = (config?.interactiveCommand ?? config?.command ?? '').split(/[\\/]/u).at(-1)
    if (
      config?.commandPresetId === 'codex' ||
      config?.sessionIdCapture?.source === 'codex_session_jsonl_dir' ||
      /^codex(?:\.(?:cmd|exe|js|ps1))?$/iu.test(executable ?? '')
    )
      return { workspaceId: workspace.id, actorId: actor.id, chinese: workspace.language !== 'en' }
  }
  return null
}

/** Routes explicit, user-submitted interview commands before Codex can load a
 * local native Skill. System delivery, shells and member terminals never enter
 * this adapter. The existing clarification runtime owns admission and dispatch. */
export const createTerminalGrillRouter = ({
  store,
  runId,
  mirror,
  broadcast,
}: {
  store: RuntimeStore
  runId: string
  mirror: TerminalStateMirror
  broadcast: (message: TerminalGrillHandoff) => void
}) => {
  const context = findContext(store, runId)
  const input = new TerminalGrillInput()
  let closed = false
  let initialized = false
  let queuedBytes = 0
  let queue = Promise.resolve()
  let current: TerminalGrillHandoff | null = null
  let attempt: { text: string; requestId: string } | null = null
  let lastSequence = context ? store.getRunInputSequence(runId) : 0
  const emit = (message: TerminalGrillHandoff) => {
    if (closed) return
    current = message
    broadcast(message)
  }
  const assertCurrent = (owner: InputOwner) => {
    if (closed || !owner.isCurrent()) throw new ConflictError('Terminal input owner disconnected')
    const run = store.getLiveRun(runId)
    if (run.status !== 'starting' && run.status !== 'running')
      throw new ConflictError('The Orchestrator terminal stopped')
    if (
      context &&
      store.getActiveRunByAgentId(context.workspaceId, context.actorId)?.runId !== runId
    )
      throw new ConflictError('The Orchestrator terminal changed')
  }
  const write = (owner: InputOwner, data: Buffer | string) => {
    assertCurrent(owner)
    owner.write(data)
    lastSequence = store.getRunInputSequence(runId)
  }
  const submit = async (owner: InputOwner, data: string) => {
    if (!context) return
    assertCurrent(owner)
    const sequence = store.getRunInputSequence(runId)
    const tracked = input.text
    const expected = tracked === null ? null : parseTerminalGrill(tracked.split(/\r?\n/u)[0] ?? '')
    if (tracked !== null && !expected) {
      if (isTerminalGrillCompletionPrefix(tracked)) {
        const screen = await mirror.getScreenText()
        assertCurrent(owner)
        if (store.getRunInputSequence(runId) !== sequence)
          throw new ConflictError('Other input changed the composer; the draft has been preserved')
        if (
          readTerminalGrillComposer(screen)?.text === tracked &&
          /enter insert\s*[·•]\s*esc close/iu.test(screen)
        ) {
          write(owner, data)
          input.expectCompletion(tracked)
          return
        }
      }
      write(owner, data)
      input.reset()
      return
    }
    const readComposer = async () => {
      const visible = readTerminalGrillComposer(await mirror.getScreenText())
      if (
        visible &&
        tracked !== null &&
        !/[\r\n]/u.test(tracked) &&
        visible.pastedCharacters === [...tracked].length
      )
        return { ...visible, text: tracked.trimEnd() }
      return visible
    }
    const deadline = Date.now() + (expected ? 1200 : 0)
    let composer: ReturnType<typeof readTerminalGrillComposer>
    do {
      composer = await readComposer()
      assertCurrent(owner)
      if (store.getRunInputSequence(runId) !== sequence)
        throw new ConflictError('Other input changed the composer; the draft has been preserved')
      if (!expected || composer?.text === tracked?.trimEnd()) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    } while (Date.now() < deadline)
    const trigger = composer && parseTerminalGrill(composer.text)
    if (!trigger && !expected) {
      write(owner, data)
      input.reset()
      return
    }
    const text = composer?.text ?? tracked ?? ''
    if (!attempt || attempt.text !== text) attempt = { text, requestId: randomUUID() }
    const base = {
      type: 'grill_handoff' as const,
      request_id: attempt.requestId,
      worker_id: null,
      worker_name: null,
      created: false,
    }
    try {
      if (
        !trigger ||
        tracked === null ||
        /[\r\n]/u.test(tracked) ||
        composer?.text !== tracked.trimEnd()
      )
        throw new ConflictError(
          'Cannot confirm the interview command in the current single-line composer; the draft is preserved. Close any completion menu and retry.'
        )
      if (composer?.blocked || composer?.busy)
        throw new ConflictError(
          'Finish the current Codex operation or dialog before starting the interview; the draft is preserved.'
        )
      owner.assertHandoff()
      assertCurrent(owner)
      emit({
        ...base,
        status: 'pending',
        message: context.chinese
          ? '正在创建或复用需求访谈员…'
          : 'Preparing the requirements interviewer…',
      })
      const result = await store.clarifications.request(
        context.workspaceId,
        context.actorId,
        {
          request_id: attempt.requestId,
          skill_name: trigger.skill,
          text:
            trigger.brief ||
            (context.chinese
              ? `用户请求使用 ${trigger.skill} 对当前工作区开展需求访谈。请先向用户确认需要讨论的方案或文档，再按照绑定的 Skill 完成访谈。`
              : `The user requested ${trigger.skill} for this workspace. First ask which plan or document to discuss, then conduct the interview using the pinned Skill.`),
        },
        owner.hivePort
      )
      if (!result.ok) {
        emit({
          ...base,
          status: 'failed',
          worker_id: result.worker_id,
          worker_name: result.worker_name,
          created: result.created,
          message: result.error ?? 'Interview handoff failed; retry with the same command.',
        })
        return
      }
      // Do not clear another writer's draft after async admission. The request
      // remains successful even if its originating browser has disconnected.
      let preserved = true
      let draftError: string | undefined
      try {
        if (!closed && owner.isCurrent() && store.getRunInputSequence(runId) === sequence) {
          const visible = await readComposer()
          if (
            !closed &&
            owner.isCurrent() &&
            store.getRunInputSequence(runId) === sequence &&
            visible?.text === text &&
            !visible.blocked &&
            !visible.busy
          ) {
            write(owner, '\u0005\u0015')
            input.reset()
            attempt = null
            preserved = false
          }
        }
      } catch (error) {
        draftError =
          error instanceof Error ? error.message : 'The main composer could not be cleared'
      }
      const status = result.status === 'queued' ? 'queued' : 'submitted'
      emit({
        ...base,
        status,
        worker_id: result.worker_id,
        worker_name: result.worker_name,
        created: result.created,
        draft_preserved: preserved,
        ...(draftError ? { draft_error: draftError } : {}),
        message: context.chinese
          ? `${status === 'queued' ? '访谈任务已保存，等待成员启动或投递' : '访谈任务已交给'}：${result.worker_name ?? '需求访谈员'}。请在该成员窗口继续。${preserved ? '主控草稿已保留，请勿重复提交。' : ''}`
          : `${status === 'queued' ? 'Interview queued for' : 'Interview handed to'} ${result.worker_name ?? 'the interviewer'}. Continue in that member window.${preserved ? ' The main draft was preserved; do not resubmit it.' : ''}`,
      })
    } catch (error) {
      emit({
        ...base,
        status: 'failed',
        message: error instanceof Error ? error.message : 'Interview handoff failed',
      })
    }
  }
  return {
    accept(data: Buffer | string, owner: InputOwner) {
      // Device/focus/color replies are not user edits. Preserve the whole
      // response for AgentManager's input-sequence classification, including
      // replies sent before Codex first displays its composer.
      if (isTerminalReplyOnly(data.toString())) {
        owner.write(data)
        return
      }
      if (!context) {
        owner.write(data)
        return
      }
      if (closed) return
      const bytes = Buffer.byteLength(data)
      if (queuedBytes + bytes > 64_000)
        throw new ConflictError(
          'Terminal input queue is full while the interview is being prepared'
        )
      queuedBytes += bytes
      queue = queue
        .then(async () => {
          if (closed || !owner.isCurrent()) return
          if (store.getRunInputSequence(runId) !== lastSequence) {
            input.invalidate()
            initialized = false
          }
          if (!initialized) {
            const sequence = store.getRunInputSequence(runId)
            const visible = readTerminalGrillComposer(await mirror.getScreenText())
            assertCurrent(owner)
            if (
              visible &&
              visible.pastedCharacters === null &&
              !visible.blocked &&
              !visible.busy &&
              store.getRunInputSequence(runId) === sequence
            ) {
              initialized = true
              lastSequence = sequence
              input.reset(visible.text === 'Ask Codex to do anything' ? '' : visible.text)
            } else input.invalidate()
          }
          if (Buffer.isBuffer(data)) {
            if (!isTerminalReplyOnly(data.toString())) input.invalidate()
            write(owner, data)
            return
          }
          const completion = input.completionPrefix
          if (completion) {
            const sequence = store.getRunInputSequence(runId)
            const deadline = Date.now() + 1200
            do {
              const visible = readTerminalGrillComposer(await mirror.getScreenText())
              assertCurrent(owner)
              if (store.getRunInputSequence(runId) !== sequence) {
                input.invalidate()
                break
              }
              const selected = visible && parseTerminalGrill(visible.text)
              if (
                selected &&
                !selected.brief &&
                visible?.text.startsWith(completion) &&
                !visible.blocked &&
                !visible.busy
              ) {
                input.reset(visible.text)
                break
              }
              await new Promise((resolve) => setTimeout(resolve, 25))
            } while (Date.now() < deadline)
          }
          for (const token of input.tokenize(data)) {
            if (closed || !owner.isCurrent()) return
            if (store.getRunInputSequence(runId) !== lastSequence) input.invalidate()
            if (token.submit) await submit(owner, token.data)
            else {
              input.observe(token)
              if (token.data) write(owner, token.data)
            }
          }
        })
        .catch((error: unknown) => {
          if (!closed)
            emit({
              type: 'grill_handoff',
              request_id: attempt?.requestId ?? randomUUID(),
              status: 'failed',
              worker_id: null,
              worker_name: null,
              created: false,
              message: error instanceof Error ? error.message : 'Terminal input failed',
            })
        })
        .finally(() => {
          queuedBytes -= bytes
        })
    },
    get current() {
      return current
    },
    close() {
      closed = true
    },
  }
}
