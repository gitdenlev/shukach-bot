import * as cheerio from 'cheerio';
import { genericAdapter } from './store-adapters';

describe('Store Adapters', () => {

  // ── Generic Adapter ────────────────────────────────────────────────────────

  describe('genericAdapter', () => {
    it('should match any URL', () => {
      expect(genericAdapter.matches.test('https://anything.com')).toBe(true);
    });

    it('should extract from JSON-LD structured data', () => {
      const html = `
        <html><body>
          <script type="application/ld+json">
          {
            "@type": "Product",
            "name": "Widget Pro",
            "offers": {
              "price": "1999.99",
              "availability": "https://schema.org/InStock"
            }
          }
          </script>
        </body></html>
      `;
      const $ = cheerio.load(html);
      const result = genericAdapter.extract($, 'https://example.com/product');

      expect(result.title).toBe('Widget Pro');
      expect(result.price).toBeCloseTo(1999.99);
      expect(result.inStock).toBe(true);
    });

    it('should fall back to OpenGraph meta when JSON-LD is absent', () => {
      const html = `
        <html><head>
          <meta property="og:title" content="OG Product Title">
        </head><body>
          <span itemprop="price" content="2500">2 500 ₴</span>
        </body></html>
      `;
      const $ = cheerio.load(html);
      const result = genericAdapter.extract($, 'https://example.com/product');

      expect(result.title).toBe('OG Product Title');
      expect(result.price).toBe(2500);
    });

    it('should fall back to h1 tag', () => {
      const html = `
        <html><body>
          <h1>H1 Title</h1>
          <div class="product-price">3 000</div>
        </body></html>
      `;
      const $ = cheerio.load(html);
      const result = genericAdapter.extract($, 'https://example.com/product');

      expect(result.title).toBe('H1 Title');
      expect(result.price).toBe(3000);
    });

    it('should detect out-of-stock from body text', () => {
      const html = `
        <html><body>
          <h1>Product</h1>
          <span class="product-price">1000</span>
          <p>Цей товар немає в наявності</p>
        </body></html>
      `;
      const $ = cheerio.load(html);
      const result = genericAdapter.extract($, 'https://example.com/product');

      expect(result.inStock).toBe(false);
    });

    it('should detect "out of stock" in English', () => {
      const html = `
        <html><body>
          <h1>Product</h1>
          <span class="product-price">1000</span>
          <p>This product is out of stock</p>
        </body></html>
      `;
      const $ = cheerio.load(html);
      const result = genericAdapter.extract($, 'https://example.com/product');

      expect(result.inStock).toBe(false);
    });

    it('should throw when no product data found at all', () => {
      const html = `<html><body><p>Just a blog post</p></body></html>`;
      const $ = cheerio.load(html);

      expect(() => genericAdapter.extract($, 'https://example.com/blog')).toThrow(
        /не знайдено товару/,
      );
    });

    it('should handle malformed JSON-LD gracefully', () => {
      const html = `
        <html><body>
          <script type="application/ld+json">{invalid json!!!}</script>
          <h1>Fallback Product</h1>
          <span class="product-price">5 000 ₴</span>
        </body></html>
      `;
      const $ = cheerio.load(html);
      const result = genericAdapter.extract($, 'https://example.com/product');

      expect(result.title).toBe('Fallback Product');
      expect(result.price).toBe(5000);
    });

    it('should handle comma-separated decimal prices', () => {
      const html = `
        <html><body>
          <h1>Product</h1>
          <span itemprop="price" content="1999,99">1999,99</span>
        </body></html>
      `;
      const $ = cheerio.load(html);
      const result = genericAdapter.extract($, 'https://example.com/product');

      expect(result.price).toBeCloseTo(1999.99);
    });

    it('should use "Unknown Product" when no title found', () => {
      const html = `
        <html><body>
          <span itemprop="price" content="100">100</span>
        </body></html>
      `;
      const $ = cheerio.load(html);
      const result = genericAdapter.extract($, 'https://example.com/product');

      expect(result.title).toBe('Unknown Product');
    });
  });
});
