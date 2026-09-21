import { useState } from 'react'
import { MAX_RESOURCE_LIMIT, type ResourceLimits } from '../../../src/shared/resource-budget.js'
import { resourceLimitLabels } from './resource-labels.js'

export const ResourceLimitsForm = ({
  limits,
  zh,
  busy,
  save,
}: {
  limits: ResourceLimits
  zh: boolean
  busy: boolean
  save: (limits: ResourceLimits) => void
}) => {
  const [draft, setDraft] = useState(limits)
  const valid = Object.values(draft).every(
    (value) => Number.isSafeInteger(value) && value > 0 && value <= MAX_RESOURCE_LIMIT
  )
  return (
    <form
      className="my-4 space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (valid) save(draft)
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {(Object.keys(resourceLimitLabels) as Array<keyof ResourceLimits>).map((key) => (
          <label key={key} className="flex flex-col gap-1 text-xs text-sec">
            {resourceLimitLabels[key][zh ? 0 : 1]}
            <input
              type="number"
              min={1}
              max={MAX_RESOURCE_LIMIT}
              step={1}
              required
              value={Number.isNaN(draft[key]) ? '' : draft[key]}
              onChange={(event) => setDraft({ ...draft, [key]: event.target.valueAsNumber })}
              className="rounded border bg-transparent px-3 py-2 text-sm text-pri"
              style={{ borderColor: 'var(--border)' }}
              disabled={busy}
            />
          </label>
        ))}
      </div>
      <p className="text-xs text-ter">
        {zh
          ? '降低上限会阻止新启动，已有执行继续运行。停止 Worker 不会释放成员名额，删除成员才会释放。'
          : 'Lower limits block new starts while existing executions continue. Stopping a worker keeps its member slot; deleting it frees that slot.'}
      </p>
      <button type="submit" className="icon-btn text-xs" disabled={busy || !valid}>
        {zh ? '保存上限' : 'Save limits'}
      </button>
    </form>
  )
}
