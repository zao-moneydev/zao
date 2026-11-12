import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../src/log.ts";

function safeUrl(url: string): string {
  return url.replace(/token=[^&]+/gi, "token=[REDACTED]");
}

/**
 * Drive the Stellar SEP-24 reference UI (anchor-ref-ui) so the transaction
 * can leave `incomplete`. Always writes a screenshot for Deliverable 2.
 */
export async function completeSep24Interactive(
  url: string,
  screenshotPath: string,
  amount = "5",
): Promise<void> {
  const { chromium } = await import("playwright");
  mkdirSync(dirname(screenshotPath), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    log.info("opening SEP-24 interactive page", { url: safeUrl(url) });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const byLabel: Array<[RegExp, string]> = [
      [/amount/i, amount],
      [/first\s*name/i, "Thabo"],
      [/last\s*name/i, "Mokoena"],
      [/email/i, "thabo.zao.d2@example.com"],
      [/bank|account/i, "123456789"],
    ];
    for (const [label, value] of byLabel) {
      const field = page.getByLabel(label);
      if ((await field.count()) > 0) {
        await field.first().fill(value).catch(() => undefined);
      }
    }

    const boxes = page.locator(
      "input:not([type=hidden]):not([type=submit]):not([type=checkbox]):not([type=radio]), textarea",
    );
    const n = await boxes.count();
    const ordered = [
      amount,
      "Thabo",
      "Mokoena",
      "thabo.zao.d2@example.com",
      "Test Bank",
      "123456789",
    ];
    for (let i = 0; i < n; i++) {
      const box = boxes.nth(i);
      const current = (await box.inputValue().catch(() => "")) ?? "";
      if (!current.trim()) {
        await box.fill(ordered[i] ?? "123456789").catch(() => undefined);
      }
    }

    await page.screenshot({ path: screenshotPath, fullPage: true });
    const submit = page.getByRole("button", { name: /^submit$/i });
    async function clickSubmit() {
      if (await submit.isVisible().catch(() => false)) {
        await submit.click({ timeout: 10_000 });
      }
    }
    await clickSubmit();
    await page.waitForTimeout(1_000);
    const again = await boxes.count();
    for (let i = 0; i < again; i++) {
      const box = boxes.nth(i);
      const current = (await box.inputValue().catch(() => "")) ?? "";
      if (!current.trim() && (await box.isVisible().catch(() => false))) {
        await box.fill("123456789").catch(() => undefined);
      }
    }
    await clickSubmit();
    await Promise.race([
      page
        .getByText(/success|complete|submitted|thank|pending/i)
        .first()
        .waitFor({ timeout: 20_000 }),
      page.waitForTimeout(8_000),
    ]).catch(() => undefined);
    await page.screenshot({
      path: screenshotPath.replace(/\.png$/i, "-after.png"),
      fullPage: true,
    });
  } catch (err) {
    log.error("SEP-24 interactive page failed", { err: String(err) });
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    throw err;
  } finally {
    await browser.close();
  }
}
