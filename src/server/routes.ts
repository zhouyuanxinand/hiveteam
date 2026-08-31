import { matchPath } from './route-helpers.js'
import type {
  ConfigureAgentLaunchBody,
  CreateWorkerBody,
  CreateWorkspaceBody,
  ReportTaskBody,
  RouteDefinition,
  SendTaskBody,
  WorkerRole,
} from './route-types.js'
import { activityRoutes } from './routes-activity.js'
import { dispatchRoutes } from './routes-dispatches.js'
import { externalGoalRoutes } from './routes-external-goals.js'
import { fsRoutes } from './routes-fs.js'
import { gitRoutes } from './routes-git.js'
import { marketplaceRoutes } from './routes-marketplace.js'
import { memoryDreamRoutes } from './routes-memory-dream.js'
import { openWorkspaceRoutes } from './routes-open-workspace.js'
import { remoteRoutes } from './routes-remote.js'
import { runtimeRoutes } from './routes-runtime.js'
import { settingsRoutes } from './routes-settings.js'
import { taskRoutes } from './routes-tasks.js'
import { teamRoutes } from './routes-team.js'
import { teamGoalRoutes } from './routes-team-goals.js'
import { teamScenarioRoutes } from './routes-team-scenarios.js'
import { uiRoutes } from './routes-ui.js'
import { versionRoutes } from './routes-version.js'
import { workflowRoutes } from './routes-workflows.js'
import { workspaceMemoryRoutes } from './routes-workspace-memory.js'
import { workspaceRoutes } from './routes-workspaces.js'

const routes: RouteDefinition[] = [
  ...activityRoutes,
  ...workspaceRoutes,
  ...workspaceMemoryRoutes,
  ...memoryDreamRoutes,
  ...workflowRoutes,
  ...openWorkspaceRoutes,
  ...dispatchRoutes,
  ...versionRoutes,
  ...uiRoutes,
  ...settingsRoutes,
  ...taskRoutes,
  ...runtimeRoutes,
  ...remoteRoutes,
  ...externalGoalRoutes,
  ...teamRoutes,
  ...teamGoalRoutes,
  ...teamScenarioRoutes,
  ...fsRoutes,
  ...gitRoutes,
  ...marketplaceRoutes,
]

export const matchRoute = (method: string, pathname: string) => {
  for (const routeDefinition of routes) {
    if (routeDefinition.method !== method) {
      continue
    }

    const params = matchPath(routeDefinition.path, pathname)
    if (!params) {
      continue
    }

    return {
      handler: routeDefinition.handler,
      params,
    }
  }

  return null
}

export type {
  ConfigureAgentLaunchBody,
  CreateWorkerBody,
  CreateWorkspaceBody,
  ReportTaskBody,
  RouteDefinition,
  SendTaskBody,
  WorkerRole,
}
