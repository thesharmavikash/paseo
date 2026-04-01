import net from "node:net";
import type { ServiceRouteEntry, ServiceRouteStore } from "./service-proxy.js";

export interface ServiceStatusEntry {
  serviceName: string;
  hostname: string;
  port: number;
  status: "running" | "stopped";
}

type RouteHealthState = {
  status: ServiceStatusEntry["status"] | null;
  consecutiveFailures: number;
  registeredAt: number;
};

export class ServiceHealthMonitor {
  private readonly routeStore: ServiceRouteStore;
  private readonly onChange: (
    workspaceId: string,
    services: ServiceStatusEntry[],
  ) => void;
  private readonly pollIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly graceMs: number;
  private readonly failuresBeforeStopped: number;
  private readonly routeStates = new Map<string, RouteHealthState>();
  private readonly lastEmittedSnapshots = new Map<string, string>();

  private intervalHandle: NodeJS.Timeout | null = null;
  private pollInFlight = false;

  constructor({
    routeStore,
    onChange,
    pollIntervalMs = 3_000,
    probeTimeoutMs = 500,
    graceMs = 5_000,
    failuresBeforeStopped = 2,
  }: {
    routeStore: ServiceRouteStore;
    onChange: (workspaceId: string, services: ServiceStatusEntry[]) => void;
    pollIntervalMs?: number;
    probeTimeoutMs?: number;
    graceMs?: number;
    failuresBeforeStopped?: number;
  }) {
    this.routeStore = routeStore;
    this.onChange = onChange;
    this.pollIntervalMs = pollIntervalMs;
    this.probeTimeoutMs = probeTimeoutMs;
    this.graceMs = graceMs;
    this.failuresBeforeStopped = failuresBeforeStopped;
  }

  start(): void {
    if (this.intervalHandle) {
      return;
    }

    const now = Date.now();
    for (const route of this.routeStore.listRoutes()) {
      this.getOrCreateState(route.hostname, now);
    }

    this.intervalHandle = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.pollInFlight) {
      return;
    }

    this.pollInFlight = true;
    try {
      const routes = this.routeStore.listRoutes();
      const activeHostnames = new Set(routes.map((route) => route.hostname));
      const changedWorkspaceIds = new Set<string>();
      const now = Date.now();

      for (const route of routes) {
        const state = this.getOrCreateState(route.hostname, now);
        if (now - state.registeredAt < this.graceMs) {
          continue;
        }

        const isHealthy = await this.probeRoute(route.port);
        const previousStatus = state.status;

        if (isHealthy) {
          state.consecutiveFailures = 0;
          state.status = "running";
        } else {
          state.consecutiveFailures += 1;
          if (state.consecutiveFailures >= this.failuresBeforeStopped) {
            state.status = "stopped";
          }
        }

        if (state.status !== null && state.status !== previousStatus) {
          changedWorkspaceIds.add(route.workspaceId);
        }
      }

      this.pruneRemovedRoutes(activeHostnames);

      for (const workspaceId of changedWorkspaceIds) {
        const services = this.buildWorkspaceServiceList(workspaceId);
        const snapshot = JSON.stringify(services);
        if (snapshot === this.lastEmittedSnapshots.get(workspaceId)) {
          continue;
        }

        this.lastEmittedSnapshots.set(workspaceId, snapshot);
        this.onChange(workspaceId, services);
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private getOrCreateState(hostname: string, registeredAt: number): RouteHealthState {
    const existing = this.routeStates.get(hostname);
    if (existing) {
      return existing;
    }

    const state: RouteHealthState = {
      status: null,
      consecutiveFailures: 0,
      registeredAt,
    };
    this.routeStates.set(hostname, state);
    return state;
  }

  private pruneRemovedRoutes(activeHostnames: Set<string>): void {
    for (const hostname of this.routeStates.keys()) {
      if (activeHostnames.has(hostname)) {
        continue;
      }
      this.routeStates.delete(hostname);
    }
  }

  private buildWorkspaceServiceList(workspaceId: string): ServiceStatusEntry[] {
    return this.routeStore
      .listRoutesForWorkspace(workspaceId)
      .flatMap((route) => {
        const state = this.routeStates.get(route.hostname);
        if (!state?.status) {
          return [];
        }
        return [this.toServiceStatusEntry(route, state.status)];
      });
  }

  getStatusForHostname(hostname: string): ServiceStatusEntry["status"] | null {
    return this.routeStates.get(hostname)?.status ?? null;
  }

  private toServiceStatusEntry(
    route: ServiceRouteEntry,
    status: ServiceStatusEntry["status"],
  ): ServiceStatusEntry {
    return {
      serviceName: route.serviceName,
      hostname: route.hostname,
      port: route.port,
      status,
    };
  }

  private probeRoute(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      let settled = false;

      const finish = (healthy: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        resolve(healthy);
      };

      socket.setTimeout(this.probeTimeoutMs);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    });
  }
}
