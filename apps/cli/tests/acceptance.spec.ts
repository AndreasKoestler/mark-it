import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const FIXTURE_PATH = resolve(__dirname, "..", "fixtures", "plan.md");
const SIDECAR_PATH = `${FIXTURE_PATH}.review.yaml`;
const FIXTURE_BACKUP = `${FIXTURE_PATH}.bak`;

test.beforeAll(() => {
  copyFileSync(FIXTURE_PATH, FIXTURE_BACKUP);
});

test.beforeEach(() => {
  if (existsSync(SIDECAR_PATH)) unlinkSync(SIDECAR_PATH);
  // Restore source fixture from backup before every test.
  copyFileSync(FIXTURE_BACKUP, FIXTURE_PATH);
});

test.afterAll(() => {
  if (existsSync(SIDECAR_PATH)) unlinkSync(SIDECAR_PATH);
  if (existsSync(FIXTURE_BACKUP)) {
    copyFileSync(FIXTURE_BACKUP, FIXTURE_PATH);
    unlinkSync(FIXTURE_BACKUP);
  }
});

async function stubClipboard(page: Page) {
  await page.addInitScript(() => {
    const captured: string[] = [];
    (window as unknown as { __captured: string[] }).__captured = captured;
    const stub = async (text: string) => {
      captured.push(text);
    };
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: stub, readText: async () => captured[captured.length - 1] ?? "" },
      configurable: true,
    });
  });
}

async function readCaptured(page: Page): Promise<string[]> {
  return await page.evaluate(() => (window as unknown as { __captured: string[] }).__captured);
}

async function gotoApp(page: Page) {
  await page.goto("/");
  await page.waitForSelector('[data-mrsf-line]');
}

async function dispatchAdd(page: Page, line: number) {
  const target = await page.locator(`[data-mrsf-line="${line}"]`).first();
  const text = (await target.textContent()) ?? "";
  await page.evaluate(({ line, text }) => {
    document.dispatchEvent(new CustomEvent("mrsf:add", {
      detail: { commentId: null, line, end_line: line, action: "add", selectionText: text },
    }));
  }, { line, text });
}

async function submitDraft(page: Page, text: string) {
  await page.locator('[data-testid="comment-draft-input"]').fill(text);
  await page.locator('[data-testid="comment-draft-submit"]').click();
  await expect(page.locator('[data-testid="comment-draft"]')).toHaveCount(0);
}

test("AC1: page loads with collapsed frontmatter (5)", async ({ page }) => {
  await gotoApp(page);
  const summary = page.locator(".mi-frontmatter-summary").first();
  await expect(summary).toHaveText(/frontmatter \(5\)/);
});

test("AC2: rendered ↔ raw toggle preserves comment data", async ({ page }) => {
  await gotoApp(page);
  await dispatchAdd(page, 17);
  await submitDraft(page, "Anchor check.");
  // Switch to raw and back; the sidebar thread should still appear.
  await page.locator('[data-testid="view-toggle-raw"]').click();
  await expect(page.locator('[data-testid="raw-view"]')).toBeVisible();
  await expect(page.locator('[data-testid="thread"][data-line="17"]')).toBeVisible();
  await page.locator('[data-testid="view-toggle-rendered"]').click();
  await expect(page.locator('[data-testid="rendered-view"]')).toBeVisible();
  await expect(page.locator('[data-testid="thread"][data-line="17"]')).toBeVisible();
});

test("AC3: add a comment writes a valid Sidemark sidecar", async ({ page }) => {
  await gotoApp(page);
  await dispatchAdd(page, 17);
  await submitDraft(page, "Confirm scaffolding includes Vitest config.");
  // Sidecar must exist on disk
  expect(existsSync(SIDECAR_PATH)).toBe(true);
  const yaml = readFileSync(SIDECAR_PATH, "utf8");
  expect(yaml).toContain("mrsf_version: \"1.0\"");
  expect(yaml).toContain("Confirm scaffolding includes Vitest config.");
  expect(yaml).toContain("selected_text: Empty repository ready for scaffolding");
  expect(yaml).toContain("line: 17");
});

test("AC4: reload rehydrates comment to the same anchor", async ({ page }) => {
  await gotoApp(page);
  await dispatchAdd(page, 17);
  await submitDraft(page, "Persistent comment.");
  await page.reload();
  await page.waitForSelector('[data-testid="thread"]');
  await expect(page.locator('[data-testid="thread"][data-line="17"]')).toBeVisible();
});

test("AC5: replies thread under the parent and write reply_to in sidecar", async ({ page }) => {
  await gotoApp(page);
  await dispatchAdd(page, 17);
  await submitDraft(page, "Parent comment.");
  const thread = page.locator('[data-testid="thread"][data-line="17"]');
  await thread.locator('[data-testid="thread-reply-input"]').fill("Threaded reply.");
  await thread.locator('[data-testid="thread-reply-submit"]').click();
  await expect(thread.locator('[data-testid="thread-reply"]')).toContainText("Threaded reply.");
  const yaml = readFileSync(SIDECAR_PATH, "utf8");
  expect(yaml).toMatch(/reply_to:/);
});

test("AC6: per-thread resolve flips resolved=true in the sidecar", async ({ page }) => {
  await gotoApp(page);
  await dispatchAdd(page, 17);
  await submitDraft(page, "Resolve me.");
  await page.locator('[data-testid="thread"][data-line="17"] [data-testid="thread-resolve"]').click();
  // Sidebar empties (only unresolved roots show)
  await expect(page.locator('[data-testid="thread"]')).toHaveCount(0);
  const yaml = readFileSync(SIDECAR_PATH, "utf8");
  expect(yaml).toMatch(/resolved: true/);
});

test("AC7: Copy 1 for Agent puts the formatted prompt on clipboard", async ({ page }) => {
  await stubClipboard(page);
  await gotoApp(page);
  await dispatchAdd(page, 17);
  await submitDraft(page, "Clip 1");
  await page.locator('[data-testid="agent-menu-toggle"]').click();
  await page.locator('[data-testid="agent-copy-one"]').click();
  await page.waitForTimeout(150);
  const captured = await readCaptured(page);
  expect(captured.length).toBe(1);
  expect(captured[0]).toContain("Document: plan.md");
  expect(captured[0]).toContain("Clip 1");
});

test("AC8: Send all + resolve copies all and flips resolved", async ({ page }) => {
  await stubClipboard(page);
  await gotoApp(page);
  await dispatchAdd(page, 17);
  await submitDraft(page, "First");
  await dispatchAdd(page, 13);
  await submitDraft(page, "Second");
  await page.locator('[data-testid="agent-menu-toggle"]').click();
  await page.locator('[data-testid="agent-send-all-resolve"]').click();
  await page.waitForTimeout(500);
  await expect(page.locator('[data-testid="thread"]')).toHaveCount(0);
  const captured = await readCaptured(page);
  const last = captured[captured.length - 1] ?? "";
  expect(last).toContain("First");
  expect(last).toContain("Second");
  const yaml = readFileSync(SIDECAR_PATH, "utf8");
  expect(yaml.match(/resolved: true/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
});

test("AC9: Resolve all without copy clears the sidebar", async ({ page }) => {
  await gotoApp(page);
  await dispatchAdd(page, 17);
  await submitDraft(page, "X");
  await dispatchAdd(page, 13);
  await submitDraft(page, "Y");
  await page.locator('[data-testid="agent-menu-toggle"]').click();
  await page.locator('[data-testid="agent-resolve-all"]').click();
  await expect(page.locator('[data-testid="thread"]')).toHaveCount(0);
});

test("AC10: drift — appending lines re-anchors comment line", async ({ page }) => {
  await gotoApp(page);
  await dispatchAdd(page, 17);
  await submitDraft(page, "Drift comment");
  // Modify the source file (prepend two newlines) outside the browser
  const original = readFileSync(FIXTURE_PATH, "utf8");
  writeFileSync(FIXTURE_PATH, "\n\n" + original, "utf8");
  // Wait for SSE to push and the thread to reflect new line
  const thread = page.locator('[data-testid="thread"]').first();
  await expect(thread).toHaveAttribute("data-line", "19", { timeout: 5_000 });
  const yaml = readFileSync(SIDECAR_PATH, "utf8");
  expect(yaml).toContain("line: 19");
  // selected_text must remain immutable per Sidemark spec
  expect(yaml).toContain("selected_text: Empty repository ready for scaffolding");
});
