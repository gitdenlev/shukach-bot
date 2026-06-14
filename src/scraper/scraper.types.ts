export interface ScrapeResult {
  title: string;
  price: number | null;
  currency: string;
  inStock: boolean;
  rawHtml?: string;
}

import type { CheerioAPI } from 'cheerio';

export interface StoreAdapter {
  /** Regex or hostname pattern this adapter handles */
  matches: RegExp;
  /** Extract data from the loaded Cheerio document */
  extract: (
    $: CheerioAPI,
    url: string,
  ) => Omit<ScrapeResult, 'rawHtml'>;
}
