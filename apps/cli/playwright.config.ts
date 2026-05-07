import { defineConfig, devices } from "@playwright/test";

const PORT = 5190;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "off",
    permissions: ["clipboard-read", "clipboard-write"],
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `bun src/index.ts fixtures/plan.md --no-open --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 30_000,
    // The shared webServer is reused across tests; between tests the page is
    // closed and re-opened, leaving the SSE channel briefly empty. Disable
    // auto-exit-on-idle so it doesn't kill itself mid-suite. AC14 spawns its
    // own mark-it without this flag to verify the production behavior.
    env: { MARK_IT_NO_AUTO_EXIT: "1" },
  },
});
