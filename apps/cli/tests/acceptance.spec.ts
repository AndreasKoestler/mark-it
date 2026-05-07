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

/**
 * Install a stub AgentTransport so "Send" actions don't hit /api/agent
 * (which would exit the CLI process and tear down the dev server mid-suite).
 * The stub records each formatForAgent payload on `window.__sentPayloads`.
 */
async function stubAgentTransport(page: Page) {
  await page.addInitScript(() => {
    const sent: Array<{ comments: string[]; resolveIds: string[] }> = [];
    (window as unknown as { __sentPayloads: typeof sent }).__sentPayloads = sent;
    (window as unknown as { __markItTestTransports: unknown }).__markItTestTransports =
      [
        {
          name: "test-stub",
          async send(payload: {
            comments: Array<{ id: string }>;
            resolveIds?: string[];
          }) {
            sent.push({
              comments: payload.comments.map((c) => c.id),
              resolveIds: payload.resolveIds ?? [],
            });
          },
        },
      ];
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

test("AC8: Send all + resolve dispatches via the agent transport with resolveIds", async ({ page }) => {
  await stubAgentTransport(page);
  await gotoApp(page);
  await dispatchAdd(page, 17);
  await submitDraft(page, "First");
  await dispatchAdd(page, 13);
  await submitDraft(page, "Second");
  await page.locator('[data-testid="agent-menu-toggle"]').click();
  await page.locator('[data-testid="agent-send-all-resolve"]').click();
  await page.waitForTimeout(500);
  const sent = await page.evaluate(
    () => (window as unknown as { __sentPayloads: Array<{ comments: string[]; resolveIds: string[] }> }).__sentPayloads,
  );
  expect(sent).toHaveLength(1);
  expect(sent[0].comments.length).toBe(2);
  expect(sent[0].resolveIds.length).toBe(2);
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

test("AC12: drift — text edit re-anchors via fuzzy match and shows drift badge", async ({ page }) => {
  await gotoApp(page);
  await dispatchAdd(page, 17);
  await submitDraft(page, "Mention scaffolding work.");
  // No drift before any edit.
  await expect(page.locator('[data-testid="thread-drift-badge"]')).toHaveCount(0);
  // Modify the anchored line in-place — same line index, slightly different
  // wording so the immutable selected_text no longer matches verbatim. Fuzzy
  // matching should still re-anchor (>0.8) and surface as drift.
  const original = readFileSync(FIXTURE_PATH, "utf8");
  const edited = original.replace(
    "Empty repository ready for scaffolding",
    "Empty repo, ready for scaffolds and tests",
  );
  expect(edited).not.toBe(original);
  writeFileSync(FIXTURE_PATH, edited, "utf8");
  // SSE-driven re-anchor: drift badge appears and the new anchor text shows.
  const badge = page.locator('[data-testid="thread-drift-badge"]');
  await expect(badge).toBeVisible({ timeout: 5_000 });
  await expect(badge).toHaveText(/drifted|anchor lost/i);
  // Fuzzy match returns a slice of the new line; full wording isn't guaranteed.
  // What matters is that the "now anchors to" block points at the edited text.
  const anchorNow = page.locator('[data-testid="thread-anchor-now"]');
  await expect(anchorNow).toContainText(/Empty repo/);
  await expect(anchorNow).not.toContainText(/Empty repository ready for scaffolding/);
  // Sidecar persists the re-anchor metadata.
  const yaml = readFileSync(SIDECAR_PATH, "utf8");
  expect(yaml).toMatch(/x_reanchor_status:/);
});

test("AC11: Send raises a top-right toast that auto-dismisses", async ({ page }) => {
  await stubAgentTransport(page);
  await gotoApp(page);
  await dispatchAdd(page, 17);
  await submitDraft(page, "Anything");
  await expect(page.locator('[data-testid="sent-toast"]')).toHaveCount(0);
  await page.locator('[data-testid="agent-menu-toggle"]').click();
  await page.locator('[data-testid="agent-send-all"]').click();
  const toast = page.locator('[data-testid="sent-toast"]');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(/agent is processing/i);
  // Auto-dismisses after ~4s; allow a generous timeout.
  await expect(toast).toHaveCount(0, { timeout: 6_000 });
});

test("AC13: Send to /api/agent keeps the server alive (long-running mode)", async ({ page }) => {
  // No stub transport here — drive the real HttpAgentTransport which POSTs
  // /api/agent. Pre-mark-it the server would process.exit(0) on this call;
  // post-change it must keep serving and resolveIds must persist.
  await gotoApp(page);
  await dispatchAdd(page, 17);
  await submitDraft(page, "Long-running send");

  // Read the comment id we just added.
  const commentId = await page
    .locator('[data-testid="thread"]')
    .first()
    .getAttribute("data-comment-id");
  expect(commentId).toBeTruthy();

  // Hit /api/agent directly with a resolveIds payload that should persist.
  const sendStatus = await page.evaluate(async (id) => {
    const res = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Document: plan.md\n\nComment 1 (line 17)",
        resolveIds: [id],
      }),
    });
    return res.status;
  }, commentId);
  expect(sendStatus).toBe(200);

  // Server still up: the next sidecar GET succeeds and shows the comment
  // resolved.
  const sidecar = await page.evaluate(async () => {
    const res = await fetch("/api/sidecar");
    return res.ok ? await res.json() : null;
  });
  expect(sidecar).not.toBeNull();
  const comments = sidecar.doc.comments as Array<{ id: string; resolved: boolean }>;
  const target = comments.find((c) => c.id === commentId);
  expect(target?.resolved).toBe(true);
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
