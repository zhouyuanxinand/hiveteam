import { useEffect, useId, useState } from 'react'
import type { VerificationProfile } from '../../../src/shared/verification-profile.js'
import { useI18n } from '../i18n.js'
import { isRemoteMode } from '../remote/remote-permissions-api.js'
import { saveVerificationProfile, verificationProfiles } from './verification-profile-api.js'
import './delivery-quality.css'

export const VerificationProfiles = ({
  workspaceId,
  selected,
  onSelect,
  disabled = false,
  requireProfile = false,
}: {
  workspaceId: string
  selected: VerificationProfile | null
  onSelect: (value: VerificationProfile | null) => void
  disabled?: boolean
  requireProfile?: boolean
}) => {
  const { language } = useI18n(),
    zh = language === 'zh',
    id = useId()
  const [profiles, setProfiles] = useState<VerificationProfile[]>([])
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [name, setName] = useState(''),
    [command, setCommand] = useState(''),
    [prepare, setPrepare] = useState('')
  const [seconds, setSeconds] = useState(900),
    [parallel, setParallel] = useState(1),
    [environment, setEnvironment] = useState('')
  const [unsafe, setUnsafe] = useState(false)
  useEffect(() => {
    let active = true
    void verificationProfiles(workspaceId).then(
      (data) => {
        if (active) setProfiles(data)
      },
      (cause) => {
        if (active) setError(String(cause))
      }
    )
    return () => {
      active = false
    }
  }, [workspaceId])
  const save = async (update: boolean) => {
    setBusy(true)
    setError('')
    try {
      const saved = await saveVerificationProfile(
        workspaceId,
        {
          name,
          command,
          prepare_commands: prepare.split('\n').filter((line) => line.trim()),
          timeout_ms: seconds * 1000,
          required_env: environment.split(/[\s,]+/u).filter(Boolean),
          max_parallel: parallel,
          execution: unsafe ? 'trusted_unsafe' : 'restricted',
          network: unsafe ? 'unrestricted' : 'none',
        },
        update ? selected?.id : undefined
      )
      onSelect(saved)
      setProfiles(await verificationProfiles(workspaceId))
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="delivery-quality" aria-label={zh ? '验证配置' : 'Verification profiles'}>
      <label htmlFor={`${id}-profile`}>{zh ? '验证配置' : 'Verification profile'}</label>
      <select
        id={`${id}-profile`}
        disabled={disabled || busy}
        value={selected?.id ?? ''}
        onChange={(event) => {
          const p = profiles.find((profile) => profile.id === event.target.value) ?? null
          onSelect(p)
          if (p) {
            setName(p.name)
            setCommand(p.command)
            setPrepare(p.prepare_commands.join('\n'))
            setSeconds(p.timeout_ms / 1000)
            setParallel(p.max_parallel)
            setEnvironment(p.required_env.join('\n'))
            setUnsafe(p.execution === 'trusted_unsafe')
          }
        }}
      >
        <option value="">
          {requireProfile
            ? zh
              ? '选择或新建验证配置'
              : 'Select or create a verification profile'
            : zh
              ? '临时本机命令（15 分钟，无网络隔离）'
              : 'One-time host command (15 minutes, unrestricted network)'}
        </option>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {selected ? (
        <p>
          {selected.timeout_ms / 1000}s · {zh ? '并发上限' : 'Concurrency'} {selected.max_parallel}{' '}
          ·{' '}
          {selected.execution === 'restricted'
            ? zh
              ? '受限环境 · 禁止网络'
              : 'Restricted · network off'
            : zh
              ? '本机权限 · 允许网络'
              : 'Host permissions · network allowed'}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {!isRemoteMode() ? (
        <details>
          <summary>{zh ? '管理验证配置' : 'Manage verification profiles'}</summary>
          <div className="delivery-quality-form">
            <label htmlFor={`${id}-name`}>{zh ? '名称' : 'Name'}</label>
            <input
              id={`${id}-name`}
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <label htmlFor={`${id}-prepare`}>
              {zh ? '准备命令（每行一条）' : 'Preparation commands (one per line)'}
            </label>
            <textarea
              id={`${id}-prepare`}
              value={prepare}
              onChange={(e) => setPrepare(e.target.value)}
              rows={2}
            />
            <label htmlFor={`${id}-command`}>{zh ? '验证命令' : 'Profile command'}</label>
            <textarea
              id={`${id}-command`}
              maxLength={2000}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              rows={2}
            />
            <label htmlFor={`${id}-timeout`}>{zh ? '超时（秒）' : 'Timeout (seconds)'}</label>
            <input
              id={`${id}-timeout`}
              type="number"
              min={1}
              max={86400}
              value={seconds}
              onChange={(e) => setSeconds(Number(e.target.value))}
            />
            <label htmlFor={`${id}-parallel`}>
              {zh
                ? '配置并发上限（仍受总配额限制）'
                : 'Profile concurrency (global limits also apply)'}
            </label>
            <input
              id={`${id}-parallel`}
              type="number"
              min={1}
              max={16}
              value={parallel}
              onChange={(e) => setParallel(Number(e.target.value))}
            />
            <label htmlFor={`${id}-env`}>
              {zh
                ? '所需环境变量名（不填写值）'
                : 'Required environment variable names (no values)'}
            </label>
            <textarea
              id={`${id}-env`}
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
              rows={2}
            />
            <label className="delivery-quality-check">
              <input
                type="checkbox"
                checked={unsafe}
                onChange={(e) => setUnsafe(e.target.checked)}
              />
              {zh
                ? '允许准备和验证命令使用本机账户权限及网络'
                : 'Allow preparation and verification to use host account permissions and network'}
            </label>
            <p>
              {zh
                ? '默认受限执行使用已验证的 Linux x64 沙箱；不支持时会拒绝执行。配置修改仅影响新验证。'
                : 'Restricted execution requires the verified Linux x64 sandbox. Unsupported environments are rejected. Edits apply to new runs.'}
            </p>
            <div className="delivery-quality-actions">
              <button
                type="button"
                className="icon-btn"
                disabled={busy || disabled || !name.trim() || !command.trim()}
                onClick={() => void save(false)}
              >
                {zh ? '保存新配置' : 'Save new profile'}
              </button>
              {selected ? (
                <button
                  type="button"
                  className="icon-btn"
                  disabled={busy || disabled || !name.trim() || !command.trim()}
                  onClick={() => void save(true)}
                >
                  {zh ? '更新配置' : 'Update profile'}
                </button>
              ) : null}
            </div>
          </div>
        </details>
      ) : null}
    </section>
  )
}
