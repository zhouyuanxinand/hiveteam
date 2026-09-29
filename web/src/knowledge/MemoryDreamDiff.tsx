import type {
  MemoryDreamSnapshot,
  MemoryDreamValue,
} from '../../../src/shared/memory-dream-plan.js'
import { useI18n } from '../i18n.js'

type Value = MemoryDreamValue & Partial<Pick<MemoryDreamSnapshot, 'pinned' | 'disabled' | 'status'>>
const ValueView = ({ value }: { value: Value }) => {
  const { t, language } = useI18n()
  const zh = language === 'zh'
  return (
    <div className="memory-dream-value">
      <p className="text-ter">
        {t(`memory.kind.${value.kind}`)} · {t(`memory.scope.${value.scope}`)}
        {value.status
          ? ` · ${{ active: zh ? '生效' : 'Active', candidate: zh ? '候选' : 'Candidate', archived: zh ? '已归档' : 'Archived', rejected: zh ? '已拒绝' : 'Rejected' }[value.status]}`
          : ''}
        {value.pinned ? ` · ${zh ? '已置顶' : 'Pinned'}` : ''}
        {value.disabled ? ` · ${zh ? '已停用' : 'Disabled'}` : ''}
      </p>
      <p className="memory-dream-body">{value.body}</p>
      {value.tags.length ? (
        <p>
          {zh ? '标签' : 'Tags'}: {value.tags.join(', ')}
        </p>
      ) : null}
      {value.procedure_ref ? (
        <p>
          {value.procedure_ref.type} · {value.procedure_ref.id}
          {value.procedure_ref.title ? ` · ${value.procedure_ref.title}` : ''}
        </p>
      ) : null}
    </div>
  )
}
export const MemoryDreamDiff = ({
  before,
  after,
  memoryId,
}: {
  before: MemoryDreamSnapshot | null
  after: Value
  memoryId?: string
}) => {
  const { language } = useI18n()
  const zh = language === 'zh'
  return (
    <div className="memory-dream-change">
      <p className="text-ter memory-dream-id">
        {memoryId ?? (zh ? '新记忆' : 'New memory')}
        {before ? ` · v${before.revision}` : ''}
      </p>
      <div className="memory-dream-diff">
        <div>
          <strong>{zh ? '变更前' : 'Before'}</strong>
          {before ? <ValueView value={before} /> : <p>{zh ? '尚未创建' : 'Not yet created'}</p>}
        </div>
        <div>
          <strong>{zh ? '变更后' : 'After'}</strong>
          <ValueView value={after} />
        </div>
      </div>
    </div>
  )
}
