import { describe, expect, it, vi } from "vitest";
import { ServiceRouteStore } from "./service-proxy.js";
import {
  buildWorkspaceServicePayloads,
  createServiceStatusEmitter,
} from "./service-status-projection.js";

describe("service-status-projection", () => {
  it("buildWorkspaceServicePayloads returns service payloads from workspace routes", () => {
    const routeStore = new ServiceRouteStore();
    routeStore.registerRoute({
      hostname: "api.localhost",
      port: 3001,
      workspaceId: "workspace-a",
      serviceName: "api",
    });
    routeStore.registerRoute({
      hostname: "docs.localhost",
      port: 3002,
      workspaceId: "workspace-b",
      serviceName: "docs",
    });
    routeStore.registerRoute({
      hostname: "web.localhost",
      port: 3003,
      workspaceId: "workspace-a",
      serviceName: "web",
    });

    expect(buildWorkspaceServicePayloads(routeStore, "workspace-a", 6767)).toEqual([
      {
        serviceName: "api",
        hostname: "api.localhost",
        port: 3001,
        url: "http://api.localhost:6767",
        status: "stopped",
      },
      {
        serviceName: "web",
        hostname: "web.localhost",
        port: 3003,
        url: "http://web.localhost:6767",
        status: "stopped",
      },
    ]);
  });

  it("computes URLs with and without a daemon port", () => {
    const routeStore = new ServiceRouteStore();
    routeStore.registerRoute({
      hostname: "api.localhost",
      port: 3001,
      workspaceId: "workspace-a",
      serviceName: "api",
    });

    expect(buildWorkspaceServicePayloads(routeStore, "workspace-a", 6767)).toEqual([
      {
        serviceName: "api",
        hostname: "api.localhost",
        port: 3001,
        url: "http://api.localhost:6767",
        status: "stopped",
      },
    ]);

    expect(buildWorkspaceServicePayloads(routeStore, "workspace-a", null)).toEqual([
      {
        serviceName: "api",
        hostname: "api.localhost",
        port: 3001,
        url: null,
        status: "stopped",
      },
    ]);
  });

  it("createServiceStatusEmitter emits updates to all active sessions", () => {
    const routeStore = new ServiceRouteStore();
    routeStore.registerRoute({
      hostname: "api.localhost",
      port: 3001,
      workspaceId: "workspace-a",
      serviceName: "api",
    });

    const sessionA = { emit: vi.fn() };
    const sessionB = { emit: vi.fn() };

    const emitUpdate = createServiceStatusEmitter({
      sessions: () => [sessionA, sessionB],
      routeStore,
      daemonPort: 6767,
    });

    emitUpdate("workspace-a", [
      {
        serviceName: "api",
        hostname: "api.localhost",
        port: 3001,
        status: "running",
      },
    ]);

    expect(sessionA.emit).toHaveBeenCalledWith({
      type: "service_status_update",
      payload: {
        workspaceId: "workspace-a",
        services: [
          {
            serviceName: "api",
            hostname: "api.localhost",
            port: 3001,
            url: "http://api.localhost:6767",
            status: "running",
          },
        ],
      },
    });
    expect(sessionB.emit).toHaveBeenCalledWith({
      type: "service_status_update",
      payload: {
        workspaceId: "workspace-a",
        services: [
          {
            serviceName: "api",
            hostname: "api.localhost",
            port: 3001,
            url: "http://api.localhost:6767",
            status: "running",
          },
        ],
      },
    });
  });

  it("uses resolveStatus to set initial service status when provided", () => {
    const routeStore = new ServiceRouteStore();
    routeStore.registerRoute({
      hostname: "api.localhost",
      port: 3001,
      workspaceId: "workspace-a",
      serviceName: "api",
    });
    routeStore.registerRoute({
      hostname: "web.localhost",
      port: 3003,
      workspaceId: "workspace-a",
      serviceName: "web",
    });

    const statuses = new Map<string, "running" | "stopped">([
      ["api.localhost", "running"],
    ]);

    expect(
      buildWorkspaceServicePayloads(routeStore, "workspace-a", 6767, (hostname) =>
        statuses.get(hostname) ?? null,
      ),
    ).toEqual([
      {
        serviceName: "api",
        hostname: "api.localhost",
        port: 3001,
        url: "http://api.localhost:6767",
        status: "running",
      },
      {
        serviceName: "web",
        hostname: "web.localhost",
        port: 3003,
        url: "http://web.localhost:6767",
        status: "stopped",
      },
    ]);
  });

  it("emits workspace-specific batches", () => {
    const routeStore = new ServiceRouteStore();
    routeStore.registerRoute({
      hostname: "api.localhost",
      port: 3001,
      workspaceId: "workspace-a",
      serviceName: "api",
    });
    routeStore.registerRoute({
      hostname: "web.localhost",
      port: 3002,
      workspaceId: "workspace-a",
      serviceName: "web",
    });
    routeStore.registerRoute({
      hostname: "docs.localhost",
      port: 3003,
      workspaceId: "workspace-b",
      serviceName: "docs",
    });

    const session = { emit: vi.fn() };
    const emitUpdate = createServiceStatusEmitter({
      sessions: () => [session],
      routeStore,
      daemonPort: null,
    });

    emitUpdate("workspace-a", [
      {
        serviceName: "api",
        hostname: "api.localhost",
        port: 3001,
        status: "running",
      },
      {
        serviceName: "web",
        hostname: "web.localhost",
        port: 3002,
        status: "stopped",
      },
    ]);

    emitUpdate("workspace-b", [
      {
        serviceName: "docs",
        hostname: "docs.localhost",
        port: 3003,
        status: "running",
      },
    ]);

    expect(session.emit).toHaveBeenNthCalledWith(1, {
      type: "service_status_update",
      payload: {
        workspaceId: "workspace-a",
        services: [
          {
            serviceName: "api",
            hostname: "api.localhost",
            port: 3001,
            url: null,
            status: "running",
          },
          {
            serviceName: "web",
            hostname: "web.localhost",
            port: 3002,
            url: null,
            status: "stopped",
          },
        ],
      },
    });
    expect(session.emit).toHaveBeenNthCalledWith(2, {
      type: "service_status_update",
      payload: {
        workspaceId: "workspace-b",
        services: [
          {
            serviceName: "docs",
            hostname: "docs.localhost",
            port: 3003,
            url: null,
            status: "running",
          },
        ],
      },
    });
  });

});
