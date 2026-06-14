import { SnipeService } from './snipe.service';
import { ItemsService } from '../items/items.service';
import { ScraperService } from '../scraper/scraper.service';
import { PriceAnalysisService } from '../analysis/price-analysis.service';
import { AffiliateService } from '../affiliate/affiliate.service';
import { UsersService } from '../users/users.service';
import { Telegraf } from 'telegraf';

// ── Mock factories ───────────────────────────────────────────────────────────

function createMockItemsService() {
  return {
    getItemsDueForCheck: jest.fn(),
    updateItemPrice: jest.fn(),
    getItemCountForUser: jest.fn(),
    getPriceHistory: jest.fn().mockResolvedValue([]),
    recordPriceSnapshot: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ItemsService>;
}

function createMockScraperService() {
  return {
    scrape: jest.fn(),
  } as unknown as jest.Mocked<ScraperService>;
}

function createMockPriceAnalysis() {
  return {
    getPriceVerdict: jest.fn(),
    analyzePriceTrends: jest.fn(),
  } as unknown as jest.Mocked<PriceAnalysisService>;
}

function createMockAffiliate() {
  return {
    wrap: jest.fn().mockImplementation((url) => url),
    hasAffiliate: jest.fn().mockReturnValue(false),
  } as unknown as jest.Mocked<AffiliateService>;
}

function createMockUsersService() {
  return {
    incrementPotentialSavings: jest.fn(),
    findByUserId: jest.fn().mockResolvedValue({ plan: 'BASE' }),
  } as unknown as jest.Mocked<UsersService>;
}

function createMockBot() {
  return {
    telegram: {
      sendMessage: jest.fn().mockResolvedValue({}),
    },
  } as unknown as jest.Mocked<Telegraf>;
}

function mockTrackedItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    url: 'https://rozetka.com.ua/product/test',
    title: 'Test Product',
    currentPrice: 10000,
    previousPrice: null,
    initialPrice: 10000,
    lowestPrice: 10000,
    targetPrice: null,
    currency: 'UAH',
    inStock: true,
    isActive: true,
    isFrozen: false,
    lastCheckedAt: new Date(),
    nextCheckAt: new Date(),
    consecutiveErrors: 0,
    checkIntervalMinutes: 720,
    createdAt: new Date(),
    updatedAt: new Date(),
    userId: 1,
    user: { telegramId: BigInt(123456789) },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SnipeService', () => {
  let service: SnipeService;
  let itemsService: ReturnType<typeof createMockItemsService>;
  let scraperService: ReturnType<typeof createMockScraperService>;
  let priceAnalysis: ReturnType<typeof createMockPriceAnalysis>;
  let affiliate: ReturnType<typeof createMockAffiliate>;
  let usersService: ReturnType<typeof createMockUsersService>;
  let bot: ReturnType<typeof createMockBot>;

  beforeEach(() => {
    itemsService = createMockItemsService();
    scraperService = createMockScraperService();
    priceAnalysis = createMockPriceAnalysis();
    affiliate = createMockAffiliate();
    usersService = createMockUsersService();
    bot = createMockBot();

    service = new SnipeService(
      itemsService as any,
      scraperService as any,
      priceAnalysis as any,
      affiliate as any,
      usersService as any,
      bot as any,
    );

    // Speed up sleep in tests
    jest.useFakeTimers();
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => {
      fn();
      return 0 as any;
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ── Guard logic ──────────────────────────────────────────────────────────

  describe('isRunning guard', () => {
    it('should skip when no items are due', async () => {
      itemsService.getItemsDueForCheck.mockResolvedValue([]);

      await service.runSniper();

      expect(scraperService.scrape).not.toHaveBeenCalled();
    });
  });

  // ── Price drop detection ─────────────────────────────────────────────────

  describe('price drop notification', () => {
    it('should send notification when price drops by >= 0.5%', async () => {
      const item = mockTrackedItem({ currentPrice: 10000 });
      itemsService.getItemsDueForCheck.mockResolvedValue([item]);
      scraperService.scrape.mockResolvedValue({
        title: 'Test',
        price: 9400, // -6% drop
        currency: 'UAH',
        inStock: true,
      });
      priceAnalysis.getPriceVerdict.mockReturnValue({
        verdict: 'real_discount',
        pctDrop: 6,
        verdictText: '✅ Чесна знижка.',
      });

      await service.runSniper();

      expect(bot.telegram.sendMessage).toHaveBeenCalledWith(
        '123456789',
        expect.stringContaining('Ціна впала'),
        expect.objectContaining({ parse_mode: 'HTML' }),
      );
      expect(itemsService.updateItemPrice).toHaveBeenCalledWith(1, 9400, true);
    });

    it('should NOT send notification for tiny price fluctuation (<0.5%)', async () => {
      const item = mockTrackedItem({ currentPrice: 10000 });
      itemsService.getItemsDueForCheck.mockResolvedValue([item]);
      scraperService.scrape.mockResolvedValue({
        title: 'Test',
        price: 9970, // -0.3% drop
        currency: 'UAH',
        inStock: true,
      });

      await service.runSniper();

      // No price-drop notification
      expect(bot.telegram.sendMessage).not.toHaveBeenCalled();
      // But still updates DB
      expect(itemsService.updateItemPrice).toHaveBeenCalledWith(1, 9970, true);
    });

    it('should NOT notify when price goes UP', async () => {
      const item = mockTrackedItem({ currentPrice: 10000 });
      itemsService.getItemsDueForCheck.mockResolvedValue([item]);
      scraperService.scrape.mockResolvedValue({
        title: 'Test',
        price: 11000, // price increase
        currency: 'UAH',
        inStock: true,
      });

      await service.runSniper();

      expect(bot.telegram.sendMessage).not.toHaveBeenCalled();
    });

    it('should handle null current price gracefully', async () => {
      const item = mockTrackedItem({ currentPrice: null });
      itemsService.getItemsDueForCheck.mockResolvedValue([item]);
      scraperService.scrape.mockResolvedValue({
        title: 'Test',
        price: 5000,
        currency: 'UAH',
        inStock: true,
      });

      await service.runSniper();

      // No price-drop notification (can't compare with null)
      expect(bot.telegram.sendMessage).not.toHaveBeenCalled();
      expect(itemsService.updateItemPrice).toHaveBeenCalled();
    });
  });

  // ── Back-in-stock detection ──────────────────────────────────────────────

  describe('back-in-stock notification', () => {
    it('should send notification when item comes back in stock', async () => {
      const item = mockTrackedItem({ inStock: false, currentPrice: 5000 });
      itemsService.getItemsDueForCheck.mockResolvedValue([item]);
      scraperService.scrape.mockResolvedValue({
        title: 'Test',
        price: 5000,
        currency: 'UAH',
        inStock: true, // was false, now true
      });

      await service.runSniper();

      expect(bot.telegram.sendMessage).toHaveBeenCalledWith(
        '123456789',
        expect.stringContaining('знову в наявності'),
        expect.any(Object),
      );
    });

    it('should NOT notify when item stays in stock', async () => {
      const item = mockTrackedItem({ inStock: true, currentPrice: 5000 });
      itemsService.getItemsDueForCheck.mockResolvedValue([item]);
      scraperService.scrape.mockResolvedValue({
        title: 'Test',
        price: 5000,
        currency: 'UAH',
        inStock: true,
      });

      await service.runSniper();

      expect(bot.telegram.sendMessage).not.toHaveBeenCalled();
    });

    it('should NOT notify when item goes OUT of stock', async () => {
      const item = mockTrackedItem({ inStock: true, currentPrice: 5000 });
      itemsService.getItemsDueForCheck.mockResolvedValue([item]);
      scraperService.scrape.mockResolvedValue({
        title: 'Test',
        price: 5000,
        currency: 'UAH',
        inStock: false,
      });

      await service.runSniper();

      // No back-in-stock notification
      expect(bot.telegram.sendMessage).not.toHaveBeenCalled();
    });
  });

  // ── Potential savings tracking ────────────────────────────────────────────

  describe('potential savings', () => {
    it('should track potential savings when new price is below lowestPrice', async () => {
      const item = mockTrackedItem({ currentPrice: 10000, lowestPrice: 9500 });
      itemsService.getItemsDueForCheck.mockResolvedValue([item]);
      scraperService.scrape.mockResolvedValue({
        title: 'Test',
        price: 9000,
        currency: 'UAH',
        inStock: true,
      });
      priceAnalysis.getPriceVerdict.mockReturnValue({
        verdict: 'real_discount',
        pctDrop: 10,
        verdictText: '✅ Чесна знижка.',
      });

      await service.runSniper();

      expect(usersService.incrementPotentialSavings).toHaveBeenCalledWith(
        1,  // userId
        1,  // itemId
        500, // priceDrop (9500 - 9000)
        9000, // new lowestPrice
      );
    });
  });

  // ── Error resilience ─────────────────────────────────────────────────────

  describe('error resilience', () => {
    it('should continue processing other items when one scrape fails', async () => {
      const item1 = mockTrackedItem({ id: 1 });
      const item2 = mockTrackedItem({ id: 2, url: 'https://allo.ua/product/test' });
      itemsService.getItemsDueForCheck.mockResolvedValue([item1, item2]);

      scraperService.scrape
        .mockRejectedValueOnce(new Error('Network timeout'))
        .mockResolvedValueOnce({
          title: 'Item 2',
          price: 5000,
          currency: 'UAH',
          inStock: true,
        });

      priceAnalysis.getPriceVerdict.mockReturnValue({
        verdict: 'real_discount',
        pctDrop: 50,
        verdictText: '✅ Чесна знижка.',
      });

      await service.runSniper();

      // Item 1 failed, but item 2 should still be processed
      expect(itemsService.updateItemPrice).toHaveBeenCalledTimes(1);
      expect(itemsService.updateItemPrice).toHaveBeenCalledWith(2, 5000, true);
    });

    it('should handle notification send failure gracefully', async () => {
      const item = mockTrackedItem({ currentPrice: 10000, inStock: false });
      itemsService.getItemsDueForCheck.mockResolvedValue([item]);
      scraperService.scrape.mockResolvedValue({
        title: 'Test',
        price: 5000,
        currency: 'UAH',
        inStock: true,
      });
      priceAnalysis.getPriceVerdict.mockReturnValue({
        verdict: 'real_discount',
        pctDrop: 50,
        verdictText: '✅ Чесна знижка.',
      });

      // Telegram send fails
      (bot.telegram.sendMessage as jest.Mock).mockRejectedValueOnce(new Error('Bot blocked by user'));

      // Should not throw — error is caught internally
      await expect(service.runSniper()).resolves.not.toThrow();
    });
  });

  // ── Affiliate URL wrapping ───────────────────────────────────────────────

  describe('affiliate integration', () => {
    it('should wrap product URL with affiliate link in notifications', async () => {
      const item = mockTrackedItem({ currentPrice: 10000 });
      itemsService.getItemsDueForCheck.mockResolvedValue([item]);
      scraperService.scrape.mockResolvedValue({
        title: 'Test',
        price: 9000,
        currency: 'UAH',
        inStock: true,
      });
      priceAnalysis.getPriceVerdict.mockReturnValue({
        verdict: 'real_discount',
        pctDrop: 10,
        verdictText: '✅ Чесна знижка.',
      });
      affiliate.wrap.mockReturnValue('https://aff.example.com/wrapped');

      await service.runSniper();

      expect(affiliate.wrap).toHaveBeenCalledWith(
        'https://rozetka.com.ua/product/test',
        BigInt(123456789),
      );
    });
  });
});
