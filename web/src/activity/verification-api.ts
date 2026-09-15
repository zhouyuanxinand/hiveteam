import type {
  DispatchVerification,
  DispatchVerificationView,
} from '../../../src/shared/verification.js'
import { apiFetch, readErrorMessage } from '../api.js'

interface RunPayload {
  id: string
  workspace_id: string
  dispatch_id: string
  report_revision: number
  head_sha: string
  command: string
  state: DispatchVerification['state']
  output: string
  output_truncated: boolean
  exit_code: number | null
  error: string | null
  started_at: number
  ended_at: number | null
  accepted_at: number | null
}
interface ViewPayload {
  isolated?: boolean
  head_sha: string | null
  is_dirty: boolean
  unavailable_reason: string | null
  report_revision: number
  can_run: boolean
  can_accept: boolean
  stale_reason: DispatchVerificationView['staleReason']
  accepted: boolean
  runs: RunPayload[]
}
const fromRun = (run: RunPayload): DispatchVerification => ({
  id: run.id,
  workspaceId: run.workspace_id,
  dispatchId: run.dispatch_id,
  reportRevision: run.report_revision,
  headSha: run.head_sha,
  command: run.command,
  state: run.state,
  output: run.output,
  outputTruncated: run.output_truncated,
  exitCode: run.exit_code,
  error: run.error,
  startedAt: run.started_at,
  endedAt: run.ended_at,
  acceptedAt: run.accepted_at,
})
const fromView = (view: ViewPayload): DispatchVerificationView => ({
  isolated: view.isolated ?? false,
  headSha: view.head_sha,
  isDirty: view.is_dirty,
  unavailableReason: view.unavailable_reason,
  reportRevision: view.report_revision,
  canRun: view.can_run,
  canAccept: view.can_accept,
  staleReason: view.stale_reason,
  accepted: view.accepted,
  runs: view.runs.map(fromRun),
})
const url = (workspaceId: string, dispatchId: string) =>
  `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/dispatches/${encodeURIComponent(dispatchId)}/verifications`
const responseJson = async (response: Response) => {
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Verification request failed'))
  return response.json()
}
export const getDispatchVerifications = async (workspaceId: string, dispatchId: string) =>
  fromView((await responseJson(await apiFetch(url(workspaceId, dispatchId)))) as ViewPayload)
export const startDispatchVerification = async (
  workspaceId: string,
  dispatchId: string,
  input: { command: string; headSha: string; reportRevision: number }
) =>
  fromRun(
    (await responseJson(
      await apiFetch(url(workspaceId, dispatchId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          command: input.command,
          head_sha: input.headSha,
          report_revision: input.reportRevision,
        }),
      })
    )) as RunPayload
  )
export const updateDispatchVerification = async (
  workspaceId: string,
  dispatchId: string,
  verificationId: string,
  action: 'accept' | 'cancel'
) =>
  fromView(
    (await responseJson(
      await apiFetch(
        `${url(workspaceId, dispatchId)}/${encodeURIComponent(verificationId)}/${action}`,
        { method: 'POST' }
      )
    )) as ViewPayload
  )
