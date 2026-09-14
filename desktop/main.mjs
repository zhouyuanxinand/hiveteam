import { app, dialog } from 'electron'

import { launchHiveDesktop } from './app.mjs'

let desktop = null
let stopping = false

const stopAndQuit = async () => {
  if (stopping) return
  stopping = true
  await desktop?.close()
  desktop = null
  app.quit()
}

app.on('before-quit', (event) => {
  if (!desktop || stopping) return
  event.preventDefault()
  void stopAndQuit()
})
app.on('window-all-closed', () => void stopAndQuit())
process.once('SIGINT', () => void stopAndQuit())
process.once('SIGTERM', () => void stopAndQuit())

void app
  .whenReady()
  .then(async () => {
    desktop = await launchHiveDesktop()
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('HiveTeam could not start', message)
    app.quit()
  })
