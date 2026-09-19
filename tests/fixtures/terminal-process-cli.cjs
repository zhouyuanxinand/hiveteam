process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)

const transcript = [
  '› 帮我安排一个成员分析技术文档',
  '',
  '• 我先查看当前可用的成员，再继续分析文档。',
  '',
  '• Ran Get-ChildItem -Force',
  '  └ Directory: D:\\项目\\技术文档',
  '    requirements.docx',
  '',
  '• 已找到文档，正在确认成员的工作状态。',
  '',
  '• Ran hive --help',
  '  └ Usage: hive [options]',
  '    --port <port>',
  '',
  '› ',
].join('\r\n')
process.stdout.write(transcript)
let input = ''
process.stdin.on('data', (chunk) => {
  if (chunk === '\x03') process.exit(0)
  for (const character of chunk) {
    if (character === '\r') {
      process.stdout.write(`\r\n• 收到：${input}\r\n› `)
      input = ''
    } else {
      input += character
      process.stdout.write(character)
    }
  }
})
