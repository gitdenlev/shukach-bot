import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import * as cheerio from 'cheerio';
import { ScrapeResult, StoreAdapter } from './scraper.types';
import {
  genericAdapter,
} from './store-adapters';

export const SUPPORTED_STORES = [
  { name: 'Comfy',    url: 'https://comfy.ua',         domain: /comfy\.ua/i },
  { name: 'Brain',    url: 'https://brain.com.ua',     domain: /brain\.com\.ua/i },
  { name: 'Allo',     url: 'https://allo.ua',          domain: /allo\.ua/i },
  { name: 'Moyo',     url: 'https://moyo.ua',          domain: /moyo\.ua/i },
  { name: 'Foxtrot',  url: 'https://foxtrot.com.ua',  domain: /foxtrot\.com\.ua/i },
  { name: 'ITbox',    url: 'https://itbox.ua',         domain: /itbox\.ua/i },
  { name: 'Citrus',   url: 'https://citrus.ua',        domain: /citrus\.ua/i },
];

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

  async scrape(url: string): Promise<ScrapeResult> {
    this.validateUrl(url);
    this.validateSupportedStore(url);

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

  private validateUrl(url: string): void {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only http/https URLs are supported');
      }
    } catch {
      throw new Error(`Invalid URL: "${url}"`);
    }
  }

  private validateSupportedStore(url: string): void {
    const isSupported = SUPPORTED_STORES.some((s) => s.domain.test(url));
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
