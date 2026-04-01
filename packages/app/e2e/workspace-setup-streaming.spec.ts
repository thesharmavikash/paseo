import { rm, writeFile } from "node:fs/promises";
import { test, expect } from "./fixtures";
import { createTempGitRepo } from "./helpers/workspace";
import { waitForWorkspaceTabsVisible } from "./helpers/workspace-tabs";
import {
  connectWorkspaceSetupClient,
  createWorkspaceFromSidebar,
  createWorkspaceThroughDaemon,
  expectSetupLogContains,
  expectSetupPanel,
  expectSetupStatus,
  openHomeWithProject,
  seedProjectForWorkspaceSetup,
  waitForWorkspaceSetupProgress,
} from "./helpers/workspace-setup";

test.describe("Workspace setup streaming", () => {
  test("opens the setup tab when a workspace is created from the sidebar", async ({ page }) => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("setup-open-", {
      paseoConfig: {
        worktree: {
          setup: ["sh -c 'echo starting setup; sleep 2; echo setup complete'"],
        },
      },
    });

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);
      await openHomeWithProject(page, repo.path);
      await createWorkspaceFromSidebar(page, repo.path);

      await expectSetupPanel(page);
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("runs setup through the sidebar and leaves the workspace usable", async ({ page }) => {
    const setupTriggerPath = `/tmp/setup-trigger-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("setup-ui-flow-", {
      paseoConfig: {
        worktree: {
          setup: [
            `sh -c 'while [ ! -f "${setupTriggerPath}" ]; do sleep 0.2; done; echo starting setup; sleep 1; echo loading dependencies; sleep 1; echo setup complete'`,
          ],
        },
      },
      files: [{ path: "src/index.ts", content: "export const ready = true;\n" }],
    });

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);
      await openHomeWithProject(page, repo.path);
      await createWorkspaceFromSidebar(page, repo.path);

      await expectSetupPanel(page);
      await expectSetupStatus(page, "Running");
      await writeFile(setupTriggerPath, "start\n");
      await expectSetupLogContains(page, "starting setup");
      await expectSetupLogContains(page, "loading dependencies");
      await expectSetupStatus(page, "Completed");
      await expectSetupLogContains(page, "setup complete");

      await waitForWorkspaceTabsVisible(page);
      await page.getByTestId("workspace-new-agent-tab").first().click();
      await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toBeVisible({
        timeout: 30_000,
      });

      const explorerToggle = page.getByTestId("workspace-explorer-toggle").first();
      if ((await explorerToggle.getAttribute("aria-label")) === "Open explorer") {
        await explorerToggle.click();
      }
      await expect(explorerToggle).toHaveAttribute("aria-label", "Close explorer", {
        timeout: 30_000,
      });
      await page.getByTestId("explorer-tab-files").click();
      await expect(page.getByTestId("file-explorer-tree-scroll")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("README.md", { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText("src", { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await rm(setupTriggerPath, { force: true });
      await client.close();
      await repo.cleanup();
    }
  });

  test("streams running and completed setup snapshots for a successful setup", async () => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("setup-success-", {
      paseoConfig: {
        worktree: {
          setup: ["sh -c 'echo starting setup; sleep 2; echo setup complete'"],
        },
      },
    });

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);
      const initialRunning = waitForWorkspaceSetupProgress(
        client,
        (payload) => payload.status === "running" && payload.detail.log === "",
      );
      const runningWithOutput = waitForWorkspaceSetupProgress(
        client,
        (payload) => payload.status === "running" && payload.detail.log.includes("starting setup"),
      );
      const completed = waitForWorkspaceSetupProgress(
        client,
        (payload) => payload.status === "completed" && payload.detail.log.includes("setup complete"),
      );

      await createWorkspaceThroughDaemon(client, {
        cwd: repo.path,
        worktreeSlug: "workspace-setup-success",
      });

      const initialPayload = await initialRunning;
      const runningPayload = await runningWithOutput;
      const completedPayload = await completed;

      expect(initialPayload.detail.log).toBe("");
      expect(runningPayload.detail.log).toContain("starting setup");
      expect(completedPayload.detail.log).toContain("setup complete");
      expect(completedPayload.error).toBeNull();
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("streams a failed setup snapshot when setup fails", async () => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("setup-failure-", {
      paseoConfig: {
        worktree: {
          setup: ["sh -c 'echo starting setup; sleep 2; echo setup failed 1>&2; exit 1'"],
        },
      },
    });

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);
      const failed = waitForWorkspaceSetupProgress(
        client,
        (payload) => payload.status === "failed" && payload.detail.log.includes("setup failed"),
      );

      await createWorkspaceThroughDaemon(client, {
        cwd: repo.path,
        worktreeSlug: "workspace-setup-failure",
      });

      const failedPayload = await failed;
      expect(failedPayload.detail.log).toContain("starting setup");
      expect(failedPayload.detail.log).toContain("setup failed");
      expect(failedPayload.error).toMatch(/failed/i);
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("emits a completed empty snapshot when no setup commands exist", async () => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("setup-none-");

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);
      const completed = waitForWorkspaceSetupProgress(
        client,
        (payload) =>
          payload.status === "completed" &&
          payload.detail.commands.length === 0 &&
          payload.detail.log === "",
      );

      await createWorkspaceThroughDaemon(client, {
        cwd: repo.path,
        worktreeSlug: "workspace-setup-none",
      });

      const completedPayload = await completed;
      expect(completedPayload.error).toBeNull();
      expect(completedPayload.detail.commands).toEqual([]);
      expect(completedPayload.detail.log).toBe("");
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("launches service terminals after setup completes", async ({ page }) => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("setup-svc-ui-", {
      paseoConfig: {
        worktree: {
          setup: ["sh -c 'echo bootstrapping; sleep 1; echo setup complete'"],
        },
        services: {
          web: {
            command:
              "node -e \"const http = require('http'); const s = http.createServer((q,r) => r.end('ok')); s.listen(process.env.PORT || 3000, () => console.log('listening on ' + s.address().port))\"",
          },
        },
      },
    });

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);
      await openHomeWithProject(page, repo.path);
      await createWorkspaceFromSidebar(page, repo.path);

      await expectSetupPanel(page);
      await expectSetupStatus(page, "Completed");

      await waitForWorkspaceTabsVisible(page);

      // Wait for the service terminal tab to appear in the tabs bar
      const terminalTab = page.locator('[data-testid^="workspace-tab-terminal_"]', {
        hasText: "web",
      });
      await expect(terminalTab).toBeVisible({ timeout: 30_000 });

      // Click the service terminal tab
      await terminalTab.click();

      // Verify the terminal surface rendered
      await expect(page.getByTestId("terminal-surface").first()).toBeVisible({ timeout: 10_000 });

      // Verify the terminal output contains "listening on" (xterm renders text in .xterm-rows)
      await expect(page.locator(".xterm-rows").first()).toContainText("listening on", {
        timeout: 30_000,
      });
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("launches workspace services after setup completes", async () => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("setup-services-", {
      paseoConfig: {
        worktree: {
          setup: ["sh -c 'echo bootstrapping; sleep 1; echo setup complete'"],
        },
        services: {
          editor: {
            command: "npm run dev",
          },
        },
      },
    });

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);
      const completed = waitForWorkspaceSetupProgress(
        client,
        (payload) => payload.status === "completed" && payload.detail.log.includes("setup complete"),
      );

      const workspace = await createWorkspaceThroughDaemon(client, {
        cwd: repo.path,
        worktreeSlug: "workspace-setup-services",
      });

      await completed;

      await expect
        .poll(async () => {
          const terminals = await client.listTerminals(workspace.id);
          return terminals.terminals.find((terminal) => terminal.name === "editor") ?? null;
        })
        .toMatchObject({
          id: expect.any(String),
          name: "editor",
        });
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });
});
