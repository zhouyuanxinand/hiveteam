import { Copy, Link } from 'lucide-react'

import { useI18n } from '../i18n.js'

type CliBindingFieldProps = {
  command: string
  displayName: string
  installHint?: string | null | undefined
  value: string
  onChange: (value: string) => void
  testId: string
}

/**
 * Explicit fallback for a CLI that is installed outside PATH. The value is
 * stored as the existing startup-command override, so no new launch format
 * or platform-specific process code is needed.
 */
export const CliBindingField = ({
  command,
  displayName,
  installHint,
  value,
  onChange,
  testId,
}: CliBindingFieldProps) => {
  const { t } = useI18n()
  const copyInstallHint = () => {
    if (!installHint) return
    void navigator.clipboard?.writeText(installHint)
  }
  return (
    <div
      className="flex flex-col gap-2 rounded border p-3"
      style={{
        background: 'color-mix(in oklab, var(--accent) 6%, var(--bg-2))',
        borderColor: 'color-mix(in oklab, var(--accent) 35%, var(--border))',
      }}
      data-testid={`${testId}-panel`}
    >
      <div className="flex items-start gap-2">
        <Link size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium text-pri">
            {t('cliBinding.title', { name: displayName })}
          </p>
          <p className="mt-0.5 text-xs leading-5 text-ter">
            {t('cliBinding.description', { command })}
          </p>
        </div>
      </div>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={t('cliBinding.placeholder')}
        aria-label={t('cliBinding.inputAria', { name: displayName })}
        className="input mono text-sm"
        spellCheck={false}
        data-testid={testId}
      />
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs leading-5 text-ter">{t('cliBinding.help')}</p>
        {installHint ? (
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 text-xs text-accent hover:underline"
            onClick={copyInstallHint}
            title={installHint}
            data-testid={`${testId}-install-guide`}
          >
            <Copy size={12} aria-hidden />
            {t('cliBinding.copyGuide')}
          </button>
        ) : null}
      </div>
    </div>
  )
}
