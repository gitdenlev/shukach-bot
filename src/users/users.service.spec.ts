import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';

// ── Mock factory ─────────────────────────────────────────────────────────────

function createMockPrisma() {
  return {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    trackedItem: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  } as unknown as jest.Mocked<PrismaService>;
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
  };
}

describe('UsersService', () => {
  let service: UsersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new UsersService(prisma as any);
  });

  // ── findOrCreate ─────────────────────────────────────────────────────────

  describe('findOrCreate', () => {
    it('should return existing user with isNew=false', async () => {
      const existing = mockUser();
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(existing);

      const result = await service.findOrCreate({
        telegramId: BigInt(123456789),
        username: 'testuser',
        firstName: 'Test',
      });

      expect(result.user).toEqual(existing);
      expect(result.isNew).toBe(false);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('should create new user when not found', async () => {
      const newUser = mockUser();
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.user.create as jest.Mock).mockResolvedValue(newUser);

      const result = await service.findOrCreate({
        telegramId: BigInt(123456789),
        username: 'testuser',
        firstName: 'Test',
      });

      expect(result.isNew).toBe(true);
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          telegramId: BigInt(123456789),
          username: 'testuser',
        }),
      });
    });

    it('should set referredById to null when not provided', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.user.create as jest.Mock).mockResolvedValue(mockUser());

      await service.findOrCreate({
        telegramId: BigInt(111),
      });

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          referredById: null,
        }),
      });
    });
  });

  // ── findByTelegramId ─────────────────────────────────────────────────────

  describe('findByTelegramId', () => {
    it('should return user when found', async () => {
      const user = mockUser();
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(user);

      const result = await service.findByTelegramId(BigInt(123456789));
      expect(result).toEqual(user);
    });

    it('should return null when not found', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await service.findByTelegramId(BigInt(999));
      expect(result).toBeNull();
    });
  });

  // ── getUserLimits ────────────────────────────────────────────────────────

  describe('getUserLimits', () => {
    it('should return BASE limits for a free user', async () => {
      const user = mockUser({ _count: { trackedItems: 2 } });
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(user);
      (prisma.trackedItem.count as jest.Mock).mockResolvedValue(2);

      const limits = await service.getUserLimits(1);

      expect(limits.plan).toBe('BASE');
      expect(limits.totalSlots).toBe(3);
      expect(limits.checkInterval).toBe(720);
      expect(limits.canAddProduct).toBe(true);
    });

    it('should return SCOUT limits for premium user', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 15);
      const user = mockUser({
        plan: 'SCOUT',
        subscriptionExpiresAt: futureDate,
        _count: { trackedItems: 5 },
      });
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(user);
      (prisma.trackedItem.count as jest.Mock).mockResolvedValue(5);

      const limits = await service.getUserLimits(1);

      expect(limits.plan).toBe('SCOUT');
      expect(limits.totalSlots).toBe(15);
      expect(limits.checkInterval).toBe(60);
    });

    it('should include extraSlots in totalSlots', async () => {
      const user = mockUser({ extraSlots: 3, _count: { trackedItems: 1 } });
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(user);
      (prisma.trackedItem.count as jest.Mock).mockResolvedValue(1);

      const limits = await service.getUserLimits(1);

      expect(limits.totalSlots).toBe(6); // 3 (base) + 3 (extra)
    });

    it('should report canAddProduct=false when at limit', async () => {
      const user = mockUser({ _count: { trackedItems: 3 } });
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(user);
      (prisma.trackedItem.count as jest.Mock).mockResolvedValue(3);

      const limits = await service.getUserLimits(1);

      expect(limits.canAddProduct).toBe(false);
    });

    it('should throw when user not found', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.getUserLimits(999)).rejects.toThrow('User not found');
    });

    it('should downgrade expired SCOUT to BASE and freeze excess items', async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 5);
      const user = mockUser({
        plan: 'SCOUT',
        subscriptionExpiresAt: pastDate,
        extraSlots: 0,
        _count: { trackedItems: 10 },
      });

      (prisma.user.findUnique as jest.Mock).mockResolvedValue(user);
      (prisma.trackedItem.findMany as jest.Mock).mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => ({ id: i + 1, createdAt: new Date(2026, 0, i + 1) })),
      );
      (prisma.trackedItem.count as jest.Mock).mockResolvedValue(3);

      const limits = await service.getUserLimits(1);

      // Should have downgraded
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { plan: 'BASE', priority: 0 },
      });

      // Should freeze items beyond slot 3
      expect(prisma.trackedItem.updateMany).toHaveBeenCalledWith({
        where: { id: { in: expect.any(Array) } },
        data: { isFrozen: true },
      });

      expect(limits.plan).toBe('BASE');
      expect(limits.totalSlots).toBe(3);
    });
  });

  // ── Monetization ─────────────────────────────────────────────────────────

  describe('addPurchasedSlots', () => {
    it('should increment extraSlots', async () => {
      const updated = mockUser({ extraSlots: 3 });
      (prisma.user.update as jest.Mock).mockResolvedValue(updated);

      const result = await service.addPurchasedSlots(1, 3);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { extraSlots: { increment: 3 } },
      });
      expect(result.extraSlots).toBe(3);
    });
  });

  describe('activateScout', () => {
    it('should set plan to SCOUT with 30-day expiry', async () => {
      const updated = mockUser({ plan: 'SCOUT', priority: 1 });
      (prisma.user.update as jest.Mock).mockResolvedValue(updated);

      const result = await service.activateScout(1);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({
          plan: 'SCOUT',
          priority: 1,
        }),
      });
    });

    it('should accept custom day count', async () => {
      (prisma.user.update as jest.Mock).mockResolvedValue(mockUser());

      await service.activateScout(1, 7);

      const call = (prisma.user.update as jest.Mock).mock.calls[0][0];
      const expiresAt = call.data.subscriptionExpiresAt as Date;
      const now = new Date();
      const diffDays = Math.round((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      expect(diffDays).toBeGreaterThanOrEqual(6);
      expect(diffDays).toBeLessThanOrEqual(7);
    });
  });

  // ── Referral ─────────────────────────────────────────────────────────────

  describe('setReferredBy', () => {
    it('should update user with referrer ID', async () => {
      (prisma.user.update as jest.Mock).mockResolvedValue(mockUser());

      await service.setReferredBy(1, BigInt(999));

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { referredById: BigInt(999) },
      });
    });
  });

  describe('claimReferralBonus', () => {
    it('should increment slots and mark bonus as claimed', async () => {
      (prisma.user.update as jest.Mock).mockResolvedValue(mockUser());

      await service.claimReferralBonus(1);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          extraSlots: { increment: 1 },
          isReferralBonusClaimed: true,
        },
      });
    });
  });

  describe('rewardReferrer', () => {
    it('should increment slots and referral count', async () => {
      (prisma.user.update as jest.Mock).mockResolvedValue(mockUser());

      await service.rewardReferrer(1);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          extraSlots: { increment: 1 },
          referralCount: { increment: 1 },
        },
      });
    });
  });

  // ── incrementPotentialSavings ─────────────────────────────────────────────

  describe('incrementPotentialSavings', () => {
    it('should update user savings and item lowestPrice in a transaction', async () => {
      (prisma.$transaction as jest.Mock).mockResolvedValue([{}, {}]);
      (prisma.user.update as jest.Mock).mockReturnValue('user-update');
      (prisma.trackedItem.update as jest.Mock).mockReturnValue('item-update');

      await service.incrementPotentialSavings(1, 42, 500, 9500);

      expect(prisma.$transaction).toHaveBeenCalledWith([
        'user-update',
        'item-update',
      ]);
    });

    it('should skip when priceDrop is zero', async () => {
      await service.incrementPotentialSavings(1, 42, 0, 10000);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('should skip when priceDrop is negative', async () => {
      await service.incrementPotentialSavings(1, 42, -100, 10000);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
