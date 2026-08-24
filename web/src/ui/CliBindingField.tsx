import { Link } from 'lucide-react'

import { useI18n } from '../i18n.js'

type CliBindingFieldProps = {
  command: string
  displayName: string
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
  value,
  onChange,
  testId,
}: CliBindingFieldProps) => {
  const { t } = useI18n()
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
      <p className="text-xs leading-5 text-ter">{t('cliBinding.help')}</p>
    </div>
  )
}
