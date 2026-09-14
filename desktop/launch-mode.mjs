const isChineseLocale = (locale) => locale?.toLowerCase().startsWith('zh') ?? false

const copyByLocale = {
  en: {
    closeButtons: ['Keep running', 'Exit HiveTeam'],
    closeDetail:
      'Running team members will stop. Your workspaces, tasks, and saved state will remain available.',
    closeError: 'HiveTeam could not close safely.',
    closeMessage: 'Exit HiveTeam?',
    launchButtons: ['Electron desktop', 'Web browser', 'Cancel'],
    launchDetail:
      'Only one interface opens for this session. Both modes share the same workspaces and data. Web mode stays available from the system tray after the browser closes.',
    launchMessage: 'How would you like to open HiveTeam?',
    trayOpen: 'Open HiveTeam in browser',
    trayQuit: 'Exit HiveTeam',
    trayTooltip: 'HiveTeam — Web mode',
    webOpenError: 'The default browser could not be opened. Try again from the system tray.',
    webServiceError: 'The local HiveTeam service stopped unexpectedly.',
  },
  zh: {
    closeButtons: ['继续运行', '退出 HiveTeam'],
    closeDetail: '正在运行的团队成员将停止；Workspace、任务和已保存状态都会保留。',
    closeError: 'HiveTeam 无法安全关闭。',
    closeMessage: '退出 HiveTeam？',
    launchButtons: ['Electron 桌面客户端', 'Web 浏览器', '取消'],
    launchDetail:
      '本次只会打开一种界面，两种模式共用相同的 Workspace 和数据。Web 模式在浏览器关闭后仍可从系统托盘重新打开。',
    launchMessage: '请选择 HiveTeam 的打开方式',
    trayOpen: '在浏览器中打开 HiveTeam',
    trayQuit: '退出 HiveTeam',
    trayTooltip: 'HiveTeam — Web 模式',
    webOpenError: '无法打开默认浏览器，请从系统托盘重试。',
    webServiceError: 'HiveTeam 本地服务意外停止。',
  },
}

export const getDesktopLaunchCopy = (locale) =>
  isChineseLocale(locale) ? copyByLocale.zh : copyByLocale.en

export const parseConfiguredLaunchMode = (value) => {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'desktop' || normalized === 'web') return normalized
  throw new Error('HIVE_DESKTOP_LAUNCH_MODE must be either "desktop" or "web"')
}

export const createLaunchModeDialogOptions = (locale) => {
  const copy = getDesktopLaunchCopy(locale)
  return {
    buttons: copy.launchButtons,
    cancelId: 2,
    defaultId: 0,
    detail: copy.launchDetail,
    message: copy.launchMessage,
    noLink: true,
    title: 'HiveTeam',
    type: 'question',
  }
}

export const chooseLaunchMode = async ({ configuredMode, locale, showMessageBox }) => {
  const selectedMode = parseConfiguredLaunchMode(configuredMode)
  if (selectedMode) return selectedMode

  const { response } = await showMessageBox(createLaunchModeDialogOptions(locale))
  if (response === 0) return 'desktop'
  if (response === 1) return 'web'
  return null
}

export const createDesktopCloseDialogOptions = (locale) => {
  const copy = getDesktopLaunchCopy(locale)
  return {
    buttons: copy.closeButtons,
    cancelId: 0,
    defaultId: 0,
    detail: copy.closeDetail,
    message: copy.closeMessage,
    noLink: true,
    title: 'HiveTeam',
    type: 'question',
  }
}

export const bindDesktopCloseConfirmation = ({ close, confirm, onError, window }) => {
  let confirmationPending = false

  const handleClose = (event) => {
    event.preventDefault()
    if (confirmationPending) return
    confirmationPending = true

    void confirm()
      .then(async (confirmed) => {
        if (!confirmed) {
          confirmationPending = false
          return
        }
        await close()
      })
      .catch((error) => {
        confirmationPending = false
        onError(error)
      })
  }

  window.on('close', handleClose)
  return () => window.removeListener('close', handleClose)
}
