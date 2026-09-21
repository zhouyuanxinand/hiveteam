export const memoryCorpus = [
  ['login', '登录接口必须验证双因素验证码，避免绕过认证。', '修复登录验证码绕过认证'],
  ['database', 'SQLite WAL backups require a consistent snapshot.', 'consistent SQLite backup'],
  ['cache', 'Invalidate user_profile cache after email updates.', 'userProfile cache invalidation'],
  ['payments', '支付回调需要幂等，重复通知不能重复扣款。', '处理支付重复通知'],
  ['recovery', '恢复索引使用文件版本和行号标识未完成任务。', '跨日未完成任务恢复'],
  ['network', 'Tests must disable outbound network calls.', 'disable network in tests'],
  ['permissions', '审查成员只读，不得修改业务代码或者推送远程。', '审查成员修改代码权限'],
  ['encoding', 'ConPTY preserves UTF-8 Chinese input and ANSI colors.', 'Chinese UTF-8 input'],
  [
    'outbox',
    'report_outbox receipt_id survives restart; reconcile unknown deliveries.',
    'report_outbox receipt restart',
  ],
  ['tasks', '任务文件并发编辑冲突时保留本地草稿，人工合并后重试。', '并发编辑冲突草稿合并'],
  [
    'timeouts',
    'dispatch timeouts need progress receipts before automatic retries.',
    'dispatch progress timeout',
  ],
  ['secrets', '备份必须去除结构化凭据，手机设备需要重新配对。', '备份凭据设备配对'],
  [
    'resize',
    'Responsive layout uses container width rather than window breakpoints.',
    'container width layout',
  ],
  ['review', '验收必须绑定报告版本、测试证据和代码审查。', '报告版本代码审查验收'],
] as const
