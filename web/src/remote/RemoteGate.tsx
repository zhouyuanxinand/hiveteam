import { useCallback, useEffect, useRef, useState } from 'react'

import type { PairingProgress, RemoteClient } from './remote-client.js'

type RemoteGateProps = {
  client: RemoteClient
  onConnected: () => Promise<void>
}

type GatePhase = 'checking' | 'login-required' | 'pair' | 'pairing' | 'connecting'

const progressMessage = (progress: PairingProgress | null) => {
  if (!progress) return null
  if (progress.stage === 'connecting') return '正在连接配对通道…'
  if (progress.stage === 'awaiting-confirmation')
    return '请在电脑 Hive 中核对并确认下面的 SAS 短码。'
  return '设备已确认，正在打开 Hive…'
}

export const RemoteGate = ({ client, onConnected }: RemoteGateProps) => {
  const [phase, setPhase] = useState<GatePhase>('checking')
  const [pairingText, setPairingText] = useState('')
  const [deviceName, setDeviceName] = useState('Hive mobile')
  const [progress, setProgress] = useState<PairingProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const launchStarted = useRef(false)

  const connect = useCallback(async () => {
    if (launchStarted.current) return
    launchStarted.current = true
    try {
      await client.connect()
      await onConnected()
    } catch (connectionError) {
      launchStarted.current = false
      setPhase('pair')
      setError(connectionError instanceof Error ? connectionError.message : '无法连接 Hive。')
    }
  }, [client, onConnected])

  useEffect(() => {
    let cancelled = false
    void fetch('/api/me', { credentials: 'same-origin' })
      .then((response) => {
        if (cancelled) return
        if (!response.ok) {
          setPhase(response.status === 401 ? 'login-required' : 'pair')
          if (response.status !== 401) setError('网关暂时不可用，请稍后刷新。')
          return
        }
        if (client.hasStoredDevice) {
          setPhase('connecting')
          void connect()
        } else {
          setPhase('pair')
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPhase('login-required')
          setError('无法连接自建网关，请确认地址和 HTTPS/WSS 配置。')
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, connect])

  const submitPairing = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (launchStarted.current || !pairingText.trim()) return
    setError(null)
    setProgress({ stage: 'connecting' })
    setPhase('pairing')
    try {
      await client.pair(pairingText, deviceName, setProgress)
      await connect()
    } catch (pairingError) {
      setPhase('pair')
      setProgress(null)
      setError(pairingError instanceof Error ? pairingError.message : '配对失败，请重试。')
    }
  }

  const clearDevice = () => {
    client.clearStoredDevice()
    launchStarted.current = false
    setProgress(null)
    setError(null)
    setPhase('pair')
  }

  return (
    <main className="remote-gate-page">
      <div className="remote-gate-wrap">
        <div className="remote-gate-brand">
          <span className="remote-gate-brand-mark" aria-hidden>
            H
          </span>
          <span>Hive Remote</span>
        </div>

        <section className="remote-gate-card">
          {phase === 'login-required' ? (
            <>
              <p className="remote-gate-eyebrow">Self-hosted gateway</p>
              <h1 className="remote-gate-title">先登录自建网关</h1>
              <p className="remote-gate-copy">
                手机页面需要网关登录会话，登录后才能建立配对通道。网关不会读取 Workspace
                内容，数据仍由电脑上的 Hive 提供。
              </p>
              {error ? <div className="remote-gate-error">{error}</div> : null}
              <a className="remote-gate-link" href="/">
                返回网关登录页 →
              </a>
            </>
          ) : phase === 'checking' || phase === 'connecting' ? (
            <>
              <p className="remote-gate-eyebrow">Secure connection</p>
              <h1 className="remote-gate-title">正在连接 Hive…</h1>
              <div className="remote-gate-status">
                正在通过加密设备通道连接电脑。首次连接需要在电脑 Hive 中确认设备。
              </div>
              {error ? <div className="remote-gate-error">{error}</div> : null}
              {client.hasStoredDevice ? (
                <div className="remote-gate-actions">
                  <button
                    className="remote-gate-button remote-gate-button--danger"
                    type="button"
                    onClick={clearDevice}
                  >
                    清除旧设备
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <p className="remote-gate-eyebrow">Secure pairing</p>
              <h1 className="remote-gate-title">连接你的 Hive 电脑</h1>
              <p className="remote-gate-copy">
                配对完成后，手机会加载完整 Hive 界面，可以切换 Workspace、查看
                Team/Tasks，并打开成员终端。
              </p>

              <ol className="remote-gate-steps">
                <li className="remote-gate-step">在电脑 Hive 的“远程访问”面板中点击“配对手机”。</li>
                <li className="remote-gate-step">
                  点击“复制配对数据”，把复制的两行内容粘贴到这里。
                </li>
                <li className="remote-gate-step">
                  对比手机和电脑显示的 SAS 短码，只在一致时确认。
                </li>
              </ol>

              <form onSubmit={(event) => void submitPairing(event)}>
                <label className="remote-gate-field">
                  <span className="remote-gate-label">配对数据</span>
                  <textarea
                    className="remote-gate-textarea"
                    value={pairingText}
                    onChange={(event) => setPairingText(event.target.value)}
                    placeholder={
                      '粘贴桌面端“复制配对数据”的结果\n配对码\n{ "v": 2, "gatewayUrl": "…" }'
                    }
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    disabled={phase === 'pairing'}
                  />
                </label>
                <label className="remote-gate-field">
                  <span className="remote-gate-label">设备名称（可选）</span>
                  <input
                    className="remote-gate-input"
                    value={deviceName}
                    onChange={(event) => setDeviceName(event.target.value)}
                    maxLength={80}
                    disabled={phase === 'pairing'}
                  />
                </label>

                {phase === 'pairing' && progress ? (
                  <div className="remote-gate-status">
                    {progressMessage(progress)}
                    {progress.stage === 'awaiting-confirmation' ? (
                      <strong className="remote-gate-sas">{progress.sas}</strong>
                    ) : null}
                  </div>
                ) : null}
                {error ? <div className="remote-gate-error">{error}</div> : null}

                <div className="remote-gate-actions">
                  <button
                    className="remote-gate-button remote-gate-button--primary"
                    type="submit"
                    disabled={phase === 'pairing' || !pairingText.trim()}
                  >
                    {phase === 'pairing' ? '等待电脑确认…' : '开始配对'}
                  </button>
                  {client.hasStoredDevice ? (
                    <button
                      className="remote-gate-button remote-gate-button--danger"
                      type="button"
                      onClick={clearDevice}
                    >
                      清除设备
                    </button>
                  ) : null}
                </div>
              </form>
            </>
          )}
        </section>
        <p className="remote-gate-footnote">
          本页面只负责配对和建立加密中继，Agent、终端与项目文件保留在你的电脑上。
        </p>
      </div>
    </main>
  )
}
