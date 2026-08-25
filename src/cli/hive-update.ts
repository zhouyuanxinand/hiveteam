import { PROJECT_REPOSITORY_URL } from '../server/package-version.js'

export const HIVE_UPDATE_USAGE = [
  'Usage:',
  '  hive update',
  '',
  'Automatic updates are disabled in this self-hosted build.',
  `Pull source changes from ${PROJECT_REPOSITORY_URL} and rebuild locally.`,
  '',
  'This command never contacts npm or the original Hive release channel.',
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

  console.log('Automatic updates are disabled in this self-hosted build.')
  console.log(`Pull source changes from ${PROJECT_REPOSITORY_URL} and rebuild locally.`)
  return 0
}
