import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, vi } from 'vitest'
import { readWorkspaceSkillFiles } from '../../src/server/skill-pack-config.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

vi.unmock('../../src/server/default-workspace-skill-pack.js')

test.runIf(process.env.HIVE_REAL_MATT_SMOKE === '1')(
  'new workspaces automatically bind the real Matt GitHub repository through cold and warm caches',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-default-matt-real-'))
    const server = await startTestServer({ dataDir: join(root, 'data') })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const releaseIds: string[] = []
      for (const name of ['cold 中文', 'warm 中文']) {
        const path = join(root, name)
        mkdirSync(path)
        const before = Date.now()
        const response = await fetch(`${server.baseUrl}/api/workspaces`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ path, name, autostart_orchestrator: false }),
        })
        if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
        const workspace = (await response.json()) as { id: string }
        const files = await readWorkspaceSkillFiles(path)
        const pack = files.lock.packs[0]
        expect(pack?.name).toBe('matt')
        expect(pack?.resolvedRevision).toMatch(/^[a-f0-9]{40}$/u)
        expect(pack?.skills.map((skill) => skill.name)).toContain('to-goal')
        expect(files.configuration.profiles.orchestrator).toContain('matt/to-goal')
        expect(
          readFileSync(join(path, '.agents', 'skills', 'to-goal', 'SKILL.md'), 'utf8')
        ).toContain('to-goal')
        const catalog = await server.store.skills.listForAgent(
          workspace.id,
          `${workspace.id}:orchestrator`
        )
        expect(catalog.map((skill) => skill.qualifiedName)).toContain('matt/to-goal')
        if (!pack) throw new Error('Default Pack missing')
        releaseIds.push(pack.releaseId)
        console.info(
          JSON.stringify({
            cache: name,
            elapsed_ms: Date.now() - before,
            revision: pack.resolvedRevision,
            skills: pack.skills.length,
          })
        )
      }
      expect(releaseIds[0]).toBe(releaseIds[1])
    } finally {
      await server.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  180_000
)
