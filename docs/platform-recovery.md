# 平台恢复与登录自启动

通过 `npm start`（源码）或 `hive`（构建包）启动的平台带有进程守护。在顶部的 **资源 → 平台恢复** 中，可以查看守护状态、连续重试次数和最近错误，并设置 **登录系统时自动启动 HiveTeam**。

登录自启动默认关闭，支持 Windows 和 macOS 的当前用户。它在你登录桌面后启动 HiveTeam，不是在电脑开机但尚未登录时运行的系统服务。更改开关只影响后续登录，当前平台继续运行；开启时不会立即启动第二个实例，关闭时不会中断正在进行的工作。

## 恢复的范围

平台守护监测 Runtime，以及开发模式下的 Vite。子进程意外退出、IPC 心跳失联或健康检查连续失败时，会先关闭旧进程组，再重新启动。恢复时使用相同的绝对数据目录和端口，工作区、成员配置及原生会话信息从既有数据库恢复，仍遵守各工作区的恢复选项和 CLI 会话可用性。进程恢复不保证补回中断前尚未持久化的输出，也不会替代原生 CLI 对被占用会话的保护。

连续故障最多重试 5 次，等待时间依次为 1、3、10、30、30 秒。稳定运行满 60 秒后，连续故障计数重置。持续启动失败达到上限会停止自动恢复，保留错误用于排查；修正原因后重新启动平台。端口被其他进程占用或启动配置无效时，会明确报错。

正常退出启动器（例如在启动终端按 Ctrl+C）会关闭其管理的服务，不会立即重新拉起。关闭浏览器标签页只关闭页面。如果开启了登录自启动，正常退出后该偏好仍然保留，下次登录会再次启动。

同一数据目录只能有一个平台实例。已有实例占用时，第二个启动器正常退出，不抢占端口或结束其他应用。要运行相互独立的平台，必须使用不同的数据目录和端口。

## Windows

开启后创建当前用户的 `HiveTeam-<数据目录摘要>` 登录计划任务，使用交互式登录和普通用户权限，不使用 SYSTEM，也不保存用户密码。任务以隐藏 PowerShell 窗口执行固定 Node 路径和启动入口；已在运行时忽略重复触发。守护启动器本身异常退出时，计划任务最多按一分钟间隔重试 3 次。

关闭开关会禁用该任务的后续触发，保留任务定义，且不停止当前运行。状态由实际任务的启用状态和归属核查得出。名称相同但项目、执行动作或用户不匹配的任务会被拒绝修改。

## macOS

开启后写入当前用户的 `~/Library/LaunchAgents/io.hiveteam.<数据目录摘要>.plist`，并用 `launchctl enable` 启用。平台不会在切换开关时执行 `bootstrap`；LaunchAgent 从下次图形界面登录生效。关闭时用 `launchctl disable` 禁止后续启动并移除自己的 plist，不执行 `bootout`，因此不会停止当前平台。

LaunchAgent 使用 `RunAtLoad` 和 `KeepAlive.SuccessfulExit=false`：守护器异常退出可由 launchd 重启，正常退出以及达到内部重试上限的受控退出不会触发它。状态联合检查有效的自有 plist 和 `launchctl print-disabled`，不会仅凭文件存在显示为启用。此处需要当前非 root 桌面用户，不安装系统级 LaunchDaemon。

登录任务不读取交互式 shell 的初始化脚本。启动环境保留已有 PATH 的查找优先级，随后补充固定 Node 所在目录、Homebrew、`~/.local/bin`、`~/.npm-global/bin`、`~/Library/pnpm`、`~/.volta/bin`、`~/.cargo/bin` 和系统工具目录。通过自定义前缀或 shell 专用版本管理器安装的 CLI，仍可能不在这些目录中；请在 HiveTeam 的 CLI 绑定入口保存它的绝对可执行路径，或把该目录加入桌面登录环境的 PATH。路径含空格时按界面提示加引号。

## 保存内容与排查

配置保存在 `<HIVE_DATA_DIR>/platform-autostart/launch.json`，只包含项目路径、Node 路径、数据目录、端口、启动模式和源码/构建入口，不保存登录令牌、密码或完整环境变量。恢复始终使用启用开关时保存的这些位置。Node 安装路径变化时，平台仍依据保存的配置识别旧注册，可直接关闭旧项，或重新开启以保存新 Node 路径；更新失败会恢复原配置，继续允许关闭。移动项目或删除工作树前，应先关闭原配置，再从新的项目位置启动并重新开启。归属冲突会显示错误，不会覆盖其他工作树的配置。

macOS 的登录启动日志位于同目录的 `stdout.log` 和 `stderr.log`。Windows 可在任务计划程序中检查对应任务的执行结果；正常从终端启动时，两平台都可以查看启动器日志。界面显示启用代表后续登录配置有效，并不表示当前平台是由系统登录任务启动的。

Linux 可以使用平台内置守护，但当前没有内置登录自启动开关。手动直接调用 Runtime 或其他未接入平台启动器的入口时，界面会显示未托管，应通过 `npm start` 或 `hive` 启动以获得这里描述的恢复能力。

## 机制依据

- [Microsoft：任务设置及失败后重试](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset?view=windowsserver2025-ps)
- [Microsoft：禁用计划任务](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/disable-scheduledtask?view=windowsserver2025-ps)
- [Apple：创建 launchd 登录任务](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
- [Apple：launchd.plist 的 RunAtLoad / KeepAlive 语义](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5)
