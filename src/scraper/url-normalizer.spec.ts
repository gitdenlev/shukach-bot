import { normalizeUrl } from './url-normalizer';

describe('normalizeUrl', () => {

  // ── Hostname normalisation ─────────────────────────────────────────────────

  describe('hostname', () => {
    it('lower-cases an upper-case hostname', () => {
      expect(normalizeUrl('https://COMFY.UA/product/123'))
        .toBe('https://comfy.ua/product/123');
    });

    it('lower-cases a mixed-case hostname', () => {
      expect(normalizeUrl('https://Comfy.Ua/product/123'))
        .toBe('https://comfy.ua/product/123');
    });

    it('leaves an already lower-case hostname unchanged', () => {
      expect(normalizeUrl('https://comfy.ua/product/123'))
        .toBe('https://comfy.ua/product/123');
    });
  });

  // ── Fragment removal ───────────────────────────────────────────────────────

  describe('fragment', () => {
    it('strips URL fragment', () => {
      expect(normalizeUrl('https://comfy.ua/product/123#reviews'))
        .toBe('https://comfy.ua/product/123');
    });

    it('strips fragment even when query params are present', () => {
      expect(normalizeUrl('https://comfy.ua/product/123?color=red#tab-2'))
        .toBe('https://comfy.ua/product/123?color=red');
    });

    it('handles URL with only a fragment', () => {
      expect(normalizeUrl('https://comfy.ua/product/123#'))
        .toBe('https://comfy.ua/product/123');
    });
  });

  // ── Tracking param removal ─────────────────────────────────────────────────

  describe('tracking params', () => {
    it('removes utm_source', () => {
      expect(normalizeUrl('https://comfy.ua/product/123?utm_source=google'))
        .toBe('https://comfy.ua/product/123');
    });

    it('removes utm_medium', () => {
      expect(normalizeUrl('https://comfy.ua/product/123?utm_medium=cpc'))
        .toBe('https://comfy.ua/product/123');
    });

    it('removes utm_campaign', () => {
      expect(normalizeUrl('https://comfy.ua/product/123?utm_campaign=summer-sale'))
        .toBe('https://comfy.ua/product/123');
    });

    it('removes utm_content', () => {
      expect(normalizeUrl('https://comfy.ua/product/123?utm_content=banner'))
        .toBe('https://comfy.ua/product/123');
    });

    it('removes utm_term', () => {
      expect(normalizeUrl('https://comfy.ua/product/123?utm_term=phone'))
        .toBe('https://comfy.ua/product/123');
    });

    it('removes fbclid', () => {
      expect(normalizeUrl('https://comfy.ua/product/123?fbclid=IwAR123abc'))
        .toBe('https://comfy.ua/product/123');
    });

    it('removes gclid', () => {
      expect(normalizeUrl('https://comfy.ua/product/123?gclid=EAIaIQo'))
        .toBe('https://comfy.ua/product/123');
    });

    it('removes msclkid', () => {
      expect(normalizeUrl('https://allo.ua/product/item?msclkid=abc123'))
        .toBe('https://allo.ua/product/item');
    });

    it('removes multiple tracking params at once', () => {
      expect(normalizeUrl(
        'https://comfy.ua/product/123?utm_source=google&utm_medium=cpc&fbclid=abc&color=black'
      )).toBe('https://comfy.ua/product/123?color=black');
    });

    it('removes unknown utm_ prefixed param (forward compatibility)', () => {
      expect(normalizeUrl('https://comfy.ua/product/123?utm_new_param=value'))
        .toBe('https://comfy.ua/product/123');
    });

    it('removes ref param', () => {
      expect(normalizeUrl('https://brain.com.ua/product/item?ref=homepage'))
        .toBe('https://brain.com.ua/product/item');
    });
  });

  // ── Structural params preserved ────────────────────────────────────────────

  describe('structural params (must be preserved)', () => {
    it('keeps product ID params', () => {
      expect(normalizeUrl('https://comfy.ua/search?productId=12345'))
        .toBe('https://comfy.ua/search?productId=12345');
    });

    it('keeps color/size variant params', () => {
      expect(normalizeUrl('https://allo.ua/product/shirt?color=blue&size=L'))
        .toBe('https://allo.ua/product/shirt?color=blue&size=L');
    });

    it('keeps "page" param for paginated paths', () => {
      expect(normalizeUrl('https://foxtrot.com.ua/category?page=2'))
        .toBe('https://foxtrot.com.ua/category?page=2');
    });

    it('strips tracking but keeps structural params together', () => {
      const input = 'https://moyo.ua/product/item?color=red&utm_source=fb&size=M&fbclid=abc';
      expect(normalizeUrl(input)).toBe('https://moyo.ua/product/item?color=red&size=M');
    });
  });

  // ── Trailing slash ─────────────────────────────────────────────────────────

  describe('trailing slash', () => {
    it('removes trailing slash from non-root path with no query string', () => {
      expect(normalizeUrl('https://comfy.ua/product/123/'))
        .toBe('https://comfy.ua/product/123');
    });

    it('keeps root "/" path unchanged', () => {
      expect(normalizeUrl('https://comfy.ua/'))
        .toBe('https://comfy.ua/');
    });

    it('does NOT remove trailing slash when query params are present', () => {
      // After param stripping, if product path ends in /, we still strip
      // (this is intentional — trailing slash + no remaining params → normalise).
      expect(normalizeUrl('https://comfy.ua/product/?color=blue'))
        .toBe('https://comfy.ua/product/?color=blue');
    });
  });

  // ── Query param sorting ────────────────────────────────────────────────────

  describe('param sorting', () => {
    it('sorts remaining query params alphabetically', () => {
      expect(normalizeUrl('https://comfy.ua/search?size=L&color=blue'))
        .toBe('https://comfy.ua/search?color=blue&size=L');
    });
  });

  // ── Protocol / path preservation ──────────────────────────────────────────

  describe('protocol and path unchanged', () => {
    it('preserves http:// protocol', () => {
      expect(normalizeUrl('http://comfy.ua/product/123'))
        .toBe('http://comfy.ua/product/123');
    });

    it('preserves https:// protocol', () => {
      expect(normalizeUrl('https://comfy.ua/product/123'))
        .toBe('https://comfy.ua/product/123');
    });

    it('preserves path case (product slugs are case-sensitive on some stores)', () => {
      expect(normalizeUrl('https://comfy.ua/Product/iPhone-15-Pro'))
        .toBe('https://comfy.ua/Product/iPhone-15-Pro');
    });

    it('preserves subdomain', () => {
      expect(normalizeUrl('https://www.foxtrot.com.ua/product/item'))
        .toBe('https://www.foxtrot.com.ua/product/item');
    });
  });

  // ── Deduplication correctness ──────────────────────────────────────────────

  describe('deduplication (same URL, different tracking)', () => {
    it('two affiliate links to same product produce the same normalised URL', () => {
      const direct   = 'https://citrus.ua/product/iphone-15-pro?color=black';
      const affiliate = 'https://citrus.ua/product/iphone-15-pro?color=black&utm_source=partner&utm_medium=cpc&fbclid=XYZ';

      expect(normalizeUrl(direct)).toBe(normalizeUrl(affiliate));
    });

    it('URLs differing only by fragment are deduplicated', () => {
      const a = 'https://brain.com.ua/item/gpu-4090#description';
      const b = 'https://brain.com.ua/item/gpu-4090#reviews';

      expect(normalizeUrl(a)).toBe(normalizeUrl(b));
    });

    it('URLs with mixed-case hostname are deduplicated', () => {
      const a = 'https://ALLO.UA/product/42';
      const b = 'https://allo.ua/product/42';

      expect(normalizeUrl(a)).toBe(normalizeUrl(b));
    });

    it('URLs with and without trailing slash are deduplicated', () => {
      const a = 'https://moyo.ua/product/smart-tv';
      const b = 'https://moyo.ua/product/smart-tv/';

      expect(normalizeUrl(a)).toBe(normalizeUrl(b));
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns original string for an invalid URL', () => {
      const bad = 'not-a-url';
      expect(normalizeUrl(bad)).toBe(bad);
    });

    it('handles URL with no path at all', () => {
      expect(normalizeUrl('https://comfy.ua')).toBe('https://comfy.ua/');
    });

    it('handles URL with empty query string', () => {
      expect(normalizeUrl('https://comfy.ua/product/123?'))
        .toBe('https://comfy.ua/product/123');
    });
  });
});
