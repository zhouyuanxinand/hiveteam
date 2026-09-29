import type { MemorySourceReference } from '../../../src/shared/memory-provenance.js'
import { useI18n } from '../i18n.js'
import './memory-provenance.css'

export const MemorySourceFields = ({
  value,
  onChange,
}: {
  value: MemorySourceReference | undefined
  onChange: (value: MemorySourceReference | undefined) => void
}) => {
  const { language } = useI18n()
  const zh = language === 'zh'
  return (
    <fieldset className="memory-source-fields">
      <legend>{zh ? '来源（可选）' : 'Source (optional)'}</legend>
      <label>
        <span>{zh ? '来源类型' : 'Source type'}</span>
        <select
          value={value?.type ?? 'manual'}
          onChange={(event) => {
            const type = event.target.value
            onChange(
              type === 'dispatch'
                ? { type, source_id: '' }
                : type === 'dispatch_message'
                  ? { type, source_id: '', source_sequence: 1 }
                  : undefined
            )
          }}
        >
          <option value="manual">{zh ? '手工记录' : 'Manual note'}</option>
          <option value="dispatch">{zh ? '任务报告' : 'Dispatch report'}</option>
          <option value="dispatch_message">{zh ? '任务对话' : 'Dispatch conversation'}</option>
        </select>
      </label>
      {value ? (
        <>
          <label>
            <span>{zh ? '派单 ID' : 'Dispatch ID'}</span>
            <input
              value={value.source_id}
              maxLength={256}
              onChange={(event) => onChange({ ...value, source_id: event.target.value })}
            />
          </label>
          {value.type === 'dispatch_message' ? (
            <label>
              <span>{zh ? '消息序号' : 'Message sequence'}</span>
              <input
                type="number"
                min={1}
                step={1}
                value={value.source_sequence || ''}
                onChange={(event) =>
                  onChange({ ...value, source_sequence: Number(event.target.value) })
                }
              />
            </label>
          ) : null}
          <p>
            {zh
              ? '从任务详情复制派单 ID 和消息序号。保存后进入候选列表，审核启用后才会用于任务上下文。作者和原文由账本读取。'
              : 'Copy the dispatch ID and message sequence from task details. This creates a candidate; approve it before use in task context. Author and excerpt come from the ledger.'}
          </p>
        </>
      ) : null}
    </fieldset>
  )
}
