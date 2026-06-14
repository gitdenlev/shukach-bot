import { BotUpdate } from './bot.update';
import { UsersService } from '../users/users.service';
import { ItemsService } from '../items/items.service';
import { ScraperService } from '../scraper/scraper.service';
import { TestUiService } from './test-ui.service';
import { RateLimitService } from './rate-limit.service';
import { Context } from 'telegraf';

// ── Mock factories ───────────────────────────────────────────────────────────

function createMockUsersService() {
  return {
    findOrCreate: jest.fn(),
    findByTelegramId: jest.fn(),
    getUserLimits: jest.fn(),
    setReferredBy: jest.fn(),
    claimReferralBonus: jest.fn(),
    rewardReferrer: jest.fn(),
    addPurchasedSlots: jest.fn(),
    activateScout: jest.fn(),
    touchActivity: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<UsersService>;
}

function createMockItemsService() {
  return {
    getItemsForUser: jest.fn(),
    findByUrl: jest.fn(),
    addItem: jest.fn(),
    deleteItem: jest.fn(),
    getItemCountForUser: jest.fn(),
  } as unknown as jest.Mocked<ItemsService>;
}

function createMockScraperService() {
  return {
    scrape: jest.fn(),
  } as unknown as jest.Mocked<ScraperService>;
}

function createMockTestUiService() {
  return {
    runSequence: jest.fn(),
  } as unknown as jest.Mocked<TestUiService>;
}

function createMockRateLimitService() {
  return {
    // Always allow in tests — rate limiting is tested separately
    isAllowed: jest.fn().mockReturnValue(true),
    cleanup: jest.fn(),
  } as unknown as jest.Mocked<RateLimitService>;
}

function mockUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    telegramId: BigInt(123456789),
    username: 'testuser',
    firstName: 'Test',
    createdAt: new Date(),
    plan: 'BASE',
    extraSlots: 0,
    subscriptionExpiresAt: null,
    telegramSubscriptionId: null,
    priority: 0,
    referredById: null,
    referralCount: 0,
    isReferralBonusClaimed: false,
    totalPotentialSavings: 0,
    ...overrides,
  } as any;
}

function mockItem(overrides: Record<string, unknown> = {}) {
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
    checkIntervalMinutes: 720,
    createdAt: new Date(),
    updatedAt: new Date(),
    nextCheckAt: new Date(),
    consecutiveErrors: 0,
    userId: 1,
    ...overrides,
  };
}

function createMockCtx(overrides: Record<string, unknown> = {}): jest.Mocked<Context> {
  return {
    from: { id: 123456789, username: 'testuser', first_name: 'Test' },
    chat: { id: 123456789 },
    message: { text: '' },
    callbackQuery: undefined,
    update: {},
    reply: jest.fn().mockResolvedValue({ message_id: 1 }),
    replyWithHTML: jest.fn().mockResolvedValue({ message_id: 1 }),
    answerCbQuery: jest.fn().mockResolvedValue(true),
    editMessageText: jest.fn().mockResolvedValue(true),
    telegram: {
      sendMessage: jest.fn().mockResolvedValue({}),
      deleteMessage: jest.fn().mockResolvedValue(true),
      createInvoiceLink: jest.fn().mockResolvedValue('https://t.me/invoice/test'),
    },
    ...overrides,
  } as unknown as jest.Mocked<Context>;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('BotUpdate', () => {
  let botUpdate: BotUpdate;
  let usersService: ReturnType<typeof createMockUsersService>;
  let itemsService: ReturnType<typeof createMockItemsService>;
  let scraperService: ReturnType<typeof createMockScraperService>;
  let testUiService: ReturnType<typeof createMockTestUiService>;
  let rateLimitService: ReturnType<typeof createMockRateLimitService>;

  beforeEach(() => {
    usersService = createMockUsersService();
    itemsService = createMockItemsService();
    scraperService = createMockScraperService();
    testUiService = createMockTestUiService();
    rateLimitService = createMockRateLimitService();

    botUpdate = new BotUpdate(
      usersService as any,
      itemsService as any,
      scraperService as any,
      testUiService as any,
      rateLimitService as any,
    );
  });

  // ── /start ───────────────────────────────────────────────────────────────

  describe('onStart', () => {
    it('should register new user and send welcome message', async () => {
      const ctx = createMockCtx();
      usersService.findOrCreate.mockResolvedValue({
        user: mockUser(),
        isNew: true,
      });

      await botUpdate.onStart(ctx);

      expect(usersService.findOrCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          telegramId: BigInt(123456789),
        }),
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Привіт'),
        expect.any(Object),
      );
    });

    it('should send returning user message for existing user', async () => {
      const ctx = createMockCtx();
      usersService.findOrCreate.mockResolvedValue({
        user: mockUser(),
        isNew: false,
      });

      await botUpdate.onStart(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('З поверненням'),
        expect.any(Object),
      );
    });

    it('should extract referral from /start refXXX deep link', async () => {
      const ctx = createMockCtx({
        message: { text: '/start ref987654321' },
      });
      usersService.findOrCreate.mockResolvedValue({
        user: mockUser(),
        isNew: true,
      });

      await botUpdate.onStart(ctx);

      expect(usersService.setReferredBy).toHaveBeenCalledWith(1, BigInt(987654321));
    });

    it('should NOT set self-referral', async () => {
      const ctx = createMockCtx({
        message: { text: '/start ref123456789' },
      });
      usersService.findOrCreate.mockResolvedValue({
        user: mockUser(),
        isNew: true,
      });

      await botUpdate.onStart(ctx);

      expect(usersService.setReferredBy).not.toHaveBeenCalled();
    });

    it('should NOT set referral for existing users', async () => {
      const ctx = createMockCtx({
        message: { text: '/start ref987654321' },
      });
      usersService.findOrCreate.mockResolvedValue({
        user: mockUser(),
        isNew: false,
      });

      await botUpdate.onStart(ctx);

      expect(usersService.setReferredBy).not.toHaveBeenCalled();
    });

    it('should do nothing when ctx.from is undefined', async () => {
      const ctx = createMockCtx({ from: undefined });

      await botUpdate.onStart(ctx);

      expect(usersService.findOrCreate).not.toHaveBeenCalled();
    });
  });

  // ── /list ────────────────────────────────────────────────────────────────

  describe('onList', () => {
    it('should show empty list message', async () => {
      const ctx = createMockCtx();
      usersService.findByTelegramId.mockResolvedValue(mockUser());
      itemsService.getItemsForUser.mockResolvedValue([]);

      await botUpdate.onList(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('нічого не відстежуєте'));
    });

    it('should show items list with count', async () => {
      const ctx = createMockCtx();
      usersService.findByTelegramId.mockResolvedValue(mockUser());
      itemsService.getItemsForUser.mockResolvedValue([mockItem()]);
      usersService.getUserLimits.mockResolvedValue({
        totalSlots: 3,
        checkInterval: 720,
        canAddProduct: true,
        plan: 'BASE',
      });

      await botUpdate.onList(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('1/3'),
        expect.any(Object),
      );
    });

    it('should prompt registration for unknown user', async () => {
      const ctx = createMockCtx();
      usersService.findByTelegramId.mockResolvedValue(null);

      await botUpdate.onList(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('/start'));
    });
  });

  // ── /delete ──────────────────────────────────────────────────────────────

  describe('onDelete', () => {
    it('should delete item and confirm', async () => {
      const ctx = createMockCtx({ message: { text: '/delete 42' } });
      usersService.findByTelegramId.mockResolvedValue(mockUser());
      itemsService.deleteItem.mockResolvedValue(mockItem({ id: 42 }));

      await botUpdate.onDelete(ctx);

      expect(itemsService.deleteItem).toHaveBeenCalledWith(42, 1);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Видалено'),
        expect.any(Object),
      );
    });

    it('should show error when no ID provided', async () => {
      const ctx = createMockCtx({ message: { text: '/delete' } });

      await botUpdate.onDelete(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Вкажи ID'),
        expect.any(Object),
      );
    });

    it('should show error when ID is not a number', async () => {
      const ctx = createMockCtx({ message: { text: '/delete abc' } });

      await botUpdate.onDelete(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Вкажи ID'),
        expect.any(Object),
      );
    });

    it('should show not-found message when item doesn\'t exist', async () => {
      const ctx = createMockCtx({ message: { text: '/delete 999' } });
      usersService.findByTelegramId.mockResolvedValue(mockUser());
      itemsService.deleteItem.mockResolvedValue(null);

      await botUpdate.onDelete(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('не знайдено'));
    });
  });

  // ── Delete callback (inline button) ──────────────────────────────────────

  describe('onDeleteCallback', () => {
    it('should delete item via inline button', async () => {
      const ctx = createMockCtx({
        callbackQuery: {
          data: 'delete_item:42',
          from: { id: 123456789 },
        },
      });
      usersService.findByTelegramId.mockResolvedValue(mockUser());
      itemsService.deleteItem.mockResolvedValue(mockItem({ id: 42 }));

      await botUpdate.onDeleteCallback(ctx);

      expect(itemsService.deleteItem).toHaveBeenCalledWith(42, 1);
      expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('видалено'));
    });

    it('should show error for non-existent item', async () => {
      const ctx = createMockCtx({
        callbackQuery: {
          data: 'delete_item:999',
          from: { id: 123456789 },
        },
      });
      usersService.findByTelegramId.mockResolvedValue(mockUser());
      itemsService.deleteItem.mockResolvedValue(null);

      await botUpdate.onDeleteCallback(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('не знайдено'));
    });
  });

  // ── /add ─────────────────────────────────────────────────────────────────

  describe('onAdd', () => {
    it('should prompt for URL when no URL provided', async () => {
      const ctx = createMockCtx({ message: { text: '/add' } });

      await botUpdate.onAdd(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('посилання'));
    });

    it('should process URL when provided inline', async () => {
      const ctx = createMockCtx({ message: { text: '/add https://rozetka.com.ua/product/123' } });
      usersService.findOrCreate.mockResolvedValue({ user: mockUser(), isNew: false });
      itemsService.findByUrl.mockResolvedValue(null);
      usersService.getUserLimits.mockResolvedValue({
        totalSlots: 3,
        checkInterval: 720,
        canAddProduct: true,
        plan: 'BASE',
      });
      scraperService.scrape.mockResolvedValue({
        title: 'Test Product',
        price: 10000,
        currency: 'UAH',
        inStock: true,
      });
      itemsService.addItem.mockResolvedValue(mockItem());
      itemsService.getItemCountForUser.mockResolvedValue(1);

      await botUpdate.onAdd(ctx);

      expect(scraperService.scrape).toHaveBeenCalledWith('https://rozetka.com.ua/product/123');
    });
  });

  // ── Text handler routing ─────────────────────────────────────────────────

  describe('onText', () => {
    it('should route "📋 Мої товари" to list', async () => {
      const ctx = createMockCtx({ message: { text: '📋 Мої товари' } });
      usersService.findByTelegramId.mockResolvedValue(mockUser());
      itemsService.getItemsForUser.mockResolvedValue([]);

      await botUpdate.onText(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('нічого не відстежуєте'));
    });

    it('should route "➕ Додати товар" to URL prompt', async () => {
      const ctx = createMockCtx({ message: { text: '➕ Додати товар' } });

      await botUpdate.onText(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('посилання'));
    });

    it('should route "❓ Допомога" to help menu', async () => {
      const ctx = createMockCtx({ message: { text: '❓ Допомога' } });

      await botUpdate.onText(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Як користуватись'),
        expect.any(Object),
      );
    });

    it('should process direct URL paste', async () => {
      const ctx = createMockCtx({
        message: { text: 'https://rozetka.com.ua/product/test' },
      });
      usersService.findOrCreate.mockResolvedValue({ user: mockUser(), isNew: false });
      itemsService.findByUrl.mockResolvedValue(null);
      usersService.getUserLimits.mockResolvedValue({
        totalSlots: 3,
        checkInterval: 720,
        canAddProduct: true,
        plan: 'BASE',
      });
      scraperService.scrape.mockResolvedValue({
        title: 'Test Product',
        price: 10000,
        currency: 'UAH',
        inStock: true,
      });
      itemsService.addItem.mockResolvedValue(mockItem());
      itemsService.getItemCountForUser.mockResolvedValue(1);

      await botUpdate.onText(ctx);

      expect(scraperService.scrape).toHaveBeenCalled();
    });

    it('should reject non-URL text from awaiting state', async () => {
      const ctx1 = createMockCtx({
        message: { text: '➕ Додати товар' },
      });
      await botUpdate.onText(ctx1);

      const ctx2 = createMockCtx({
        message: { text: 'just some text' },
      });
      await botUpdate.onText(ctx2);

      expect(ctx2.reply).toHaveBeenCalledWith(expect.stringContaining('не схоже на посилання'));
    });

    it('should show fallback for unrecognized text', async () => {
      const ctx = createMockCtx({ message: { text: 'hello there' } });

      await botUpdate.onText(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Не розумію'));
    });
  });

  // ── processUrl (via onText) ──────────────────────────────────────────────

  describe('processUrl (via text handler)', () => {
    it('should reject invalid URL', async () => {
      const ctx = createMockCtx({
        message: { text: 'https://invalid url with spaces' },
      });
      // This is a direct URL paste, not awaiting
      usersService.findOrCreate.mockResolvedValue({ user: mockUser(), isNew: false });

      await botUpdate.onText(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Невірний URL'));
    });

    it('should detect duplicate item', async () => {
      const ctx = createMockCtx({
        message: { text: 'https://rozetka.com.ua/product/test' },
      });
      usersService.findOrCreate.mockResolvedValue({ user: mockUser(), isNew: false });
      itemsService.findByUrl.mockResolvedValue(mockItem());

      await botUpdate.onText(ctx);

      expect(ctx.replyWithHTML).toHaveBeenCalledWith(
        expect.stringContaining('вже у вашому списку'),
        expect.any(Object),
      );
    });

    it('should handle scraper failure gracefully with sanitized message', async () => {
      const ctx = createMockCtx({
        message: { text: 'https://rozetka.com.ua/product/test' },
      });
      usersService.findOrCreate.mockResolvedValue({ user: mockUser(), isNew: false });
      itemsService.findByUrl.mockResolvedValue(null);
      usersService.getUserLimits.mockResolvedValue({
        totalSlots: 3,
        checkInterval: 720,
        canAddProduct: true,
        plan: 'BASE',
      });
      scraperService.scrape.mockRejectedValue(new Error('Network timeout'));

      await botUpdate.onText(ctx);

      // Should show a user-friendly sanitized message, NOT the raw internal error
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringMatching(/❌.+(\u0437\u0430\u0447\u0435\u043a\u0430\u0439\u0442\u0435|\u0441\u043f\u0440\u043e\u0431\u0443\u0439\u0442\u0435)/i),
      );
      // Ensure raw error text is NOT forwarded to the user
      expect(ctx.reply).not.toHaveBeenCalledWith(expect.stringContaining('Network timeout'));
    });
  });

  // ── Payment ──────────────────────────────────────────────────────────────

  describe('onSuccessfulPayment', () => {
    it('should add 3 slots for pack_economy purchase', async () => {
      const ctx = createMockCtx({
        message: {
          text: '',
          successful_payment: { invoice_payload: 'pack_economy' },
        },
      });
      usersService.findByTelegramId.mockResolvedValue(mockUser());
      usersService.addPurchasedSlots.mockResolvedValue(mockUser({ extraSlots: 3 }));

      await botUpdate.onSuccessfulPayment(ctx);

      expect(usersService.addPurchasedSlots).toHaveBeenCalledWith(1, 3);
    });

    it('should activate Scout for tier_scout purchase', async () => {
      const ctx = createMockCtx({
        message: {
          text: '',
          successful_payment: { invoice_payload: 'tier_scout' },
        },
      });
      usersService.findByTelegramId.mockResolvedValue(mockUser());
      usersService.activateScout.mockResolvedValue(mockUser({ plan: 'SCOUT' }));

      await botUpdate.onSuccessfulPayment(ctx);

      expect(usersService.activateScout).toHaveBeenCalledWith(1);
    });

    it('should do nothing when user is not found', async () => {
      const ctx = createMockCtx({
        message: {
          text: '',
          successful_payment: { invoice_payload: 'tier_scout' },
        },
      });
      usersService.findByTelegramId.mockResolvedValue(null);

      await botUpdate.onSuccessfulPayment(ctx);

      expect(usersService.activateScout).not.toHaveBeenCalled();
    });
  });

  // ── PreCheckoutQuery ─────────────────────────────────────────────────────

  describe('onPreCheckoutQuery', () => {
    it('should approve pre-checkout query', async () => {
      const ctx = createMockCtx({
        update: {
          pre_checkout_query: {
            id: 'test-query-id',
          },
        },
        telegram: {
          answerPreCheckoutQuery: jest.fn().mockResolvedValue(true),
          sendMessage: jest.fn(),
          deleteMessage: jest.fn(),
          createInvoiceLink: jest.fn(),
        },
      });

      await botUpdate.onPreCheckoutQuery(ctx);

      expect(ctx.telegram.answerPreCheckoutQuery).toHaveBeenCalledWith('test-query-id', true);
    });
  });

  // ── Unsupported media ────────────────────────────────────────────────────

  describe('unsupported media handlers', () => {
    it.each(['onSticker', 'onPhoto', 'onVoice', 'onAnimation'] as const)(
      '%s should reply with unsupported message',
      async (method) => {
        const ctx = createMockCtx();
        await (botUpdate as any)[method](ctx);
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Не розумію'));
      },
    );
  });

  // ── Admin test_ui ────────────────────────────────────────────────────────

  describe('onTestUi', () => {
    it('should reject non-admin users', async () => {
      const ctx = createMockCtx({
        from: { id: 999999, username: 'hacker' },
      });

      await botUpdate.onTestUi(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('недоступна'));
      expect(testUiService.runSequence).not.toHaveBeenCalled();
    });
  });
});
