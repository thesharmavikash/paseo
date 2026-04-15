import type pino from "pino";

import type { ManagedAgent } from "./agent/agent-manager.js";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentPersistenceHandle, AgentSessionConfig } from "./agent/agent-sdk-types.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import {
  buildConfigOverrides,
  buildSessionConfig,
  extractTimestamps,
  toAgentPersistenceHandle,
} from "./persistence-hooks.js";

const pendingAgentBootstrapLoads = new Map<string, Promise<ManagedAgent>>();

export type AgentLoadingServiceOptions = {
  agentManager: Pick<
    AgentManager,
    | "createAgent"
    | "getAgent"
    | "hydrateTimelineFromProvider"
    | "reloadAgentSession"
    | "resumeAgentFromPersistence"
  >;
  agentStorage: Pick<AgentStorage, "get">;
  logger: pino.Logger;
};

// Coordinates cold loads, explicit resumes, and refreshes for persisted agents.
export class AgentLoadingService {
  private readonly agentManager: AgentLoadingServiceOptions["agentManager"];
  private readonly agentStorage: AgentLoadingServiceOptions["agentStorage"];
  private readonly logger: pino.Logger;

  constructor(options: AgentLoadingServiceOptions) {
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.logger = options.logger.child({ component: "agent-loading" });
  }

  async ensureAgentLoaded(options: { agentId: string }): Promise<ManagedAgent> {
    const existing = this.agentManager.getAgent(options.agentId);
    if (existing) {
      return existing;
    }

    const inflight = pendingAgentBootstrapLoads.get(options.agentId);
    if (inflight) {
      return inflight;
    }

    const initPromise = this.loadStoredAgent(options);
    pendingAgentBootstrapLoads.set(options.agentId, initPromise);

    try {
      return await initPromise;
    } finally {
      pendingAgentBootstrapLoads.delete(options.agentId);
    }
  }

  async resumeAgent(options: {
    handle: AgentPersistenceHandle;
    overrides?: Partial<AgentSessionConfig>;
  }): Promise<ManagedAgent> {
    const snapshot = await this.agentManager.resumeAgentFromPersistence(
      options.handle,
      options.overrides,
    );
    await this.agentManager.hydrateTimelineFromProvider(snapshot.id);
    return snapshot;
  }

  async refreshAgent(options: { agentId: string }): Promise<ManagedAgent> {
    const existing = this.agentManager.getAgent(options.agentId);
    if (existing) {
      if (!existing.persistence) {
        return existing;
      }

      const snapshot = await this.agentManager.reloadAgentSession(options.agentId);
      await this.agentManager.hydrateTimelineFromProvider(snapshot.id);
      return snapshot;
    }

    const record = await this.agentStorage.get(options.agentId);
    if (!record) {
      throw new Error(`Agent not found: ${options.agentId}`);
    }

    const handle = toAgentPersistenceHandle(this.logger, record.persistence);
    if (!handle) {
      throw new Error(`Agent ${options.agentId} cannot be refreshed because it lacks persistence`);
    }

    const snapshot = await this.agentManager.resumeAgentFromPersistence(
      handle,
      buildConfigOverrides(record),
      options.agentId,
      extractTimestamps(record),
    );
    await this.agentManager.hydrateTimelineFromProvider(snapshot.id);
    return snapshot;
  }

  private async loadStoredAgent(options: { agentId: string }): Promise<ManagedAgent> {
    const record = await this.agentStorage.get(options.agentId);
    if (!record) {
      throw new Error(`Agent not found: ${options.agentId}`);
    }

    const handle = toAgentPersistenceHandle(this.logger, record.persistence);
    let snapshot: ManagedAgent;
    if (handle) {
      snapshot = await this.agentManager.resumeAgentFromPersistence(
        handle,
        buildConfigOverrides(record),
        options.agentId,
        extractTimestamps(record),
      );
      this.logger.info(
        { agentId: options.agentId, provider: record.provider },
        "Agent resumed from persistence",
      );
    } else {
      const sessionConfig = buildSessionConfig(record);
      if (!sessionConfig) {
        throw new Error(
          `Agent ${options.agentId} has an invalid provider '${record.provider}' and cannot be loaded`,
        );
      }
      snapshot = await this.agentManager.createAgent(sessionConfig, options.agentId, {
        labels: record.labels,
      });
      this.logger.info(
        { agentId: options.agentId, provider: record.provider },
        "Agent created from stored config",
      );
    }

    await this.agentManager.hydrateTimelineFromProvider(snapshot.id);
    return snapshot;
  }
}
