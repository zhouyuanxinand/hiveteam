const capabilityMessages: Record<string, [string, string]> = {
  cli_unavailable: [
    '找不到配置的 CLI，请先安装或修正启动命令。',
    'Configured CLI was not found. Install it or correct the launch command.',
  ],
  platform_sandbox_unverified: [
    '当前操作系统与架构的受限沙箱尚未通过验证。请改用已验证的环境，或在本机明确授权此成员使用宿主权限。',
    'Restricted execution is not verified on this operating system and architecture. Use a verified environment or explicitly authorize host access for this agent locally.',
  ],
  cli_toolchain_unverified: [
    '此 CLI 版本尚未通过隔离验证。',
    'This CLI version has not passed isolation verification.',
  ],
  cli_inside_mutable_workspace: [
    'CLI 位于可写工作区内，请使用工作区外的可信安装。',
    'The CLI is inside a writable workspace. Use a trusted installation outside it.',
  ],
  native_toolchain_acceptance_pending: [
    '原生工具与会话恢复的隔离验收尚未完成。',
    'Native tool and session-resume isolation verification is incomplete.',
  ],
  persistent_policy_directory_required: [
    '受限执行需要持久化的 HiveTeam 数据目录。',
    'Restricted execution requires a persistent HiveTeam data directory.',
  ],
  custom_launch_flags_unverified: [
    '自定义启动参数或模型未通过隔离验证。',
    'Custom launch arguments or the selected model have not been verified.',
  ],
  custom_role_permissions_required: [
    '自定义角色尚未定义受限权限。',
    'Restricted permissions have not been defined for this custom role.',
  ],
  isolated_worker_worktree_required: [
    'Coder 与 Tester 需要独立 worktree；请在添加成员时启用独立工作树。',
    'Coders and testers require an isolated worktree. Enable it when adding the member.',
  ],
  native_sandbox_preflight_failed: [
    '本机沙箱检查失败，启动已被阻止。',
    'The local sandbox check failed and the launch was blocked.',
  ],
  tester_checkout_unavailable: [
    '无法创建固定提交的 Tester 临时副本，请检查 Git 源版本及目录权限。当前副本不支持符号链接或子模块。',
    'The Tester checkout could not be created. Check the Git revision and directory permissions; symlinks and submodules are currently unsupported.',
  ],
}

export const executionCapabilityMessage = (code: string, zh: boolean) =>
  capabilityMessages[code]?.[zh ? 0 : 1] ?? code
