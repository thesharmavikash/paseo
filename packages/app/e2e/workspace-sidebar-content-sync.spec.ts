import { execSync } from 'node:child_process';
import { test, expect, type Page } from './fixtures';
import { setWorkingDirectory } from './helpers/app';
import { createTempGitRepo } from './helpers/workspace';
import { buildHostWorkspaceRoute } from '@/utils/host-routes';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function workspaceLabelFromPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function candidateWorkspaceIds(inputPath: string): string[] {
  const trimmed = inputPath.replace(/\/+$/, '');
  const candidates = new Set<string>([trimmed]);
  if (trimmed.startsWith('/var/')) {
    candidates.add(`/private${trimmed}`);
  }
  if (trimmed.startsWith('/private/var/')) {
    candidates.add(trimmed.replace(/^\/private/, ''));
  }
  return Array.from(candidates);
}

function workspaceRowLocator(page: Page, serverId: string, workspacePath: string) {
  const ids = candidateWorkspaceIds(workspacePath).map(
    (id) => `[data-testid="sidebar-workspace-row-${serverId}:${id}"]`
  );
  return page.locator(ids.join(',')).first();
}

async function openNewAgentComposer(page: Page): Promise<void> {
  await page.goto('/');

  const sidebarNewAgent = page.getByTestId('sidebar-new-agent').first();
  if (await sidebarNewAgent.isVisible().catch(() => false)) {
    await sidebarNewAgent.click();
  } else {
    await page.getByText('New agent', { exact: true }).first().click();
  }

  await expect(page.getByRole('textbox', { name: 'Message agent...' })).toBeVisible({ timeout: 30000 });
}

async function seedWorkspaceActivity(page: Page, marker: string): Promise<void> {
  const input = page.getByRole('textbox', { name: 'Message agent...' });
  await expect(input).toBeEditable({ timeout: 30000 });
  await input.fill(marker);
  await input.press('Enter');
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 30000 });
}

async function switchViaSidebar(input: {
  page: Page;
  serverId: string;
  targetWorkspacePath: string;
}) {
  const row = workspaceRowLocator(input.page, input.serverId, input.targetWorkspacePath);
  await expect(row).toBeVisible({ timeout: 30000 });
  await row.click();

  const targetWorkspaceRoute = buildHostWorkspaceRoute(input.serverId, input.targetWorkspacePath);
  await expect(input.page).toHaveURL(new RegExp(escapeRegex(targetWorkspaceRoute)), {
    timeout: 30000,
  });
}

async function expectWorkspaceHeader(
  page: Page,
  input: { title: string; subtitle: string }
): Promise<void> {
  const titleLocator = page.getByTestId('workspace-header-title');
  const subtitleLocator = page.getByTestId('workspace-header-subtitle');

  await expect(titleLocator.first()).toHaveText(input.title, {
    timeout: 30000,
  });
  await expect(subtitleLocator.first()).toHaveText(input.subtitle, {
    timeout: 30000,
  });
}

test('sidebar workspace switch keeps visible content in sync with selected workspace', async ({ page }) => {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error('E2E_SERVER_ID is not set.');
  }

  const repoA = await createTempGitRepo('paseo-e2e-sync-a-');
  const repoB = await createTempGitRepo('paseo-e2e-sync-b-');

  const tokenA = `SYNC_A_${Date.now()}`;
  const tokenB = `SYNC_B_${Date.now()}`;

  try {
    execSync('git checkout -b sync-a-branch', { cwd: repoA.path, stdio: 'ignore' });
    execSync('git checkout -b sync-b-branch', { cwd: repoB.path, stdio: 'ignore' });

    await openNewAgentComposer(page);
    await setWorkingDirectory(page, repoA.path);
    await seedWorkspaceActivity(page, tokenA);

    await openNewAgentComposer(page);
    await setWorkingDirectory(page, repoB.path);
    await seedWorkspaceActivity(page, tokenB);

    await page.goto(buildHostWorkspaceRoute(serverId, repoA.path));
    await expect(page).toHaveURL(new RegExp('/workspace/'), { timeout: 30000 });
    await expectWorkspaceHeader(page, {
      title: 'sync-a-branch',
      subtitle: workspaceLabelFromPath(repoA.path),
    });

    await switchViaSidebar({ page, serverId, targetWorkspacePath: repoB.path });
    await expectWorkspaceHeader(page, {
      title: 'sync-b-branch',
      subtitle: workspaceLabelFromPath(repoB.path),
    });

    await switchViaSidebar({ page, serverId, targetWorkspacePath: repoA.path });
    await expectWorkspaceHeader(page, {
      title: 'sync-a-branch',
      subtitle: workspaceLabelFromPath(repoA.path),
    });
  } finally {
    await repoA.cleanup();
    await repoB.cleanup();
  }
});
