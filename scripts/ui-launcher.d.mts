import type { ChildProcess } from 'node:child_process'

export const requestUiBootstrap: (child: ChildProcess) => Promise<string>
export const createUiLaunchUrl: (child: ChildProcess, origin: string) => Promise<string>
export const openUiBrowser: (url: string) => Promise<void>
