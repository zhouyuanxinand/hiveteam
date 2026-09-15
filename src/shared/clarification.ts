/** Interview entry points, including Matt's native aliases. */
export const clarificationSkillNames = ['grill', 'grilling', 'grill-me', 'grill-with-docs'] as const

export const isClarificationSkill = (reference: string) =>
  clarificationSkillNames.some(
    (name) => reference.trim() === name || reference.trim().endsWith(`/${name}`)
  )

export interface ClarificationAssignment {
  dispatchId: string
  skillName: string
  active: boolean
}
