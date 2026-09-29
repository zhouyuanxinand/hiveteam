import { join } from 'node:path'
import { type RunAutostartCommand, requireCommandSuccess } from './platform-autostart-command.js'
import type { AutostartLaunchConfig } from './platform-autostart-files.js'

// A fixed program reads data over stdin; paths are never interpolated into this
// administrative script. Each operation verifies the current user's exact job.
const schedulerScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Resolve-TaskSid([string]$value) {
  if ($value -eq $sid) { return $value }
  return ([Security.Principal.NTAccount]::new($value)).Translate([Security.Principal.SecurityIdentifier]).Value
}
function Read-OwnedTask {
  $tasks = @(Get-ScheduledTask -TaskPath '\' | Where-Object { $_.TaskName -eq $request.task_name })
  if ($tasks.Count -eq 0) { return $null }
  if ($tasks.Count -ne 1) { throw 'Autostart task name is ambiguous.' }
  $task = $tasks[0]
  $actions = @($task.Actions)
  $triggers = @($task.Triggers)
  if ($task.Description -cne $request.description -or
      $actions.Count -ne 1 -or
      $actions[0].Execute -ine $request.execute -or
      $actions[0].Arguments -cne $request.arguments -or
      $actions[0].WorkingDirectory -ine $request.working_directory -or
      (Resolve-TaskSid $task.Principal.UserId) -ne $sid -or
      [string]$task.Principal.LogonType -ne 'Interactive' -or
      [string]$task.Principal.RunLevel -ne 'Limited' -or
      $triggers.Count -ne 1 -or
      $triggers[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger' -or
      (Resolve-TaskSid $triggers[0].UserId) -ne $sid) {
    throw 'Autostart task belongs to another owner or has a different action.'
  }
  return $task
}
$task = Read-OwnedTask
switch ($request.operation) {
  'enable' {
    $nextArguments = $request.desired_arguments
    if ($null -eq $task) {
      $request.arguments = $nextArguments
      $action = New-ScheduledTaskAction -Execute $request.execute -Argument $request.arguments -WorkingDirectory $request.working_directory
      $trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
      $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
      $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
      Register-ScheduledTask -TaskPath '\' -TaskName $request.task_name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $request.description | Out-Null
    } else {
      if ($request.arguments -cne $nextArguments) {
        $action = New-ScheduledTaskAction -Execute $request.execute -Argument $nextArguments -WorkingDirectory $request.working_directory
        $settings = $task.Settings
        $settings.Enabled = $true
        Set-ScheduledTask -TaskPath '\' -TaskName $request.task_name -Action $action -Settings $settings | Out-Null
        $request.arguments = $nextArguments
      } elseif (-not $task.Settings.Enabled) { $task | Enable-ScheduledTask | Out-Null }
    }
  }
  'disable' {
    # Disabling future triggers does not stop a currently running platform.
    if ($null -ne $task) { $task | Disable-ScheduledTask | Out-Null }
  }
  'query' { }
  default { throw 'Unknown autostart operation.' }
}
# A later status read runs separately so a read failure cannot roll back the
# config after a successful OS update.
if ($request.operation -ne 'query') {
  @{ registered = ($request.operation -eq 'enable' -or $null -ne $task); enabled = ($request.operation -eq 'enable') } | ConvertTo-Json -Compress
  return
}
@{ registered = ($null -ne $task); enabled = ($null -ne $task -and $task.Settings.Enabled) } | ConvertTo-Json -Compress
`

const quotePowerShell = (value: string) => `'${value.replace(/'/g, "''")}'`

export const createWindowsAutostart = ({
  config,
  configPath,
  id,
  runCommand,
}: {
  config: AutostartLaunchConfig
  configPath: string
  id: string
  runCommand: RunAutostartCommand
}) => {
  const executable = join(
    process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const launcher = join(config.project_root, 'scripts', 'platform-start.mjs')
  const actionArguments = (nodeExecutable: string) => {
    const action = `& ${quotePowerShell(nodeExecutable)} ${quotePowerShell(launcher)} --config ${quotePowerShell(configPath)}; exit $LASTEXITCODE`
    return `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(action, 'utf16le').toString('base64')}`
  }
  const operate = async (operation: 'query' | 'enable' | 'disable', desiredConfig = config) => {
    const result = await runCommand({
      executable,
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(schedulerScript, 'utf16le').toString('base64'),
      ],
      input: JSON.stringify({
        operation,
        task_name: `HiveTeam-${id}`,
        description: `HiveTeam login startup v1 (${id})`,
        execute: executable,
        arguments: actionArguments(config.node_executable),
        desired_arguments: actionArguments(desiredConfig.node_executable),
        working_directory: config.project_root,
      }),
    })
    const output: unknown = JSON.parse(requireCommandSuccess(result, 'Task Scheduler'))
    if (
      !output ||
      typeof output !== 'object' ||
      !('registered' in output) ||
      typeof output.registered !== 'boolean' ||
      !('enabled' in output) ||
      typeof output.enabled !== 'boolean'
    )
      throw new Error('Task Scheduler returned an invalid registration status.')
    return { registered: output.registered, enabled: output.enabled }
  }
  return {
    query: () => operate('query'),
    setEnabled: (value: boolean, desiredConfig?: AutostartLaunchConfig) =>
      operate(value ? 'enable' : 'disable', desiredConfig),
  }
}
