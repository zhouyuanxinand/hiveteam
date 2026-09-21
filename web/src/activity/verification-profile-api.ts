import type {
  VerificationLogPage,
  VerificationProfile,
} from '../../../src/shared/verification-profile.js'
import { apiFetch, readErrorMessage } from '../api.js'

const root = (workspaceId: string) => `/api/ui/workspaces/${encodeURIComponent(workspaceId)}`
export const saveVerificationProfile = async (
  workspaceId: string,
  body: Omit<VerificationProfile, 'id'>,
  id?: string
): Promise<VerificationProfile> => {
  const url = `${root(workspaceId)}/verification-profiles`
  const result = await apiFetch(`${url}${id ? `/${encodeURIComponent(id)}` : ''}`, {
    method: id ? 'PUT' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!result.ok)
    throw new Error(await readErrorMessage(result, 'Could not save verification profile'))
  return result.json()
}
export const verificationProfiles = async (workspaceId: string): Promise<VerificationProfile[]> => {
  const url = `${root(workspaceId)}/verification-profiles`
  const result = await apiFetch(url)
  if (!result.ok)
    throw new Error(await readErrorMessage(result, 'Could not load verification profiles'))
  return result.json()
}
export const verificationLogUrl = (workspaceId: string, dispatchId: string, runId: string) =>
  `${root(workspaceId)}/dispatches/${encodeURIComponent(dispatchId)}/verifications/${encodeURIComponent(runId)}/log`
export const verificationLog = async (
  workspaceId: string,
  dispatchId: string,
  runId: string,
  offset?: number
): Promise<VerificationLogPage> => {
  const response = await apiFetch(
    `${verificationLogUrl(workspaceId, dispatchId, runId)}${offset === undefined ? '' : `?offset=${offset}`}`
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Could not load verification log'))
  return response.json()
}
