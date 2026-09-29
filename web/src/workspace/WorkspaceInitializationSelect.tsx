import { useI18n } from '../i18n.js'

export const WorkspaceInitializationSelect = ({
  value,
  onChange,
}: {
  value: 'basic' | 'packs'
  onChange: (value: 'basic' | 'packs') => void
}) => {
  const { language } = useI18n()
  const zh = language === 'zh'
  return (
    <label className="flex flex-col gap-2 text-sm">
      {zh ? '工作区初始化' : 'Workspace initialization'}
      <select
        aria-label={zh ? '工作区初始化' : 'Workspace initialization'}
        className="input"
        value={value}
        onChange={(event) => onChange(event.target.value as 'basic' | 'packs')}
      >
        <option value="packs">
          {zh ? '默认安装 matt + code-janitor' : 'Install matt + code-janitor (default)'}
        </option>
        <option value="basic">
          {zh
            ? '基础模式（可离线，不安装默认包）'
            : 'Basic workspace (offline, skip default packs)'}
        </option>
      </select>
      <span className="text-xs text-sec">
        {value === 'packs'
          ? zh
            ? '安装两个默认团队技能包，需要网络或已有缓存。保留项目已有技能与文件。'
            : 'Installs both default team skill packs using the network or an existing cache. Existing project skills and files are preserved.'
          : zh
            ? '不安装 matt 和 code-janitor。保留已有技能与文件，之后可从顶部“团队技能”添加。'
            : 'Skips matt and code-janitor. Existing skills and files are preserved; add packs later from Team Skills in the top bar.'}
      </span>
    </label>
  )
}
