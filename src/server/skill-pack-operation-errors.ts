export type SkillPackChangeErrorCode =
  | 'drift_detected'
  | 'invalid_intent'
  | 'mutation_conflict'
  | 'path_unsafe'
  | 'placement_conflict'
  | 'plan_already_applied'
  | 'plan_expired'
  | 'plan_not_found'
  | 'receipt_not_found'
  | 'receipt_not_undoable'
  | 'recovery_required'
  | 'release_unavailable'
  | 'skill_name_conflict'

export class SkillPackChangeError extends Error {
  readonly code: SkillPackChangeErrorCode

  constructor(code: SkillPackChangeErrorCode, message: string) {
    super(message)
    this.name = 'SkillPackChangeError'
    this.code = code
  }
}
