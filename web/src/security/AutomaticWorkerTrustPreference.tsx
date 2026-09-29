export const AutomaticWorkerTrustPreference = ({
  checked,
  disabled,
  saved,
  zh,
  onChange,
  onSave,
}: {
  checked: boolean
  disabled: boolean
  saved: boolean
  zh: boolean
  onChange: (checked: boolean) => void
  onSave?: () => void
}) => (
  <div className="mt-4 rounded border p-3" style={{ borderColor: 'var(--border)' }}>
    <label className="flex items-start gap-2 text-sm text-sec">
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {zh
        ? '后续自动创建的成员使用同一 CLI 时，默认授予可信权限'
        : 'Trust future automatically created members using the same CLI'}
    </label>
    <p className="mt-2 text-xs text-sec">
      {zh
        ? '保存后适用于本机所有工作区后续自动创建的成员；手动成员不变。CLI 更新后需要重新授权。取消此默认值会保留现有成员的授权。'
        : 'Once saved, this applies to future automatic members in all local workspaces. Manual members are unchanged. CLI updates need a new authorization. Turning this off keeps existing member grants.'}
    </p>
    {onSave ? (
      <button
        type="button"
        className="icon-btn mt-3"
        disabled={disabled || checked === saved}
        onClick={onSave}
      >
        {zh ? '保存自动成员默认权限' : 'Save automatic member default'}
      </button>
    ) : null}
  </div>
)
