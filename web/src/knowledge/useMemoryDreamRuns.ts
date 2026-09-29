import { useEffect, useRef, useState } from 'react'
import { MEMORY_DREAM_PLAN_VERSION } from '../../../src/shared/memory-dream-plan.js'
import type { TeamMemoryDreamRun } from '../../../src/shared/team-memory.js'
import { getTeamMemoryDream, listTeamMemoryDreamHistory } from './memory-dream-api.js'

const needsGeneration = (run: TeamMemoryDreamRun) =>
  Boolean(run.generation && run.generation.status !== 'completed')
const isReview = (run: TeamMemoryDreamRun) =>
  run.status === 'review' && run.planVersion === MEMORY_DREAM_PLAN_VERSION
const mergeRuns = (previous: TeamMemoryDreamRun[], next: TeamMemoryDreamRun[]) =>
  [...new Map([...previous, ...next].map((run) => [run.id, run])).values()].sort(
    (left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id)
  )

export const useMemoryDreamRuns = (workspaceId: string, open: boolean) => {
  const [runs, setRuns] = useState<TeamMemoryDreamRun[]>([])
  const [current, setCurrent] = useState<TeamMemoryDreamRun | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [reviewOnly, setReviewOnly] = useState(false)
  const [reviewCount, setReviewCount] = useState(0)
  const [reviewIds, setReviewIds] = useState(new Set<string>())
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [noNewMessages, setNoNewMessages] = useState(false)
  const epoch = useRef(0)
  const draftEdits = useRef(new Map<string, TeamMemoryDreamRun>())

  useEffect(() => {
    const requestEpoch = ++epoch.current
    draftEdits.current.clear()
    setRuns([])
    setCurrent(null)
    setBusy(false)
    setHistoryLoading(false)
    setReviewOnly(false)
    setReviewCount(0)
    setReviewIds(new Set())
    setNextCursor(null)
    setNoNewMessages(false)
    setError(null)
    setPollError(null)
    setLoading(open)
    if (!open) return
    void listTeamMemoryDreamHistory(workspaceId)
      .then((page) => {
        if (epoch.current !== requestEpoch) return
        setRuns(page.runs)
        setNextCursor(page.nextCursor)
        setReviewCount(page.reviewCount)
        setCurrent(page.runs.find(isReview) ?? page.runs[0] ?? null)
      })
      .catch((loadError: unknown) => {
        if (epoch.current === requestEpoch)
          setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
      .finally(() => {
        if (epoch.current === requestEpoch) setLoading(false)
      })
    return () => {
      epoch.current++
    }
  }, [open, workspaceId])

  const pendingIds = runs
    .filter(needsGeneration)
    .map((run) => run.id)
    .join(',')
  useEffect(() => {
    if (!open || loading || busy || historyLoading || !pendingIds) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await Promise.all(
          pendingIds.split(',').map((id) => getTeamMemoryDream(workspaceId, id))
        )
        const page = next.some((run) => !needsGeneration(run))
          ? await listTeamMemoryDreamHistory(workspaceId, { limit: 1 })
          : null
        if (!active) return
        if (page) setReviewCount(page.reviewCount)
        setRuns((previous) => mergeRuns(previous, next))
        setReviewIds((previous) => {
          const ids = new Set(previous)
          for (const run of next) {
            if (isReview(run)) ids.add(run.id)
            else ids.delete(run.id)
          }
          return ids
        })
        setPollError(null)
        // Only unfinished generation follows server state. A reviewer's edits stay local.
        setCurrent((previous) =>
          previous && needsGeneration(previous)
            ? (next.find((run) => run.id === previous.id) ?? previous)
            : previous
        )
      } catch (pollError: unknown) {
        if (active) setPollError(pollError instanceof Error ? pollError.message : String(pollError))
      } finally {
        if (active) timer = setTimeout(() => void poll(), 2000)
      }
    }
    timer = setTimeout(() => void poll(), 2000)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [open, loading, busy, historyLoading, pendingIds, workspaceId])

  const loadHistory = async (onlyReview: boolean, cursor?: string) => {
    const requestEpoch = epoch.current
    setHistoryLoading(true)
    setError(null)
    try {
      const page = await listTeamMemoryDreamHistory(workspaceId, {
        reviewOnly: onlyReview,
        ...(cursor ? { cursor } : {}),
      })
      if (epoch.current !== requestEpoch) return
      const selected =
        !cursor && current && !page.runs.some((run) => run.id === current.id)
          ? await getTeamMemoryDream(workspaceId, current.id)
          : null
      if (epoch.current !== requestEpoch) return
      const next = [...page.runs, ...(selected ? [selected] : [])].map(
        (run) => draftEdits.current.get(run.id) ?? run
      )
      if (onlyReview)
        setReviewIds(
          (previous) => new Set([...(cursor ? previous : []), ...page.runs.map((run) => run.id)])
        )
      setRuns((previous) => mergeRuns(previous, next))
      setReviewOnly(onlyReview)
      setNextCursor(page.nextCursor)
      setReviewCount(page.reviewCount)
      setCurrent((previous) =>
        previous && (cursor || !onlyReview || isReview(previous))
          ? (next.find((run) => run.id === previous.id) ?? previous)
          : (next.find(isReview) ?? next[0] ?? previous)
      )
    } catch (loadError: unknown) {
      if (epoch.current === requestEpoch)
        setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      if (epoch.current === requestEpoch) setHistoryLoading(false)
    }
  }
  const select = (run: TeamMemoryDreamRun) => {
    setCurrent(draftEdits.current.get(run.id) ?? run)
    setError(null)
    setNoNewMessages(false)
  }
  const edit = (run: TeamMemoryDreamRun) => {
    draftEdits.current.set(run.id, run)
    setCurrent(run)
    setRuns((previous) => previous.map((item) => (item.id === run.id ? run : item)))
  }
  const perform = async (
    action: () => Promise<TeamMemoryDreamRun | null>,
    onChanged?: () => void
  ) => {
    const requestEpoch = epoch.current
    setBusy(true)
    setError(null)
    setNoNewMessages(false)
    try {
      const next = await action()
      if (epoch.current !== requestEpoch) return
      // Refresh counts without dropping loaded history or replacing the selected receipt.
      try {
        const page = await listTeamMemoryDreamHistory(workspaceId, { limit: 1 })
        if (epoch.current === requestEpoch) {
          setReviewCount(page.reviewCount)
          setPollError(null)
        }
      } catch (refreshError: unknown) {
        if (epoch.current === requestEpoch)
          setPollError(refreshError instanceof Error ? refreshError.message : String(refreshError))
      }
      if (epoch.current !== requestEpoch) return
      if (next) {
        draftEdits.current.delete(next.id)
        setCurrent(next)
        setRuns((previous) => mergeRuns(previous, [next]))
        setReviewIds((previous) => {
          const ids = new Set(previous)
          if (isReview(next)) ids.add(next.id)
          else ids.delete(next.id)
          return ids
        })
        onChanged?.()
      } else setNoNewMessages(true)
    } catch (actionError: unknown) {
      if (epoch.current === requestEpoch)
        setError(actionError instanceof Error ? actionError.message : String(actionError))
    } finally {
      if (epoch.current === requestEpoch) setBusy(false)
    }
  }
  return {
    runs: runs.filter((run) => !reviewOnly || reviewIds.has(run.id) || run.id === current?.id),
    current,
    loading,
    busy: busy || historyLoading,
    historyLoading,
    reviewOnly,
    reviewCount,
    hasMore: nextCursor !== null,
    filterHistory: (onlyReview: boolean) => loadHistory(onlyReview),
    loadMore: () => nextCursor && loadHistory(reviewOnly, nextCursor),
    error: error ?? pollError,
    noNewMessages,
    select,
    edit,
    perform,
  }
}
