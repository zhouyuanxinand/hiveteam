import DOMPurify from 'isomorphic-dompurify'
import { marked } from 'marked'
import { useEffect, useMemo, useRef } from 'react'

export const ReviewMarkdown = ({
  content,
  path = '',
  documentPaths = [],
  onNavigate,
}: {
  content: string
  path?: string
  documentPaths?: string[]
  onNavigate?: (path: string) => void
}) => {
  const article = useRef<HTMLElement>(null)
  const html = useMemo(
    () =>
      DOMPurify.sanitize(marked.parse(content, { async: false, gfm: true }), {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'style', 'form', 'input', 'button', 'svg'],
        FORBID_ATTR: ['style'],
      }),
    [content]
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: React replaces the article DOM when sanitized HTML changes, so listeners must be rebound.
  useEffect(() => {
    const root = article.current
    if (!root) return
    const cleanup: Array<() => void> = []
    for (const link of Array.from(root.querySelectorAll('a[href], a[data-review-href]'))) {
      const href = link.getAttribute('data-review-href') ?? link.getAttribute('href') ?? ''
      link.setAttribute('data-review-href', href)
      if (/^https?:\/\//i.test(href)) {
        link.setAttribute('target', '_blank')
        link.setAttribute('rel', 'noopener noreferrer')
        continue
      }
      link.removeAttribute('href')
      // Only listed workspace Markdown links navigate inside Hive, never to a local URL.
      const base = new URL(path, 'https://review.invalid/')
      let target: URL
      try {
        target = new URL(href, base)
      } catch {
        continue
      }
      if (target.origin !== base.origin || !onNavigate) continue
      let nextPath: string
      try {
        nextPath = decodeURIComponent(target.pathname.slice(1))
      } catch {
        continue
      }
      if (!documentPaths.includes(nextPath)) continue
      link.setAttribute('href', '#')
      const navigate = (event: Event) => {
        event.preventDefault()
        onNavigate(nextPath)
      }
      link.addEventListener('click', navigate)
      cleanup.push(() => link.removeEventListener('click', navigate))
    }
    return () => {
      for (const remove of cleanup) remove()
    }
  }, [html, path, documentPaths, onNavigate])
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: Markdown is sanitized and active/remote content is disabled.
    <article ref={article} className="review-markdown" dangerouslySetInnerHTML={{ __html: html }} />
  )
}
