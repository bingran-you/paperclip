import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function json(response: Awaited<ReturnType<APIRequestContext["get"]>>) {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

async function failFirstTaskCss(page: Page) {
  const counts = { failed: 0, served: 0, documents: 0 };
  await page.route(/\/assets\/issue-detail-[^/]+\.css$/, async (route) => {
    if (counts.failed === 0) {
      counts.failed += 1;
      await route.abort("failed");
      return;
    }
    counts.served += 1;
    await route.continue();
  });
  page.on("request", (request) => {
    if (request.resourceType() === "document" && request.frame() === page.mainFrame()) counts.documents += 1;
  });
  return counts;
}

test.use({ serviceWorkers: "block" });

for (const entry of ["task", "agents"] as const) {
  test(`a failed task-page CSS preload recovers with one reload (${entry} page)`, async ({ page, request }) => {
    const company = await json(await request.post("/api/companies", {
      data: { name: `Chunk recovery ${randomUUID()}` },
    }));
    const issue = await json(await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Open after a failed stylesheet", status: "backlog" },
    }));
    const counts = await failFirstTaskCss(page);

    if (entry === "task") {
      await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
      await expect(page.getByRole("heading", { name: issue.title, exact: true })).toBeVisible();
    } else {
      await page.goto(`/${company.issuePrefix}/agents`);
      await expect(page.getByRole("heading", { name: "Agents", exact: true }).first()).toBeVisible();
    }

    await expect(page.getByText("This page hit an error")).toHaveCount(0);
    expect(counts.failed).toBe(1);
    expect(counts.served).toBeGreaterThan(0);
    expect(counts.documents).toBe(2);
  });
}

for (const entry of ["task", "agents"] as const) {
  test(`a task-page CSS asset that stays broken reloads once, then shows the error (${entry} page)`, async ({ page, request }) => {
    const company = await json(await request.post("/api/companies", {
      data: { name: `Chunk recovery ${randomUUID()}` },
    }));
    const issue = await json(await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Open with a broken stylesheet", status: "backlog" },
    }));
    let failed = 0;
    let documents = 0;
    await page.route(/\/assets\/issue-detail-[^/]+\.css$/, async (route) => {
      failed += 1;
      await route.abort("failed");
    });
    page.on("request", (request) => {
      if (request.resourceType() === "document" && request.frame() === page.mainFrame()) documents += 1;
    });

    await page.goto(entry === "task"
      ? `/${company.issuePrefix}/issues/${issue.identifier}`
      : `/${company.issuePrefix}/agents`);

    await expect(page.getByText("This page hit an error")).toBeVisible();
    await expect(page.getByText(/Unable to preload CSS for .*issue-detail-/)).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(documents).toBe(2);
    expect(failed).toBe(2);
  });
}
