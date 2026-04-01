import type {
  ServiceStatusUpdateMessage,
  SessionOutboundMessage,
  WorkspaceServicePayload,
} from "../shared/messages.js";
import type { ServiceStatusEntry } from "./service-health-monitor.js";
import type { ServiceRouteStore } from "./service-proxy.js";

type SessionEmitter = {
  emit(message: SessionOutboundMessage): void;
};

function resolveDaemonPort(daemonPort: number | null | (() => number | null)): number | null {
  if (typeof daemonPort === "function") {
    return daemonPort();
  }
  return daemonPort;
}

function toServiceUrl(hostname: string, daemonPort: number | null): string | null {
  if (daemonPort === null) {
    return null;
  }
  return `http://${hostname}:${daemonPort}`;
}

export function buildWorkspaceServicePayloads(
  routeStore: ServiceRouteStore,
  workspaceId: string,
  daemonPort: number | null,
  resolveStatus?: (hostname: string) => "running" | "stopped" | null,
): WorkspaceServicePayload[] {
  return routeStore.listRoutesForWorkspace(workspaceId).map((route) => ({
    serviceName: route.serviceName,
    hostname: route.hostname,
    port: route.port,
    url: toServiceUrl(route.hostname, daemonPort),
    status: resolveStatus?.(route.hostname) ?? "stopped",
  }));
}

function buildServiceStatusUpdateMessage(params: {
  workspaceId: string;
  services: WorkspaceServicePayload[];
}): ServiceStatusUpdateMessage {
  return {
    type: "service_status_update",
    payload: {
      workspaceId: params.workspaceId,
      services: params.services,
    },
  };
}

export function createServiceStatusEmitter({
  sessions,
  routeStore,
  daemonPort,
}: {
  sessions: () => SessionEmitter[];
  routeStore: ServiceRouteStore;
  daemonPort: number | null | (() => number | null);
}): (workspaceId: string, services: ServiceStatusEntry[]) => void {
  return (workspaceId, services) => {
    const resolvedDaemonPort = resolveDaemonPort(daemonPort);
    const serviceStatusByHostname = new Map(
      services.map((service) => [service.hostname, service.status] as const),
    );

    const projected = buildWorkspaceServicePayloads(routeStore, workspaceId, resolvedDaemonPort).map(
      (service) => ({
        ...service,
        status: serviceStatusByHostname.get(service.hostname) ?? service.status,
      }),
    );

    const message = buildServiceStatusUpdateMessage({
      workspaceId,
      services: projected,
    });

    for (const session of sessions()) {
      session.emit(message);
    }
  };
}
