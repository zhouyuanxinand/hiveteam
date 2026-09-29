import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type RunAutostartCommand, requireCommandSuccess } from './platform-autostart-command.js'
import {
  type AutostartLaunchConfig,
  readAutostartFile,
  writeAutostartFile,
  xmlString,
} from './platform-autostart-files.js'

export const createMacAutostart = ({
  config,
  configPath,
  homeDir,
  id,
  runCommand,
  uid,
}: {
  config: AutostartLaunchConfig
  configPath: string
  homeDir: string
  id: string
  runCommand: RunAutostartCommand
  uid: number
}) => {
  const label = `io.hiveteam.${id}`
  const domain = `gui/${uid}`
  const plistPath = join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`)
  const renderPlist = (launchConfig: AutostartLaunchConfig) => {
    const args = [
      launchConfig.node_executable,
      join(config.project_root, 'scripts', 'platform-start.mjs'),
      '--config',
      configPath,
    ]
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((value) => `<string>${xmlString(value)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xmlString(config.project_root)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>StandardOutPath</key><string>${xmlString(join(config.data_dir, 'platform-autostart', 'stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xmlString(join(config.data_dir, 'platform-autostart', 'stderr.log'))}</string>
</dict></plist>
`
  }
  let plist = renderPlist(config)
  const checkOwner = async () => {
    const current = await readAutostartFile(plistPath)
    if (current !== null && current !== plist)
      throw new Error('LaunchAgent belongs to another project or has a different action.')
    return current !== null
  }
  const query = async () => {
    const registered = await checkOwner()
    const output = requireCommandSuccess(
      await runCommand({ executable: '/bin/launchctl', args: ['print-disabled', domain] }),
      'launchctl print-disabled'
    )
    if (!/disabled services\s*=\s*\{[\s\S]*\}/u.test(output))
      throw new Error('launchctl returned an unrecognized disabled-services status.')
    const escaped = label.replace(/\./g, '\\.')
    const match = output.match(
      new RegExp(`^\\s*"${escaped}"\\s*=>\\s*(true|false|enabled|disabled)\\s*;?\\s*$`, 'm')
    )
    if (!match && new RegExp(`^\\s*"${escaped}"\\s*=>`, 'm').test(output))
      throw new Error('launchctl returned an unrecognized state for this LaunchAgent.')
    const disabled = match?.[1] === 'true' || match?.[1] === 'disabled'
    return { registered, enabled: registered && !disabled }
  }
  return {
    query,
    async setEnabled(enabled: boolean, desiredConfig = config) {
      const existed = await checkOwner()
      if (!enabled && !existed) return
      const previous = plist
      if (enabled) {
        plist = renderPlist(desiredConfig)
        await writeAutostartFile(plistPath, plist)
      }
      try {
        requireCommandSuccess(
          await runCommand({
            executable: '/bin/launchctl',
            args: [enabled ? 'enable' : 'disable', `${domain}/${label}`],
          }),
          `launchctl ${enabled ? 'enable' : 'disable'}`
        )
      } catch (error) {
        if (enabled) {
          if (existed) await writeAutostartFile(plistPath, previous)
          else await rm(plistPath, { force: true })
          plist = previous
        }
        throw error
      }
      if (!enabled) await rm(plistPath, { force: true })
      // LaunchAgents are loaded at the next GUI login. Do not bootstrap or
      // bootout here: changing this preference must not interrupt the platform.
    },
  }
}
