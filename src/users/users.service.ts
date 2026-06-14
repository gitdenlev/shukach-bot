import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { User } from '@prisma/client';

const BASE_ITEM_LIMIT = 3;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findOrCreate(data: {
    telegramId: bigint;
    username?: string;
    firstName?: string;
    referredById?: bigint | null;
  }): Promise<{ user: User; isNew: boolean }> {
    const existing = await this.prisma.user.findUnique({
      where: { telegramId: data.telegramId },
    });

    if (existing) return { user: existing, isNew: false };

    const user = await this.prisma.user.create({
      data: {
        telegramId: data.telegramId,
        username: data.username,
        firstName: data.firstName,
        referredById: data.referredById ?? null,
      },
    });

    this.logger.log(`New user registered: internal_id=${user.id}`);
    return { user, isNew: true };
  }

  async findByTelegramId(telegramId: bigint): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { telegramId } });
  }

  async findByUserId(userId: number): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id: userId } });
  }

  // ── Limit & Subscription helpers ───────────────────────────────────────────

  async getUserLimits(userId: number): Promise<{ totalSlots: number; checkInterval: number; canAddProduct: boolean; plan: 'BASE' | 'SCOUT' }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { _count: { select: { trackedItems: { where: { isActive: true } } } } }
    });
    if (!user) throw new Error('User not found');

    let currentPlan = user.plan as 'BASE' | 'SCOUT';

    // Safety Check: if SCOUT expired, revert to BASE gracefully
    if (currentPlan === 'SCOUT' && user.subscriptionExpiresAt && user.subscriptionExpiresAt < new Date()) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { plan: 'BASE', priority: 0 }
      });
      currentPlan = 'BASE';

      // Implement Freeze Logic
      const newTotalSlots = 3 + user.extraSlots;
      const activeItems = await this.prisma.trackedItem.findMany({
        where: { userId: userId, isActive: true, isFrozen: false },
        orderBy: { createdAt: 'asc' }
      });
      if (activeItems.length > newTotalSlots) {
        const itemsToFreeze = activeItems.slice(newTotalSlots);
        await this.prisma.trackedItem.updateMany({
          where: { id: { in: itemsToFreeze.map((i) => i.id) } },
          data: { isFrozen: true }
        });
      }
    }

    const baseSlots = currentPlan === 'SCOUT' ? 15 : 3;
    const totalSlots = baseSlots + user.extraSlots;
    const checkInterval = currentPlan === 'SCOUT' ? 60 : 720;
    
    // Recount after potential freeze
    const currentProductsCount = await this.prisma.trackedItem.count({
      where: { userId: userId, isActive: true, isFrozen: false }
    });

    return {
      totalSlots,
      checkInterval,
      canAddProduct: currentProductsCount < totalSlots,
      plan: currentPlan,
    };
  }

  // ── Monetization ───────────────────────────────────────────────────────────

  async addPurchasedSlots(userId: number, count: number): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { extraSlots: { increment: count } },
    });
  }

  async activateScout(userId: number, days = 30): Promise<User> {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);

    return this.prisma.user.update({
      where: { id: userId },
      // TypeScript requires cast to any or ignoring while Prisma cache is invalid
      data: { plan: 'SCOUT', priority: 1, subscriptionExpiresAt: expiresAt } as any,
    });
  }

  // ── Referral ───────────────────────────────────────────────────────────────

  /** Save who invited this user (called once right after registration). */
  async setReferredBy(userId: number, referredById: bigint): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { referredById },
    });
  }

  /** Grant +1 slot to the new (referred) user and mark bonus as claimed. */
  async claimReferralBonus(userId: number): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        extraSlots: { increment: 1 },
        isReferralBonusClaimed: true,
      } as any,
    });
  }

  /** Grant +1 slot to the referrer and increment their referral counter. */
  async rewardReferrer(userId: number): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        extraSlots: { increment: 1 },
        referralCount: { increment: 1 },
      } as any,
    });
  }



  async incrementPotentialSavings(userId: number, itemId: number, priceDrop: number, newLowestPrice: number): Promise<void> {
    if (priceDrop <= 0) return;
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { totalPotentialSavings: { increment: priceDrop } } as any,
      }),
      this.prisma.trackedItem.update({
        where: { id: itemId },
        data: { lowestPrice: newLowestPrice } as any,
      }),
    ]);
  }

  // ── GDPR: Right to be forgotten ────────────────────────────────────────────

  /** Permanently delete a user and all their data (cascading). */
  async deleteByTelegramId(telegramId: bigint): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) return false;

    await this.prisma.user.delete({ where: { telegramId } });
    this.logger.log(`🗑 User data permanently deleted: internal_id=${user.id}`);
    return true;
  }

  // ── Activity tracking ───────────────────────────────────────────────────────

  /** Update lastActivityAt to now for a given telegram user. */
  async touchActivity(telegramId: bigint): Promise<void> {
    try {
      await this.prisma.user.update({
        where: { telegramId },
        data: { lastActivityAt: new Date() } as any,
      });
    } catch {
      // User may not exist yet — silently ignore
    }
  }

  // ── Cleanup: delete inactive profiles ──────────────────────────────────────

  /** Delete users who had no activity for more than `monthsInactive` months.
   *  Returns the count of deleted profiles.
   */
  async deleteInactiveUsers(monthsInactive = 12): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - monthsInactive);

    const result = await this.prisma.user.deleteMany({
      where: {
        lastActivityAt: { lt: cutoffDate },
      },
    });

    return result.count;
  }
}
