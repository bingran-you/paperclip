import type { Db, chatEndpoints } from "@paperclipai/db";
import type { ToolCredentialSecretRef } from "@paperclipai/shared";
import type { ChatEndpointRuntime } from "../voice/voice-runtime.js";

export type EndpointRow = typeof chatEndpoints.$inferSelect;

export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type DbOrTransaction = Db | DbTransaction;

export type RuntimeContext = {
  credentialFingerprint: string;
  discordGatewayEventQueue?: Promise<void>;
  discordGatewaySequence?: number;
  discordGatewayOwned?: boolean;
  /** Cache identity only; durable command admission rechecks ownership. */
  discordCommandId?: string;
  endpointRuntime?: ChatEndpointRuntime;
  generation: number;
  localEpoch: number;
  version: string;
};

export type LifecycleRuntimeFence = Pick<
  RuntimeContext,
  "credentialFingerprint" | "generation"
>;

export type InboundRuntimeContext = LifecycleRuntimeFence &
  Pick<RuntimeContext, "discordGatewayOwned" | "endpointRuntime">;

export type EndpointRecord = {
  endpoint: EndpointRow;
  assignedAgentName: string;
  connectionName: string;
  applicationId: string;
  credentialSecretRefs: ToolCredentialSecretRef[];
};
