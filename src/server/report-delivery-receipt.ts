export interface ReportDeliveryCheckpoint {
  cwd: string
  inputSequence: number
  lastSubmitAt: number
  offset: number
  pasteConfirmed: boolean
  runId: string
  sessionFile: string | null
  sessionId: string | null
  capturePattern?: string
  wireFormat?: 'json-string-v1' | 'native-initial-v1'
  wireSha256?: string
  submitAttempts: number
}

export interface ReportDeliveryReceipt {
  checkpoint: ReportDeliveryCheckpoint | null
  id: string
  save: (checkpoint: ReportDeliveryCheckpoint) => void
}

export interface SystemMessageDeliveryOptions {
  allowUnboundCodexSession?: boolean
  requireActiveRun?: boolean
  receipt?: ReportDeliveryReceipt
  delivery?: {
    signal: AbortSignal
    timeoutMs: number
    prepared?: (payload: string) => void
    beforeWrite: () => void
    nativeReceipt: () => void
  }
}

export const reportReceiptMarker = (id: string) => `[Hive report receipt: ${id}]`
