import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Session } from "./session.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";

const { watchCalls, watchMock } = vi.hoisted(() => {
  const hoistedWatchCalls: Array<{
    path: string;
    listener: () => void;
    close: ReturnType<typeof vi.fn>;
  }> = [];

  const hoistedWatchMock = vi.fn(
    (watchPath: string, _options: { recursive: boolean }, listener: () => void) => {
      const close = vi.fn();
      const watcher = {
        close,
        on: vi.fn().mockReturnThis(),
      };
      hoistedWatchCalls.push({
        path: watchPath,
        listener,
        close,
      });
      return watcher as any;
    },
  );

  return {
    watchCalls: hoistedWatchCalls,
    watchMock: hoistedWatchMock,
  };
});

const resolveCheckoutGitDirMock = vi.hoisted(() => vi.fn(async () => null));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    watch: watchMock,
  };
});

vi.mock("./checkout-git-utils.js", () => ({
  READ_ONLY_GIT_ENV: {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
  },
  resolveCheckoutGitDir: resolveCheckoutGitDirMock,
  toCheckoutError: vi.fn((error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  })),
}));

vi.mock("@getpaseo/highlight", () => ({
  highlightCode: vi.fn(async () => ""),
  isLanguageSupported: vi.fn(() => false),
}));

function createSessionForWorkspaceGitWatchTests(): {
  session: Session;
  emitted: Array<{ type: string; payload: unknown }>;
  projects: Map<number, ReturnType<typeof createPersistedProjectRecord>>;
  workspaces: Map<number, ReturnType<typeof createPersistedWorkspaceRecord>>;
  backgroundGitFetchManager: {
    subscribe: ReturnType<typeof vi.fn>;
    subscriptions: Array<{
      params: { repoGitRoot: string; cwd: string };
      listener: () => void;
      unsubscribe: ReturnType<typeof vi.fn>;
    }>;
  };
  logger: {
    child: () => unknown;
    trace: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
} {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const projects = new Map<number, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<number, ReturnType<typeof createPersistedWorkspaceRecord>>();
  let nextProjectId = 1;
  let nextWorkspaceId = 1;
  const backgroundGitFetchSubscriptions: Array<{
    params: { repoGitRoot: string; cwd: string };
    listener: () => void;
    unsubscribe: ReturnType<typeof vi.fn>;
  }> = [];
  const logger = {
    child: () => logger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const backgroundGitFetchManager = {
    subscribe: vi.fn(
      async (params: { repoGitRoot: string; cwd: string }, listener: () => void) => {
        const unsubscribe = vi.fn();
        backgroundGitFetchSubscriptions.push({
          params,
          listener,
          unsubscribe,
        });
        return { unsubscribe };
      },
    ),
  };

  const session = new Session({
    clientId: "test-client",
    onMessage: (message) => emitted.push(message as any),
    logger: logger as any,
    downloadTokenStore: {} as any,
    pushTokenStore: {} as any,
    paseoHome: "/tmp/paseo-test",
    agentManager: {
      subscribe: () => () => {},
      listAgents: () => [],
      getAgent: () => null,
    } as any,
    agentStorage: {
      list: async () => [],
      get: async () => null,
    } as any,
    projectRegistry: {
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => Array.from(projects.values()),
      get: async (id: number) => projects.get(id) ?? null,
      insert: async (record: Omit<ReturnType<typeof createPersistedProjectRecord>, "id">) => {
        const id = nextProjectId++;
        projects.set(id, createPersistedProjectRecord({ id, ...record }));
        return id;
      },
      upsert: async (record: any) => {
        projects.set(record.id, record);
      },
      archive: async (id: number, archivedAt: string) => {
        const existing = projects.get(id);
        if (!existing) {
          return;
        }
        projects.set(id, {
          ...existing,
          archivedAt,
          updatedAt: archivedAt,
        });
      },
      remove: async (id: number) => {
        projects.delete(id);
      },
    } as any,
    workspaceRegistry: {
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => Array.from(workspaces.values()),
      get: async (id: number) => workspaces.get(id) ?? null,
      insert: async (record: Omit<ReturnType<typeof createPersistedWorkspaceRecord>, "id">) => {
        const id = nextWorkspaceId++;
        workspaces.set(id, createPersistedWorkspaceRecord({ id, ...record }));
        return id;
      },
      upsert: async (record: any) => {
        workspaces.set(record.id, record);
      },
      archive: async (id: number, archivedAt: string) => {
        const existing = workspaces.get(id);
        if (!existing) {
          return;
        }
        workspaces.set(id, {
          ...existing,
          archivedAt,
          updatedAt: archivedAt,
        });
      },
      remove: async (id: number) => {
        workspaces.delete(id);
      },
    } as any,
    checkoutDiffManager: {
      subscribe: async () => ({
        initial: { cwd: "/tmp", files: [], error: null },
        unsubscribe: () => {},
      }),
      scheduleRefreshForCwd: () => {},
      getMetrics: () => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      }),
      dispose: () => {},
    } as any,
    backgroundGitFetchManager: backgroundGitFetchManager as any,
    createAgentMcpTransport: async () => {
      throw new Error("not used");
    },
    stt: null,
    tts: null,
    terminalManager: null,
  }) as any;

  (session as any).listAgentPayloads = async () => [];

  return {
    session,
    emitted,
    projects,
    workspaces,
    backgroundGitFetchManager: {
      subscribe: backgroundGitFetchManager.subscribe,
      subscriptions: backgroundGitFetchSubscriptions,
    },
    logger,
  };
}

function seedGitWorkspace(input: {
  projects: Map<number, ReturnType<typeof createPersistedProjectRecord>>;
  workspaces: Map<number, ReturnType<typeof createPersistedWorkspaceRecord>>;
  projectId: number;
  workspaceId: number;
  cwd: string;
  name: string;
}) {
  input.projects.set(
    input.projectId,
    createPersistedProjectRecord({
      id: input.projectId,
      directory: "/tmp/repo",
      displayName: "repo",
      kind: "git",
      gitRemote: "https://github.com/acme/repo.git",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
  );
  input.workspaces.set(
    input.workspaceId,
    createPersistedWorkspaceRecord({
      id: input.workspaceId,
      projectId: input.projectId,
      directory: input.cwd,
      displayName: input.name,
      kind: "checkout",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
  );
}

describe("workspace git watch targets", () => {
  beforeEach(() => {
    watchCalls.length = 0;
    watchMock.mockClear();
    resolveCheckoutGitDirMock.mockReset();
    resolveCheckoutGitDirMock.mockResolvedValue(null);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("debounces watcher events and skips unchanged branch/diff snapshots", async () => {
    const { session, emitted, projects, workspaces } = createSessionForWorkspaceGitWatchTests();
    const sessionAny = session as any;
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: 1,
      workspaceId: 10,
      cwd: "/tmp/repo",
      name: "main",
    });

    resolveCheckoutGitDirMock.mockResolvedValue("/tmp/repo/.git");
    sessionAny.workspaceUpdatesSubscription = {
      subscriptionId: "sub-1",
      filter: undefined,
      isBootstrapping: false,
      pendingUpdatesByWorkspaceId: new Map(),
    };

    let descriptor = {
      id: "/tmp/repo",
      projectId: "/tmp/repo",
      projectDisplayName: "repo",
      projectRootPath: "/tmp/repo",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "main",
      status: "done",
      activityAt: null,
      diffStat: { additions: 1, deletions: 0 },
      workspaceDirectory: "/tmp/repo",
    };

    sessionAny.buildWorkspaceDescriptorMap = async () =>
      new Map([[descriptor.id, descriptor]]);

    await sessionAny.primeWorkspaceGitWatchFingerprints([descriptor]);

    expect(watchCalls.map((entry) => entry.path).sort()).toEqual([
      "/tmp/repo/.git/HEAD",
      "/tmp/repo/.git/refs/heads",
    ]);

    watchCalls[0]!.listener();
    watchCalls[1]!.listener();
    await vi.advanceTimersByTimeAsync(500);

    expect(emitted.filter((message) => message.type === "workspace_update")).toHaveLength(0);

    descriptor = {
      ...descriptor,
      name: "renamed-branch",
    };
    watchCalls[0]!.listener();
    await vi.advanceTimersByTimeAsync(500);

    const workspaceUpdates = emitted.filter(
      (message) => message.type === "workspace_update",
    ) as any[];
    expect(workspaceUpdates).toHaveLength(1);
    expect(workspaceUpdates[0]?.payload).toMatchObject({
      kind: "upsert",
      workspace: {
        id: "/tmp/repo",
        name: "renamed-branch",
        diffStat: { additions: 1, deletions: 0 },
      },
    });

    descriptor = {
      ...descriptor,
      diffStat: { additions: 3, deletions: 1 },
    };
    watchCalls[1]!.listener();
    await vi.advanceTimersByTimeAsync(500);

    expect(emitted.filter((message) => message.type === "workspace_update")).toHaveLength(2);

    await session.cleanup();
  });

  test("closes watchers when a workspace is archived and when the session closes", async () => {
    const { session, projects, workspaces } = createSessionForWorkspaceGitWatchTests();
    const sessionAny = session as any;

    seedGitWorkspace({
      projects,
      workspaces,
      projectId: 2,
      workspaceId: 20,
      cwd: "/tmp/repo-one",
      name: "main",
    });
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: 3,
      workspaceId: 30,
      cwd: "/tmp/repo-two",
      name: "main",
    });

    resolveCheckoutGitDirMock.mockImplementation(async (cwd: string) => path.join(cwd, ".git"));

    await sessionAny.primeWorkspaceGitWatchFingerprints([
      {
        id: "/tmp/repo-one",
        projectId: "/tmp/repo-one",
        projectDisplayName: "repo-one",
        projectRootPath: "/tmp/repo-one",
        projectKind: "git",
        workspaceKind: "local_checkout",
        name: "main",
        status: "done",
        activityAt: null,
        workspaceDirectory: "/tmp/repo-one",
      },
    ]);
    expect(sessionAny.workspaceGitWatchTargets.size).toBe(1);
    expect(watchCalls).toHaveLength(2);

    await sessionAny.archiveWorkspaceRecord(20, "2026-03-21T00:00:00.000Z");

    expect(sessionAny.workspaceGitWatchTargets.size).toBe(0);
    expect(watchCalls.every((entry) => entry.close.mock.calls.length === 1)).toBe(true);

    watchCalls.length = 0;
    watchMock.mockClear();

    await sessionAny.primeWorkspaceGitWatchFingerprints([
      {
        id: "/tmp/repo-two",
        projectId: "/tmp/repo-two",
        projectDisplayName: "repo-two",
        projectRootPath: "/tmp/repo-two",
        projectKind: "git",
        workspaceKind: "local_checkout",
        name: "main",
        status: "done",
        activityAt: null,
        workspaceDirectory: "/tmp/repo-two",
      },
    ]);
    expect(sessionAny.workspaceGitWatchTargets.size).toBe(1);
    expect(watchCalls).toHaveLength(2);

    await session.cleanup();

    expect(sessionAny.workspaceGitWatchTargets.size).toBe(0);
    expect(watchCalls.every((entry) => entry.close.mock.calls.length === 1)).toBe(true);
  });

  test("resolves refs from the shared git dir for linked worktrees", async () => {
    const { session } = createSessionForWorkspaceGitWatchTests();
    const sessionAny = session as any;
    const tempDir = mkdtempSync(path.join(tmpdir(), "session-workspace-git-watch-"));
    const gitDir = path.join(tempDir, "repo", ".git", "worktrees", "feature");

    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(gitDir, "commondir"), "../..\n");

    try {
      expect(await sessionAny.resolveWorkspaceGitRefsRoot(gitDir)).toBe(
        path.join(tempDir, "repo", ".git"),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      await session.cleanup();
    }
  });

  test("subscribes to the background fetch manager when a git watch target is created", async () => {
    const { session, projects, workspaces, backgroundGitFetchManager } =
      createSessionForWorkspaceGitWatchTests();
    const sessionAny = session as any;

    seedGitWorkspace({
      projects,
      workspaces,
      projectId: 4,
      workspaceId: 40,
      cwd: "/tmp/repo",
      name: "main",
    });
    resolveCheckoutGitDirMock.mockResolvedValue("/tmp/repo/.git");

    await sessionAny.syncWorkspaceGitWatchTarget("/tmp/repo", { isGit: true });

    expect(backgroundGitFetchManager.subscribe).toHaveBeenCalledWith(
      { repoGitRoot: "/tmp/repo/.git", cwd: "/tmp/repo" },
      expect.any(Function),
    );
    expect(sessionAny.workspaceGitFetchSubscriptions.size).toBe(1);

    await session.cleanup();
  });

  test("stores separate background fetch subscriptions per workspace and unsubscribes removed targets", async () => {
    const { session, projects, workspaces, backgroundGitFetchManager } =
      createSessionForWorkspaceGitWatchTests();
    const sessionAny = session as any;

    seedGitWorkspace({
      projects,
      workspaces,
      projectId: 5,
      workspaceId: 50,
      cwd: "/tmp/repo",
      name: "main",
    });
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: 6,
      workspaceId: 60,
      cwd: "/tmp/repo-feature",
      name: "feature",
    });
    resolveCheckoutGitDirMock.mockImplementation(async (cwd: string) =>
      cwd === "/tmp/repo" ? "/tmp/repo/.git" : "/tmp/repo/.git/worktrees/feature",
    );
    sessionAny.resolveWorkspaceGitRefsRoot = vi.fn(async () => "/tmp/repo/.git");

    await sessionAny.syncWorkspaceGitWatchTarget("/tmp/repo", { isGit: true });
    await sessionAny.syncWorkspaceGitWatchTarget("/tmp/repo-feature", { isGit: true });

    expect(backgroundGitFetchManager.subscribe).toHaveBeenCalledTimes(2);
    expect(backgroundGitFetchManager.subscriptions[0]?.params).toEqual({
      repoGitRoot: "/tmp/repo/.git",
      cwd: "/tmp/repo",
    });
    expect(backgroundGitFetchManager.subscriptions[1]?.params).toEqual({
      repoGitRoot: "/tmp/repo/.git",
      cwd: "/tmp/repo-feature",
    });

    sessionAny.removeWorkspaceGitWatchTarget("/tmp/repo");

    expect(backgroundGitFetchManager.subscriptions[0]?.unsubscribe).toHaveBeenCalledTimes(1);
    expect(backgroundGitFetchManager.subscriptions[1]?.unsubscribe).not.toHaveBeenCalled();
    expect(sessionAny.workspaceGitFetchSubscriptions.size).toBe(1);

    await session.cleanup();
  });

  test("refreshes the workspace when the background fetch manager callback fires and unsubscribes on cleanup", async () => {
    const { session, emitted, projects, workspaces, backgroundGitFetchManager } =
      createSessionForWorkspaceGitWatchTests();
    const sessionAny = session as any;

    seedGitWorkspace({
      projects,
      workspaces,
      projectId: 7,
      workspaceId: 70,
      cwd: "/tmp/repo",
      name: "main",
    });
    resolveCheckoutGitDirMock.mockResolvedValue("/tmp/repo/.git");
    sessionAny.workspaceUpdatesSubscription = {
      subscriptionId: "sub-1",
      filter: undefined,
      isBootstrapping: false,
      pendingUpdatesByWorkspaceId: new Map(),
    };
    sessionAny.reconcileActiveWorkspaceRecords = async () => new Set();

    let descriptor = {
      id: "/tmp/repo",
      projectId: "/tmp/repo",
      projectDisplayName: "repo",
      projectRootPath: "/tmp/repo",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "main",
      status: "done",
      activityAt: null,
      diffStat: { additions: 1, deletions: 0 },
    };

    sessionAny.buildWorkspaceDescriptorMap = async () =>
      new Map([[descriptor.id, descriptor]]);

    await sessionAny.syncWorkspaceGitWatchTarget("/tmp/repo", { isGit: true });
    sessionAny.primeWorkspaceGitWatchFingerprints([descriptor]);

    descriptor = {
      ...descriptor,
      name: "updated-after-fetch",
    };

    backgroundGitFetchManager.subscriptions[0]?.listener();
    await vi.advanceTimersByTimeAsync(500);

    const workspaceUpdates = emitted.filter(
      (message) => message.type === "workspace_update",
    ) as any[];
    expect(workspaceUpdates).toHaveLength(1);
    expect(workspaceUpdates[0]?.payload).toMatchObject({
      kind: "upsert",
      workspace: {
        id: "/tmp/repo",
        name: "updated-after-fetch",
      },
    });

    await session.cleanup();

    expect(backgroundGitFetchManager.subscriptions[0]?.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
