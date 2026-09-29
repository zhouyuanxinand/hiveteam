import assert from 'node:assert/strict'
import { stripVTControlCharacters } from 'node:util'
import { waitForRuntime } from './pack-runtime-process.mjs'

export const verifyTeamLauncher = async ({ baseUrl, cookie, workspace, launcher }) => {
  const agentId = `${workspace.id}:orchestrator`
  const call = async (path, body, method = 'POST') => {
    const response = await fetch(baseUrl + path, {
      method: body === undefined ? 'GET' : method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    assert.ok(
      response.ok,
      `${path}: ${response.status} ${response.ok ? '' : await response.text()}`
    )
    return response.status === 204 ? null : response.json()
  }
  const witness = await call(`/api/workspaces/${workspace.id}/workers`, {
    name: 'Pack launcher witness',
    role: 'coder',
  })
  await call(`/api/workspaces/${workspace.id}/agents/${encodeURIComponent(agentId)}/config`, {
    command: launcher,
    args: ['list'],
  })
  const policyPath = `/api/ui/workspaces/${workspace.id}/agents/${encodeURIComponent(agentId)}/execution-policy`
  const policy = await call(policyPath)
  await call(
    policyPath,
    {
      profile: 'trusted_unsafe',
      expected_cli_fingerprint: policy.cli_fingerprint,
      expected_cli_version: policy.cli_version,
      policy_revision: policy.policy_revision,
      acknowledge_unsafe: true,
    },
    'PUT'
  )
  const started = await call(
    `/api/workspaces/${workspace.id}/agents/${encodeURIComponent(agentId)}/start`,
    {}
  )
  const runId = started.run_id ?? started.runId
  const run = await waitForRuntime(async () => {
    const current = await call(`/api/runtime/runs/${runId}`)
    return ['exited', 'error'].includes(current.status) ? current : null
  }, 'packaged team launcher exit')
  assert.equal(run.status, 'exited', run.output)
  assert.equal(run.exitCode, 0, run.output)
  const output = stripVTControlCharacters(run.output).replace(/[\r\n]/g, '')
  assert.ok(output.includes(witness.name), `team list did not return the worker: ${output}`)
  return { status: 'passed', launcher, exit_code: run.exitCode, worker_id: witness.id }
}
