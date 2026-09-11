#!/usr/bin/env node
/**
 * Speak First — automated screenshot capture.
 *
 * Drives a headless Chromium over the PUBLIC surfaces of the live site, saves
 * PNGs to screenshots/, then emails the batch in one message via Resend.
 *
 * Nothing here publishes anything. The email is the end of the pipeline —
 * captions and posting stay manual, by design.
 *
 *   SITE_URL              base URL to shoot (default: the Vercel deployment)
 *   RESEND_API_KEY        Resend API key            (required unless SKIP_EMAIL)
 *   AGENT_RECIPIENT_EMAIL where the batch is sent   (required unless SKIP_EMAIL)
 *   SKIP_EMAIL=1          capture only — for local dry runs
 *   SETTLE_MS             pause before each shot (default 3000)
 */
import { chromium } from "playwright";
import { mkdir, writeFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { sendScreenshotEmail } from "./send-email.mjs";

const SITE_URL = (process.env.SITE_URL || "https://speak-first-one.vercel.app").replace(/\/+$/, "");
const OUT_DIR = path.resolve(process.cwd(), "screenshots");
const SKIP_EMAIL = /^(1|true|yes)$/i.test(process.env.SKIP_EMAIL || "");

// Fonts and entrance animations need a beat to settle — screenshots taken the
// instant `load` fires catch half-painted type and mid-flight transitions.
const SETTLE_MS = Number(process.env.SETTLE_MS || 3000);

// UTC so a run is named the same no matter which machine fires it.
const DATE = new Date().toISOString().slice(0, 10);

const VIEWPORTS = [
  { name: "mobile",  width: 390,  height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", width: 1280, height: 800, deviceScaleFactor: 2 },
];

const SHOTS = [
  { slug: "hero",         label: "Landing hero (first viewport)", route: "/",    kind: "viewport" },
  { slug: "landing-full", label: "Landing full page",             route: "/",    kind: "fullpage" },
  { slug: "why",          label: "Why Speak First (full page)",   route: "/why", kind: "fullpage" },
  { slug: "demo",         label: "Guest demo panel, expanded",    route: "/",    kind: "demo"     },
];

// The collapsed demo CTA, most specific first. Accent-tolerant: "Sofía" is easy
// to mangle, so the fallbacks never depend on it.
const DEMO_BUTTON_SELECTORS = [
  'button:has-text("Try it — say hi to Sofía")',
  'button:has-text("say hi to Sof")',
  'button:has-text("Try it")',
];

// Markers that the panel is open: the expand wrapper's open class, or its header.
const DEMO_PANEL_SELECTORS = ['.sf-expand--open', 'text=live demo'];

const results = [];
const record = (status, file, note) => {
  results.push({ status, file, note });
  const icon = status === "ok" ? "✓" : status === "skipped" ? "–" : "✗";
  console.log(`  ${icon} ${file}${note ? ` — ${note}` : ""}`);
};

/** Wipe PNGs from a previous run so an email never carries stale shots. */
async function resetOutDir() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const f of await readdir(OUT_DIR)) {
    if (f.endsWith(".png")) await unlink(path.join(OUT_DIR, f));
  }
}

/**
 * Scroll the whole page once, then return to the top.
 *
 * Belt-and-braces for lazily loaded imagery. The scroll-reveal wrappers are
 * already neutralised by the context's reduced-motion setting (Reveal.jsx
 * renders children immediately in that mode), but a pass down the page also
 * settles anything that waits on a scroll event.
 */
async function primeFullPage(page) {
  await page.evaluate(async () => {
    const step = Math.max(window.innerHeight * 0.8, 400);
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 250));
  });
}

async function gotoAndSettle(page, route) {
  const url = `${SITE_URL}${route}`;
  await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  // Best-effort: a live site may hold an open connection, so never hard-fail here.
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(SETTLE_MS);
}

/** Open the guest demo panel. Returns the panel locator, or null if absent. */
async function openDemoPanel(page) {
  let button = null;
  for (const selector of DEMO_BUTTON_SELECTORS) {
    const candidate = page.locator(selector).first();
    if (await candidate.count().catch(() => 0)) {
      // Confirm it is actually on screen before committing to it.
      if (await candidate.isVisible().catch(() => false)) {
        button = candidate;
        break;
      }
    }
  }
  if (!button) return null;

  await button.scrollIntoViewIfNeeded().catch(() => {});
  await button.click({ timeout: 10_000 });

  for (const selector of DEMO_PANEL_SELECTORS) {
    const panel = page.locator(selector).first();
    try {
      await panel.waitFor({ state: "visible", timeout: 10_000 });
      return page.locator(DEMO_PANEL_SELECTORS[0]).first();
    } catch {
      /* try the next marker */
    }
  }
  return null;
}

async function captureShot(page, shot, viewport) {
  const file = `${DATE}_${shot.slug}_${viewport.name}.png`;
  const dest = path.join(OUT_DIR, file);

  try {
    await gotoAndSettle(page, shot.route);

    if (shot.kind === "demo") {
      const panel = await openDemoPanel(page);
      if (!panel) {
        record("skipped", file, "demo CTA / panel not found on the page");
        return;
      }
      await page.waitForTimeout(SETTLE_MS);
      // Frame the panel itself; fall back to the viewport if the element shot
      // fails (an element mid-animation can report a zero-size box).
      try {
        await panel.screenshot({ path: dest });
      } catch {
        await page.screenshot({ path: dest });
      }
      record("ok", file);
      return;
    }

    if (shot.kind === "fullpage") {
      await primeFullPage(page);
      await page.waitForTimeout(500);
      await page.screenshot({ path: dest, fullPage: true });
    } else {
      await page.screenshot({ path: dest });
    }
    record("ok", file);
  } catch (err) {
    record("failed", file, err.message.split("\n")[0]);
  }
}

async function main() {
  console.log(`Speak First screenshots — ${DATE}`);
  console.log(`Target: ${SITE_URL}\n`);

  await resetOutDir();

  const browser = await chromium.launch();
  try {
    for (const viewport of VIEWPORTS) {
      console.log(`${viewport.name} (${viewport.width}x${viewport.height} @${viewport.deviceScaleFactor}x)`);
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.deviceScaleFactor,
        isMobile: viewport.isMobile ?? false,
        hasTouch: viewport.hasTouch ?? false,
        // Renders scroll-reveal content immediately and stills every transition,
        // so a full-page shot is not a page of invisible sections.
        reducedMotion: "reduce",
        locale: "en-US",
        timezoneId: "UTC",
      });
      const page = await context.newPage();
      for (const shot of SHOTS) await captureShot(page, shot, viewport);
      await context.close();
      console.log("");
    }
  } finally {
    await browser.close();
  }

  const captured = results.filter((r) => r.status === "ok");
  const failed = results.filter((r) => r.status === "failed");
  const skipped = results.filter((r) => r.status === "skipped");

  console.log(`Captured ${captured.length}/${results.length} — ${failed.length} failed, ${skipped.length} skipped`);

  if (captured.length === 0) {
    console.error("\nNo shots were captured. Not sending an email.");
    process.exit(1);
  }

  if (SKIP_EMAIL) {
    console.log(`\nSKIP_EMAIL set — PNGs left in ${OUT_DIR}, no email sent.`);
    return;
  }

  await sendScreenshotEmail({
    date: DATE,
    siteUrl: SITE_URL,
    outDir: OUT_DIR,
    shots: SHOTS,
    captured,
    failed,
    skipped,
  });
}

main().catch((err) => {
  console.error("\nCapture run failed:", err?.stack || err);
  process.exit(1);
});
