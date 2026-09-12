import type { SkillPackSource } from './skill-packs.js'

export interface SkillPackSourceDescription {
  inputValue: string
  label: string
  payload: SkillPackSource
  ref: string | null
  uri: string
}

export const describeSkillPackSource = (source: SkillPackSource): SkillPackSourceDescription => {
  if (source.type === 'github') {
    return {
      inputValue: source.repository,
      label: `${source.repository}@${source.ref}`,
      payload: { ref: source.ref, repository: source.repository, type: source.type },
      ref: source.ref,
      uri: `https://github.com/${source.repository}.git`,
    }
  }
  if (source.type === 'git') {
    return {
      inputValue: source.url,
      label: `${source.url}@${source.ref}`,
      payload: { ref: source.ref, type: source.type, url: source.url },
      ref: source.ref,
      uri: source.url,
    }
  }
  return {
    inputValue: source.path,
    label: source.path,
    payload: { path: source.path, type: source.type },
    ref: null,
    uri: source.path,
  }
}
