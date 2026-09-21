import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, vi } from 'vitest'
import { readWorkspaceSkillFiles } from '../../src/server/skill-pack-config.js'
import { startAuthorizedTestServer as startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

vi.unmock('../../src/server/default-workspace-skill-pack.js')

test.runIf(process.env.HIVE_REAL_DEFAULT_PACKS_SMOKE === '1')(
  'new workspaces automatically bind the real Matt and Janitor repositories through cold and warm caches',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-default-packs-real-'))
    const server = await startTestServer({ dataDir: join(root, 'data') })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const releaseIds: string[][] = []
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
        const pack = files.lock.packs.find((entry) => entry.name === 'matt')
        const janitor = files.lock.packs.find((entry) => entry.name === 'code-janitor')
        expect(files.lock.packs).toHaveLength(2)
        expect(pack?.name).toBe('matt')
        expect(pack?.resolvedRevision).toMatch(/^[a-f0-9]{40}$/u)
        expect(pack?.skills.map((skill) => skill.name)).toContain('to-goal')
        expect(files.configuration.profiles.orchestrator).toContain('matt/to-goal')
        expect(janitor?.resolvedRevision).toMatch(/^[a-f0-9]{40}$/u)
        expect(janitor?.sourceUri).toBe('https://github.com/zhouyuanxinand/code-janitor.git')
        expect(janitor?.skills).toMatchObject([{ name: 'code-janitor', relativePath: '.' }])
        for (const role of ['orchestrator', 'coder', 'reviewer', 'tester'] as const) {
          expect(files.configuration.profiles[role]).toContain('code-janitor/code-janitor')
        }
        expect(
          readFileSync(join(path, '.agents', 'skills', 'to-goal', 'SKILL.md'), 'utf8')
        ).toContain('to-goal')
        const janitorInstructions = readFileSync(
          join(path, '.agents', 'skills', 'code-janitor', 'SKILL.md'),
          'utf8'
        )
        expect(janitorInstructions).toContain('name: code-janitor')
        expect(
          readFileSync(
            join(path, '.agents', 'skills', 'code-janitor', 'references', 'investigation.md'),
            'utf8'
          ).length
        ).toBeGreaterThan(0)
        const catalog = await server.store.skills.listForAgent(
          workspace.id,
          `${workspace.id}:orchestrator`
        )
        expect(catalog.map((skill) => skill.qualifiedName)).toEqual(
          expect.arrayContaining(['matt/to-goal', 'code-janitor/code-janitor'])
        )
        const loaded = await server.store.skills.loadForAgent({
          workspaceId: workspace.id,
          agentId: `${workspace.id}:orchestrator`,
          skillName: 'code-janitor/code-janitor',
        })
        expect(loaded.instructionSnapshot).toBe(janitorInstructions)
        if (!pack || !janitor) throw new Error('Default Pack missing')
        expect(loaded.releaseId).toBe(janitor.releaseId)
        releaseIds.push([pack.releaseId, janitor.releaseId])
        console.info(
          JSON.stringify({
            cache: name,
            elapsed_ms: Date.now() - before,
            packs: files.lock.packs.map((entry) => ({
              name: entry.name,
              revision: entry.resolvedRevision,
              skills: entry.skills.length,
            })),
          })
        )
      }
      expect(releaseIds[0]).toEqual(releaseIds[1])
    } finally {
      await server.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  180_000
)
