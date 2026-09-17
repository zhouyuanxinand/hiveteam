import { useI18n } from '../i18n.js'

const en = {
  conversation: 'Conversation',
  terminal: 'Terminal / input',
  loading: 'Loading conversation…',
  pending: 'Waiting for the native session record. The terminal remains available.',
  error: 'Conversation could not be loaded. Retry or use the terminal.',
  retry: 'Retry',
  process: 'Process',
  running: 'In progress',
  complete: 'Answered',
  interrupted: 'Interrupted',
  note: 'Messages and tool names only. Full tool output is retained in the terminal.',
  truncated: 'Showing recent conversation. Open the terminal for more history.',
}
const zh: typeof en = {
  conversation: '对话',
  terminal: '终端 / 输入',
  loading: '正在载入对话…',
  pending: '正在等待原生会话记录，可继续使用终端。',
  error: '暂时无法载入对话，请重试或切换到终端。',
  retry: '重试',
  process: '过程记录',
  running: '进行中',
  complete: '已回答',
  interrupted: '已中断',
  note: '这里展示过程说明和工具名称，完整工具输出保留在终端中。',
  truncated: '当前展示近期对话，更多历史请查看终端。',
}
export const useConversationCopy = () => (useI18n().language === 'zh' ? zh : en)
