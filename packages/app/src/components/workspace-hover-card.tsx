import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactElement,
} from "react";
import { Dimensions, Platform, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ExternalLink, FolderGit2, GitPullRequest, Monitor } from "lucide-react-native";
import { Pressable } from "react-native";
import { Portal } from "@gorhom/portal";
import { useBottomSheetModalInternal } from "@gorhom/bottom-sheet";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { type PrHint, useWorkspacePrHint } from "@/hooks/use-checkout-pr-status-query";
import { openExternalUrl } from "@/utils/open-external-url";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { shouldRenderSyncedStatusLoader } from "@/utils/status-loader";
import { SyncedLoader } from "@/components/synced-loader";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function measureElement(element: View): Promise<Rect> {
  return new Promise((resolve) => {
    element.measureInWindow((x, y, width, height) => {
      resolve({ x, y, width, height });
    });
  });
}

function computeHoverCardPosition({
  triggerRect,
  contentSize,
  displayArea,
  offset,
}: {
  triggerRect: Rect;
  contentSize: { width: number; height: number };
  displayArea: Rect;
  offset: number;
}): { x: number; y: number } {
  let x = triggerRect.x + triggerRect.width + offset;
  let y = triggerRect.y;

  // If it overflows right, try left
  if (x + contentSize.width > displayArea.width - 8) {
    x = triggerRect.x - contentSize.width - offset;
  }

  // Constrain to screen
  const padding = 8;
  x = Math.max(padding, Math.min(displayArea.width - contentSize.width - padding, x));
  y = Math.max(
    displayArea.y + padding,
    Math.min(displayArea.y + displayArea.height - contentSize.height - padding, y),
  );

  return { x, y };
}

const HOVER_GRACE_MS = 100;
const HOVER_CARD_WIDTH = 260;

interface WorkspaceHoverCardProps {
  workspace: SidebarWorkspaceEntry;
  isDragging: boolean;
}

export function WorkspaceHoverCard({
  workspace,
  isDragging,
  children,
}: PropsWithChildren<WorkspaceHoverCardProps>): ReactElement {
  // Desktop-only: skip on non-web platforms
  if (Platform.OS !== "web") {
    return <>{children}</>;
  }

  return (
    <WorkspaceHoverCardDesktop workspace={workspace} isDragging={isDragging}>
      {children}
    </WorkspaceHoverCardDesktop>
  );
}

function WorkspaceHoverCardDesktop({
  workspace,
  isDragging,
  children,
}: PropsWithChildren<WorkspaceHoverCardProps>): ReactElement {
  const triggerRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerHoveredRef = useRef(false);
  const contentHoveredRef = useRef(false);

  const hasServices = workspace.services.length > 0;

  const clearGraceTimer = useCallback(() => {
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    clearGraceTimer();
    graceTimerRef.current = setTimeout(() => {
      if (!triggerHoveredRef.current && !contentHoveredRef.current) {
        setOpen(false);
      }
      graceTimerRef.current = null;
    }, HOVER_GRACE_MS);
  }, [clearGraceTimer]);

  const handleTriggerEnter = useCallback(() => {
    triggerHoveredRef.current = true;
    clearGraceTimer();
    if (!isDragging && hasServices) {
      setOpen(true);
    }
  }, [clearGraceTimer, isDragging, hasServices]);

  const handleTriggerLeave = useCallback(() => {
    triggerHoveredRef.current = false;
    scheduleClose();
  }, [scheduleClose]);

  const handleContentEnter = useCallback(() => {
    contentHoveredRef.current = true;
    clearGraceTimer();
  }, [clearGraceTimer]);

  const handleContentLeave = useCallback(() => {
    contentHoveredRef.current = false;
    scheduleClose();
  }, [scheduleClose]);

  // Close when drag starts
  useEffect(() => {
    if (isDragging) {
      clearGraceTimer();
      setOpen(false);
    }
  }, [isDragging, clearGraceTimer]);

  // When hasServices becomes true while trigger is already hovered, open the card.
  useEffect(() => {
    if (!hasServices || isDragging) return;
    if (triggerHoveredRef.current) {
      setOpen(true);
    }
  }, [hasServices, isDragging]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearGraceTimer();
    };
  }, [clearGraceTimer]);

  return (
    <View
      ref={triggerRef}
      collapsable={false}
      onPointerEnter={handleTriggerEnter}
      onPointerLeave={handleTriggerLeave}
    >
      {children}
      {open && hasServices ? (
        <WorkspaceHoverCardContent
          workspace={workspace}
          triggerRef={triggerRef}
          onContentEnter={handleContentEnter}
          onContentLeave={handleContentLeave}
        />
      ) : null}
    </View>
  );
}

const GITHUB_PR_STATE_LABELS: Record<PrHint["state"], string> = {
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};

function HoverCardStatusIndicator({
  workspace,
}: {
  workspace: SidebarWorkspaceEntry;
}): ReactElement | null {
  const { theme } = useUnistyles();
  const showSyncedLoader = shouldRenderSyncedStatusLoader({ bucket: workspace.statusBucket });

  if (showSyncedLoader) {
    return <SyncedLoader size={11} color={theme.colors.palette.amber[500]} />;
  }

  const KindIcon =
    workspace.workspaceKind === "local_checkout"
      ? Monitor
      : workspace.workspaceKind === "worktree"
        ? FolderGit2
        : null;
  if (!KindIcon) return null;

  const dotColor = getStatusDotColor({ theme, bucket: workspace.statusBucket, showDoneAsInactive: false });

  return (
    <View style={styles.hoverStatusIcon}>
      <KindIcon size={14} color={theme.colors.foregroundMuted} />
      {dotColor ? (
        <View
          style={[
            styles.hoverStatusDotOverlay,
            {
              backgroundColor: dotColor,
              borderColor: theme.colors.surface1,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

function WorkspaceHoverCardContent({
  workspace,
  triggerRef,
  onContentEnter,
  onContentLeave,
}: {
  workspace: SidebarWorkspaceEntry;
  triggerRef: React.RefObject<View | null>;
  onContentEnter: () => void;
  onContentLeave: () => void;
}): ReactElement | null {
  const { theme } = useUnistyles();
  const bottomSheetInternal = useBottomSheetModalInternal(true);
  const [triggerRect, setTriggerRect] = useState<Rect | null>(null);
  const [contentSize, setContentSize] = useState<{ width: number; height: number } | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const prHint = useWorkspacePrHint({
    serverId: workspace.serverId,
    cwd: workspace.workspaceId,
    enabled: workspace.workspaceKind !== "directory",
  });

  // Measure trigger — same pattern as tooltip.tsx
  useEffect(() => {
    if (!triggerRef.current) return;

    let cancelled = false;
    measureElement(triggerRef.current).then((rect) => {
      if (cancelled) return;
      setTriggerRect(rect);
    });

    return () => {
      cancelled = true;
    };
  }, [triggerRef]);

  // Compute position when both measurements are available
  useEffect(() => {
    if (!triggerRect || !contentSize) return;
    const { width: screenWidth, height: screenHeight } = Dimensions.get("window");
    const displayArea = { x: 0, y: 0, width: screenWidth, height: screenHeight };
    const result = computeHoverCardPosition({
      triggerRect,
      contentSize,
      displayArea,
      offset: 4,
    });
    setPosition(result);
  }, [triggerRect, contentSize]);

  const handleLayout = useCallback(
    (event: { nativeEvent: { layout: { width: number; height: number } } }) => {
      const { width, height } = event.nativeEvent.layout;
      setContentSize({ width, height });
    },
    [],
  );

  return (
    <Portal hostName={bottomSheetInternal?.hostName}>
      <View pointerEvents="box-none" style={styles.portalOverlay}>
        <Animated.View
          entering={FadeIn.duration(80)}
          exiting={FadeOut.duration(80)}
          collapsable={false}
          onLayout={handleLayout}
          onPointerEnter={onContentEnter}
          onPointerLeave={onContentLeave}
          accessibilityRole="menu"
          accessibilityLabel="Workspace services"
          testID="workspace-hover-card"
          style={[
            styles.card,
            {
              width: HOVER_CARD_WIDTH,
              position: "absolute",
              top: position?.y ?? -9999,
              left: position?.x ?? -9999,
            },
          ]}
        >
          <View style={styles.cardHeader}>
            <HoverCardStatusIndicator workspace={workspace} />
            <Text style={styles.cardTitle} numberOfLines={1} testID="hover-card-workspace-name">
              {workspace.name}
            </Text>
          </View>
          {workspace.diffStat ? (
            <View style={styles.cardMetaRow}>
              <Text style={styles.diffStatAdditions}>+{workspace.diffStat.additions}</Text>
              <Text style={styles.diffStatDeletions}>-{workspace.diffStat.deletions}</Text>
            </View>
          ) : null}
          {prHint ? (
            <Pressable
              style={styles.cardMetaRow}
              onPress={() => void openExternalUrl(prHint.url)}
            >
              <GitPullRequest size={12} color={theme.colors.foregroundMuted} />
              <Text style={styles.prBadgeText} numberOfLines={1}>
                #{prHint.number} · {GITHUB_PR_STATE_LABELS[prHint.state]}
              </Text>
            </Pressable>
          ) : null}
          <View style={styles.separator} />
          <View style={styles.serviceList} testID="hover-card-service-list">
            {workspace.services.map((service) => (
              <Pressable
                key={service.hostname}
                accessibilityRole="link"
                accessibilityLabel={`${service.serviceName} service`}
                testID={`hover-card-service-${service.serviceName}`}
                style={({ hovered }) => [
                  styles.serviceRow,
                  hovered && styles.serviceRowHovered,
                ]}
                onPress={() => {
                  if (service.url) {
                    void openExternalUrl(service.url);
                  }
                }}
                disabled={!service.url}
              >
                <View
                  testID={`hover-card-service-status-${service.serviceName}`}
                  accessibilityLabel={service.status === "running" ? "Running" : "Stopped"}
                  style={[
                    styles.statusDot,
                    {
                      backgroundColor:
                        service.status === "running"
                          ? theme.colors.palette.green[500]
                          : theme.colors.palette.red[500],
                    },
                  ]}
                />
                <Text style={styles.serviceName} numberOfLines={1}>
                  {service.serviceName}
                </Text>
                {service.url ? (
                  <ExternalLink size={12} color={theme.colors.foregroundMuted} />
                ) : null}
              </Pressable>
            ))}
          </View>
        </Animated.View>
      </View>
    </Portal>
  );
}

const styles = StyleSheet.create((theme) => ({
  portalOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1000,
  },
  card: {
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[2],
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 8,
    zIndex: 1000,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    flex: 1,
    minWidth: 0,
  },
  cardMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  diffStatAdditions: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.palette.green[400],
  },
  diffStatDeletions: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.palette.red[500],
  },
  prBadgeText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  hoverStatusIcon: {
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  hoverStatusDotOverlay: {
    position: "absolute",
    bottom: -1,
    right: -1,
    width: 6,
    height: 6,
    borderRadius: 3,
    borderWidth: 1,
  },
  separator: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  serviceList: {
    paddingTop: theme.spacing[1],
  },
  serviceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    minHeight: 32,
  },
  serviceRowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    flexShrink: 0,
  },
  serviceName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flex: 1,
    minWidth: 0,
  },
}));
