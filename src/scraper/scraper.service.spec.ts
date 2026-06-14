import { ScraperService } from './scraper.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('ScraperService', () => {
  let service: ScraperService;

  beforeEach(() => {
    service = new ScraperService();
    jest.clearAllMocks();
  });

  // ── Successful scrape ──────────────────────────────────────────────────────

  describe('scrape() — happy path', () => {
    it('should scrape a supported Comfy URL successfully', async () => {
      const mockHtml = `
        <html><body>
          <h1>iPhone 15 Pro</h1>
          <span class="product-price">48 500 ₴</span>
        </body></html>
      `;
      mockedAxios.get.mockResolvedValue({ data: mockHtml });

      const result = await service.scrape('https://comfy.ua/product/123');

      expect(result.title).toBe('iPhone 15 Pro');
      expect(result.price).toBe(48500);
      expect(result.inStock).toBe(true);
      expect(result.currency).toBe('UAH');
      expect(result.rawHtml).toBe(mockHtml);
    });

    it('should use generic adapter for non-specific supported stores', async () => {
      const mockHtml = `
        <html><body>
          <script type="application/ld+json">
          {"@type":"Product","name":"Test Widget","offers":{"price":"1500","availability":"InStock"}}
          </script>
        </body></html>
      `;
      mockedAxios.get.mockResolvedValue({ data: mockHtml });

      const result = await service.scrape('https://comfy.ua/product/test');

      expect(result.title).toBe('Test Widget');
      expect(result.price).toBe(1500);
    });
  });

  // ── URL validation ─────────────────────────────────────────────────────────

  describe('scrape() — URL validation', () => {
    it('should reject invalid URLs', async () => {
      await expect(service.scrape('not-a-url')).rejects.toThrow(/Invalid URL/);
    });

    it('should reject ftp:// protocol', async () => {
      await expect(service.scrape('ftp://rozetka.com.ua/file')).rejects.toThrow(
        /Invalid URL/,
      );
    });

    it('should reject unsupported stores', async () => {
      await expect(service.scrape('https://amazon.com/product/123')).rejects.toThrow(
        /не підтримується/,
      );
    });
  });

  // ── Network errors ─────────────────────────────────────────────────────────

  describe('scrape() — network errors', () => {
    it('should wrap timeout errors with friendly message', async () => {
      const timeoutError = Object.assign(new Error('timeout'), {
        code: 'ECONNABORTED',
        isAxiosError: true,
      });
      // Make it look like an AxiosError
      Object.defineProperty(timeoutError, 'constructor', { value: axios.AxiosError ?? Error });
      mockedAxios.get.mockRejectedValue(timeoutError);

      await expect(service.scrape('https://comfy.ua/product/123')).rejects.toThrow();
    });

    it('should wrap HTTP 404 errors', async () => {
      const httpError: any = new Error('Request failed');
      httpError.isAxiosError = true;
      httpError.code = undefined;
      httpError.response = { status: 404, data: 'Not Found' };
      // Simulate AxiosError by setting constructor name
      Object.setPrototypeOf(httpError, axios.AxiosError?.prototype ?? Error.prototype);
      mockedAxios.get.mockRejectedValue(httpError);

      await expect(service.scrape('https://comfy.ua/product/123')).rejects.toThrow();
    });

    it('should wrap DNS resolution errors', async () => {
      const dnsError: any = new Error('getaddrinfo ENOTFOUND');
      dnsError.isAxiosError = true;
      dnsError.code = 'ENOTFOUND';
      Object.setPrototypeOf(dnsError, axios.AxiosError?.prototype ?? Error.prototype);
      mockedAxios.get.mockRejectedValue(dnsError);

      await expect(service.scrape('https://comfy.ua/product/123')).rejects.toThrow();
    });
  });



  // ── Parse errors ───────────────────────────────────────────────────────────

  describe('scrape() — parse errors', () => {
    it('should throw when page has no product data', async () => {
      const mockHtml = `<html><body><p>Just a blog post</p></body></html>`;
      mockedAxios.get.mockResolvedValue({ data: mockHtml });

      await expect(service.scrape('https://comfy.ua/product/123')).rejects.toThrow(
        /не знайдено товару|Failed to parse/,
      );
    });
  });
});
