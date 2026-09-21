// Collect an explicitly authorized real-model experiment. No credentials, CLI
// defaults, workspace paths or model accounts are discovered by this script.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

const [configPath, outputPath, approval] = process.argv.slice(2)
if (!configPath || !outputPath)
  throw new Error(
    'Usage: node tests/manual/team-experiment.mjs experiment.json results.json [--collect-authorized]'
  )
const config = JSON.parse(readFileSync(configPath, 'utf8'))
assert.equal(config.runs.length, 3)
assert.deepEqual(
  config.runs.map((run) => run.workers).sort((a, b) => a - b),
  [1, 4, 8]
)
assert.match(config.fixed_task_set_sha256, /^[a-f0-9]{64}$/u)
assert.ok(config.acceptance_definition && config.model_version)
assert.ok(config.max_duration_ms > 0 && config.max_duration_ms <= 3600000)
assert.equal(
  config.external_budget_enforced,
  true,
  'Configure the CLI/account budget before real-model experiments'
)
if (approval !== '--collect-authorized') {
  writeFileSync(
    outputPath,
    JSON.stringify(
      { state: 'plan_only', configuration: config, model_cost: null, quality_improvement: null },
      null,
      2
    )
  )
} else {
  assert.equal(config.account_authorized, true)
  const base = new URL(config.base_url)
  assert.equal(base.protocol, 'http:')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
  const cookie = process.env.HIVE_EXPERIMENT_UI_COOKIE
  assert.ok(cookie, 'Supply the dedicated experiment UI session explicitly')
  const results = []
  const collectedAt = Date.now()
  for (const run of config.runs) {
    assert.ok(run.dispatch_ids.length > 0 && run.dispatch_ids.length <= 100)
    assert.equal(new Set(run.dispatch_ids).size, run.dispatch_ids.length)
    if (run.verified_model_cost !== undefined && run.verified_model_cost !== null)
      assert.ok(run.billing_source, 'Verified cost requires a billing source')
    const response = await fetch(
      new URL(
        `/api/ui/workspaces/${encodeURIComponent(run.workspace_id)}/dispatches?limit=100`,
        base
      ),
      {
        headers: { cookie },
        signal: AbortSignal.timeout(Math.min(config.max_duration_ms, 30000)),
        redirect: 'error',
      }
    )
    assert.equal(response.status, 200)
    const body = await response.json(),
      items = Array.isArray(body) ? body : body.dispatches
    const dispatches = run.dispatch_ids.map((id) => {
      const item = items.find((d) => d.id === id)
      assert.ok(item, `Missing selected dispatch ${id}; keep each experiment within 100 records`)
      return item
    })
    const completed = dispatches
      .filter((d) => d.reported_at !== null)
      .map((d) => d.reported_at - d.created_at)
      .sort((a, b) => a - b)
    const pending = dispatches.filter((d) => ['queued', 'submitted'].includes(d.state))
    results.push({
      workers: run.workers,
      dispatches: dispatches.map((d) => ({
        id: d.id,
        state: d.state,
        outcome: d.report_outcome,
        accepted_at: d.accepted_at,
        elapsed_ms: d.reported_at === null ? null : d.reported_at - d.created_at,
      })),
      successes: dispatches.filter((d) => d.report_outcome === 'success' && d.accepted_at !== null)
        .length,
      total: dispatches.length,
      failures: dispatches.filter((d) => ['failed', 'blocked'].includes(d.report_outcome)).length,
      cancelled: dispatches.filter((d) => d.state === 'cancelled').length,
      pending: pending.length,
      overdue_pending: pending.filter((d) => collectedAt - d.created_at >= config.max_duration_ms)
        .length,
      awaiting_acceptance: dispatches.filter(
        (d) => d.state === 'reported' && d.accepted_at === null
      ).length,
      completion_p95_ms: completed.length
        ? completed[Math.ceil(completed.length * 0.95) - 1]
        : null,
      manual_interventions: run.manual_interventions ?? null,
      manual_wait_ms: run.manual_wait_ms ?? null,
      rework_rounds: run.rework_rounds ?? null,
      model_cost: run.verified_model_cost ?? null,
      billing_source: run.billing_source ?? null,
      recorded_experiment_limits: run.effective_limits ?? null,
    })
  }
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        state: 'observed',
        collected_at: collectedAt,
        max_duration_ms: config.max_duration_ms,
        pending_work_is_not_cancelled_by_collector: true,
        fixed_task_set_sha256: config.fixed_task_set_sha256,
        acceptance_definition: config.acceptance_definition,
        model_version: config.model_version,
        results,
      },
      null,
      2
    )
  )
}
