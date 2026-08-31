import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  discoverWorkspaceDocuments,
  formatWorkspaceDocumentContext,
} from '../../src/shared/workspace-documents.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

describe('workspace document discovery', () => {
  test('finds supported documents without requiring source code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hive-documents-'))
    temporaryDirectories.push(root)
    await mkdir(join(root, '.hive'))
    await writeFile(join(root, '需求说明.docx'), 'docx placeholder')
    await writeFile(join(root, 'notes.md'), '# notes')
    await writeFile(join(root, '.hive', 'internal.md'), 'do not expose')
    await writeFile(join(root, 'ignored.bin'), 'binary')

    const documents = await discoverWorkspaceDocuments(root)

    expect(documents.map((document) => document.relative_path)).toEqual([
      'notes.md',
      '需求说明.docx',
    ])
    expect(documents.find((document) => document.extension === '.docx')?.kind).toBe('document')
  })

  test('formats paths as untrusted reference context for code generation', () => {
    const context = formatWorkspaceDocumentContext(
      [
        {
          extension: '.docx',
          kind: 'document',
          name: 'requirements.docx',
          path: 'D:\\桌面\\AI test\\requirements.docx',
          relative_path: 'requirements.docx',
          size: 10,
        },
      ],
      'zh'
    )

    expect(context).toContain('<hive-workspace-documents>')
    expect(context).toContain('先读取与任务相关的文档')
    expect(context).toContain('不受信任的项目资料')
    expect(context).toContain('D:\\桌面\\AI test\\requirements.docx')
    expect(context).toContain('</hive-workspace-documents>')
  })
})
