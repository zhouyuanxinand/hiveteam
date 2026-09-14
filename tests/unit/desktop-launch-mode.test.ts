import { EventEmitter } from 'node:events'

import { describe, expect, test, vi } from 'vitest'

import {
  bindDesktopCloseConfirmation,
  chooseLaunchMode,
  createDesktopCloseDialogOptions,
  parseConfiguredLaunchMode,
} from '../../desktop/launch-mode.mjs'

const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('desktop launch mode', () => {
  test('offers one localized interface and maps the Web choice', async () => {
    let shownOptions: Record<string, unknown> | undefined

    const mode = await chooseLaunchMode({
      configuredMode: undefined,
      locale: 'zh-CN',
      showMessageBox: async (options: Record<string, unknown>) => {
        shownOptions = options
        return { response: 1 }
      },
    })

    expect(mode).toBe('web')
    expect(shownOptions).toMatchObject({
      buttons: ['Electron 桌面客户端', 'Web 浏览器', '取消'],
      cancelId: 2,
      defaultId: 0,
      message: '请选择 HiveTeam 的打开方式',
    })
  })

  test('supports unattended mode selection and rejects ambiguous values', async () => {
    const showMessageBox = vi.fn()

    await expect(
      chooseLaunchMode({ configuredMode: ' DESKTOP ', locale: 'en', showMessageBox })
    ).resolves.toBe('desktop')
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(() => parseConfiguredLaunchMode('browser')).toThrow(
      'HIVE_DESKTOP_LAUNCH_MODE must be either "desktop" or "web"'
    )
  })

  test('treats cancel and an unknown response as no launch', async () => {
    await expect(
      chooseLaunchMode({
        configuredMode: undefined,
        locale: 'en-US',
        showMessageBox: async () => ({ response: 2 }),
      })
    ).resolves.toBeNull()
    await expect(
      chooseLaunchMode({
        configuredMode: undefined,
        locale: 'en-US',
        showMessageBox: async () => ({ response: 99 }),
      })
    ).resolves.toBeNull()
  })

  test('uses a safe default when confirming desktop exit', () => {
    expect(createDesktopCloseDialogOptions('en-US')).toMatchObject({
      buttons: ['Keep running', 'Exit HiveTeam'],
      cancelId: 0,
      defaultId: 0,
    })
  })

  test('serializes close attempts, re-arms after cancel, and closes after confirmation', async () => {
    const window = new EventEmitter()
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const close = vi.fn().mockResolvedValue(undefined)
    const onError = vi.fn()
    const firstEvent = { preventDefault: vi.fn() }
    const duplicateEvent = { preventDefault: vi.fn() }

    bindDesktopCloseConfirmation({ close, confirm, onError, window })
    window.emit('close', firstEvent)
    window.emit('close', duplicateEvent)
    await flushPromises()

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce()
    expect(duplicateEvent.preventDefault).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()

    const confirmedEvent = { preventDefault: vi.fn() }
    window.emit('close', confirmedEvent)
    await flushPromises()

    expect(confirmedEvent.preventDefault).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
  })
})
