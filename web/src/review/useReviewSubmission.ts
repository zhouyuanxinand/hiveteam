import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReviewSubmission } from '../../../src/shared/workspace-review.js'
import { reviewRequest } from './review-api.js'

export const useReviewSubmission = (
  workspaceId: string,
  initial: ReviewSubmission | null = null,
  attemptedId: string | null = null
) => {
  const [submission, setSubmission] = useState<ReviewSubmission | null>(initial)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  const inFlight = useRef(false)
  const activeRequest = useRef(initial?.request_id ?? attemptedId)
  const [requestId, setRequestId] = useState(activeRequest.current)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const check = useCallback(
    async (id: string) => {
      try {
        const next = await reviewRequest<ReviewSubmission>(workspaceId, `/submissions/${id}`)
        if (mounted.current && activeRequest.current === id) {
          setSubmission(next)
          setError('')
        }
      } catch (e) {
        if (mounted.current && activeRequest.current === id)
          setError(e instanceof Error ? e.message : String(e))
      }
    },
    [workspaceId]
  )
  useEffect(() => {
    if (attemptedId && !initial) void check(attemptedId)
  }, [attemptedId, initial, check])
  useEffect(() => {
    if (submission?.status !== 'sending') return
    const timer = setTimeout(() => {
      void check(submission.request_id)
    }, 1000)
    return () => clearTimeout(timer)
  }, [submission, check])
  const send = async (id: string, action: () => Promise<ReviewSubmission>) => {
    if (inFlight.current || submission?.status === 'sending') return
    inFlight.current = true
    activeRequest.current = id
    setRequestId(id)
    setBusy(true)
    setError('')
    try {
      const next = await action()
      if (mounted.current) setSubmission(next)
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return {
    submission,
    requestId,
    reset: () => {
      activeRequest.current = null
      setRequestId(null)
      setSubmission(null)
      setError('')
    },
    error,
    setError,
    send,
    check,
    busy: busy || submission?.status === 'sending',
  }
}
