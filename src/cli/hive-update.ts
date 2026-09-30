import { PROJECT_REPOSITORY_URL } from '../server/package-version.js'

const HIVE_UPDATE_GUIDANCE = [
  'To update a global npm installation, stop HiveTeam and run:',
  '  npm install -g hiveteam@latest',
  'Then restart HiveTeam:',
  '  hive',
  '',
  'If you start HiveTeam with npx, stop HiveTeam and run:',
  '  npx --yes hiveteam@latest',
  '',
  `For a source checkout, pull changes from ${PROJECT_REPOSITORY_URL} and rebuild locally:`,
  '  git pull',
  '  pnpm install --frozen-lockfile',
  '  pnpm build',
  '',
  'This command only prints instructions; it does not download or install updates.',
].join('\n')

export const HIVE_UPDATE_USAGE = [
  'Usage:',
  '  hive update',
  '',
  HIVE_UPDATE_GUIDANCE,
  '',
  'Options:',
  '  -h, --help      Print this help.',
].join('\n')

export const runHiveUpdateCommand = async (argv: string[]): Promise<number> => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HIVE_UPDATE_USAGE)
    return 0
  }

  // Reject unknown flags rather than silently ignoring them — keeps behavior
  // consistent with how `parsePort` validates `hive` itself.
  const extra = argv.find((arg) => arg !== '--help' && arg !== '-h')
  if (extra !== undefined) {
    console.error(`Unknown argument: ${extra}`)
    console.error(HIVE_UPDATE_USAGE)
    return 1
  }

  console.log(HIVE_UPDATE_GUIDANCE)
  return 0
}
