export interface ReportDeliveryCheckpoint {
  cwd: string
  inputSequence: number
  lastSubmitAt: number
  offset: number
  pasteConfirmed: boolean
  runId: string
  sessionFile: string
  sessionId: string
  submitAttempts: number
}

export interface ReportDeliveryReceipt {
  checkpoint: ReportDeliveryCheckpoint | null
  id: string
  save: (checkpoint: ReportDeliveryCheckpoint) => void
}

export interface SystemMessageDeliveryOptions {
  requireActiveRun?: boolean
  receipt?: ReportDeliveryReceipt
  delivery?: {
    signal: AbortSignal
    timeoutMs: number
    beforeWrite: () => void
    nativeReceipt: () => void
  }
}

export const reportReceiptMarker = (id: string) => `[Hive report receipt: ${id}]`
