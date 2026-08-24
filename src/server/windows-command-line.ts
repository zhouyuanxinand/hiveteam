const CMD_META_CHARS = /[\s"&<>|^()%]/u

export const escapeCmdToken = (value: string) => {
  if (value.length === 0) return '""'
  const escaped = value.replace(/%/g, '%%').replace(/"/g, '""')
  return CMD_META_CHARS.test(value) ? `"${escaped}"` : escaped
}

export const buildCmdCommand = (command: string, args: readonly string[] = []) =>
  [command, ...args].map(escapeCmdToken).join(' ')

export const buildCmdCallCommand = (command: string, args: readonly string[] = []) =>
  `call ${buildCmdCommand(command, args)}`
