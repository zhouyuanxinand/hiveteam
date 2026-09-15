import { execFile } from 'node:child_process'
import { parse } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from 'vitest'

import { pickFolder, type RunPickCommand } from '../../src/server/fs-pick-folder.js'

const observerScript = fileURLToPath(
  new URL('../helpers/windows-folder-picker.ps1', import.meta.url)
)

test.skipIf(process.platform !== 'win32').each(['cancel', 'select'] as const)(
  'native Windows picker stays above another window and cleans up after %s',
  async (action) => {
    const selectedPath = parse(process.cwd()).root
    let observation: unknown
    const runCommand: RunPickCommand = async (command, args, options) => {
      // Preselect an existing drive using the public WinForms property, then click the
      // real OK button. Window ownership and the result/probe path run normally.
      const encodedPath = Buffer.from(selectedPath, 'utf8').toString('base64')
      const commandArgs =
        action === 'select'
          ? args.map((arg) =>
              arg.replace(
                '$dialog.ShowNewFolderButton = $false',
                `$dialog.ShowNewFolderButton = $false; $dialog.SelectedPath = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`
              )
            )
          : args
      let child!: ReturnType<typeof execFile>
      const execution = new Promise<Awaited<ReturnType<RunPickCommand>>>((resolve) => {
        child = execFile(command, commandArgs, options, (error, stdout, stderr) => {
          resolve({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            status: typeof error?.code === 'number' ? error.code : (child.exitCode ?? 0),
            signal: error?.signal ?? null,
            timedOut: false,
            spawnError:
              error && typeof error.code === 'string'
                ? Object.assign(error, { code: error.code })
                : null,
          })
        })
      })
      // Observe and interact with this child only, leaving other open pickers alone.
      const observed = new Promise<void>((resolve, reject) => {
        execFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-STA',
            '-File',
            observerScript,
            '-PickerProcessId',
            String(child.pid),
            '-Action',
            action,
          ],
          { windowsHide: true, timeout: 50_000 },
          (error, stdout, stderr) => {
            if (error) {
              reject(new Error(`Native picker observation failed: ${stderr}`, { cause: error }))
              return
            }
            try {
              observation = JSON.parse(stdout.trim())
              resolve()
            } catch (cause) {
              reject(cause)
            }
          }
        )
      })
      try {
        const [result] = await Promise.all([execution, observed])
        return result
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill()
      }
    }
    const result = await pickFolder({ runCommand })
    expect(observation).toEqual({
      aboveNormalWindow: true,
      ownerTopMost: true,
      dialogClosed: true,
      ownerClosed: true,
    })
    expect(result.error).toBeNull()
    expect(result.supported).toBe(true)
    expect(result.canceled).toBe(action === 'cancel')
    expect(result.path).toBe(action === 'cancel' ? null : selectedPath)
    if (action === 'select') {
      expect(result.probe).toEqual(
        expect.objectContaining({ exists: true, is_dir: true, ok: true })
      )
    } else {
      expect(result.probe).toBeNull()
    }
  },
  60_000
)
