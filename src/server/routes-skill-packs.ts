import {
  type ResolveSkillPackInput,
  type SkillPackChangeIntent,
  type SkillProfiles,
  skillProfileNames,
} from '../shared/skill-packs.js'
import { BadRequestError } from './http-errors.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import {
  serializeSkillChangePlan,
  serializeSkillChangeReceipt,
  serializeSkillPackRelease,
  serializeWorkspaceSkillInspection,
} from './skill-inspection-serializer.js'
import { SkillPackChangeError } from './skill-pack-operation-errors.js'
import { SkillPackResolutionError } from './skill-pack-source.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const skillProfileNameSet = new Set<string>(skillProfileNames)

const inspectWorkspace = async (
  context: Parameters<RouteDefinition['handler']>[0]
): Promise<void> => {
  requireUiTokenFromRequest(context.request, context.store.validateUiToken)
  const workspaceId = getRequiredParam(
    context.response,
    context.params,
    'workspaceId',
    'Workspace id is required'
  )
  if (!workspaceId) return
  // Resolve the workspace first so an unknown id fails before touching disk.
  context.store.getWorkspaceSnapshot(workspaceId)
  const inspection = await context.store.skills.scan(workspaceId)
  sendJson(context.response, 200, serializeWorkspaceSkillInspection(inspection))
}

const sendChangeError = (response: Parameters<typeof sendJson>[0], error: unknown) => {
  if (!(error instanceof SkillPackChangeError)) throw error
  const notFound = new Set(['plan_not_found', 'receipt_not_found', 'release_unavailable'])
  const conflicts = new Set([
    'drift_detected',
    'mutation_conflict',
    'placement_conflict',
    'plan_already_applied',
    'plan_expired',
    'receipt_not_undoable',
    'recovery_required',
    'skill_name_conflict',
  ])
  sendJson(response, notFound.has(error.code) ? 404 : conflicts.has(error.code) ? 409 : 400, {
    error: error.message,
    error_code: error.code,
  })
}

const parsePlanIntent = (body: Record<string, unknown>): SkillPackChangeIntent => {
  if (body.action === 'remove') {
    if (typeof body.pack_name !== 'string') throw new BadRequestError('pack_name is required')
    return { action: 'remove', packName: body.pack_name }
  }
  if (body.action !== 'bind' && body.action !== 'update') {
    throw new BadRequestError('action must be bind, update, or remove')
  }
  if (typeof body.pack_name !== 'string' || typeof body.release_id !== 'string') {
    throw new BadRequestError('pack_name and release_id are required')
  }
  if (!Array.isArray(body.native_exposure)) {
    throw new BadRequestError('native_exposure must be an array')
  }
  const nativeExposure = body.native_exposure.filter(
    (entry): entry is string => typeof entry === 'string'
  )
  if (nativeExposure.length !== body.native_exposure.length) {
    throw new BadRequestError('native_exposure must contain only strings')
  }
  if (!body.profiles || typeof body.profiles !== 'object' || Array.isArray(body.profiles)) {
    throw new BadRequestError('profiles must be an object')
  }
  const profileInput = body.profiles as Record<string, unknown>
  const unknownProfiles = Object.keys(profileInput).filter(
    (profile) => !skillProfileNameSet.has(profile)
  )
  if (unknownProfiles.length > 0) {
    throw new BadRequestError(`Unknown profiles: ${unknownProfiles.join(', ')}`)
  }
  const profiles: Partial<SkillProfiles> = {}
  for (const profile of skillProfileNames) {
    const value = profileInput[profile]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      throw new BadRequestError(`profiles.${profile} must be a string array`)
    }
    profiles[profile] = value as string[]
  }
  return {
    action: body.action,
    nativeExposure,
    packName: body.pack_name,
    profiles,
    releaseId: body.release_id,
  }
}

export const skillPackRoutes: RouteDefinition[] = [
  route('GET', '/api/ui/workspaces/:workspaceId/skill-packs', inspectWorkspace),
  route('POST', '/api/ui/workspaces/:workspaceId/skill-packs/scan', inspectWorkspace),
  route(
    'POST',
    '/api/ui/workspaces/:workspaceId/skill-packs/resolve',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return
      store.getWorkspaceSnapshot(workspaceId)
      const body = await readJsonBody<{
        name?: unknown
        source?: Record<string, unknown>
      }>(request)
      if (typeof body.name !== 'string' || !body.source || typeof body.source.type !== 'string') {
        throw new BadRequestError('name and source are required')
      }
      let source: ResolveSkillPackInput['source']
      if (body.source.type === 'github') {
        if (typeof body.source.repository !== 'string') {
          throw new BadRequestError('source.repository is required')
        }
        source = {
          ref: typeof body.source.ref === 'string' ? body.source.ref : 'main',
          repository: body.source.repository,
          type: 'github',
        }
      } else if (body.source.type === 'git') {
        if (typeof body.source.url !== 'string') {
          throw new BadRequestError('source.url is required')
        }
        source = {
          ref: typeof body.source.ref === 'string' ? body.source.ref : 'main',
          type: 'git',
          url: body.source.url,
        }
      } else if (body.source.type === 'local') {
        if (typeof body.source.path !== 'string') {
          throw new BadRequestError('source.path is required')
        }
        source = { path: body.source.path, type: 'local' }
      } else {
        throw new BadRequestError('source.type must be github, git, or local')
      }
      try {
        const release = await store.skills.resolvePack({ packName: body.name, source })
        sendJson(response, 200, serializeSkillPackRelease(release))
      } catch (error) {
        if (!(error instanceof SkillPackResolutionError)) throw error
        const conflictCodes = new Set(['cache_unavailable', 'duplicate_skill_name'])
        sendJson(response, conflictCodes.has(error.code) ? 409 : 400, {
          error: error.message,
          error_code: error.code,
        })
      }
    }
  ),
  route(
    'POST',
    '/api/ui/workspaces/:workspaceId/skill-packs/plans',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return
      store.getWorkspaceSnapshot(workspaceId)
      const body = await readJsonBody<Record<string, unknown>>(request)
      try {
        const plan = await store.skills.plan(workspaceId, parsePlanIntent(body))
        sendJson(response, 201, serializeSkillChangePlan(plan))
      } catch (error) {
        sendChangeError(response, error)
      }
    }
  ),
  route(
    'POST',
    '/api/ui/workspaces/:workspaceId/skill-packs/plans/:planId/apply',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      const planId = getRequiredParam(response, params, 'planId', 'Plan id is required')
      if (!workspaceId || !planId) return
      store.getWorkspaceSnapshot(workspaceId)
      try {
        const receipt = await store.skills.applyPlan(workspaceId, planId)
        sendJson(response, 200, serializeSkillChangeReceipt(receipt))
      } catch (error) {
        sendChangeError(response, error)
      }
    }
  ),
  route(
    'POST',
    '/api/ui/workspaces/:workspaceId/skill-packs/receipts/:receiptId/undo',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      const receiptId = getRequiredParam(response, params, 'receiptId', 'Receipt id is required')
      if (!workspaceId || !receiptId) return
      store.getWorkspaceSnapshot(workspaceId)
      try {
        const receipt = await store.skills.undoReceipt(workspaceId, receiptId)
        sendJson(response, 200, serializeSkillChangeReceipt(receipt))
      } catch (error) {
        sendChangeError(response, error)
      }
    }
  ),
]
