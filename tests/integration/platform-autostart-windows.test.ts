import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  createPlatformAutostart,
  type RunAutostartCommand,
} from '../../src/server/platform-autostart.js'
import { runAutostartCommand } from '../../src/server/platform-autostart-command.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
})

// Execute the actual PowerShell program and argument escaping, replacing only
// Task Scheduler cmdlets with a file-backed provider. Never register OS tasks.
const schedulerProvider = (path: string) => `
$script:fixturePath = '${path.replace(/'/g, "''")}'
function Save-Task($task) {
  [IO.File]::WriteAllText($script:fixturePath, ($task | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
}
function Get-ScheduledTask { param($TaskPath)
  if (Test-Path -LiteralPath $script:fixturePath) { Get-Content -LiteralPath $script:fixturePath -Raw -Encoding UTF8 | ConvertFrom-Json }
}
function New-ScheduledTaskAction { param($Execute, $Argument, $WorkingDirectory)
  [pscustomobject]@{ Execute=$Execute; Arguments=$Argument; WorkingDirectory=$WorkingDirectory }
}
function New-ScheduledTaskTrigger { param([switch]$AtLogOn, $User)
  [pscustomobject]@{ UserId=$User; AtLogOn=[bool]$AtLogOn; CimClass=@{CimClassName='MSFT_TaskLogonTrigger'} }
}
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel)
  [pscustomobject]@{ UserId=$UserId; LogonType=$LogonType; RunLevel=$RunLevel }
}
function New-ScheduledTaskSettingsSet { param($MultipleInstances, $ExecutionTimeLimit, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, $RestartCount, $RestartInterval)
  [pscustomobject]@{ Enabled=$true; RestartCount=$RestartCount; RestartSeconds=$RestartInterval.TotalSeconds; MultipleInstances=$MultipleInstances; ExecutionSeconds=$ExecutionTimeLimit.TotalSeconds; AllowStartIfOnBatteries=[bool]$AllowStartIfOnBatteries; DontStopIfGoingOnBatteries=[bool]$DontStopIfGoingOnBatteries }
}
function Register-ScheduledTask { param($TaskPath, $TaskName, $Action, $Trigger, $Principal, $Settings, $Description)
  Save-Task ([pscustomobject]@{TaskPath=$TaskPath; TaskName=$TaskName; Actions=@($Action); Triggers=@($Trigger); Principal=$Principal; Settings=$Settings; Description=$Description})
}
function Set-ScheduledTask { param($TaskPath, $TaskName, $Action, $Settings)
  if (Test-Path -LiteralPath ($script:fixturePath + '.deny-update')) { throw 'Fixture update denied' }
  $task = Get-ScheduledTask -TaskPath $TaskPath
  $task.Actions = @($Action)
  $task.Settings = $Settings
  Save-Task $task
}
function Enable-ScheduledTask { param([Parameter(ValueFromPipeline=$true)]$InputObject)
  process { $InputObject.Settings.Enabled=$true; Save-Task $InputObject }
}
function Disable-ScheduledTask { param([Parameter(ValueFromPipeline=$true)]$InputObject)
  process { $InputObject.Settings.Enabled=$false; Save-Task $InputObject }
}
`

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'hive-scheduler-contract-'))
  roots.push(root)
  const projectRoot = join(root, "工作区 ' & $HOME")
  const dataDir = join(root, 'saved data')
  const taskPath = join(root, 'scheduler.json')
  await mkdir(join(projectRoot, 'scripts'), { recursive: true })
  await mkdir(dataDir)
  await writeFile(
    join(projectRoot, 'scripts', 'platform-start.mjs'),
    'console.log(JSON.stringify(process.argv.slice(2)))'
  )
  const runCommand: RunAutostartCommand = async (command) => {
    const encoded = command.args.at(-1)
    if (!encoded) throw new Error('Missing PowerShell script')
    const script = `${schedulerProvider(taskPath)}\n${Buffer.from(encoded, 'base64').toString('utf16le')}`
    return runAutostartCommand({
      ...command,
      args: [...command.args.slice(0, -1), Buffer.from(script, 'utf16le').toString('base64')],
    })
  }
  const startup = createPlatformAutostart({
    dataDir,
    projectRoot,
    nodeExecutable: process.execPath,
    runtimePort: 9483,
    platform: 'win32',
    runCommand,
  })
  return {
    startup,
    runCommand,
    dataDir,
    taskPath,
    projectRoot,
    configPath: join(dataDir, 'platform-autostart', 'launch.json'),
  }
}

test.skipIf(process.platform !== 'win32')(
  'PowerShell registers only an interactive limited logon job and safely executes Unicode paths',
  async () => {
    const ctx = await setup()
    expect(await ctx.startup.getStatus()).toMatchObject({ enabled: false })
    expect(await ctx.startup.setEnabled(true)).toMatchObject({ enabled: true })
    const task = JSON.parse(await readFile(ctx.taskPath, 'utf8'))
    expect(task.Principal).toMatchObject({
      UserId: expect.stringMatching(/^S-1-/),
      LogonType: 'Interactive',
      RunLevel: 'Limited',
    })
    expect(task.Triggers).toEqual([
      {
        UserId: task.Principal.UserId,
        AtLogOn: true,
        CimClass: { CimClassName: 'MSFT_TaskLogonTrigger' },
      },
    ])
    expect(task.Settings).toMatchObject({
      Enabled: true,
      RestartCount: 3,
      RestartSeconds: 60,
      MultipleInstances: 'IgnoreNew',
      ExecutionSeconds: 0,
      AllowStartIfOnBatteries: true,
      DontStopIfGoingOnBatteries: true,
    })
    expect(task.Actions).toHaveLength(1)
    const action = task.Actions[0]
    expect(action.WorkingDirectory).toBe(ctx.projectRoot)
    const args = String(action.Arguments).split(' ')
    expect(args.slice(0, -1)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
    ])
    const executed = await runAutostartCommand({ executable: action.Execute, args })
    expect(executed.exitCode).toBe(0)
    expect(JSON.parse(executed.stdout.trim())).toEqual(['--config', ctx.configPath])
    expect(await ctx.startup.setEnabled(false)).toMatchObject({ enabled: false })
    const disabled = JSON.parse(await readFile(ctx.taskPath, 'utf8'))
    expect(disabled.Settings.Enabled).toBe(false)
    expect(disabled.Actions).toEqual(task.Actions)
  }
)

test.skipIf(process.platform !== 'win32')(
  'the real PowerShell ownership check refuses another action without modifying the job',
  async () => {
    const ctx = await setup()
    await ctx.startup.setEnabled(true)
    const task = JSON.parse(await readFile(ctx.taskPath, 'utf8'))
    task.Actions[0].Arguments = '-NoProfile -Command another-application'
    const foreign = JSON.stringify(task)
    await writeFile(ctx.taskPath, foreign)
    expect(await ctx.startup.getStatus()).toMatchObject({
      enabled: false,
      error: expect.stringContaining('another owner'),
    })
    await expect(ctx.startup.setEnabled(false)).rejects.toThrow('another owner')
    await expect(ctx.startup.setEnabled(true)).rejects.toThrow('another owner')
    expect(await readFile(ctx.taskPath, 'utf8')).toBe(foreign)
  }
)

test.skipIf(process.platform !== 'win32')(
  'a Node upgrade can disable the saved task and update only its owned action',
  async () => {
    const ctx = await setup()
    await ctx.startup.setEnabled(true)
    const oldTask = JSON.parse(await readFile(ctx.taskPath, 'utf8'))
    const upgradedNode = join(ctx.projectRoot, 'new node.exe')
    await writeFile(upgradedNode, '')
    const upgraded = createPlatformAutostart({
      dataDir: ctx.dataDir,
      projectRoot: ctx.projectRoot,
      nodeExecutable: upgradedNode,
      runtimePort: 9483,
      runtimeEntry: 'built',
      platform: 'win32',
      runCommand: ctx.runCommand,
    })
    expect(await upgraded.getStatus()).toMatchObject({ enabled: true })
    expect(await upgraded.setEnabled(false)).toMatchObject({ enabled: false })
    expect(JSON.parse(await readFile(ctx.taskPath, 'utf8')).Actions).toEqual(oldTask.Actions)
    expect(await upgraded.setEnabled(true)).toMatchObject({ enabled: true })
    const task = JSON.parse(await readFile(ctx.taskPath, 'utf8'))
    expect(task.Actions).not.toEqual(oldTask.Actions)
    expect(task.Settings.Enabled).toBe(true)
    expect(JSON.parse(await readFile(ctx.configPath, 'utf8'))).toMatchObject({
      node_executable: upgradedNode,
      runtime_entry: 'built',
    })
    // A newly constructed controller verifies the persisted definition, not cached state.
    expect(await upgraded.getStatus()).toMatchObject({ enabled: true })
    expect(await upgraded.setEnabled(false)).toMatchObject({ enabled: false })
  }
)

test.skipIf(process.platform !== 'win32')(
  'a failed Node upgrade preserves the original registration and saved configuration',
  async () => {
    const ctx = await setup()
    await ctx.startup.setEnabled(true)
    const beforeConfig = await readFile(ctx.configPath, 'utf8')
    const beforeTask = await readFile(ctx.taskPath, 'utf8')
    const upgradedNode = join(ctx.projectRoot, 'new node.exe')
    await writeFile(upgradedNode, '')
    await writeFile(`${ctx.taskPath}.deny-update`, 'deny')
    const upgraded = createPlatformAutostart({
      dataDir: ctx.dataDir,
      projectRoot: ctx.projectRoot,
      nodeExecutable: upgradedNode,
      runtimePort: 9483,
      platform: 'win32',
      runCommand: ctx.runCommand,
    })
    await expect(upgraded.setEnabled(true)).rejects.toThrow('Fixture update denied')
    expect(await readFile(ctx.configPath, 'utf8')).toBe(beforeConfig)
    expect(await readFile(ctx.taskPath, 'utf8')).toBe(beforeTask)
    expect(await upgraded.getStatus()).toMatchObject({ enabled: true })
    expect(await upgraded.setEnabled(false)).toMatchObject({ enabled: false })
  }
)
