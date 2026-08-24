import { basename } from 'node:path'

const getEnvValue = (env: NodeJS.ProcessEnv, key: string, platform = process.platform) => {
  if (platform !== 'win32') return env[key]
  if (Object.hasOwn(env, key)) return env[key]
  const matchedKey = Object.keys(env)
    .filter((item) => item.toLowerCase() === key.toLowerCase())
    .at(-1)
  return matchedKey ? env[matchedKey] : undefined
}

const createPosixShellArgs = (shell: string, command: string) => {
  const shellName = basename(shell).toLowerCase()
  if (shellName.includes('bash') || shellName.includes('zsh') || shellName.includes('ksh')) {
    return ['-lic', command]
  }
  if (shellName.includes('fish')) return ['-ic', command]
  return ['-ic', command]
}

export const createStartupCommandLaunch = (
  startupCommand: string,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform
) => {
  const command = startupCommand.trim()
  if (platform === 'win32') {
    return {
      args: ['/d', '/s', '/c', command],
      command: getEnvValue(env, 'ComSpec', platform) ?? 'cmd.exe',
    }
  }

  const shell = env.SHELL || '/bin/sh'
  return {
    args: createPosixShellArgs(shell, command),
    command: shell,
  }
}

export const getStartupCommandExecutable = (startupCommand: string) => {
  const command = startupCommand.trim()
  if (!command) return null
  const match = /^"([^"]+)"|^'([^']+)'|^([^\s'"]+)/.exec(command)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null
}

export const normalizeExecutableToken = (token: string | null | undefined) => {
  if (!token) return null
  const lastSegment = token.replace(/^.*[\\/]/, '')
  if (!lastSegment) return null
  return lastSegment.toLowerCase().replace(/\.(cmd|bat|exe|ps1)$/u, '')
}
