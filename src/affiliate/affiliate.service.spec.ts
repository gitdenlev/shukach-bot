import { AffiliateService } from './affiliate.service';

describe('AffiliateService', () => {
  let service: AffiliateService;
  const originalEnv = process.env;

  beforeEach(() => {
    service = new AffiliateService();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ── wrap() ─────────────────────────────────────────────────────────────────

  describe('wrap()', () => {
    it('should wrap Rozetka URL with affiliate prefix and subid', () => {
      process.env.AFFILIATE_LINK_PREFIX_ROZETKA = 'https://aff.example.com/rozetka?url=';
      const url = 'https://rozetka.com.ua/product/iphone-15';
      const result = service.wrap(url, 123456);

      expect(result).toBe(
        `https://aff.example.com/rozetka?url=${encodeURIComponent(url)}&subid=123456`,
      );
    });

    it('should wrap URL with www prefix stripped', () => {
      process.env.AFFILIATE_LINK_PREFIX_ROZETKA = 'https://aff.example.com/?url=';
      const url = 'https://www.rozetka.com.ua/product/test';
      const result = service.wrap(url, 1);

      expect(result).toContain('https://aff.example.com/?url=');
    });

    it('should return original URL when no env prefix is configured', () => {
      delete process.env.AFFILIATE_LINK_PREFIX_ROZETKA;
      const url = 'https://rozetka.com.ua/product/test';
      const result = service.wrap(url);

      expect(result).toBe(url);
    });

    it('should return original URL for unsupported store', () => {
      const url = 'https://amazon.com/product/test';
      const result = service.wrap(url, 1);

      expect(result).toBe(url);
    });

    it('should return original URL for invalid URL input', () => {
      const result = service.wrap('not-a-url', 1);
      expect(result).toBe('not-a-url');
    });

    it('should omit subid param when userId is not provided', () => {
      process.env.AFFILIATE_LINK_PREFIX_ALLO = 'https://aff.example.com/allo?url=';
      const url = 'https://allo.ua/product/test';
      const result = service.wrap(url);

      expect(result).not.toContain('subid');
    });

    it('should handle BigInt userId', () => {
      process.env.AFFILIATE_LINK_PREFIX_BRAIN = 'https://aff.example.com/brain?url=';
      const url = 'https://brain.com.ua/product/test';
      const result = service.wrap(url, BigInt(930478064));

      expect(result).toContain('subid=930478064');
    });
  });

  // ── hasAffiliate() ─────────────────────────────────────────────────────────

  describe('hasAffiliate()', () => {
    it('should return true when prefix is configured', () => {
      process.env.AFFILIATE_LINK_PREFIX_COMFY = 'https://aff.example.com/comfy?url=';
      expect(service.hasAffiliate('https://comfy.ua/product/test')).toBe(true);
    });

    it('should return false when prefix is empty string', () => {
      process.env.AFFILIATE_LINK_PREFIX_COMFY = '';
      expect(service.hasAffiliate('https://comfy.ua/product/test')).toBe(false);
    });

    it('should return false for unsupported store', () => {
      expect(service.hasAffiliate('https://unknown-store.ua/product')).toBe(false);
    });

    it('should return false for invalid URL', () => {
      expect(service.hasAffiliate('not-a-url')).toBe(false);
    });
  });
});
