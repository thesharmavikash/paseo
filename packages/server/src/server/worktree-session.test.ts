import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { SessionOutboundMessage } from "./messages.js";
import { ServiceRouteStore } from "./service-proxy.js";
import {
  createPaseoWorktreeInBackground,
  handleCreatePaseoWorktreeRequest,
  handleWorkspaceSetupStatusRequest,
} from "./worktree-session.js";
import { createWorktree } from "../utils/worktree.js";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

function createTerminalManagerStub(options?: {
  createTerminal?: (input: {
    cwd: string;
    name?: string;
    env?: Record<string, string>;
  }) => Promise<any>;
}) {
  const terminals: Array<{
    id: string;
    cwd: string;
    name: string | undefined;
    env: Record<string, string> | undefined;
    sent: string[];
  }> = [];

  return {
    terminals,
    manager: {
      registerCwdEnv: vi.fn(),
      createTerminal: vi.fn(async (input: {
        cwd: string;
        name?: string;
        env?: Record<string, string>;
      }) => {
        if (options?.createTerminal) {
          return options.createTerminal(input);
        }
        const sent: string[] = [];
        const terminal = {
          id: `terminal-${terminals.length + 1}`,
          getState: () => ({
            scrollback: [[{ char: "$" }]],
            grid: [],
          }),
          subscribe: () => () => {},
          send: (message: { type: string; data: string }) => {
            if (message.type === "input") {
              sent.push(message.data);
            }
          },
        };
        terminals.push({
          id: terminal.id,
          cwd: input.cwd,
          name: input.name,
          env: input.env,
          sent,
        });
        return terminal;
      }),
    } as any,
  };
}

function createGitRepo(options?: { paseoConfig?: Record<string, unknown> }) {
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "worktree-session-test-")));
  const repoDir = path.join(tempDir, "repo");
  execSync(`mkdir -p ${JSON.stringify(repoDir)}`);
  execSync("git init -b main", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  if (options?.paseoConfig) {
    writeFileSync(path.join(repoDir, "paseo.json"), JSON.stringify(options.paseoConfig, null, 2));
  }
  execSync("git add .", { cwd: repoDir, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'initial'", { cwd: repoDir, stdio: "pipe" });
  return { tempDir, repoDir };
}

describe("createPaseoWorktreeInBackground", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("emits running then completed snapshots for no-setup workspaces and then launches services", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        services: {
          web: {
            command: "npm run dev",
          },
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const createdWorktree = await createWorktree({
      branchName: "feature-no-setup",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "feature-no-setup",
      runSetup: false,
      paseoHome,
    });
    const worktreePath = createdWorktree.worktreePath;
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const routeStore = new ServiceRouteStore();
    const logger = createLogger();
    const terminalManager = createTerminalManagerStub();
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await createPaseoWorktreeInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) => snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: terminalManager.manager,
        archiveWorkspaceRecord,
        serviceRouteStore: routeStore,
        daemonPort: 6767,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        worktree: {
          branchName: "feature-no-setup",
          worktreePath,
        },
        shouldBootstrap: true,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages).toHaveLength(2);
    expect(progressMessages[0]?.payload).toMatchObject({
      workspaceId: worktreePath,
      status: "running",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath,
        branchName: "feature-no-setup",
        log: "",
        commands: [],
      },
    });
    expect(progressMessages[1]?.payload).toMatchObject({
      workspaceId: worktreePath,
      status: "completed",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath,
        branchName: "feature-no-setup",
        log: "",
        commands: [],
      },
    });
    expect(snapshots.get(worktreePath)).toMatchObject({
      status: "completed",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath,
        branchName: "feature-no-setup",
        log: "",
        commands: [],
      },
    });

    expect(routeStore.listRoutes()).toEqual([
      {
        hostname: "feature-no-setup.web.localhost",
        port: expect.any(Number),
        workspaceId: worktreePath,
        serviceName: "web",
      },
    ]);
    expect(terminalManager.terminals).toHaveLength(1);
    expect(terminalManager.terminals[0]?.cwd).toBe(worktreePath);
    expect(terminalManager.terminals[0]?.env?.PORT).toEqual(expect.any(String));
    expect(terminalManager.terminals[0]?.env?.PASEO_SERVICE_URL).toBeDefined();
    expect(terminalManager.terminals[0]?.sent).toEqual(["npm run dev\r"]);
    expect(archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(emitWorkspaceUpdateForCwd).toHaveBeenCalledWith(worktreePath);
  });

  test("archives the pending workspace and emits a failed snapshot when setup cannot start", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);

    writeFileSync(path.join(repoDir, "paseo.json"), "{ invalid json\n");
    execSync("git add paseo.json", { cwd: repoDir, stdio: "pipe" });
    execSync("git -c commit.gpgsign=false commit -m 'broken config'", {
      cwd: repoDir,
      stdio: "pipe",
    });

    const paseoHome = path.join(tempDir, ".paseo");
    const createdWorktree = await createWorktree({
      branchName: "broken-feature",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "broken-feature",
      runSetup: false,
      paseoHome,
    });
    const worktreePath = createdWorktree.worktreePath;
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const logger = createLogger();
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await createPaseoWorktreeInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) => snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: null,
        archiveWorkspaceRecord,
        serviceRouteStore: null,
        daemonPort: null,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        worktree: {
          branchName: "broken-feature",
          worktreePath,
        },
        shouldBootstrap: true,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages).toHaveLength(2);
    expect(progressMessages[0]?.payload.status).toBe("running");
    expect(progressMessages[0]?.payload.error).toBeNull();
    expect(progressMessages[1]?.payload.status).toBe("failed");
    expect(progressMessages[1]?.payload.error).toContain("Failed to parse paseo.json");
    expect(progressMessages[1]?.payload.detail.commands).toEqual([]);
    expect(snapshots.get(worktreePath)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Failed to parse paseo.json"),
    });
    expect(archiveWorkspaceRecord).toHaveBeenCalledWith(worktreePath);
    expect(emitWorkspaceUpdateForCwd).toHaveBeenCalledWith(worktreePath);
  });

  test("emits running setup snapshots before completed for real setup commands", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        worktree: {
          setup: ['sh -c "printf \'phase-one\\\\n\'; sleep 0.1; printf \'phase-two\\\\n\'"'],
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const createdWorktree = await createWorktree({
      branchName: "feature-running-setup",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "feature-running-setup",
      runSetup: false,
      paseoHome,
    });
    const worktreePath = createdWorktree.worktreePath;
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const logger = createLogger();
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await createPaseoWorktreeInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) => snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: null,
        archiveWorkspaceRecord,
        serviceRouteStore: null,
        daemonPort: null,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        worktree: {
          branchName: "feature-running-setup",
          worktreePath,
        },
        shouldBootstrap: true,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages.length).toBeGreaterThan(1);
    expect(progressMessages[0]?.payload).toMatchObject({
      workspaceId: worktreePath,
      status: "running",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath,
        branchName: "feature-running-setup",
        log: "",
        commands: [],
      },
    });
    expect(progressMessages.at(-1)?.payload.status).toBe("completed");

    const runningMessages = progressMessages.filter((message) => message.payload.status === "running");
    expect(runningMessages.length).toBeGreaterThan(0);
    expect(progressMessages.findIndex((message) => message.payload.status === "running")).toBeLessThan(
      progressMessages.findIndex((message) => message.payload.status === "completed"),
    );

    const setupOutputMessage = runningMessages.find((message) =>
      message.payload.detail.commands[0]?.log.includes("phase-one"),
    );
    expect(setupOutputMessage?.payload.detail.log).toContain("phase-one");
    expect(setupOutputMessage?.payload.detail.commands[0]).toMatchObject({
      index: 1,
      command: 'sh -c "printf \'phase-one\\\\n\'; sleep 0.1; printf \'phase-two\\\\n\'"',
      log: expect.stringContaining("phase-one"),
      status: "running",
    });

    expect(progressMessages.at(-1)?.payload).toMatchObject({
      workspaceId: worktreePath,
      status: "completed",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath,
        branchName: "feature-running-setup",
      },
    });
    expect(progressMessages.at(-1)?.payload.detail.log).toContain("phase-two");
    expect(progressMessages.at(-1)?.payload.detail.commands[0]).toMatchObject({
      index: 1,
      command: 'sh -c "printf \'phase-one\\\\n\'; sleep 0.1; printf \'phase-two\\\\n\'"',
      log: expect.stringContaining("phase-two"),
      status: "completed",
      exitCode: 0,
    });
    expect(snapshots.get(worktreePath)).toMatchObject({
      status: "completed",
      error: null,
    });
  });

  test("emits completed when reusing an existing worktree without bootstrapping", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        worktree: {
          setup: ["printf 'ran' > setup-ran.txt"],
        },
        services: {
          web: {
            command: "npm run dev",
          },
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const existingWorktree = await createWorktree({
      branchName: "reused-worktree",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "reused-worktree",
      runSetup: false,
      paseoHome,
    });

    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const routeStore = new ServiceRouteStore();
    const logger = createLogger();
    const terminalManager = createTerminalManagerStub();
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await createPaseoWorktreeInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) => snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: terminalManager.manager,
        archiveWorkspaceRecord,
        serviceRouteStore: routeStore,
        daemonPort: 6767,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        worktree: {
          branchName: "reused-worktree",
          worktreePath: existingWorktree.worktreePath,
        },
        shouldBootstrap: false,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages).toHaveLength(2);
    expect(progressMessages[0]?.payload).toMatchObject({
      workspaceId: existingWorktree.worktreePath,
      status: "running",
      error: null,
    });
    expect(progressMessages[1]?.payload).toMatchObject({
      workspaceId: existingWorktree.worktreePath,
      status: "completed",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath: existingWorktree.worktreePath,
        branchName: "reused-worktree",
        log: "",
        commands: [],
      },
    });
    expect(routeStore.listRoutes()).toEqual([
      {
        hostname: "reused-worktree.web.localhost",
        port: expect.any(Number),
        workspaceId: existingWorktree.worktreePath,
        serviceName: "web",
      },
    ]);
    expect(terminalManager.terminals).toHaveLength(1);
    expect(terminalManager.terminals[0]?.cwd).toBe(existingWorktree.worktreePath);
    expect(terminalManager.terminals[0]?.name).toBe("web");
    expect(terminalManager.terminals[0]?.env?.PORT).toEqual(expect.any(String));
    expect(terminalManager.terminals[0]?.env?.PASEO_SERVICE_URL).toBeDefined();
    expect(terminalManager.terminals[0]?.sent).toEqual(["npm run dev\r"]);
    expect(
      readFileSync(path.join(existingWorktree.worktreePath, "README.md"), "utf8"),
    ).toContain("hello");
    expect(() => readFileSync(path.join(existingWorktree.worktreePath, "setup-ran.txt"), "utf8")).toThrow();
    expect(snapshots.get(existingWorktree.worktreePath)).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(emitWorkspaceUpdateForCwd).toHaveBeenCalledWith(existingWorktree.worktreePath);
  });

  test("keeps setup completed when service launch fails afterward", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        services: {
          web: {
            command: "npm run dev",
          },
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const createdWorktree = await createWorktree({
      branchName: "feature-service-failure",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "feature-service-failure",
      runSetup: false,
      paseoHome,
    });
    const worktreePath = createdWorktree.worktreePath;
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const routeStore = new ServiceRouteStore();
    const logger = createLogger();
    const terminalManager = createTerminalManagerStub({
      createTerminal: async () => {
        throw new Error("terminal spawn failed");
      },
    });
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await createPaseoWorktreeInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) => snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: terminalManager.manager,
        archiveWorkspaceRecord,
        serviceRouteStore: routeStore,
        daemonPort: 6767,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        worktree: {
          branchName: "feature-service-failure",
          worktreePath,
        },
        shouldBootstrap: true,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages).toHaveLength(2);
    expect(progressMessages[0]?.payload.status).toBe("running");
    expect(progressMessages[0]?.payload.error).toBeNull();
    expect(progressMessages[1]?.payload.status).toBe("completed");
    expect(progressMessages[1]?.payload.error).toBeNull();
    expect(emitted.some((message) => message.type === "workspace_setup_progress" && message.payload.status === "failed")).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        cwd: repoDir,
        repoRoot: repoDir,
        worktreeSlug: "feature-service-failure",
        worktreePath,
      }),
      "Failed to spawn worktree services after workspace setup completed",
    );
    expect(snapshots.get(worktreePath)).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(emitWorkspaceUpdateForCwd).toHaveBeenCalledWith(worktreePath);
  });

  test("launches services in socket mode without requiring a daemon TCP port", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        services: {
          web: {
            command: "npm run dev",
          },
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const createdWorktree = await createWorktree({
      branchName: "feature-socket-mode",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "feature-socket-mode",
      runSetup: false,
      paseoHome,
    });
    const worktreePath = createdWorktree.worktreePath;
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const routeStore = new ServiceRouteStore();
    const logger = createLogger();
    const terminalManager = createTerminalManagerStub();
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await createPaseoWorktreeInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) => snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: terminalManager.manager,
        archiveWorkspaceRecord,
        serviceRouteStore: routeStore,
        daemonPort: null,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        worktree: {
          branchName: "feature-socket-mode",
          worktreePath,
        },
        shouldBootstrap: true,
      },
    );

    expect(routeStore.listRoutes()).toEqual([
      {
        hostname: "feature-socket-mode.web.localhost",
        port: expect.any(Number),
        workspaceId: worktreePath,
        serviceName: "web",
      },
    ]);
    expect(terminalManager.terminals).toHaveLength(1);
    expect(terminalManager.terminals[0]?.cwd).toBe(worktreePath);
    expect(terminalManager.terminals[0]?.env?.PORT).toEqual(expect.any(String));
    expect(terminalManager.terminals[0]?.env?.PASEO_SERVICE_URL).toBeUndefined();
    expect(terminalManager.terminals[0]?.sent).toEqual(["npm run dev\r"]);
    expect(snapshots.get(worktreePath)).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(emitWorkspaceUpdateForCwd).toHaveBeenCalledWith(worktreePath);
  });

  test("returns the cached workspace setup snapshot for status requests", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map([
      [
        "/repo/.paseo/worktrees/feature-a",
        {
          status: "completed",
          detail: {
            type: "worktree_setup",
            worktreePath: "/repo/.paseo/worktrees/feature-a",
            branchName: "feature-a",
            log: "done",
            commands: [],
          },
          error: null,
        },
      ],
    ]);

    await handleWorkspaceSetupStatusRequest(
      {
        emit: (message) => emitted.push(message),
        workspaceSetupSnapshots: snapshots,
      },
      {
        type: "workspace_setup_status_request",
        workspaceId: "/repo/.paseo/worktrees/feature-a",
        requestId: "req-status",
      },
    );

    expect(emitted).toContainEqual({
      type: "workspace_setup_status_response",
      payload: {
        requestId: "req-status",
        workspaceId: "/repo/.paseo/worktrees/feature-a",
        snapshot: {
          status: "completed",
          detail: {
            type: "worktree_setup",
            worktreePath: "/repo/.paseo/worktrees/feature-a",
            branchName: "feature-a",
            log: "done",
            commands: [],
          },
          error: null,
        },
      },
    });
  });

  test("returns null when no cached workspace setup snapshot exists", async () => {
    const emitted: SessionOutboundMessage[] = [];

    await handleWorkspaceSetupStatusRequest(
      {
        emit: (message) => emitted.push(message),
        workspaceSetupSnapshots: new Map(),
      },
      {
        type: "workspace_setup_status_request",
        workspaceId: "/repo/.paseo/worktrees/missing",
        requestId: "req-missing",
      },
    );

    expect(emitted).toContainEqual({
      type: "workspace_setup_status_response",
      payload: {
        requestId: "req-missing",
        workspaceId: "/repo/.paseo/worktrees/missing",
        snapshot: null,
      },
    });
  });

});

describe("handleCreatePaseoWorktreeRequest", () => {
  test("creates the worktree before emitting the response", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const emitted: SessionOutboundMessage[] = [];
    const backgroundWork = vi.fn(async () => {});

    try {
      await handleCreatePaseoWorktreeRequest(
        {
          paseoHome,
          sessionLogger: createLogger(),
          emit: (message) => emitted.push(message),
          registerPendingWorktreeWorkspace: vi.fn(async (options) => {
            expect(existsSync(options.worktreePath)).toBe(true);
            return {
              workspaceId: options.worktreePath,
              projectId: options.repoRoot,
            } as any;
          }),
          describeWorkspaceRecord: vi.fn(async (workspace) => ({
            id: workspace.workspaceId,
            projectId: workspace.projectId,
            projectDisplayName: path.basename(repoDir),
            projectRootPath: repoDir,
            projectKind: "git",
            workspaceKind: "worktree",
            name: path.basename(workspace.workspaceId),
            status: "done",
            activityAt: null,
          })),
          createPaseoWorktreeInBackground: backgroundWork,
        },
        {
          type: "create_paseo_worktree_request",
          cwd: repoDir,
          worktreeSlug: "response-after-create",
          requestId: "req-1",
        },
      );

      const response = emitted.find(
        (message): message is Extract<SessionOutboundMessage, { type: "create_paseo_worktree_response" }> =>
          message.type === "create_paseo_worktree_response",
      );
      expect(response?.payload.error).toBeNull();
      expect(response?.payload.workspace?.id).toBeTruthy();
      expect(existsSync(response!.payload.workspace!.id)).toBe(true);
      expect(backgroundWork).toHaveBeenCalledWith(
        expect.objectContaining({
          requestCwd: repoDir,
          repoRoot: repoDir,
          worktree: {
            branchName: "response-after-create",
            worktreePath: response!.payload.workspace!.id,
          },
          shouldBootstrap: true,
        }),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
