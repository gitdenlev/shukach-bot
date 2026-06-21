import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import * as cheerio from 'cheerio';
import { ScrapeResult, StoreAdapter } from './scraper.types';
import { genericAdapter } from './store-adapters';
import { BrowserScraperService, requiresBrowser } from './browser-scraper.service';

export const SUPPORTED_STORES = [
  { name: 'Comfy',    url: 'https://comfy.ua',        hostname: 'comfy.ua' },
  { name: 'Brain',    url: 'https://brain.com.ua',    hostname: 'brain.com.ua' },
  { name: 'Allo',     url: 'https://allo.ua',         hostname: 'allo.ua' },
  { name: 'Moyo',     url: 'https://moyo.ua',         hostname: 'moyo.ua' },
  { name: 'Foxtrot',  url: 'https://foxtrot.com.ua',  hostname: 'foxtrot.com.ua' },
  { name: 'Citrus',   url: 'https://citrus.ua',       hostname: 'citrus.ua' },
];

/**
 * Regex for RFC-1918 private / loopback IPv4 ranges and IPv6 loopback.
 * Blocks SSRF attempts targeting internal infrastructure.
 */
const PRIVATE_IP_RE = new RegExp(
  '^(' +
    '127\\.\\d+\\.\\d+\\.\\d+' +         // 127.0.0.0/8  loopback
    '|10\\.\\d+\\.\\d+\\.\\d+' +          // 10.0.0.0/8   private
    '|192\\.168\\.\\d+\\.\\d+' +          // 192.168.0.0/16 private
    '|172\\.(1[6-9]|2\\d|3[01])\\.\\d+\\.\\d+' + // 172.16.0.0/12 private
    '|169\\.254\\.\\d+\\.\\d+' +          // 169.254.0.0/16 link-local
    '|0\\.0\\.0\\.0' +                    // unspecified
    '|\\[::1\\]' +                        // IPv6 loopback (bracket form)
    '|::1' +                             // IPv6 loopback (bare)
  ')$',
  'i',
);

const ADAPTERS: StoreAdapter[] = [
  genericAdapter,
];

/**
 * Pool of real desktop browser User-Agents.
 * Rozetka and some other stores detect bots via a static UA; rotating
 * across several real-browser strings greatly reduces 403 probability.
 */
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
];

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/** Build request headers, injecting a domain-appropriate Referer for anti-bot bypass. */
function buildHeaders(url: string): Record<string, string> {
  const origin = new URL(url).origin;
  const ua = randomUserAgent();

  return {
    'User-Agent': ua,
    'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Referer': `${origin}/`,
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
  };
}

@Injectable()
export class ScraperService {
  private readonly logger = new Logger(ScraperService.name);

  constructor(private readonly browserScraper: BrowserScraperService) {}

  async scrape(url: string): Promise<ScrapeResult> {
    this.validateUrl(url);
    this.validateSupportedStore(url);

    const hostname = new URL(url).hostname.toLowerCase();

    // ── Route to Playwright for stores that block plain HTTP requests ────────
    if (requiresBrowser(hostname)) {
      this.logger.debug(`[Router] ${hostname} requires browser scraping — delegating to BrowserScraperService`);
      return this.browserScraper.scrape(url);
    }

    // ── Standard axios path for stores that serve static HTML ───────────────
    let html: string;
    try {
      html = await this.fetchHtml(url);
    } catch (err) {
      const message = this.httpErrorMessage(err, url);
      this.logger.warn(message);
      throw new Error(message);
    }

    const $ = cheerio.load(html);
    const adapter = this.pickAdapter(url);

    this.logger.debug(`Using adapter "${adapter.matches}" for URL: ${url}`);

    try {
      const result = adapter.extract($, url);
      this.logger.log(`Scraped "${result.title}" | price: ${result.price} ${result.currency} | inStock: ${result.inStock}`);
      return { ...result, rawHtml: html };
    } catch (err) {
      const msg = `Failed to parse page content from ${url}: ${(err as Error).message}`;
      this.logger.error(msg);
      throw new Error(msg);
    }
  }


  /**
   * Validates the URL for both security and supported-store constraints.
   *
   * Security rules enforced:
   *  1. Must be a syntactically valid URL.
   *  2. Protocol must be http: or https: — blocks javascript:, ftp:, etc.
   *  3. No userinfo (username / password) — blocks `user@host` credential embedding.
   *  4. Hostname must NOT be localhost or a private/loopback IP — blocks SSRF.
   *  5. Hostname must match one of the allowed store domains exactly, or be a
   *     direct subdomain (e.g. www.comfy.ua) — prevents path/query injection.
   */
  private validateUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid URL: "${url}"`);
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Invalid URL: "${url}" — only http/https are allowed`);
    }

    if (parsed.username || parsed.password) {
      throw new Error(`Invalid URL: "${url}" — userinfo (credentials) not allowed`);
    }

    const hostname = parsed.hostname.toLowerCase();

    if (hostname === 'localhost' || PRIVATE_IP_RE.test(hostname)) {
      throw new Error(`Invalid URL: "${url}" — private/local hosts are not allowed`);
    }
  }

  private validateSupportedStore(url: string): void {
    // URL is already validated by validateUrl(), so new URL() won't throw here.
    const hostname = new URL(url).hostname.toLowerCase();

    const isSupported = SUPPORTED_STORES.some((s) => {
      const allowed = s.hostname.toLowerCase();
      // Allow exact match OR subdomain: e.g. "www.comfy.ua" ends with ".comfy.ua"
      return hostname === allowed || hostname.endsWith(`.${allowed}`);
    });

    if (!isSupported) {
      throw new Error(
        'Цей магазин поки не підтримується. Перегляньте список доступних у розділі Допомога.',
      );
    }
  }

  private async fetchHtml(url: string): Promise<string> {
    const response = await axios.get<string>(url, {
      headers: buildHeaders(url),
      timeout: 15_000,
      maxRedirects: 5,
      decompress: true,
      maxContentLength: 5 * 1024 * 1024, // 5 MB — protects against abnormally large pages
      maxBodyLength: 5 * 1024 * 1024,
    });
    return response.data;
  }

  private pickAdapter(url: string): StoreAdapter {
    return (
      ADAPTERS.find((a) => a.matches.source !== '.*' && a.matches.test(url)) ??
      genericAdapter
    );
  }

  private httpErrorMessage(err: unknown, url: string): string {
    if (err instanceof AxiosError) {
      if (err.code === 'ECONNABORTED') return `Request timed out for ${url}`;
      if (err.code === 'ENOTFOUND') return `Could not resolve host for ${url}`;
      if (err.response) {
        return `HTTP ${err.response.status} from ${url}`;
      }
    }
    return `Network error for ${url}: ${(err as Error).message}`;
  }
}
