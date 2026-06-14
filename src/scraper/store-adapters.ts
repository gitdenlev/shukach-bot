import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { StoreAdapter } from './scraper.types';

export const genericAdapter: StoreAdapter = {
  matches: /.*/,
  extract: ($, _url) => {
    // --- 1. Try JSON-LD ---
    let jsonLdTitle: string | undefined;
    let jsonLdPrice: number | null = null;
    let jsonLdInStock: boolean | undefined;

    $('script[type="application/ld+json"]').each((_i: number, el: Element) => {
      try {
        const raw = $(el).html() ?? '';
        const data = JSON.parse(raw) as Record<string, unknown>;
        const schemas = Array.isArray(data) ? data : [data];

        for (const schema of schemas) {
          if (schema['@type'] === 'Product' || schema['@type'] === 'Offer') {
            if (!jsonLdTitle) jsonLdTitle = schema['name'] as string | undefined;
            const offers = schema['offers'];
            if (offers) {
              const offerList = Array.isArray(offers) ? offers : [offers];
              const firstOffer = offerList[0] as Record<string, unknown> | undefined;
              if (firstOffer) {
                if (!jsonLdPrice) jsonLdPrice = parsePrice(String(firstOffer['price'] ?? ''));
                if (jsonLdInStock === undefined) {
                  jsonLdInStock = String(firstOffer['availability'] ?? '').toLowerCase().includes('instock');
                }
              }
            }
          }
        }
      } catch {
        // malformed JSON-LD — skip
      }
    });

    // --- 2. OpenGraph / meta fallbacks ---
    const ogTitle = $('meta[property="og:title"]').attr('content')?.trim();
    const metaTitle = $('meta[name="title"]').attr('content')?.trim();
    const h1Title = $('h1').first().text().trim();
    const docTitle = $('title').text().trim();

    const title = jsonLdTitle || ogTitle || metaTitle || h1Title || docTitle || 'Unknown Product';

    // --- 3. Price from common selectors ---
    const priceCandidates = [
      $('[itemprop="price"]').attr('content'),
      $('[class*="price"][class*="current"]').first().text(),
      $('[class*="price"][class*="big"]').first().text(),
      $('[class*="product-price"]').first().text(),
      $('[class*="current-price"]').first().text(),
      $('[data-price]').first().attr('data-price'),
      $('[class*="Price"]').first().text(),
    ].filter(Boolean) as string[];

    let price: number | null = jsonLdPrice;
    if (!price) {
      for (const candidate of priceCandidates) {
        const parsed = parsePrice(candidate);
        if (parsed !== null) { price = parsed; break; }
      }
    }

    // --- 4. Stock status ---
    const outOfStockKeywords = ['немає в наявності', 'out of stock', 'unavailable', 'sold out'];
    const bodyText = $('body').text().toLowerCase();
    const inStock =
      jsonLdInStock ??
      !outOfStockKeywords.some((kw) => bodyText.includes(kw));

    // --- 5. Validation ---
    if (price === null && !jsonLdTitle && jsonLdInStock === undefined) {
      throw new Error("За цим посиланням не знайдено товару. Переконайтеся, що це сторінка конкретного товару в інтернет-магазині.");
    }

    return { title, price, currency: 'UAH', inStock };
  },
};

function parsePrice(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/[₴$€£UAH\s]/gi, '')
    .replace(',', '.')
    .trim();

  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}
