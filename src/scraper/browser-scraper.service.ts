import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as cheerio from 'cheerio';
import { ScrapeResult } from './scraper.types';
import { genericAdapter } from './store-adapters';

/**
 * Stores that require a real browser due to Cloudflare / anti-bot JS challenges.
 * Requests to these hostnames are automatically routed through BrowserScraperService.
 */
export const BROWSER_REQUIRED_HOSTNAMES = new Set([
  'foxtrot.com.ua',
  'comfy.ua',
]);

/**
 * Proxy list — rotate per request to reduce per-IP ban risk.
 * Format: 'http://user:pass@host:port'  OR  'http://host:port' (no auth).
 *
 * Leave the array EMPTY to run without a proxy (useful for local dev).
 * On Railway: set PROXY_LIST env var as a comma-separated string of proxy URLs.
 */
function loadProxies(): string[] {
  const raw = process.env.PROXY_LIST ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Pick a pseudo-random entry from an array. */
function pickRandom<T>(arr: T[]): T | undefined {
  if (!arr.length) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Real-browser scraper using Playwright + stealth evasions.
 *
 * Why stealth matters:
 *  - navigator.webdriver = false  (headless Chromium sets this to true by default)
 *  - Realistic viewport, locale and timezone
 *  - Randomised user-agent matching the Chromium version
 *  - Chrome runtime object injected (missing in plain headless)
 *  - No "HeadlessChrome" in the UA string
 *
 * The service lazily creates a shared Browser instance and tears it down
 * when the NestJS module is destroyed (OnModuleDestroy).
 */
@Injectable()
export class BrowserScraperService implements OnModuleDestroy {
  private readonly logger = new Logger(BrowserScraperService.name);
  private browser: Browser | null = null;
  private readonly proxies: string[] = loadProxies();

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;

    const proxy = pickRandom(this.proxies);
    this.logger.debug(proxy ? `Launching browser via proxy: ${proxy}` : 'Launching browser (no proxy)');

    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled', // hides webdriver flag
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-infobars',
        '--window-size=1920,1080',
        ...(proxy ? [`--proxy-server=${proxy}`] : []),
      ],
    });

    return this.browser;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => void 0);
      this.browser = null;
    }
  }

  // ── Core scrape ────────────────────────────────────────────────────────────

  async scrape(url: string): Promise<ScrapeResult> {
    const browser = await this.getBrowser();

    // Each scrape gets its own isolated context (cookies / cache don't leak
    // between products, and anti-bot systems see "fresh" sessions).
    const context = await this.createStealthContext(browser);
    const page    = await context.newPage();

    try {
      this.logger.debug(`[Browser] Navigating to: ${url}`);

      await page.goto(url, {
        waitUntil: 'domcontentloaded', // faster than 'networkidle'; JS challenge pages re-render anyway
        timeout: 30_000,
      });

      // If Cloudflare is present it injects a challenge page first.
      // Wait up to 8 s for the challenge to resolve (CF usually solves in ~3-5 s).
      await this.waitForCloudflareSolve(page);

      const html = await page.content();
      const $    = cheerio.load(html);

      const result = genericAdapter.extract($, url);
      this.logger.log(
        `[Browser] Scraped "${result.title}" | price: ${result.price} ${result.currency} | inStock: ${result.inStock}`,
      );
      return { ...result, rawHtml: html };
    } finally {
      await page.close().catch(() => void 0);
      await context.close().catch(() => void 0);
    }
  }

  // ── Stealth context ────────────────────────────────────────────────────────

  private async createStealthContext(browser: Browser): Promise<BrowserContext> {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'uk-UA',
      timezoneId: 'Europe/Kyiv',
      extraHTTPHeaders: {
        'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });

    // ── Stealth script — runs in every new page before any other JS ──────────
    await context.addInitScript(() => {
      // 1. Hide webdriver flag
      Object.defineProperty(navigator, 'webdriver', { get: () => false });

      // 2. Restore plugins array (empty in headless)
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5], // non-zero length satisfies basic checks
      });

      // 3. Restore languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['uk-UA', 'uk', 'en-US', 'en'],
      });

      // 4. Fake chrome runtime object (missing in headless)
      (window as any).chrome = {
        runtime: {},
        loadTimes: () => ({}),
        csi: () => ({}),
        app: {},
      };

      // 5. Overwrite permissions query so Notification is not "denied" by default
      const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
      (window.navigator.permissions as any).query = (parameters: PermissionDescriptor) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: 'default' } as PermissionStatus)
          : originalQuery(parameters);
    });

    return context;
  }

  // ── Cloudflare challenge detection ─────────────────────────────────────────

  /**
   * Waits up to `timeoutMs` for the Cloudflare challenge to auto-solve.
   * Cloudflare renders a challenge page first, then redirects to the real page.
   * We detect the challenge by looking for CF-specific HTML attributes/titles,
   * and poll until they disappear or timeout is reached.
   */
  private async waitForCloudflareSolve(page: Page, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const isChallenging = await page.evaluate(() => {
        const title = document.title.toLowerCase();
        const hasCfAttr = !!document.querySelector('[data-cf-challenge]');
        const isCfTitle = title.includes('just a moment') || title.includes('attention required');
        return hasCfAttr || isCfTitle;
      });

      if (!isChallenging) return; // challenge resolved
      await new Promise((r) => setTimeout(r, 500));
    }

    this.logger.warn(`[Browser] Cloudflare challenge did not resolve within ${timeoutMs}ms for ${page.url()}`);
  }
}
