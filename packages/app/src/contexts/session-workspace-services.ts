import type { ServiceStatusUpdateMessage } from "@server/shared/messages";
import type { WorkspaceDescriptor } from "@/stores/session-store";

export function patchWorkspaceServices(
  workspaces: Map<string, WorkspaceDescriptor>,
  update: ServiceStatusUpdateMessage["payload"],
): Map<string, WorkspaceDescriptor> {
  const existing = workspaces.get(update.workspaceId);
  if (!existing) {
    return workspaces;
  }

  const next = new Map(workspaces);
  next.set(update.workspaceId, {
    ...existing,
    services: update.services.map((s) => ({ ...s })),
  });
  return next;
}
