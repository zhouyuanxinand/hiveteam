import type { ExecFileOptions } from 'node:child_process'

export function npmCommand<Options extends ExecFileOptions>(
  args: string[],
  options?: Options
): {
  file: string
  args: string[]
  options: Options & { env: NodeJS.ProcessEnv; windowsHide: true }
}
