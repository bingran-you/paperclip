import { eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db, type agents, type projects } from "@paperclipai/db";
import type { AiConnectionBinding, AiRuntimeConnectionBinding } from "@paperclipai/shared";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { parseObject } from "../../adapters/utils.js";
import { logger } from "../../middleware/logger.js";
import { AI_CONNECTION_BUSY_RETRY_REASON, extractWakeCommentIds, isNonAssigneeWorkspaceBusyRetry } from "../../modules/run-dispatch/index.js";
import { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import { agentIdentityService, supportsManagedAgentIdentity } from "../agent-identity.js";
import { readAiConnectionConfigurationFailure, readAiCredentialAccessFailure } from "../ai-connection-configuration-failure.js";
import { AI_AUTH_ENV_KEYS, isAiConnectionBusy, prepareManagedAiRuntime, stripAiAuthBindings } from "../ai-connection-runtime.js";
import { managedAiSessionIdentityCompatible } from "../ai-connection-session.js";
import type { companySkillService } from "../company-skills.js";
import { connectionIntentService } from "../connection-intents.js";
import { prepareConnectionInstructionDelivery } from "../connection-instructions.js";
import { applyConnectorSkills, prepareConnectorSkillDelivery, resolveConnectorAssignments } from "../connector-runtime.js";
import { buildExecutionWorkspaceAdapterConfig } from "../execution-workspace-policy.js";
import { resolveManagedGitHubIdentitySelection } from "../git-credentials.js";
import { resolveAssignedConnectionInstructionsForRun } from "../native-runtime/assigned-mcp-tools.js";
import { recordFailedSkillPreparation, type NativeRunHistoricalSpan } from "../native-runtime/native-run-trace.js";
import { collectRunFailureSecretValues } from "../run-failure-diagnostics.js";
import { skillVersionSelectionMap } from "../runtime-skill-selections.js";
import type { selectHeartbeatEnvironment } from "./environment-selection.js";
import type { createHeartbeatRetries } from "./retries.js";
import type { createHeartbeatLifecycle } from "./run-lifecycle.js";
import {
  ConfigurationIncompleteFailure, applyRunScopedMentionedSkillKeys, resolveExecutionRunAdapterConfig,
  resolveRunScopedMentionedSkillKeys, type createHeartbeatRunPreparation, type resolveAcceptedPlanWakeRoutingDecision,
} from "./run-preparation.js";
import { buildExecutionWorkspaceConfigSnapshot, stripWorkspaceRuntimeFromExecutionRunConfig } from "./workspaces.js";
import type { HeartbeatWorkspacePreparationInput } from "./workspace-preparation.js";

const ACCEPTED_PLAN_CONVERSION_SKILL_KEY =
  "paperclipai/paperclip/paperclip-converting-plans-to-tasks";

type ManagedAiRuntime = Awaited<ReturnType<typeof prepareManagedAiRuntime>>;
type EnvironmentSelection = Awaited<ReturnType<typeof selectHeartbeatEnvironment>>;

export interface HeartbeatExecutionConfigurationInput {
  run: typeof heartbeatRuns.$inferSelect;
  agent: typeof agents.$inferSelect;
  task: {
    issueId: string | null;
    context: Record<string, unknown>;
    responsibleUserId: string | null;
    acceptedPlanContinuationWake: boolean;
    acceptedPlanWakeRoutingDecision: Awaited<ReturnType<typeof resolveAcceptedPlanWakeRoutingDecision>> | null;
    projectContext: Pick<typeof projects.$inferSelect, "id" | "env"> | null;
    routineEnvContext: Awaited<ReturnType<ReturnType<typeof createHeartbeatRunPreparation>["getRoutineEnvForExecutionIssue"]>>;
  };
  config: {
    config: Record<string, unknown>;
    issueAssigneeOverrides: { adapterConfig: Record<string, unknown> | null; useProjectWorkspace: boolean | null } | null;
    requestedAiBinding: AiRuntimeConnectionBinding | undefined;
    aiBinding: AiConnectionBinding | undefined;
  };
  policy: Pick<HeartbeatWorkspacePreparationInput["policy"],
    "trustPreset" | "projectExecutionWorkspacePolicy" | "issueExecutionWorkspaceSettings" | "requestedExecutionWorkspaceMode" | "useIsolatedTaskDirectory">;
  environment: Pick<EnvironmentSelection,
    "selectedEnvironmentId" | "selectedEnvironmentForConfig" | "resolvedInstanceSettings" | "persistedNativeExecutionInput">;
  services: {
    secretsSvc: Parameters<typeof resolveExecutionRunAdapterConfig>[0]["secretsSvc"];
    companySkills: Pick<ReturnType<typeof companySkillService>, "listRuntimeSkillEntries">;
    appendRunEvent: ReturnType<typeof createHeartbeatLifecycle>["appendRunEvent"];
    finalizeAiConnectionBusyDeferral: ReturnType<typeof createHeartbeatRetries>["finalizeAiConnectionBusyDeferral"];
  };
  // The executor must observe these before a later preparation step can throw.
  onFailureSecretsResolved: (readSecrets: () => string[]) => void;
  onManagedAiRuntimeAcquired: (runtime: ManagedAiRuntime) => void;
  onIdentityRedactorPrepared: (redactor: ReturnType<typeof createAgentIdentityRedactor>) => void;
}

/** Assembles effective run configuration; the executor retains cleanup ownership. */
export async function prepareHeartbeatExecutionConfiguration(db: Db, input: HeartbeatExecutionConfigurationInput) {
  const { run, agent, onFailureSecretsResolved, onManagedAiRuntimeAcquired, onIdentityRedactorPrepared } = input;
  const { issueId, context, responsibleUserId, acceptedPlanContinuationWake, acceptedPlanWakeRoutingDecision, projectContext, routineEnvContext } = input.task;
  const { config, issueAssigneeOverrides, requestedAiBinding, aiBinding } = input.config;
  const { trustPreset, projectExecutionWorkspacePolicy, issueExecutionWorkspaceSettings, requestedExecutionWorkspaceMode, useIsolatedTaskDirectory } = input.policy;
  const { selectedEnvironmentId, selectedEnvironmentForConfig, resolvedInstanceSettings, persistedNativeExecutionInput } = input.environment;
  const { secretsSvc, companySkills, appendRunEvent, finalizeAiConnectionBusyDeferral } = input.services;
  let managedAiRuntime: ManagedAiRuntime | undefined;
  const workspaceManagedConfig = buildExecutionWorkspaceAdapterConfig({
    agentConfig: config,
    projectPolicy: projectExecutionWorkspacePolicy,
    issueSettings: issueExecutionWorkspaceSettings,
    mode: requestedExecutionWorkspaceMode,
    legacyUseProjectWorkspace:
      issueAssigneeOverrides?.useProjectWorkspace ?? null,
  });
  const mergedConfig = {
    ...workspaceManagedConfig,
    ...Object.fromEntries(Object.entries(issueAssigneeOverrides?.adapterConfig ?? {}).filter(([key]) => requestedAiBinding?.mode !== "router" || !["provider", "acpxAgent", "model", "modelReasoningEffort", "reasoningEffort", "effort", "variant"].includes(key))),
    ...(requestedAiBinding?.mode === "router" ? parseObject(parseObject(context.aiRouterSelection).runtimeConfig) : {}),
    // The base below is already task-owned. Keep directory transport while
    // preserving isolated mode and the mandatory sandbox preflight.
    ...(useIsolatedTaskDirectory ? { workspaceStrategy: { type: "project_primary" } } : {}),
  };
  const configSnapshot = buildExecutionWorkspaceConfigSnapshot(
    mergedConfig,
    selectedEnvironmentId,
  );
  const executionRunConfig =
    stripWorkspaceRuntimeFromExecutionRunConfig(mergedConfig);
  const runScopedMentionedSkillKeys =
    await resolveRunScopedMentionedSkillKeys({
      db,
      companyId: agent.companyId,
      issueId,
      commentIds: extractWakeCommentIds(context),
    });
  const runScopedSkillKeys =
    acceptedPlanContinuationWake &&
    !acceptedPlanWakeRoutingDecision?.suppressAcceptedContinuation
      ? [...runScopedMentionedSkillKeys, ACCEPTED_PLAN_CONVERSION_SKILL_KEY]
      : runScopedMentionedSkillKeys;
  const githubSelection = await resolveManagedGitHubIdentitySelection(
    db,
    agent.companyId,
    {
      agentId: agent.id,
      responsibleUserId,
      allowStandingDelegation: false,
    },
  );
  const useHostGitHub =
    !githubSelection.configured &&
    trustPreset.kind === "standard" &&
    ["local", "ssh"].includes(
      selectedEnvironmentForConfig?.driver ?? "local",
    );

  const { resolvedConfig, configuredTaskEnvironment, secretKeys, secretManifest } =
    await resolveExecutionRunAdapterConfig({
      managedAiCredentials: Boolean(aiBinding),
      managedGitHubCredentials: !useHostGitHub,
      companyId: agent.companyId,
      agentId: agent.id,
      adapterType: agent.adapterType,
      issueId,
      heartbeatRunId: run.id,
      environmentId: selectedEnvironmentForConfig?.id ?? null,
      environmentEnv: aiBinding ? stripAiAuthBindings(selectedEnvironmentForConfig?.envVars) : selectedEnvironmentForConfig?.envVars ?? null,
      environmentDriver: selectedEnvironmentForConfig?.driver ?? null,
      projectId: projectContext?.id ?? null,
      routineId: routineEnvContext.routineId,
      responsibleUserId,
      executionRunConfig: aiBinding ? { ...executionRunConfig, env: stripAiAuthBindings(executionRunConfig.env) } : executionRunConfig,
      projectEnv: aiBinding ? stripAiAuthBindings(projectContext?.env) : projectContext?.env ?? null,
      routineEnv: aiBinding ? stripAiAuthBindings(routineEnvContext.env) : routineEnvContext.env,
      secretsSvc,
      trustPreset,
    });
  onFailureSecretsResolved(() => collectRunFailureSecretValues(resolvedConfig.env, secretKeys));
  if (aiBinding) {
    try {
      managedAiRuntime = await prepareManagedAiRuntime(db, { companyId: agent.companyId, agentId: agent.id, responsibleUserId, adapterType: agent.adapterType, binding: aiBinding, config: resolvedConfig });
      onManagedAiRuntimeAcquired(managedAiRuntime);
    } catch (error) {
      // Only fresh executions can receive a pre-provider wait receipt. A
      // persisted native input may already have provider effects to recover.
      if (isAiConnectionBusy(error) && !persistedNativeExecutionInput) {
        // Use the authority recorded by the locked admission gate, never
        // the issue's mutable assignee observed during runtime preparation.
        const authorizedNonAssigneeWake =
          parseObject(run.runnerProfileJson).aiConnectionNonAssigneeCommentWake === true ||
          (run.scheduledRetryReason === AI_CONNECTION_BUSY_RETRY_REASON &&
            isNonAssigneeWorkspaceBusyRetry(run.scheduledRetryReason, parseObject(run.contextSnapshot)));
        await finalizeAiConnectionBusyDeferral(run, error, !authorizedNonAssigneeWake);
        return { prepared: false as const };
      }
      if (responsibleUserId && issueId) {
        await connectionIntentService(db).request({ sub: agent.id, company_id: agent.companyId, run_id: run.id, responsible_user_id: responsibleUserId }, aiBinding.provider, { purpose: "ai" }).catch(() => {
          logger.warn({ runId: run.id, agentId: agent.id }, "Could not attach AI connection request; runtime configuration action remains available");
        });
      }
      throw new ConfigurationIncompleteFailure(error instanceof Error ? error.message : "Configure this agent’s AI connection", {
        configurationIncomplete: { reason: "ai_connection_unavailable", companyId: agent.companyId, agentId: agent.id, responsibleUserId,
          ...(!persistedNativeExecutionInput && readAiConnectionConfigurationFailure(error)
            ? { selectionFailure: readAiConnectionConfigurationFailure(error) } : {}),
          ...(readAiCredentialAccessFailure(error)
            ? { credentialAccess: readAiCredentialAccessFailure(error) } : {}),
          provider: aiBinding.provider, method: aiBinding.method, actionUrl: `/agents/${agent.id}/runtime`,
          fingerprint: `ai:${agent.id}:${responsibleUserId}:${JSON.stringify(aiBinding)}` },
      });
    }
    const savedAiAccount = parseObject(run.contextSnapshot?.aiConnection);
    if (persistedNativeExecutionInput && !managedAiSessionIdentityCompatible(
      savedAiAccount.sessionIdentity ?? savedAiAccount.identity,
      managedAiRuntime.sessionIdentity,
      managedAiRuntime.identity,
    )) {
      throw new ConfigurationIncompleteFailure("The AI account changed while this native run was suspended. Start a new execution.", { configurationIncomplete: { reason: "ai_connection_changed", actionUrl: `/agents/${agent.id}/runtime` } });
    }
    Object.assign(resolvedConfig, managedAiRuntime.config);
    for (const key of AI_AUTH_ENV_KEYS) secretKeys.add(key);
    context.aiConnection = { ...managedAiRuntime.attribution, accountName: managedAiRuntime.accountName, identity: managedAiRuntime.identity, sessionIdentity: managedAiRuntime.sessionIdentity };
    await db.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({ aiConnection: context.aiConnection, ...(context.aiRouterTaskKey ? { aiRouterTaskKey: context.aiRouterTaskKey } : {}), ...(context.aiRouterSelection ? { aiRouterSelection: context.aiRouterSelection } : {}) })}::jsonb` }).where(eq(heartbeatRuns.id, run.id));
  }
  if (secretManifest.length > 0) {
    context.paperclipSecrets = {
      manifest: secretManifest,
    };
  } else {
    delete context.paperclipSecrets;
  }
  const effectiveResolvedConfig = applyRunScopedMentionedSkillKeys(
    resolvedConfig,
    runScopedSkillKeys,
  );
  const runtimeSkillPreference = readPaperclipSkillSyncPreference(
    effectiveResolvedConfig,
  );
  const nativeRunnerPreparationSpans: NativeRunHistoricalSpan[] = [];
  const skillsPrepareStartedAtMs = Date.now();
  const runtimeSkillEntries = await (async () => {
    try {
      return await companySkills.listRuntimeSkillEntries(agent.companyId, {
        versionSelections: skillVersionSelectionMap(
          runtimeSkillPreference.desiredSkillEntries,
          {
            versionPinsEnabled:
              resolvedInstanceSettings.experimental.enableBetaSkills ===
              true,
          },
        ),
      });
    } catch (error) {
      if (agent.adapterType === "paperclip_runner") {
        await recordFailedSkillPreparation({
          runId: run.id,
          startedAtMs: skillsPrepareStartedAtMs,
          onEvent: async (event) => {
            await appendRunEvent(run, event);
          },
        });
      }
      throw error;
    }
  })();
  nativeRunnerPreparationSpans.push({
    name: "skills.prepare",
    parentName: "task.prepare",
    startedAtMs: skillsPrepareStartedAtMs,
    endedAtMs: Date.now(),
  });
  const connectorAssignments = await resolveConnectorAssignments(db, { companyId: agent.companyId, agentId: agent.id, runId: run.id, issueId: typeof context.issueId === "string" ? context.issueId : undefined });
  const connectorSkillConfig = await applyConnectorSkills(effectiveResolvedConfig, runtimeSkillEntries, connectorAssignments);
  // Both CLI adapters and native context materialization use the same resolved set.
  runtimeSkillEntries.splice(0, runtimeSkillEntries.length, ...connectorSkillConfig.paperclipRuntimeSkills);
  const connectorDelivery = await prepareConnectorSkillDelivery(connectorSkillConfig, agent.adapterType);
  // Always replace this runtime-only field; caller wake data cannot supply skills.
  context.paperclipWake = { ...parseObject(context.paperclipWake), connectorSkillInstructions: connectorDelivery.instructions };
  let runtimeConfig = await prepareConnectionInstructionDelivery({
    resolve: () => resolveAssignedConnectionInstructionsForRun(db, { companyId: agent.companyId, agentId: agent.id, runId: run.id }),
    context, config: connectorDelivery.config, native: agent.adapterType === "paperclip_runner",
  });
  const agentIdentity = supportsManagedAgentIdentity(agent.adapterType, agent.adapterConfig, run.runtimeMode === "native" ? run.driverKind : undefined)
    ? await agentIdentityService(db).ensureAgentIdentity(agent.companyId, agent.id)
    : undefined;
  const identityRedactor = createAgentIdentityRedactor(agentIdentity?.privateKeyPem);
  onIdentityRedactorPrepared(identityRedactor);
  if (agentIdentity) secretKeys.add("PAPERCLIP_AGENT_PRIVATE_KEY");
  return {
    prepared: true as const,
    mergedConfig, configSnapshot, runScopedMentionedSkillKeys, githubSelection, useHostGitHub,
    resolvedConfig, configuredTaskEnvironment, secretKeys, secretManifest,
    runtimeSkillEntries, nativeRunnerPreparationSpans, runtimeConfig, agentIdentity,
  };
}
