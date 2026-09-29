import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'
import { createTasksFileWatcher } from '../../src/server/tasks-file-watcher.js'

const runChild = promisify(execFile)
const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}hive-watch-lifecycle-`))
      throw new Error('Unexpected watcher fixture cleanup path')
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), 'hive-watch-lifecycle-'))
  directories.push(path)
  return path
}

test('concurrent starts deliver real file updates and release every watcher before the child exits', async () => {
  const root = await directory()
  const source = new URL('../../src/server/tasks-file-watcher.ts', import.meta.url).href
  const script = `
    import { writeFile } from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    import { createTasksFileWatcher } from ${JSON.stringify(source)};
    const updates = [];
    const watcher = createTasksFileWatcher({onTasksUpdated: (id, content) => updates.push({id, content})});
    try {
      await Promise.all([watcher.start('workspace', ${JSON.stringify(root)}), watcher.start('workspace', ${JSON.stringify(root)})]);
      await writeFile(${JSON.stringify(join(root, '.hive', 'tasks.md'))}, 'written after both starts');
      const deadline = Date.now() + 3000;
      while (!updates.some(entry => entry.content === 'written after both starts')) {
        if (Date.now() > deadline) throw new Error('No real file update arrived');
        await delay(25);
      }
    } finally {
      await watcher.close();
    }
    console.log(JSON.stringify(updates));
  `
  const result = await runChild(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      cwd: dirname(fileURLToPath(new URL('../../package.json', import.meta.url))),
      timeout: 8000,
      windowsHide: true,
    }
  )
  expect(JSON.parse(result.stdout.trim())).toContainEqual({
    id: 'workspace',
    content: 'written after both starts',
  })
}, 15000)

test('stop and close wait for queued starts across workspaces and detach file events', async () => {
  const first = await directory()
  const second = await directory()
  const updates: Array<{ id: string; content: string }> = []
  const watcher = createTasksFileWatcher({
    onTasksUpdated: (id, content) => updates.push({ id, content }),
  })
  try {
    await Promise.all([
      watcher.start('first', first),
      watcher.stop('first'),
      watcher.start('first', first),
      watcher.start('second', second),
    ])
    await Promise.all([
      writeFile(join(first, '.hive', 'tasks.md'), 'first content'),
      writeFile(join(second, '.hive', 'tasks.md'), 'second content'),
    ])
    await expect
      .poll(() => updates)
      .toEqual(
        expect.arrayContaining([
          { id: 'first', content: 'first content' },
          { id: 'second', content: 'second content' },
        ])
      )
    const stop = watcher.stop('first')
    const restart = watcher.start('second', second)
    await watcher.close()
    await Promise.all([stop, restart])
    const finalUpdates = [...updates]
    await writeFile(join(second, '.hive', 'tasks.md'), 'after close')
    await new Promise((done) => setTimeout(done, 200))
    expect(updates).toEqual(finalUpdates)
    expect(await readFile(join(second, '.hive', 'tasks.md'), 'utf8')).toBe('after close')
  } finally {
    await watcher.close()
  }
}, 15000)
