import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { SkillSourceScope } from '../shared/skill-packs.js'

export interface SkillRootDescriptor {
  adapterId: string
  id: string
  label: string
  path: string
  scope: SkillSourceScope
  verified: boolean
}

interface ResolveSkillRootsInput {
  homePath?: string
  presetId: string | null
  workspacePath: string
}

interface RootTemplate {
  label: string
  relativePath: string
  scope: 'workspace' | 'user'
}

const PRESET_ROOTS: Record<string, { roots: RootTemplate[]; verified: boolean }> = {
  claude: {
    roots: [
      { label: 'Workspace Claude Skills', relativePath: '.claude/skills', scope: 'workspace' },
      { label: 'User Claude Skills', relativePath: '.claude/skills', scope: 'user' },
    ],
    verified: true,
  },
  gemini: {
    roots: [
      { label: 'Workspace Gemini Skills', relativePath: '.gemini/skills', scope: 'workspace' },
      { label: 'User Gemini Skills', relativePath: '.gemini/skills', scope: 'user' },
    ],
    verified: false,
  },
  kimi: {
    roots: [
      { label: 'Workspace Kimi Skills', relativePath: '.kimi/skills', scope: 'workspace' },
      { label: 'User Kimi Skills', relativePath: '.kimi/skills', scope: 'user' },
    ],
    verified: false,
  },
  opencode: {
    roots: [
      { label: 'Workspace OpenCode Skills', relativePath: '.opencode/skills', scope: 'workspace' },
      {
        label: 'User OpenCode Skills',
        relativePath: '.config/opencode/skills',
        scope: 'user',
      },
    ],
    verified: false,
  },
  pi: {
    roots: [
      { label: 'Workspace Pi Skills', relativePath: '.pi/skills', scope: 'workspace' },
      { label: 'User Pi Skills', relativePath: '.pi/agent/skills', scope: 'user' },
    ],
    verified: false,
  },
  qwen: {
    roots: [
      { label: 'Workspace Qwen Skills', relativePath: '.qwen/skills', scope: 'workspace' },
      { label: 'User Qwen Skills', relativePath: '.qwen/skills', scope: 'user' },
    ],
    verified: false,
  },
  zcode: {
    roots: [
      { label: 'Workspace Zcode Skills', relativePath: '.zcode/skills', scope: 'workspace' },
      { label: 'User Zcode Skills', relativePath: '.zcode/skills', scope: 'user' },
    ],
    verified: false,
  },
}

const workspaceAncestorsToRepositoryRoot = (workspacePath: string): string[] => {
  const paths: string[] = []
  let cursor = resolve(workspacePath)
  for (let depth = 0; depth < 32; depth += 1) {
    paths.push(cursor)
    if (existsSync(join(cursor, '.git'))) break
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return paths
}

const pathKey = (value: string) =>
  process.platform === 'win32' ? resolve(value).toLocaleLowerCase('en-US') : resolve(value)

export const resolveSkillRootDescriptors = ({
  homePath = homedir(),
  presetId,
  workspacePath,
}: ResolveSkillRootsInput): SkillRootDescriptor[] => {
  const roots: Array<Omit<SkillRootDescriptor, 'id'>> = []
  const resolvedWorkspace = resolve(workspacePath)
  const resolvedHome = resolve(homePath)

  if (presetId === 'codex') {
    for (const [index, ancestor] of workspaceAncestorsToRepositoryRoot(
      resolvedWorkspace
    ).entries()) {
      roots.push({
        adapterId: 'codex-native',
        label: index === 0 ? 'Workspace Agent Skills' : 'Repository Agent Skills',
        path: join(ancestor, '.agents', 'skills'),
        scope: 'workspace',
        verified: true,
      })
    }
    roots.push(
      {
        adapterId: 'codex-native',
        label: 'User Agent Skills',
        path: join(resolvedHome, '.agents', 'skills'),
        scope: 'user',
        verified: true,
      },
      {
        adapterId: 'codex-native',
        label: 'User Codex Skills',
        path: join(resolvedHome, '.codex', 'skills'),
        scope: 'user',
        verified: true,
      }
    )
  } else {
    const preset = presetId ? PRESET_ROOTS[presetId] : undefined
    for (const template of preset?.roots ?? []) {
      roots.push({
        adapterId: `${presetId}-native`,
        label: template.label,
        path: join(
          template.scope === 'workspace' ? resolvedWorkspace : resolvedHome,
          template.relativePath
        ),
        scope: template.scope,
        verified: preset?.verified ?? false,
      })
    }
    // The universal Skills convention is useful evidence for custom and
    // unverified hosts, but it does not claim that the host loads the path.
    roots.push(
      {
        adapterId: 'universal-observer',
        label: 'Workspace Agent Skills',
        path: join(resolvedWorkspace, '.agents', 'skills'),
        scope: 'workspace',
        verified: false,
      },
      {
        adapterId: 'universal-observer',
        label: 'User Agent Skills',
        path: join(resolvedHome, '.agents', 'skills'),
        scope: 'user',
        verified: false,
      }
    )
  }

  const seen = new Set<string>()
  return roots
    .filter((root) => {
      const key = `${root.adapterId}:${pathKey(root.path)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((root, index) => ({ ...root, id: `${root.adapterId}:${root.scope}:${index}` }))
}
