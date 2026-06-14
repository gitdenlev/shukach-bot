import { TrackedItem } from '@prisma/client';
import {
  itemInlineKeyboard,
  formatItemAdded,
  formatItemCard,
  formatItemList,
  formatItemDeleted,
  formatPriceDropAlert,
  formatBackInStockAlert,
  formatPriceAnalysis,
  extractStore,
  formatCurrency,
  formatStoreLocation,
  formatReservationAdvice,
  buildNotificationKeyboard,
  NearbyStore,
} from './bot.utils';
import { ScrapeResult } from '../scraper/scraper.types';
import { PriceAnalysis } from '../analysis/price-analysis.service';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<TrackedItem> = {}): TrackedItem {
  return {
    id: 1,
    url: 'https://rozetka.com.ua/product/test',
    title: 'Test Product',
    currentPrice: 10000,
    previousPrice: 11000,
    initialPrice: 12000,
    lowestPrice: 9500,
    targetPrice: null,
    currency: 'UAH',
    inStock: true,
    isActive: true,
    isFrozen: false,
    lastCheckedAt: new Date('2026-05-26T10:00:00Z'),
    nextCheckAt: new Date('2026-05-26T10:00:00Z'),
    consecutiveErrors: 0,
    checkIntervalMinutes: 720,
    createdAt: new Date('2026-05-20T10:00:00Z'),
    updatedAt: new Date('2026-05-26T10:00:00Z'),
    userId: 1,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('bot.utils', () => {
  // ── itemInlineKeyboard ───────────────────────────────────────────────────

  describe('itemInlineKeyboard', () => {
    it('should create keyboard with site link and delete button', () => {
      const kb = itemInlineKeyboard(42, 'https://example.com');
      expect(kb.inline_keyboard).toHaveLength(1);
      expect(kb.inline_keyboard[0]).toHaveLength(2);
      expect(kb.inline_keyboard[0][0]).toEqual({
        text: '🔗 Відкрити сайт',
        url: 'https://example.com',
      });
      expect(kb.inline_keyboard[0][1]).toEqual({
        text: '❌ Видалити',
        callback_data: 'delete_item:42',
      });
    });
  });

  // ── extractStore ─────────────────────────────────────────────────────────

  describe('extractStore', () => {
    it.each([
      ['https://rozetka.com.ua/product/123', 'Rozetka'],
      ['https://www.rozetka.com.ua/product/123', 'Rozetka'],
      ['https://brain.com.ua/product/test', 'Brain'],
      ['https://allo.ua/product/test', 'Allo'],
      ['https://moyo.ua/product/test', 'Moyo'],
      ['https://epicentrk.ua/product/test', 'Епіцентр'],
      ['https://comfy.ua/product/test', 'Comfy'],
      ['https://foxtrot.com.ua/product/test', 'Foxtrot'],
    ])('should extract store name from %s → %s', (url, expected) => {
      expect(extractStore(url)).toBe(expected);
    });

    it('should return hostname for unknown store', () => {
      expect(extractStore('https://unknown-store.ua/product')).toBe('unknown-store.ua');
    });

    it('should return raw URL for invalid URL', () => {
      expect(extractStore('not-a-url')).toBe('not-a-url');
    });
  });

  // ── formatCurrency ───────────────────────────────────────────────────────

  describe('formatCurrency', () => {
    it('should format UAH with hryvnia symbol', () => {
      const result = formatCurrency(12500);
      expect(result).toContain('₴');
      // locale-specific number format
      expect(result).toMatch(/12[\s\u00a0]?500/);
    });

    it('should format zero correctly', () => {
      expect(formatCurrency(0)).toContain('0');
    });

    it('should use non-UAH currency code as-is', () => {
      expect(formatCurrency(100, 'USD')).toContain('USD');
    });
  });

  // ── formatItemAdded ──────────────────────────────────────────────────────

  describe('formatItemAdded', () => {
    it('should format a successfully added item', () => {
      const item = makeItem();
      const scraped: ScrapeResult = {
        title: 'Test Product',
        price: 10000,
        currency: 'UAH',
        inStock: true,
      };
      const result = formatItemAdded(item, scraped);

      expect(result).toContain('✅');
      expect(result).toContain('Додано до відстеження');
      expect(result).toContain('Test Product');
      expect(result).toContain('Rozetka');
      expect(result).toContain('В наявності');
    });

    it('should handle null price gracefully', () => {
      const item = makeItem({ currentPrice: null });
      const scraped: ScrapeResult = {
        title: 'Test',
        price: null,
        currency: 'UAH',
        inStock: false,
      };
      const result = formatItemAdded(item, scraped);

      expect(result).toContain('ціна не знайдена');
      expect(result).toContain('Немає в наявності');
    });
  });

  // ── formatItemCard ───────────────────────────────────────────────────────

  describe('formatItemCard', () => {
    it('should format item card with all fields', () => {
      const result = formatItemCard(makeItem());
      expect(result).toContain('Test Product');
      expect(result).toContain('Rozetka');
      expect(result).toContain('В наявності');
    });

    it('should truncate long titles at 60 characters', () => {
      const longTitle = 'A'.repeat(100);
      const result = formatItemCard(makeItem({ title: longTitle }));
      // Truncated to 59 chars + '…'
      expect(result).not.toContain('A'.repeat(100));
      expect(result).toContain('…');
    });

    it('should show "не визначена" for null price', () => {
      const result = formatItemCard(makeItem({ currentPrice: null }));
      expect(result).toContain('не визначена');
    });
  });

  // ── formatItemList ───────────────────────────────────────────────────────

  describe('formatItemList', () => {
    it('should format multiple items with header', () => {
      const items = [makeItem({ id: 1 }), makeItem({ id: 2 })];
      const result = formatItemList(items, 5);
      expect(result).toContain('Ваші товари (2/5)');
      expect(result).toContain('──────────────────');
    });
  });

  // ── formatItemDeleted ────────────────────────────────────────────────────

  describe('formatItemDeleted', () => {
    it('should format deletion confirmation', () => {
      const result = formatItemDeleted(makeItem());
      expect(result).toContain('Видалено з відстеження');
      expect(result).toContain('Test Product');
      expect(result).toContain('Rozetka');
    });
  });

  // ── formatPriceDropAlert ─────────────────────────────────────────────────

  describe('formatPriceDropAlert', () => {
    it('should format price drop with percentage and absolute savings', () => {
      const result = formatPriceDropAlert(makeItem(), 10000, 9000);
      expect(result).toContain('Ціна впала');
      expect(result).toContain('10.0%');
    });

    it('should include analysis when provided', () => {
      const analysis: PriceAnalysis = {
        verdict: 'real_discount',
        pctDrop: 10,
        verdictText: '✅ Чесна знижка. Товар досяг свого історичного мінімуму.',
      };
      const result = formatPriceDropAlert(makeItem(), 10000, 9000, analysis);
      expect(result).toContain('Чесна знижка');
    });

    it('should omit analysis section when not provided', () => {
      const result = formatPriceDropAlert(makeItem(), 10000, 9000);
      expect(result).not.toContain('Аналіз пропозиції');
    });
  });

  // ── formatBackInStockAlert ───────────────────────────────────────────────

  describe('formatBackInStockAlert', () => {
    it('should format back-in-stock with price', () => {
      const result = formatBackInStockAlert(makeItem({ currentPrice: 5000 }));
      expect(result).toContain('знову в наявності');
    });

    it('should handle null price', () => {
      const result = formatBackInStockAlert(makeItem({ currentPrice: null }));
      expect(result).toContain('не вказана');
    });
  });

  // ── formatPriceAnalysis ──────────────────────────────────────────────────

  describe('formatPriceAnalysis', () => {
    it.each<[PriceAnalysis['verdict'], string, string]>([
      ['real_discount',       'Чесна знижка',    '✅ Чесна знижка. Товар досяг свого історичного мінімуму.'],
      ['marketing_move',      'Маркетинговий хід', '⚠️ Маркетинговий хід.'],
      ['artificial_increase', 'Штучне завищення',  '❌ Штучне завищення.'],
    ])('should render verdict "%s" correctly', (verdict, expectedText, verdictText) => {
      const analysis: PriceAnalysis = { verdict, pctDrop: 5, verdictText };
      const result = formatPriceAnalysis(analysis);
      expect(result).toContain(expectedText);
    });
  });

  // ── formatStoreLocation ──────────────────────────────────────────────────

  describe('formatStoreLocation', () => {
    it('should display distance in meters when < 1km', () => {
      const store: NearbyStore = {
        address: 'вул. Тестова, 1',
        distanceMeters: 350,
        isClosestOverall: true,
        mapsUrl: 'https://maps.google.com',
      };
      expect(formatStoreLocation(store)).toContain('350 м');
    });

    it('should display distance in km when >= 1km', () => {
      const store: NearbyStore = {
        address: 'вул. Тестова, 1',
        distanceMeters: 2400,
        isClosestOverall: false,
        mapsUrl: 'https://maps.google.com',
      };
      expect(formatStoreLocation(store)).toContain('2.4 км');
    });
  });

  // ── formatReservationAdvice ──────────────────────────────────────────────

  describe('formatReservationAdvice', () => {
    it('should return advice when store is closest', () => {
      const store: NearbyStore = {
        address: 'test',
        distanceMeters: 100,
        isClosestOverall: true,
        mapsUrl: '',
      };
      expect(formatReservationAdvice(store)).toContain('зарезервувати');
    });

    it('should return empty string when store is not closest', () => {
      const store: NearbyStore = {
        address: 'test',
        distanceMeters: 5000,
        isClosestOverall: false,
        mapsUrl: '',
      };
      expect(formatReservationAdvice(store)).toBe('');
    });
  });

  // ── buildNotificationKeyboard ────────────────────────────────────────────

  describe('buildNotificationKeyboard', () => {
    it('should include buy button with affiliate URL', () => {
      const kb = buildNotificationKeyboard({
        affiliateUrl: 'https://aff.example.com',
      });
      expect(kb.inline_keyboard).toHaveLength(1);
      expect(kb.inline_keyboard[0][0].url).toBe('https://aff.example.com');
    });

    it('should prepend store reservation button when store is provided', () => {
      const store: NearbyStore = {
        address: 'test',
        distanceMeters: 100,
        isClosestOverall: true,
        mapsUrl: 'https://maps.google.com',
      };
      const kb = buildNotificationKeyboard({
        affiliateUrl: 'https://aff.example.com',
        store,
      });
      expect(kb.inline_keyboard).toHaveLength(2);
      expect(kb.inline_keyboard[0][0].text).toContain('Забронювати');
    });
  });

  // ── HTML escaping (via formatItemCard) ─────────────────────────────────

  describe('HTML escaping', () => {
    it('should escape HTML entities in titles', () => {
      const item = makeItem({ title: 'Samsung <Galaxy> S24 & Ultra' });
      const result = formatItemCard(item);
      expect(result).toContain('&lt;Galaxy&gt;');
      expect(result).toContain('&amp;');
      expect(result).not.toContain('<Galaxy>');
    });
  });
});
