import { Page } from "@playwright/test";
import { cache } from "./cache";
import { estimateTokens } from "./utils";

export async function detectNavigationChange(
  page: Page,
  state: { currentPageUrl: string; navigationCount: number },
  useCache: boolean,
): Promise<boolean> {
  const newUrl = page.url();
  if (newUrl !== state.currentPageUrl) {
    state.navigationCount++;
    console.log(
      `🧭 Navigation ${state.navigationCount} detected: ${state.currentPageUrl} → ${newUrl}`,
    );
    state.currentPageUrl = newUrl;
    if (useCache) {
      cache.htmlContent = null;
      cache.htmlTimestamp = 0;
      cache.currentUrl = newUrl;
      cache.llmResponse = null;
      cache.llmCommand = "";
      console.log("🗑️ All caches invalidated due to navigation");
    }
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 8000 });
      await page.waitForTimeout(1000);
    } catch {
      console.warn("⚠️ Timeout waiting for page load, continuing...");
      await page.waitForTimeout(1500);
    }
    return true;
  }
  return false;
}

export async function getOptimizedHTML(
  page: Page,
  containerSelector: string | undefined,
  useCache: boolean,
): Promise<string> {
  const now = Date.now();
  const urlChanged = cache.currentUrl !== page.url();
  if (
    useCache &&
    !urlChanged &&
    cache.htmlContent &&
    now - cache.htmlTimestamp < cache.CACHE_DURATION
  ) {
    console.log("📋 Using cached HTML (saves ~2-3 seconds)");
    return cache.htmlContent!;
  }
  await page.waitForTimeout(800);
  let html = "";
  try {
    if (containerSelector) {
      const c = page.locator(containerSelector);
      if (await c.isVisible()) {
        html = await c.innerHTML();
        console.log(`🎯 Using container HTML: ${containerSelector}`);
      } else {
        console.warn(
          `⚠️ Container ${containerSelector} not visible, using full HTML`,
        );
        html = await page.content();
      }
    } else {
      const mainLoc = page.locator("main, [role='main'], #root, #app").first();
      html = (await mainLoc.count())
        ? await mainLoc.innerHTML()
        : await page.content();
    }
  } catch {
    console.warn("⚠️ Error accessing container, using full HTML");
    html = await page.content();
  }

  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/style="[^"]{50,}"/gi, 'style="…"')
    .replace(/\s(data-[^=]+="[^"]*")/g, "")
    .replace(/\s(class="[^"]{100,}")/gi, ' class="…"')
    .replace(/\s+/g, " ")
    .trim();
  const max = 25000;
  const finalHTML =
    cleaned.length > max
      ? cleaned.slice(0, max) + "\n<!-- [HTML truncated] -->"
      : cleaned;
  if (useCache) {
    cache.htmlContent = finalHTML;
    cache.htmlTimestamp = now;
    cache.currentUrl = page.url();
  }
  console.log(`📊 HTML optimized: ${estimateTokens(finalHTML)} tokens`);
  return finalHTML;
}

export async function tryExecuteWaitCommand(
  page: Page,
  cmd: string,
  useCache: boolean,
): Promise<boolean> {
  const timeP = [
    /(?:wait|pause|sleep)\s+(?:for\s+)?(\d+)\s+seconds?/i,
    /wait\s+(\d+)s/i,
  ];
  const reloadP = [
    /(?:reload|refresh)\s+(?:the\s+)?page/i,
    /page\s+(?:reload|refresh)/i,
  ];
  const cacheP = [
    /clear\s+(?:the\s+)?cache/i,
    /cache\s+clear/i,
    /clear\s+browser\s+cache/i,
    /flush\s+cache/i,
  ];

  for (const p of cacheP)
    if (p.test(cmd)) {
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        document.cookie
          .split(";")
          .forEach(
            (c) =>
              (document.cookie = c
                .replace(/^ +/, "")
                .replace(
                  /=.*/,
                  "=;expires=" + new Date().toUTCString() + ";path=/",
                )),
          );
      });
      await page.context().clearCookies();
      if (useCache) {
        cache.htmlContent = null;
        cache.htmlTimestamp = 0;
        cache.currentUrl = page.url();
        cache.llmResponse = null;
        cache.llmCommand = "";
      }
      await page.waitForTimeout(900);
      return true;
    }
  for (const p of reloadP)
    if (p.test(cmd)) {
      await page.reload({ waitUntil: "domcontentloaded" });
      if (useCache) {
        cache.htmlContent = null;
        cache.htmlTimestamp = 0;
        cache.currentUrl = page.url();
        cache.llmResponse = null;
        cache.llmCommand = "";
      }
      await page.waitForTimeout(1500);
      return true;
    }
  for (const p of timeP) {
    const m = cmd.match(p);
    if (m) {
      await page.waitForTimeout(parseInt(m[1]) * 1000);
      return true;
    }
  }
  return false;
}
