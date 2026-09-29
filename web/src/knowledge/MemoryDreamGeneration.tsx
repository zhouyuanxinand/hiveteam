import type { MemoryDreamGeneration as Generation } from '../../../src/shared/memory-dream-generation.js'
import { useI18n } from '../i18n.js'

type Message = Generation['input']['messages'][number]

export const MemoryDreamMessages = ({ messages }: { messages: Message[] }) => {
  const { language } = useI18n()
  const zh = language === 'zh'
  return (
    <ol className="memory-dream-messages">
      {messages.map((message) => (
        <li key={`${message.sequence}:${message.start_offset}`}>
          <p className="memory-dream-message-heading">
            <strong>#{message.sequence}</strong> · {message.type} ·{' '}
            {new Date(message.created_at).toLocaleString()}
          </p>
          <p className="text-ter">
            {message.from_agent_id ?? (zh ? '用户' : 'User')} →{' '}
            {message.to_agent_id ?? (zh ? '工作区' : 'Workspace')}
          </p>
          <p className="text-ter">
            {zh ? '字符范围' : 'Character range'} {message.start_offset + 1}–{message.end_offset} /{' '}
            {message.total_chars}
            {message.start_offset > 0 || message.end_offset < message.total_chars
              ? zh
                ? '（消息片段）'
                : ' (message excerpt)'
              : zh
                ? '（完整消息）'
                : ' (complete message)'}
          </p>
          <p className="memory-dream-body">{message.text}</p>
        </li>
      ))}
    </ol>
  )
}

export const MemoryDreamCitations = ({
  messages,
  sequences,
}: {
  messages: Message[]
  sequences: number[]
}) => {
  const { language } = useI18n()
  if (!sequences.length) return null
  return (
    <details className="memory-dream-evidence">
      <summary>
        {language === 'zh' ? '提案引用消息' : 'Messages cited by this proposal'}:{' '}
        {sequences.map((sequence) => `#${sequence}`).join(', ')}
      </summary>
      <MemoryDreamMessages
        messages={messages.filter((message) => sequences.includes(message.sequence))}
      />
    </details>
  )
}

export const MemoryDreamGeneration = ({
  generation,
  busy,
  onRetry,
}: {
  generation: Generation
  busy: boolean
  onRetry: () => void
}) => {
  const { language } = useI18n()
  const zh = language === 'zh'
  const labels = zh
    ? {
        pending: '等待工作区 Orchestrator 生成候选',
        requested: 'Orchestrator 正在生成候选',
        failed: '候选生成失败',
        completed: '候选生成完成',
      }
    : {
        pending: 'Waiting for the workspace Orchestrator',
        requested: 'Orchestrator is generating candidates',
        failed: 'Candidate generation failed',
        completed: 'Candidate generation complete',
      }
  return (
    <div className="memory-dream-generation" data-testid="memory-dream-generation">
      <p role="status">{labels[generation.status]}</p>
      <p className="text-ter">
        {zh
          ? '生成只创建待审核提案。记忆需经审核后单独应用。'
          : 'Generation creates proposals for review. Applying memory changes is a separate action.'}
      </p>
      {generation.error ? (
        <p role="alert" className="text-red-400">
          {generation.error}
        </p>
      ) : null}
      {generation.status === 'failed' || generation.status === 'requested' ? (
        <button
          type="button"
          className="icon-btn"
          disabled={busy}
          onClick={onRetry}
          data-testid="memory-dream-retry"
        >
          {zh ? '重试本批生成' : 'Retry this generation'}
        </button>
      ) : null}
      {generation.status === 'completed' ? (
        <p>
          {generation.candidate_count === 0
            ? zh
              ? '本批没有可采纳的候选，已结束；现有记忆未变更。'
              : 'This batch produced no candidates and is closed. Existing memories are unchanged.'
            : zh
              ? `生成了 ${generation.candidate_count} 条候选。请核对每条提案及来源。`
              : `${generation.candidate_count} ${generation.candidate_count === 1 ? 'candidate' : 'candidates'} generated. Review each proposal and its sources.`}
        </p>
      ) : null}
      {generation.result_summary ? (
        <p className="memory-dream-body">{generation.result_summary}</p>
      ) : null}
      <details className="memory-dream-evidence">
        <summary>
          {zh ? '查看本批冻结消息' : 'View frozen message batch'} (
          {generation.input.messages.length})
        </summary>
        <p className="text-ter">
          {zh ? '处理范围' : 'Processing range'} {generation.input.from.sequence}:
          {generation.input.from.offset} → {generation.input.to.sequence}:
          {generation.input.to.offset}
        </p>
        <MemoryDreamMessages messages={generation.input.messages} />
      </details>
    </div>
  )
}
