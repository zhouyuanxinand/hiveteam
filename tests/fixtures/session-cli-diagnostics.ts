import type { SessionCliDiagnostic } from '../../src/shared/session-adapter.js'

// Synthetic offline transcripts exercise syntax detection. These are not
// captured vendor releases and cannot certify any native session behavior.
export const cursorDiagnostic: SessionCliDiagnostic = {
  command: 'agent',
  platform: 'win32',
  version: { exit_code: 0, stdout: 'Cursor Agent 0.0.0-fixture\n', stderr: '' },
  help: {
    exit_code: 0,
    stdout:
      'Usage: agent [options] [command]\nOptions:\n  --resume [chatId]  Select a chat\nCommands:\n  create-chat  Create an empty chat\n',
    stderr: '',
  },
}

export const grokDiagnostic: SessionCliDiagnostic = {
  command: 'grok',
  platform: 'linux',
  version: { exit_code: 0, stdout: 'grok 0.0.0-fixture\n', stderr: '' },
  help: {
    exit_code: 0,
    stdout:
      'Usage: grok [options] [command]\nOptions:\n  -s, --session-id <UUID>  Name a new session\n  -r, --resume [ID]  Select an existing session\n  --output-format <format>  Output format\nCommands:\n  sessions  List sessions\n  version  Show version\n',
    stderr: '',
  },
}
