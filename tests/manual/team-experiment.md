# Authorized team experiment collection

`team-experiment.mjs` collects existing dispatch results from a dedicated local
Runtime. It never starts agents, sends tasks, cancels work, or discovers accounts.
Its default mode only validates and writes a plan. The capacity fixture is a
separate experiment; its reports do not measure model quality or cost.

Before a real-model run, select a dedicated account, repository and permitted
external actions. Configure a hard account/CLI spending limit and a supervisor
that stops the experiment at the time limit. Use the same task set, acceptance
definition, model version and role prompts for all three team sizes. Keep failed
and cancelled dispatch IDs in the set. Configure resource limits through Hive's
settings before each run and record them, including the Orchestrator's slot.

Create an experiment JSON file with these fields (replace the placeholder IDs and
SHA-256 with actual experiment values):

```json
{
  "base_url": "http://127.0.0.1:4010",
  "account_authorized": false,
  "external_budget_enforced": true,
  "fixed_task_set_sha256": "REPLACE_WITH_TASK_SET_SHA256",
  "acceptance_definition": "Same tests and reviewed acceptance criteria for every run",
  "model_version": "Exact CLI and model version used by all runs",
  "max_duration_ms": 1200000,
  "runs": [
    {
      "workers": 1,
      "workspace_id": "ONE_WORKER_WORKSPACE_ID",
      "dispatch_ids": ["ALL_SELECTED_DISPATCH_IDS"],
      "effective_limits": { "max_running_total": 2, "max_running_per_workspace": 2 },
      "manual_interventions": null,
      "manual_wait_ms": null,
      "rework_rounds": null,
      "verified_model_cost": null,
      "billing_source": null
    },
    {
      "workers": 4,
      "workspace_id": "FOUR_WORKER_WORKSPACE_ID",
      "dispatch_ids": ["ALL_SELECTED_DISPATCH_IDS"],
      "effective_limits": { "max_running_total": 5, "max_running_per_workspace": 5 }
    },
    {
      "workers": 8,
      "workspace_id": "EIGHT_WORKER_WORKSPACE_ID",
      "dispatch_ids": ["ALL_SELECTED_DISPATCH_IDS"],
      "effective_limits": { "max_running_total": 9, "max_running_per_workspace": 9 }
    }
  ]
}
```

```text
node tests/manual/team-experiment.mjs experiment.json plan.json
```

Only after account authorization, set `account_authorized` to true and supply the
dedicated local UI session in `HIVE_EXPERIMENT_UI_COOKIE` without placing it in the
config, logs or shell history. Then collect with:

```text
node tests/manual/team-experiment.mjs experiment.json results.json --collect-authorized
```

Use fresh workspaces with at most 100 dispatches each. Missing selected IDs fail
collection; the script does not silently omit them. Fetch is bounded to 30 seconds
or the configured duration, whichever is shorter, and does not follow redirects.
The duration is an experiment observation threshold, not an automatic cancellation
mechanism. Stop pending work using the separately configured supervisor.

Results include every selected state/outcome, accepted successes, failures,
cancellations, pending/overdue work and reports still awaiting acceptance. The
completion p95 covers terminal records only; interpret it alongside the pending
count. Intervention, wait, rework and cost fields stay null when unavailable.
Verified costs require a billing source. Recorded resource limits are supplied
experiment metadata; they are not reconstructed from a later Runtime snapshot.

The collector has been exercised against synthetic local HTTP/SQLite records.
No real model experiment or spending was performed for stages 08–10.
