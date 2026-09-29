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
import { activityAttentionRoutes } from './routes-activity-attention.js'
import { agentConversationRoutes } from './routes-agent-conversation.js'
import { codeReviewRoutes } from './routes-code-reviews.js'
import { collaborationStatsRoutes } from './routes-collaboration-stats.js'
import { dataRecoveryRoutes } from './routes-data-recovery.js'
import { deliveryQueueRoutes } from './routes-delivery-queue.js'
import { dispatchRoutes } from './routes-dispatches.js'
import { executionPolicyRoutes } from './routes-execution-policy.js'
import { externalGoalRoutes } from './routes-external-goals.js'
import { fsRoutes } from './routes-fs.js'
import { gitRoutes } from './routes-git.js'
import { integrationCandidateRoutes } from './routes-integration-candidates.js'
import { integrationRoutes } from './routes-integrations.js'
import { marketplaceRoutes } from './routes-marketplace.js'
import { memoryContextRoutes } from './routes-memory-context.js'
import { memoryDreamRoutes } from './routes-memory-dream.js'
import { messageDeliveryRoutes } from './routes-message-delivery.js'
import { nativeSessionRoutes } from './routes-native-sessions.js'
import { onboardingRoutes } from './routes-onboarding.js'
import { openWorkspaceRoutes } from './routes-open-workspace.js'
import { platformRecoveryRoutes } from './routes-platform-recovery.js'
import { pullRequestRoutes } from './routes-pull-requests.js'
import { recoveryIndexRoutes } from './routes-recovery-index.js'
import { remoteRoutes } from './routes-remote.js'
import { remotePermissionRoutes } from './routes-remote-permissions.js'
import { resourceRoutes } from './routes-resources.js'
import { runtimeRoutes } from './routes-runtime.js'
import { sessionAdapterRoutes } from './routes-session-adapters.js'
import { settingsRoutes } from './routes-settings.js'
import { skillPackRoutes } from './routes-skill-packs.js'
import { taskRoutes } from './routes-tasks.js'
import { teamRoutes } from './routes-team.js'
import { teamGoalRoutes } from './routes-team-goals.js'
import { teamGrillRoutes } from './routes-team-grill.js'
import { teamMemoryDreamRoutes } from './routes-team-memory-dream.js'
import { teamMessageRoutes } from './routes-team-messages.js'
import { teamReviewRoutes } from './routes-team-review.js'
import { teamScenarioRoutes } from './routes-team-scenarios.js'
import { teamTasksRoutes } from './routes-team-tasks.js'
import { uiRoutes } from './routes-ui.js'
import { verificationRoutes } from './routes-verifications.js'
import { versionRoutes } from './routes-version.js'
import { workerBranchRoutes } from './routes-worker-branches.js'
import { workerLifecycleRoutes } from './routes-worker-lifecycle.js'
import { workflowRoutes } from './routes-workflows.js'
import { workspaceDeliveryRoutes } from './routes-workspace-delivery.js'
import { workspaceMemoryRoutes } from './routes-workspace-memory.js'
import { workspaceReviewRoutes } from './routes-workspace-review.js'
import { workspaceRoutes } from './routes-workspaces.js'
import { worktreeResourceRoutes } from './routes-worktree-resources.js'

const routes: RouteDefinition[] = [
  ...teamGrillRoutes,
  ...workerLifecycleRoutes,
  ...teamReviewRoutes,
  ...dataRecoveryRoutes,
  ...memoryContextRoutes,
  ...recoveryIndexRoutes,
  ...onboardingRoutes,
  ...workspaceDeliveryRoutes,
  ...nativeSessionRoutes,
  ...sessionAdapterRoutes,
  ...messageDeliveryRoutes,
  ...resourceRoutes,
  ...platformRecoveryRoutes,
  ...executionPolicyRoutes,
  ...activityRoutes,
  ...activityAttentionRoutes,
  ...collaborationStatsRoutes,
  ...agentConversationRoutes,
  ...workspaceRoutes,
  ...workspaceReviewRoutes,
  ...workspaceMemoryRoutes,
  ...memoryDreamRoutes,
  ...workflowRoutes,
  ...openWorkspaceRoutes,
  ...dispatchRoutes,
  ...codeReviewRoutes,
  ...verificationRoutes,
  ...integrationRoutes,
  ...integrationCandidateRoutes,
  ...pullRequestRoutes,
  ...deliveryQueueRoutes,
  ...workerBranchRoutes,
  ...worktreeResourceRoutes,
  ...versionRoutes,
  ...uiRoutes,
  ...settingsRoutes,
  ...skillPackRoutes,
  ...taskRoutes,
  ...runtimeRoutes,
  ...remoteRoutes,
  ...remotePermissionRoutes,
  ...externalGoalRoutes,
  ...teamRoutes,
  ...teamMessageRoutes,
  ...teamMemoryDreamRoutes,
  ...teamTasksRoutes,
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
      method: routeDefinition.method,
      path: routeDefinition.path,
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
