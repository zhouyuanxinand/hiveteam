import { useLayoutEffect, useRef, useState } from 'react'
import type { DispatchVerification } from '../../../src/shared/verification.js'
import type { VerificationLogPage } from '../../../src/shared/verification-profile.js'
import { useI18n } from '../i18n.js'
import { verificationLog } from './verification-profile-api.js'

export const VerificationLog = ({ run }: { run: DispatchVerification }) => {
  const { language } = useI18n(),
    zh = language === 'zh'
  const [page, setPage] = useState<VerificationLogPage | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const output = useRef<HTMLPreElement>(null)
  const tail = useRef(false)
  useLayoutEffect(() => {
    if (page && output.current)
      output.current.scrollTop = tail.current ? output.current.scrollHeight : 0
  }, [page])
  const load = async (offset?: number) => {
    setBusy(true)
    setError('')
    try {
      tail.current = offset === undefined
      setPage(await verificationLog(run.workspaceId, run.dispatchId, run.id, offset))
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }
  const download = () => {
    if (!page) return
    const url = URL.createObjectURL(
      new Blob(
        [
          `Verification ${run.id}\nCommit ${run.headSha}\nState ${run.state}\nBytes ${page.offset}–${page.next_offset} / ${page.total_bytes}\n\n${page.text}`,
        ],
        { type: 'text/plain;charset=utf-8' }
      )
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `verification-${run.id}-page.txt`
    link.click()
    URL.revokeObjectURL(url)
  }
  return (
    <details className="delivery-quality">
      <summary>{zh ? '完整日志与诊断' : 'Full log and diagnostics'}</summary>
      <div className="delivery-quality-actions">
        <button type="button" className="icon-btn" disabled={busy} onClick={() => void load()}>
          {zh ? '查看末尾' : 'Read tail'}
        </button>
        <button type="button" className="icon-btn" disabled={busy} onClick={() => void load(0)}>
          {zh ? '从头读取' : 'Read from start'}
        </button>
        {page ? (
          <>
            <button
              type="button"
              className="icon-btn"
              disabled={busy || page.next_offset >= page.total_bytes}
              onClick={() => void load(page.next_offset)}
            >
              {zh ? '下一页' : 'Next page'}
            </button>
            <button type="button" className="icon-btn" onClick={download}>
              {zh ? '导出当前诊断页' : 'Export this diagnostic page'}
            </button>
          </>
        ) : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {page ? (
        <>
          <p>
            {page.offset}–{page.next_offset} / {page.total_bytes}{' '}
            {zh ? '字节；常见凭据已脱敏。' : 'bytes; common credentials redacted.'}
          </p>
          {page.truncated ? (
            <p>
              {zh
                ? '当前仅展示这一页；可从头翻页或跳到末尾。'
                : 'Only this page is shown; read from the start or jump to the tail.'}
            </p>
          ) : null}
          <pre ref={output} className="dispatch-verification-output" aria-live="polite">
            {page.text || (zh ? '暂无输出' : 'No output yet')}
          </pre>
        </>
      ) : null}
    </details>
  )
}
