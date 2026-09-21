import { createRuntimeStore, type RuntimeStore } from '../../src/server/runtime-store.js'

/**
 * Legacy lifecycle/PTY fixtures model a local operator approving their synthetic
 * executable. They still compile a real policy and persist a scoped grant before
 * each launch. Security suites use the ordinary runtime without this fixture.
 */
export const authorizeSyntheticAgent = async (
  store: RuntimeStore,
  workspaceId: string,
  agentId: string
) => {
  const view = await store.executionPolicies.preview(workspaceId, agentId)
  await store.executionPolicies.update(workspaceId, agentId, {
    profile: 'trusted_unsafe',
    expected_cli_fingerprint: view.cli_fingerprint,
    expected_cli_version: view.cli_version,
    policy_revision: view.policy_revision,
    acknowledge_unsafe: true,
  })
}

export const installSyntheticAgentAuthorization = (store: RuntimeStore) => {
  const prepare = store.executionPolicies.prepare.bind(store.executionPolicies)
  store.executionPolicies.prepare = async (input) => {
    await authorizeSyntheticAgent(store, input.workspace.id, input.agentId)
    return prepare(input)
  }
  return store
}

export const createAuthorizedTestRuntimeStore = (...args: Parameters<typeof createRuntimeStore>) =>
  installSyntheticAgentAuthorization(createRuntimeStore(...args))
