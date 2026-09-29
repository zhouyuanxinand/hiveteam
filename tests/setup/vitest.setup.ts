import '@testing-library/jest-dom/vitest'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, vi } from 'vitest'

const testDataParent = resolve(tmpdir())
const testDataRoot = mkdtempSync(join(testDataParent, 'hive-test-data-'))
// Temporary workspaces without their own repository must never discover a
// developer's ancestor repository when runtime snapshotting invokes Git.
process.env.GIT_CEILING_DIRECTORIES = [testDataParent, process.env.GIT_CEILING_DIRECTORIES]
  .filter(Boolean)
  .join(delimiter)
// Setup runs before test modules, including CLI modules that resolve runtime
// data during import. A test that clears this variable must not expose the next
// test to the user's normal runtime directory.
process.env.HIVE_DATA_DIR = testDataRoot
beforeEach(() => {
  process.env.HIVE_DATA_DIR = mkdtempSync(join(testDataRoot, 'case-'))
})
afterAll(() => {
  // The runner removes its entire root after the Vitest child closes. Direct
  // Vitest invocations still get isolated data and own just this suite directory.
  if (process.env.HIVE_TEST_RUN_ROOT) return
  if (dirname(resolve(testDataRoot)) !== testDataParent) {
    throw new Error('Unexpected test data directory')
  }
  rmSync(testDataRoot, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 })
})

// Model the trusted launcher in tests; no server auth path is mocked or weakened.
vi.mock('../../src/server/app.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/server/app.js')>()
  const { registerUiLauncher } = await import('../helpers/ui-session.js')
  return {
    ...original,
    createApp: (...args: Parameters<typeof original.createApp>) => {
      const app = original.createApp(...args)
      registerUiLauncher(app.server, app.store)
      return app
    },
  }
})

// Unrelated HTTP/PTY suites isolate default provisioning from GitHub and disk
// installation. The workspace-default-skill-pack suites unmock this seam and
// exercise the real HTTP -> SQLite -> cache -> filesystem -> PTY flow.
vi.mock('../../src/server/default-workspace-skill-pack.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/server/default-workspace-skill-pack.js')>()),
  prepareDefaultWorkspaceSkillPacks: async () => async () => {},
}))

// Node 25 ships an experimental localStorage that overrides jsdom's implementation
// but lacks standard methods (setItem, getItem, clear, removeItem). Polyfill when needed.
if (typeof window !== 'undefined' && typeof window.localStorage?.setItem !== 'function') {
  const store: Record<string, string> = {}
  Object.defineProperty(window, 'localStorage', {
    writable: true,
    configurable: true,
    value: {
      getItem: (key: string) => (Object.hasOwn(store, key) ? store[key] : null),
      setItem: (key: string, value: string) => {
        store[key] = String(value)
      },
      removeItem: (key: string) => {
        delete store[key]
      },
      clear: () => {
        for (const k of Object.keys(store)) delete store[k]
      },
      get length() {
        return Object.keys(store).length
      },
      key: (idx: number) => Object.keys(store)[idx] ?? null,
    },
  })
}

if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        addEventListener: () => {},
        addListener: () => {},
        dispatchEvent: () => false,
        matches: false,
        media: query,
        onchange: null,
        removeEventListener: () => {},
        removeListener: () => {},
      }) as MediaQueryList,
  })
}

const createCanvasContext = (canvas: HTMLCanvasElement): CanvasRenderingContext2D =>
  ({
    canvas,
    clearRect: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    fillRect: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
    measureText: () => ({ width: 0 }),
  }) as unknown as CanvasRenderingContext2D

if (typeof HTMLCanvasElement !== 'undefined') {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value(this: HTMLCanvasElement, contextId: string) {
      return contextId === '2d' ? createCanvasContext(this) : null
    },
  })
}

afterEach(() => {
  if (typeof document === 'undefined') return

  document.body.removeAttribute('data-scroll-locked')
  document.body.style.pointerEvents = ''
  document.querySelectorAll('[data-radix-focus-guard]').forEach((node) => {
    node.parentNode?.removeChild(node)
  })
})
