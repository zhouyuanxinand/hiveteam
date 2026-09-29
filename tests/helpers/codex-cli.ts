import { writeNodeCli } from './platform-cli.js'

/** A standalone synthetic Codex executable, including its noninteractive help path. */
export const writeCodexCli = (directory: string, source: string): string =>
  writeNodeCli(
    directory,
    'codex',
    `if (process.argv[2] === '--help') {
  console.log('Codex CLI\\nUsage: codex [OPTIONS]\\n  --no-daemon  Run without a shared daemon')
  process.exit(0)
}
${source}`
  )
