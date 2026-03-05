import { usePathname } from 'expo-router'
import { WorkspaceScreen } from '@/screens/workspace/workspace-screen'
import {
  parseHostWorkspaceRouteFromPathname,
  parseHostWorkspaceOpenIntentFromPathname,
} from '@/utils/host-routes'

export default function HostWorkspaceLayout() {
  const expoPathname = usePathname()
  const resolvedPathname = expoPathname
  const activeRoute = parseHostWorkspaceRouteFromPathname(resolvedPathname)
  const serverId = activeRoute?.serverId ?? ''
  const workspaceId = activeRoute?.workspaceId ?? ''
  const openIntent = parseHostWorkspaceOpenIntentFromPathname(resolvedPathname)

  return (
    <WorkspaceScreen
      key={`${serverId}:${workspaceId}`}
      serverId={serverId}
      workspaceId={workspaceId}
      openIntent={openIntent}
    />
  )
}
