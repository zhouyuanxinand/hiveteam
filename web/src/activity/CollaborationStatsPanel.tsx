import { useEffect, useId, useState } from 'react'
import type {
  CollaborationPeriod,
  CollaborationStatistics,
} from '../../../src/shared/collaboration-stats.js'
import { useI18n } from '../i18n.js'
import { readCollaborationStats } from './collaboration-stats-api.js'
import './collaboration-stats.css'

export const CollaborationStatsPanel = ({ workspaceId }: { workspaceId: string }) => {
  const { language } = useI18n()
  const zh = language === 'zh'
  const id = useId()
  const [period, setPeriod] = useState<CollaborationPeriod>('30')
  const [refresh, setRefresh] = useState(0)
  const [result, setResult] = useState<{
    workspaceId: string
    value: CollaborationStatistics
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit refresh starts a new read
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    readCollaborationStats(workspaceId, period, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setResult({ workspaceId, value })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [workspaceId, period, refresh])
  const data =
    result?.workspaceId === workspaceId && result.value.period === period ? result.value : null
  const number = (n: number) =>
    n.toLocaleString(zh ? 'zh-CN' : 'en-US', { maximumFractionDigits: 1 })
  const duration = (ms: number | null) => {
    if (ms === null) return '—'
    if (ms < 1000) return `${number(ms)} ms`
    if (ms < 60_000) return `${number(ms / 1000)} ${zh ? '秒' : 's'}`
    if (ms < 3_600_000) return `${number(ms / 60_000)} ${zh ? '分' : 'min'}`
    return `${number(ms / 3_600_000)} ${zh ? '小时' : 'h'}`
  }
  const counts = [
    ['root_tasks', zh ? '根任务' : 'Root tasks'],
    ['dispatches', zh ? '派单（含审查）' : 'Dispatches (including reviews)'],
    ['messages', zh ? '任务对话消息' : 'Conversation messages'],
    ['reworks', zh ? '返工轮次' : 'Rework rounds'],
    ['delivery_attempts', zh ? '投递尝试' : 'Delivery attempts'],
    ['retries', zh ? '额外重试' : 'Additional attempts'],
  ] as const
  const durations = [
    ['queue', zh ? '排队' : 'Queue'],
    ['execution', zh ? '执行至汇报' : 'Submission to report'],
    ['report_submission', zh ? '报告提交' : 'Report submission'],
    ['acceptance_to_integration', zh ? '验收到集成' : 'Acceptance to integration'],
  ] as const
  return (
    <section className="collaboration-stats" aria-labelledby={`${id}-title`}>
      <header>
        <h2 id={`${id}-title`}>{zh ? '协作统计' : 'Collaboration statistics'}</h2>
        <p>
          {zh
            ? '按根任务创建时间筛选，包含其审查子任务及保留的归档记录。'
            : 'Selected by root task creation time, including review tasks and retained archives.'}
        </p>
      </header>
      <div className="collaboration-stats-controls">
        <label htmlFor={`${id}-period`}>{zh ? '任务创建时间' : 'Task creation period'}</label>
        <select
          id={`${id}-period`}
          value={period}
          onChange={(event) => setPeriod(event.target.value as CollaborationPeriod)}
        >
          <option value="7">{zh ? '最近 7 天' : 'Last 7 days'}</option>
          <option value="30">{zh ? '最近 30 天' : 'Last 30 days'}</option>
          <option value="all">{zh ? '全部保留记录' : 'All retained records'}</option>
        </select>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setRefresh((value) => value + 1)}
          disabled={loading}
        >
          {zh ? '刷新统计' : 'Refresh statistics'}
        </button>
      </div>
      {loading ? <p role="status">{zh ? '正在读取统计…' : 'Loading statistics…'}</p> : null}
      {error ? (
        <p role="alert">
          {error} {zh ? '请刷新重试。' : 'Refresh to retry.'}
        </p>
      ) : null}
      {data && !loading && !error ? (
        <>
          <p className="collaboration-stats-meta">
            {zh ? '统计时间：' : 'As of '}
            <time dateTime={new Date(data.generated_at).toISOString()}>
              {new Date(data.generated_at).toLocaleString(zh ? 'zh-CN' : 'en-US')}
            </time>
          </p>
          {data.counts.root_tasks === 0 ? (
            <p>
              {zh
                ? '此时间范围内没有保留的任务。'
                : 'No retained tasks were created in this period.'}
            </p>
          ) : null}
          <dl className="collaboration-stats-counts">
            {counts.map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{number(data.counts[key])}</dd>
              </div>
            ))}
          </dl>
          <div className="collaboration-stats-table-wrap">
            <table>
              <caption>
                {zh ? '每个根任务的累计耗时' : 'Cumulative durations per root task'}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{zh ? '阶段' : 'Stage'}</th>
                  <th scope="col">{zh ? '平均' : 'Mean'}</th>
                  <th scope="col">P50</th>
                  <th scope="col">P95</th>
                  <th scope="col">{zh ? '样本 / 缺失' : 'Samples / missing'}</th>
                </tr>
              </thead>
              <tbody>
                {durations.map(([key, label]) => {
                  const metric = data.durations[key]
                  return (
                    <tr key={key}>
                      <th scope="row">{label}</th>
                      <td data-label={zh ? '平均' : 'Mean'}>{duration(metric.mean_ms)}</td>
                      <td data-label="P50">{duration(metric.p50_ms)}</td>
                      <td data-label="P95">{duration(metric.p95_ms)}</td>
                      <td data-label={zh ? '样本 / 缺失' : 'Samples / missing'}>
                        {number(metric.sample_count)} / {number(metric.missing_count)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <section aria-labelledby={`${id}-bytes`}>
            <h3 id={`${id}-bytes`}>{zh ? '已准备的提示词字节' : 'Prepared prompt bytes'}</h3>
            <p className="collaboration-stats-bytes">
              {data.payload.total_bytes === null
                ? zh
                  ? '尚无测量值'
                  : 'Not measured yet'
                : `${number(data.payload.total_bytes)} B`}
            </p>
            <p>
              {zh
                ? `已测 ${number(data.payload.measured_attempts)} 次尝试 · 未测 ${number(data.payload.unmeasured_attempts)} 次 · 尚未尝试 ${number(data.payload.pending_deliveries)} 条投递`
                : `${number(data.payload.measured_attempts)} measured attempts · ${number(data.payload.unmeasured_attempts)} unmeasured · ${number(data.payload.pending_deliveries)} deliveries awaiting an attempt`}
            </p>
            <p>
              {zh
                ? '按实际准备的 UTF-8 内容记录，重试重新准备会累计。历史缺值不补算；字节不代表 token、金额或模型收件。'
                : 'Actual prepared UTF-8 content; preparing again on retry adds another sample. Historical gaps stay missing. Bytes do not measure tokens, cost or model receipt.'}
            </p>
          </section>
          <details>
            <summary>{zh ? '统计口径' : 'How these statistics are calculated'}</summary>
            <p>
              {zh
                ? '每个阶段先将根任务及审查子任务的时长相加，再计算平均值及最近秩 P50/P95。排队和执行须全部派单有有效起止时间；报告须全部已有报告回执有提交时间。缺少记录或时间倒置时不计为零。'
                : 'Durations are summed across each root task and its reviews, then summarized using the mean and nearest-rank P50/P95. Queue and execution require valid endpoints for every dispatch; report submission requires every recorded report receipt. Missing or reversed timestamps are excluded, never counted as zero.'}
            </p>
            <p>
              {zh
                ? '执行包含等待及返工，并非 CPU 或模型运行时间。报告提交只表示终端提交或收件确认。验收到集成来自同一验证记录或候选的接受与 Git 集成时间，累计已记录的集成动作，不表示已发布。'
                : 'Execution includes waiting and rework; it is not CPU or model time. Report submission means terminal submission or receipt confirmation. Acceptance to integration sums recorded Git integration actions using their matching verification or candidate acceptance; it does not mean published.'}
            </p>
            <p>
              {zh
                ? '返工为汇报后重新打开的轮次；任务对话消息不含派单、汇报或原始终端输出。已清理记录无法恢复统计。'
                : 'Rework counts reopening after a report. Conversation messages exclude dispatches, reports and raw terminal output. Purged records cannot be reconstructed.'}
            </p>
          </details>
        </>
      ) : null}
    </section>
  )
}
