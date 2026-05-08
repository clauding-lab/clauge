// T24 — tauri-driver bootstrap helpers for the V3 E2E suite.
//
// `application` path is resolved relative to the spawned process's CWD (the
// repo root when the suite is launched via `npm run test:e2e`), so we point
// at `src-tauri/target/debug/clauge` from the repo root. Path is not
// abs-resolved in code so dev/CI machines can run the suite from a checkout
// without per-host config.
//
// PLATFORM CAVEAT (2026-05-08): tauri-driver v2.0.6 (the current Tauri-2
// compatible line; v0.1.x fails to compile on rustc 1.95) supports ONLY
// Linux (via WebKitWebDriver) and Windows (via Microsoft Edge Driver).
// macOS support is listed as TODO upstream
// (https://github.com/tauri-apps/tauri/tree/dev/crates/tauri-driver, README:
// "Todo: macOS via Appium Mac2 Driver (probably)"). On Darwin, invoking
// `tauri-driver` prints "tauri-driver is not supported on this platform"
// and exits 1.
//
// The suite is staged and ready for the day upstream lands macOS support
// (or for running against a Linux CI runner). Until then, the manual
// scenarios in docs/RELEASE_CHECKLIST.md are the sole release gate on Mac.
//
// Preconditions for actually running the suite:
//   - `tauri-driver` v2.x on PATH (cargo install tauri-driver --version "^2.0")
//   - Linux or Windows host (NOT macOS, until upstream support lands)
//   - Debug build of the Tauri app at `src-tauri/target/debug/clauge`

import { spawn } from 'node:child_process';
import { remote } from 'webdriverio';

let driverProcess: ReturnType<typeof spawn> | null = null;

export async function startDriver() {
  driverProcess = spawn('tauri-driver', [], { stdio: 'pipe' });
  await new Promise((r) => setTimeout(r, 1000));
  const browser = await remote({
    hostname: 'localhost',
    port: 4444,
    capabilities: {
      // @ts-expect-error tauri:options is a non-standard webdriver capability
      'tauri:options': {
        application: 'src-tauri/target/debug/clauge',
      },
    },
  });
  return browser;
}

export async function stopDriver(browser: WebdriverIO.Browser) {
  await browser.deleteSession();
  driverProcess?.kill();
}
