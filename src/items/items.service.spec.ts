import { ConflictException } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
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

    it('should throw ConflictException when DB unique constraint is violated (race condition)', async () => {
      // Simulates: two concurrent requests both passed findByUrl() check,
      // but the second INSERT hits the partial unique index.
      usersService.getUserLimits.mockResolvedValue({
        totalSlots: 3,
        checkInterval: 720,
        canAddProduct: true,
        plan: 'BASE',
      });

      const p2002Error = new PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`userId`,`url`)',
        { code: 'P2002', clientVersion: '5.0.0' },
      );
      (prisma.trackedItem.create as jest.Mock).mockRejectedValue(p2002Error);

      await expect(
        service.addItem({
          userId: 1,
          url: 'https://rozetka.com.ua/product/race',
          title: 'Race Product',
          currentPrice: 5000,
          inStock: true,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should rethrow non-P2002 DB errors unchanged', async () => {
      usersService.getUserLimits.mockResolvedValue({
        totalSlots: 3,
        checkInterval: 720,
        canAddProduct: true,
        plan: 'BASE',
      });

      const connectionError = new Error('DB connection lost');
      (prisma.trackedItem.create as jest.Mock).mockRejectedValue(connectionError);

      await expect(
        service.addItem({
          userId: 1,
          url: 'https://rozetka.com.ua/product/new',
          title: 'Test',
          currentPrice: 1000,
          inStock: true,
        }),
      ).rejects.toThrow('DB connection lost');
    });

    it('should handle concurrent adds: second call throws ConflictException (race condition simulation)', async () => {
      // Simulates: request A and request B both call findByUrl() → null (no item yet).
      // Request A wins the INSERT race; request B's INSERT hits the unique constraint.
      usersService.getUserLimits.mockResolvedValue({
        totalSlots: 3,
        checkInterval: 720,
        canAddProduct: true,
        plan: 'BASE',
      });

      const createdItem = mockItem();
      const p2002Error = new PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`userId`,`url`)',
        { code: 'P2002', clientVersion: '5.0.0' },
      );

      // First call succeeds, second call hits the constraint.
      (prisma.trackedItem.create as jest.Mock)
        .mockResolvedValueOnce(createdItem)
        .mockRejectedValueOnce(p2002Error);

      const addPayload = {
        userId: 1,
        url: 'https://rozetka.com.ua/product/concurrent',
        title: 'Concurrent Product',
        currentPrice: 8000,
        inStock: true,
      };

      const [resultA, resultB] = await Promise.allSettled([
        service.addItem(addPayload),
        service.addItem(addPayload),
      ]);

      expect(resultA.status).toBe('fulfilled');
      expect((resultA as PromiseFulfilledResult<any>).value).toEqual(createdItem);

      expect(resultB.status).toBe('rejected');
      expect((resultB as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
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
    it('should return priceBeforeUpdate from atomic SQL RETURNING', async () => {
      // The raw SQL returns the previousPrice value — which is what currentPrice WAS before the update
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ previousPrice: 10000 }]);

      const result = await service.updateItemPrice(1, 9000, true);

      // Verify we issued a raw query (not findUnique + update)
      expect(prisma.$queryRaw).toHaveBeenCalled();
      expect(prisma.trackedItem.findUnique).not.toHaveBeenCalled();
      expect(prisma.trackedItem.update).not.toHaveBeenCalled();

      // Returns the old currentPrice from before the atomic write
      expect(result).toEqual({ priceBeforeUpdate: 10000 });
    });

    it('should return priceBeforeUpdate: null when previous price was null', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ previousPrice: null }]);

      const result = await service.updateItemPrice(1, 5000, true);

      expect(result).toEqual({ priceBeforeUpdate: null });
    });

    it('should handle null new price (item went unavailable)', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ previousPrice: 7000 }]);

      const result = await service.updateItemPrice(1, null, false);

      expect(prisma.$queryRaw).toHaveBeenCalled();
      expect(result).toEqual({ priceBeforeUpdate: 7000 });
    });

    it('should return priceBeforeUpdate: null when item not found', async () => {
      // Empty RETURNING when no row matches WHERE id = ?
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      const result = await service.updateItemPrice(999, 5000, true);

      expect(result).toEqual({ priceBeforeUpdate: null });
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
