const { contextBridge, ipcRenderer, webUtils } = require('electron')

const PROBE_DROPPED_FOLDER_CHANNEL = 'hive-desktop:probe-dropped-folder'

contextBridge.exposeInMainWorld('hiveDesktop', {
  probeDroppedFolder(file) {
    let path
    try {
      path = webUtils.getPathForFile(file)
    } catch {
      return Promise.resolve({ error_code: 'path_unavailable', ok: false })
    }

    if (!path) return Promise.resolve({ error_code: 'path_unavailable', ok: false })
    return ipcRenderer.invoke(PROBE_DROPPED_FOLDER_CHANNEL, path)
  },
})
