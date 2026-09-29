import type { TerminalGrillHandoff } from '../../../src/shared/terminal-grill.js'
import { useI18n } from '../i18n.js'

export const GrillHandoffNotice = ({ handoff }: { handoff: TerminalGrillHandoff }) => {
  const { language } = useI18n()
  const zh = language === 'zh'
  const name = handoff.worker_name ?? (zh ? '需求访谈员' : 'Interviewer')
  const failed = handoff.status === 'failed'
  const text =
    handoff.status === 'pending'
      ? zh
        ? '正在安排需求访谈成员…'
        : 'Arranging an interview member…'
      : handoff.status === 'queued'
        ? zh
          ? `已安排「${name}」，访谈任务正在等待启动或投递。请等待成员就绪。`
          : `${name} is assigned. The interview is waiting for startup or delivery.`
        : handoff.status === 'submitted'
          ? zh
            ? `访谈已交给「${name}」。请在团队成员区域打开该成员窗口回答。`
            : `Interview delivered to ${name}. Open that member's window to answer.`
          : zh
            ? '访谈交接未完成。主控不会代为执行访谈。'
            : 'Interview handoff did not complete. The main agent will not conduct it.'
  return (
    <div
      role={failed ? 'alert' : 'status'}
      className="shrink-0 border-b border-[var(--border)] bg-[var(--bg-2)] px-4 py-3 text-sm text-pri"
    >
      <p>{text}</p>
      {!failed && handoff.draft_preserved ? (
        <p className="mt-1 text-sec">
          {zh
            ? '主控草稿已保留。访谈已经交接，请勿重复提交；输入其他内容前请先清空草稿。'
            : 'The main draft was preserved. The interview is already handed off; do not resubmit it. Clear the draft before entering another message.'}
        </p>
      ) : null}
      {!failed && handoff.draft_error ? (
        <p className="mt-1 break-words text-sec">{handoff.draft_error}</p>
      ) : null}
      {failed ? (
        <>
          <p className="mt-1 break-words text-[var(--status-red)]">{handoff.message}</p>
          <p className="mt-1 break-all text-xs text-sec">
            {zh ? '交接编号：' : 'Handoff ID: '} {handoff.request_id}
          </p>
        </>
      ) : null}
    </div>
  )
}
