// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { WorkspaceSkillPackDrawer } from '../../web/src/WorkspaceSkillPackDrawer.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const inspectionPayload = {
  conflicts: [
    {
      member_ids: ['workspace-1:orchestrator'],
      name: 'to-goal',
      paths: ['/workspace/.agents/skills/to-goal', '/home/.codex/skills/to-goal'],
    },
  ],
  members: [
    {
      agent_id: 'workspace-1:orchestrator',
      command_preset_id: 'codex',
      delivery_status: 'not_configured',
      error: null,
      name: 'Orchestrator',
      native_discovery_status: 'conflict',
      profile: 'orchestrator',
      restart_required: false,
      roots: [
        {
          adapter_id: 'codex-native',
          error: null,
          id: 'workspace-root',
          label: 'Workspace Agent Skills',
          path: '/workspace/.agents/skills',
          scope: 'workspace',
          status: 'found',
          verified: true,
        },
        {
          adapter_id: 'codex-native',
          error: null,
          id: 'user-root',
          label: 'User Codex Skills',
          path: '/home/.codex/skills',
          scope: 'user',
          status: 'found',
          verified: true,
        },
      ],
      scan_status: 'ready',
      skills: [
        {
          canonical_path: '/workspace/.agents/skills/to-goal',
          conflict: true,
          contains_scripts: false,
          description: 'Create a verifiable execution goal.',
          directory_name: 'to-goal',
          explicit_only: true,
          instruction_digest: `sha256:${'a'.repeat(64)}`,
          name: 'to-goal',
          root_ids: ['workspace-root'],
          source_scopes: ['workspace'],
          validation_errors: [],
        },
      ],
      status: 'idle',
    },
  ],
  scanned_at: 1_788_000_000_000,
  summary: {
    conflict_count: 1,
    effective_skill_count: 1,
    invalid_skill_count: 0,
    member_count: 1,
  },
  workspace_id: 'workspace-1',
}

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  })

const releasePayload = {
  cache_key: 'matt-cache-key',
  content_digest: `sha256:${'b'.repeat(64)}`,
  created_at: 1_788_000_000_100,
  id: 'release-1',
  manifest: {
    file_count: 1,
    skills: [
      {
        contains_scripts: true,
        content_digest: `sha256:${'c'.repeat(64)}`,
        description: 'Create a verifiable execution goal.',
        explicit_only: true,
        file_count: 1,
        instruction_digest: `sha256:${'d'.repeat(64)}`,
        name: 'to-goal',
        relative_path: 'skills/to-goal',
        script_paths: ['skills/to-goal/scripts/run.sh'],
        total_bytes: 128,
      },
    ],
    total_bytes: 128,
  },
  pack_name: 'matt',
  resolved_revision: 'a'.repeat(40),
  source: {
    ref: 'main',
    repository: 'tt-a1i/matt-skills-with-to-goal',
    type: 'github',
  },
  source_dirty: false,
  source_uri: 'https://github.com/tt-a1i/matt-skills-with-to-goal.git',
}

const operationPayload = {
  after_fingerprint: `sha256:${'e'.repeat(64)}`,
  before_fingerprint: `sha256:${'f'.repeat(64)}`,
  kind: 'write_config',
  path: '/workspace/.hive/skill-packs.json',
  skill_name: null,
}

const planPayload = {
  action: 'bind',
  before_fingerprint: `sha256:${'f'.repeat(64)}`,
  created_at: 1_788_000_000_200,
  expires_at: 1_788_003_600_200,
  id: 'plan-1',
  intent: {
    action: 'bind',
    native_exposure: ['to-goal'],
    pack_name: 'matt',
    profiles: {
      coder: [],
      custom: [],
      orchestrator: ['to-goal'],
      reviewer: [],
      tester: [],
    },
    release_id: 'release-1',
  },
  operations: [operationPayload],
  status: 'ready',
  workspace_id: 'workspace-1',
}

const appliedReceiptPayload = {
  completed_at: 1_788_000_000_400,
  error: null,
  id: 'receipt-1',
  operations: [operationPayload],
  plan_id: 'plan-1',
  started_at: 1_788_000_000_300,
  state: 'applied',
  undo_available: true,
  workspace_id: 'workspace-1',
}

const configuredInspectionPayload = {
  ...inspectionPayload,
  configuration: {
    native_exposure: ['matt/to-goal'],
    packs: [
      {
        enabled: true,
        name: 'matt',
        source: releasePayload.source,
      },
    ],
    profiles: {
      coder: [],
      custom: [],
      orchestrator: ['matt/to-goal'],
      reviewer: [],
      tester: [],
    },
    version: 1,
  },
  lock: {
    packs: [
      {
        cache_key: releasePayload.cache_key,
        content_digest: releasePayload.content_digest,
        name: 'matt',
        release_id: releasePayload.id,
        resolved_revision: releasePayload.resolved_revision,
        skills: [
          {
            contains_scripts: false,
            content_digest: releasePayload.manifest.skills[0]?.content_digest,
            explicit_only: true,
            instruction_digest: releasePayload.manifest.skills[0]?.instruction_digest,
            name: 'to-goal',
            relative_path: 'skills/to-goal',
          },
        ],
        source_type: 'github',
        source_uri: releasePayload.source_uri,
      },
    ],
    version: 1,
  },
  plans: [{ ...planPayload, status: 'applied' }],
  receipts: [appliedReceiptPayload],
}

describe('Workspace Skill Pack drawer', () => {
  test('separates delivery from native discovery and discloses effective Skill evidence', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(inspectionPayload)
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<WorkspaceSkillPackDrawer onClose={vi.fn()} open workspaceId="workspace-1" />)

    expect((await screen.findAllByText('Orchestrator')).length).toBeGreaterThan(0)
    expect(screen.getByText(/does not prove that the model followed it/u)).toBeInTheDocument()
    expect(screen.getByText('Not configured')).toBeInTheDocument()
    expect(screen.getAllByText('Conflict').length).toBeGreaterThan(0)
    expect(screen.getByText('1 conflicts')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Inspect'))

    expect(screen.getByText('$to-goal')).toBeInTheDocument()
    expect(screen.getByText('Create a verifiable execution goal.')).toBeInTheDocument()
    expect(screen.getByText('Explicit only')).toBeInTheDocument()
    expect(screen.getByText('/workspace/.agents/skills')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Packs' }))
    expect(screen.getByText('No Skill Pack is bound to this Workspace')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Rescan Skills' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' })
  })

  test('shows the active profile release provenance for each member', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(configuredInspectionPayload))
    )

    render(<WorkspaceSkillPackDrawer onClose={vi.fn()} open workspaceId="workspace-1" />)

    expect(await screen.findByText('Locked release')).toBeInTheDocument()
    expect(screen.getByText('matt@aaaaaaaaaaaa')).toBeInTheDocument()
  })

  test('resolves, plans, applies, and undoes a shared Skill Pack', async () => {
    let applied = false
    let undone = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/resolve')) return jsonResponse(releasePayload)
      if (url.endsWith('/plans')) return jsonResponse(planPayload)
      if (url.endsWith('/plans/plan-1/apply')) {
        applied = true
        return jsonResponse(appliedReceiptPayload)
      }
      if (url.endsWith('/receipts/receipt-1/undo')) {
        undone = true
        return jsonResponse({
          ...appliedReceiptPayload,
          completed_at: 1_788_000_000_500,
          state: 'rolled_back',
          undo_available: false,
        })
      }
      if (url.endsWith('/scan')) {
        if (undone) {
          return jsonResponse({
            ...inspectionPayload,
            plans: [{ ...planPayload, status: 'applied' }],
            receipts: [
              {
                ...appliedReceiptPayload,
                completed_at: 1_788_000_000_500,
                state: 'rolled_back',
                undo_available: false,
              },
            ],
          })
        }
        return jsonResponse(applied ? configuredInspectionPayload : inspectionPayload)
      }
      expect(init?.method).toBeUndefined()
      return jsonResponse(inspectionPayload)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <WorkspaceSkillPackDrawer
        initialTab="packs"
        onClose={vi.fn()}
        open
        workspaceId="workspace-1"
      />
    )

    await screen.findByText('No Skill Pack is bound to this Workspace')
    fireEvent.click(screen.getByRole('button', { name: 'Resolve release' }))

    expect(await screen.findByText('Resolved release')).toBeInTheDocument()
    expect(screen.getByText('1 Skills')).toBeInTheDocument()
    expect(screen.getByText('1 added')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Script inventory · 1'))
    expect(screen.getByText('skills/to-goal/scripts/run.sh')).toBeInTheDocument()
    expect(screen.getByText(/never executed by Hive/u)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))

    expect(await screen.findByText('Change Plan ready')).toBeInTheDocument()
    expect(screen.getByText('/workspace/.hive/skill-packs.json')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(screen.getByText('matt')).toBeInTheDocument())
    expect(screen.getByText('tt-a1i/matt-skills-with-to-goal@main')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }))
    expect(screen.getByText('Applied')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

    expect(await screen.findByText('Rolled back')).toBeInTheDocument()
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).endsWith('/plans/plan-1/apply'))
    ).toBe(true)
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).endsWith('/receipts/receipt-1/undo'))
    ).toBe(true)
  })

  test('drops removed Skills from hidden profile selections during an update', async () => {
    const legacySkill = {
      contains_scripts: false,
      content_digest: `sha256:${'1'.repeat(64)}`,
      explicit_only: false,
      instruction_digest: `sha256:${'2'.repeat(64)}`,
      name: 'legacy-skill',
      relative_path: 'skills/legacy-skill',
    }
    const updateInspection = {
      ...configuredInspectionPayload,
      configuration: {
        ...configuredInspectionPayload.configuration,
        native_exposure: ['matt/to-goal', 'matt/legacy-skill'],
        profiles: {
          ...configuredInspectionPayload.configuration.profiles,
          orchestrator: ['matt/to-goal', 'matt/legacy-skill'],
        },
      },
      lock: {
        ...configuredInspectionPayload.lock,
        packs: [
          {
            ...configuredInspectionPayload.lock.packs[0],
            skills: [...configuredInspectionPayload.lock.packs[0].skills, legacySkill],
          },
        ],
      },
    }
    const updateRelease = {
      ...releasePayload,
      content_digest: `sha256:${'3'.repeat(64)}`,
      id: 'release-2',
      resolved_revision: 'b'.repeat(40),
    }
    const updatePlan = {
      ...planPayload,
      action: 'update',
      id: 'plan-2',
      intent: { ...planPayload.intent, action: 'update', release_id: 'release-2' },
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/resolve')) return jsonResponse(updateRelease)
      if (url.endsWith('/plans')) return jsonResponse(updatePlan)
      return jsonResponse(updateInspection)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <WorkspaceSkillPackDrawer
        initialTab="packs"
        onClose={vi.fn()}
        open
        workspaceId="workspace-1"
      />
    )

    await screen.findByText('tt-a1i/matt-skills-with-to-goal@main')
    fireEvent.click(screen.getByRole('button', { name: 'Check updates' }))
    expect(await screen.findByText('1 removed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))
    await screen.findByText('Change Plan ready')

    const planCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/plans'))
    const requestBody = JSON.parse(String(planCall?.[1]?.body)) as {
      native_exposure: string[]
      profiles: { orchestrator: string[] }
    }
    expect(requestBody.profiles.orchestrator).toEqual(['to-goal'])
    expect(requestBody.native_exposure).toEqual(['to-goal'])
  })

  test('does not claim a Pack is locked when its lock entry is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ...configuredInspectionPayload,
          lock: { packs: [], version: 1 },
        })
      )
    )

    render(
      <WorkspaceSkillPackDrawer
        initialTab="packs"
        onClose={vi.fn()}
        open
        workspaceId="workspace-1"
      />
    )

    expect(await screen.findByText('Lock missing or mismatched')).toBeInTheDocument()
    expect(screen.queryByText('Locked')).not.toBeInTheDocument()
  })
})
