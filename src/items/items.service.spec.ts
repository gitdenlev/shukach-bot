import { ItemsService } from './items.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';

// ── Mock factories ───────────────────────────────────────────────────────────

function createMockPrisma() {
  return {
    trackedItem: {
      count: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    $queryRaw: jest.fn(),
  } as unknown as jest.Mocked<PrismaService>;
}

function createMockUsersService() {
  return {
    getUserLimits: jest.fn(),
  } as unknown as jest.Mocked<UsersService>;
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
    currency: 'UAH',
    inStock: true,
    isActive: true,
    isFrozen: false,
    lastCheckedAt: new Date(),
    checkIntervalMinutes: 720,
    createdAt: new Date(),
    updatedAt: new Date(),
    userId: 1,
    ...overrides,
  };
}

describe('ItemsService', () => {
  let service: ItemsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let usersService: ReturnType<typeof createMockUsersService>;

  beforeEach(() => {
    prisma = createMockPrisma();
    usersService = createMockUsersService();
    service = new ItemsService(prisma as any, usersService as any);
  });

  // ── getItemCountForUser ──────────────────────────────────────────────────

  describe('getItemCountForUser', () => {
    it('should count active non-frozen items', async () => {
      (prisma.trackedItem.count as jest.Mock).mockResolvedValue(2);

      const count = await service.getItemCountForUser(1);

      expect(count).toBe(2);
      expect(prisma.trackedItem.count).toHaveBeenCalledWith({
        where: { userId: 1, isActive: true, isFrozen: false },
      });
    });

    it('should return 0 when user has no items', async () => {
      (prisma.trackedItem.count as jest.Mock).mockResolvedValue(0);

      const count = await service.getItemCountForUser(99);
      expect(count).toBe(0);
    });
  });

  // ── isLimitReached ───────────────────────────────────────────────────────

  describe('isLimitReached', () => {
    it('should return false when user can add products', async () => {
      usersService.getUserLimits.mockResolvedValue({
        totalSlots: 3,
        checkInterval: 720,
        canAddProduct: true,
        plan: 'BASE',
      });

      const result = await service.isLimitReached({ id: 1 } as any);
      expect(result).toBe(false);
    });

    it('should return true when limit is reached', async () => {
      usersService.getUserLimits.mockResolvedValue({
        totalSlots: 3,
        checkInterval: 720,
        canAddProduct: false,
        plan: 'BASE',
      });

      const result = await service.isLimitReached({ id: 1 } as any);
      expect(result).toBe(true);
    });
  });

  // ── findByUrl ────────────────────────────────────────────────────────────

  describe('findByUrl', () => {
    it('should return item when found', async () => {
      const item = mockItem();
      (prisma.trackedItem.findFirst as jest.Mock).mockResolvedValue(item);

      const result = await service.findByUrl(1, 'https://rozetka.com.ua/product/test');

      expect(result).toEqual(item);
      expect(prisma.trackedItem.findFirst).toHaveBeenCalledWith({
        where: { userId: 1, url: 'https://rozetka.com.ua/product/test', isActive: true, isFrozen: false },
      });
    });

    it('should return null when not found', async () => {
      (prisma.trackedItem.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.findByUrl(1, 'https://example.com');
      expect(result).toBeNull();
    });
  });

  // ── addItem ──────────────────────────────────────────────────────────────

  describe('addItem', () => {
    it('should create item with correct defaults', async () => {
      const created = mockItem();
      usersService.getUserLimits.mockResolvedValue({
        totalSlots: 3,
        checkInterval: 720,
        canAddProduct: true,
        plan: 'BASE',
      });
      (prisma.trackedItem.create as jest.Mock).mockResolvedValue(created);

      const result = await service.addItem({
        userId: 1,
        url: 'https://rozetka.com.ua/product/new',
        title: 'New Product',
        currentPrice: 5000,
        inStock: true,
      });

      expect(prisma.trackedItem.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 1,
          title: 'New Product',
          currentPrice: 5000,
          initialPrice: 5000,
          lowestPrice: 5000,
          isActive: true,
          checkIntervalMinutes: 720,
        }),
      });
      expect(result).toEqual(created);
    });

    it('should set checkIntervalMinutes based on user plan', async () => {
      usersService.getUserLimits.mockResolvedValue({
        totalSlots: 15,
        checkInterval: 60,
        canAddProduct: true,
        plan: 'SCOUT',
      });
      (prisma.trackedItem.create as jest.Mock).mockResolvedValue(mockItem());

      await service.addItem({
        userId: 1,
        url: 'https://rozetka.com.ua/product/new',
        title: 'Test',
        currentPrice: 1000,
        inStock: true,
      });

      expect(prisma.trackedItem.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          checkIntervalMinutes: 60,
        }),
      });
    });

    it('should handle null price', async () => {
      usersService.getUserLimits.mockResolvedValue({
        totalSlots: 3,
        checkInterval: 720,
        canAddProduct: true,
        plan: 'BASE',
      });
      (prisma.trackedItem.create as jest.Mock).mockResolvedValue(mockItem({ currentPrice: null }));

      await service.addItem({
        userId: 1,
        url: 'https://rozetka.com.ua/product/new',
        title: 'Test',
        currentPrice: null,
        inStock: false,
      });

      expect(prisma.trackedItem.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          currentPrice: null,
          initialPrice: null,
          lowestPrice: null,
        }),
      });
    });
  });

  // ── getItemsForUser ──────────────────────────────────────────────────────

  describe('getItemsForUser', () => {
    it('should return active non-frozen items sorted by createdAt desc', async () => {
      const items = [mockItem({ id: 2 }), mockItem({ id: 1 })];
      (prisma.trackedItem.findMany as jest.Mock).mockResolvedValue(items);

      const result = await service.getItemsForUser(1);

      expect(result).toHaveLength(2);
      expect(prisma.trackedItem.findMany).toHaveBeenCalledWith({
        where: { userId: 1, isActive: true, isFrozen: false },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should return empty array when user has no items', async () => {
      (prisma.trackedItem.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.getItemsForUser(1);
      expect(result).toEqual([]);
    });
  });

  // ── deleteItem ───────────────────────────────────────────────────────────

  describe('deleteItem', () => {
    it('should hard-delete item (CASCADE removes PriceHistory)', async () => {
      const item = mockItem();
      (prisma.trackedItem.findFirst as jest.Mock).mockResolvedValue(item);
      (prisma.trackedItem.delete as jest.Mock).mockResolvedValue(item);

      const result = await service.deleteItem(1, 1);

      expect(result).toBeTruthy();
      expect(prisma.trackedItem.delete).toHaveBeenCalledWith({
        where: { id: 1 },
      });
      // update should NOT be called (we use hard delete now)
      expect(prisma.trackedItem.update).not.toHaveBeenCalled();
    });

    it('should return null when item does not exist', async () => {
      (prisma.trackedItem.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.deleteItem(999, 1);
      expect(result).toBeNull();
    });

    it('should return null when item belongs to different user (IDOR protection)', async () => {
      // Item exists but userId doesn't match
      (prisma.trackedItem.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.deleteItem(1, 999);

      expect(result).toBeNull();
      expect(prisma.trackedItem.delete).not.toHaveBeenCalled();
    });
  });

  // ── updateItemPrice ──────────────────────────────────────────────────────

  describe('updateItemPrice', () => {
    it('should update price and set previousPrice from current', async () => {
      const current = mockItem({ currentPrice: 10000 });
      (prisma.trackedItem.findUnique as jest.Mock).mockResolvedValue(current);
      (prisma.trackedItem.update as jest.Mock).mockResolvedValue({
        ...current,
        previousPrice: 10000,
        currentPrice: 9000,
      });

      await service.updateItemPrice(1, 9000, true);

      expect(prisma.trackedItem.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          previousPrice: 10000,
          currentPrice: 9000,
          inStock: true,
          lastCheckedAt: expect.any(Date),
        },
      });
    });

    it('should handle null new price', async () => {
      const current = mockItem({ currentPrice: 5000 });
      (prisma.trackedItem.findUnique as jest.Mock).mockResolvedValue(current);
      (prisma.trackedItem.update as jest.Mock).mockResolvedValue(current);

      await service.updateItemPrice(1, null, false);

      expect(prisma.trackedItem.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({
          currentPrice: null,
          previousPrice: 5000,
        }),
      });
    });

    it('should set previousPrice to null when current item has no price', async () => {
      (prisma.trackedItem.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.trackedItem.update as jest.Mock).mockResolvedValue(mockItem());

      await service.updateItemPrice(1, 5000, true);

      expect(prisma.trackedItem.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({
          previousPrice: null,
        }),
      });
    });
  });

  // ── getItemsDueForCheck ──────────────────────────────────────────────────

  describe('getItemsDueForCheck', () => {
    it('should return items with user telegramId mapped', async () => {
      const rawItems = [
        { id: 1, url: 'https://rozetka.com.ua/test', userTelegramId: BigInt(123) },
        { id: 2, url: 'https://allo.ua/test', userTelegramId: BigInt(456) },
      ];
      (prisma.$queryRaw as jest.Mock).mockResolvedValue(rawItems);

      const result = await service.getItemsDueForCheck();

      expect(result).toHaveLength(2);
      expect(result[0].user.telegramId).toBe(BigInt(123));
      expect(result[1].user.telegramId).toBe(BigInt(456));
    });

    it('should return empty array when no items are due', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      const result = await service.getItemsDueForCheck();
      expect(result).toEqual([]);
    });
  });
});
