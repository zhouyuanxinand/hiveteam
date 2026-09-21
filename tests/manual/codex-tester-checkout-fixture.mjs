import { createInterface } from 'node:readline'
import { readExecutionFilesystem } from '../../dist/src/server/execution-filesystem.js'
import { createExecutionGitView } from '../../dist/src/server/execution-git-view.js'
import { createTesterCheckout } from '../../dist/src/server/execution-tester-checkout.js'

let current
for await (const line of createInterface({ input: process.stdin })) {
  const input = JSON.parse(line)
  if (input.operation === 'close') {
    await current?.close()
    current = undefined
    process.stdout.write(`${JSON.stringify({ closed: true })}\n`)
    continue
  }
  current = await createTesterCheckout({ sourcePath: input.sourcePath, rootPath: input.rootPath })
  const filesystem = await readExecutionFilesystem(current.checkoutRoot)
  const gitEnv = await createExecutionGitView({
    workspacePath: current.checkoutRoot,
    viewPath: input.gitViewPath,
    gitDirectory: filesystem.gitDirectory,
    commonDirectory: filesystem.commonDirectory,
  })
  process.stdout.write(`${JSON.stringify({ ...current, close: undefined, filesystem, gitEnv })}\n`)
}
await current?.close()
