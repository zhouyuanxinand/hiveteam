import type { DispatchRecord } from './dispatch-ledger-store.js'

export const serializeDispatchRecord = (record: DispatchRecord) => ({
  ...(record.parentDispatchId
    ? {
        parent_dispatch_id: record.parentDispatchId,
        root_dispatch_id: record.rootDispatchId ?? record.id,
      }
    : {}),
  ...(record.messageProtocolVersion === 1 ? { message_protocol_version: 1 } : {}),
  report_outcome: record.reportOutcome,
  report_revision: record.reportRevision,
  accepted_at: record.acceptedAt,
  artifacts: record.artifacts,
  base_head_sha: record.baseHeadSha,
  created_at: record.createdAt,
  delivered_at: record.deliveredAt,
  from_agent_id: record.fromAgentId,
  id: record.id,
  reported_at: record.reportedAt,
  report_text: record.reportText,
  state: record.status,
  submitted_at: record.submittedAt,
  text: record.text,
  to_agent_id: record.toAgentId,
  workspace_id: record.workspaceId,
  ...(record.attemptCount !== undefined ? { attempt_count: record.attemptCount } : {}),
  ...(record.lastAttemptAt !== undefined ? { last_attempt_at: record.lastAttemptAt } : {}),
  ...(record.lastError !== undefined ? { last_error: record.lastError } : {}),
  ...(record.reportDelivery
    ? {
        report_delivery: {
          attempt_count: record.reportDelivery.attemptCount,
          delivered_at: record.reportDelivery.deliveredAt,
          last_attempt_at: record.reportDelivery.lastAttemptAt,
          last_error: record.reportDelivery.lastError,
        },
      }
    : {}),
})
