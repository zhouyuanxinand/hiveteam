export type DesktopLaunchMode = 'desktop' | 'web'

export interface DesktopLaunchCopy {
  closeButtons: string[]
  closeDetail: string
  closeError: string
  closeMessage: string
  launchButtons: string[]
  launchDetail: string
  launchMessage: string
  trayOpen: string
  trayQuit: string
  trayTooltip: string
  webOpenError: string
  webServiceError: string
}

export type DesktopDialogOptions = {
  buttons: string[]
  cancelId: number
  defaultId: number
  detail: string
  message: string
  noLink: boolean
  title: string
  type: 'question'
}

export const getDesktopLaunchCopy: (locale?: string | null) => DesktopLaunchCopy
export const parseConfiguredLaunchMode: (value?: string | null) => DesktopLaunchMode | null
export const createLaunchModeDialogOptions: (locale?: string | null) => DesktopDialogOptions
export const createDesktopCloseDialogOptions: (locale?: string | null) => DesktopDialogOptions
export const chooseLaunchMode: (options: {
  configuredMode: string | undefined
  locale: string
  showMessageBox: (options: DesktopDialogOptions) => Promise<{ response: number }>
}) => Promise<DesktopLaunchMode | null>

interface DesktopCloseEvent {
  preventDefault: () => void
}

export const bindDesktopCloseConfirmation: (options: {
  close: () => void | Promise<void>
  confirm: () => Promise<boolean>
  onError: (error: unknown) => void
  window: {
    on: (event: 'close', listener: (event: DesktopCloseEvent) => void) => unknown
    removeListener: (event: 'close', listener: (event: DesktopCloseEvent) => void) => unknown
  }
}) => () => unknown
