import { Injectable, Logger, Inject, forwardRef, ConflictException } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { PrismaService } from '../prisma/prisma.service';
import { TrackedItem, User } from '@prisma/client';
import { UsersService } from '../users/users.service';
import { PricePoint } from '../analysis/price-analysis.service';

const MAX_ITEMS_PER_USER = 3;

/**
 * Shape of the raw SQL row returned by getItemsDueForCheck.
 * Keeping this explicit prevents silent regressions if the query changes.
 */
type RawTrackedItemRow = {
  id: number;
  url: string;
  title: string;
  currentPrice: number | null;
  previousPrice: number | null;
  initialPrice: number | null;
  lowestPrice: number | null;
  targetPrice: number | null;
  currency: string;
  inStock: boolean;
  isActive: boolean;
  isFrozen: boolean;
  lastCheckedAt: Date;
  nextCheckAt: Date;
  checkIntervalMinutes: number;
  consecutiveErrors: number;
  createdAt: Date;
  updatedAt: Date;
  userId: number;
  userTelegramId: bigint;
};

@Injectable()
export class ItemsService {
  private readonly logger = new Logger(ItemsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => UsersService))
    private readonly usersService: UsersService,
  ) {}

  async getItemCountForUser(userId: number): Promise<number> {
    return this.prisma.trackedItem.count({
      where: { userId, isActive: true, isFrozen: false },
    });
  }

  async isLimitReached(user: User): Promise<boolean> {
    const limits = await this.usersService.getUserLimits(user.id);
    return !limits.canAddProduct;
  }

  /**
   * Returns the active tracked item for this user/url combo, or null if not tracked.
   */
  async findByUrl(userId: number, url: string): Promise<TrackedItem | null> {
    return this.prisma.trackedItem.findFirst({
      where: { userId, url, isActive: true, isFrozen: false },
    });
  }

  async findById(itemId: number, userId: number): Promise<TrackedItem | null> {
    return this.prisma.trackedItem.findFirst({
      where: { id: itemId, userId, isActive: true },
    });
  }


  async addItem(data: {
    userId: number;
    url: string;
    title: string;
    currentPrice: number | null;
    inStock: boolean;
  }): Promise<TrackedItem> {
    const limits = await this.usersService.getUserLimits(data.userId);
    try {
      return await this.prisma.trackedItem.create({
        data: {
          userId: data.userId,
          url: data.url,
          title: data.title,
          currentPrice: data.currentPrice,
          initialPrice: data.currentPrice,
          lowestPrice: data.currentPrice,
          inStock: data.inStock,
          isActive: true,
          checkIntervalMinutes: limits.checkInterval,
        } as any,
      });
    } catch (err) {
      // P2002 = unique constraint violation — the partial unique index
      // "tracked_items_userId_url_active_uq" caught a race condition where two
      // concurrent requests both passed the findByUrl() check and tried to insert
      // the same (userId, url) pair simultaneously.
      if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('This URL is already being tracked');
      }
      throw err;
    }
  }

  async getItemsForUser(userId: number): Promise<TrackedItem[]> {
    return this.prisma.trackedItem.findMany({
      where: { userId, isActive: true, isFrozen: false },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteItem(itemId: number, userId: number): Promise<TrackedItem | null> {
    const item = await this.prisma.trackedItem.findFirst({
      where: { id: itemId, userId, isActive: true },
    });

    if (!item) return null;

    // Hard delete — ON DELETE CASCADE removes PriceHistory automatically.
    // This ensures no orphaned records remain after the user removes a product.
    return this.prisma.trackedItem.delete({
      where: { id: itemId },
    });
  }

  async getItemsDueForCheck(): Promise<(TrackedItem & { user: { telegramId: bigint } })[]> {
    const rawItems = await this.prisma.$queryRaw<RawTrackedItemRow[]>`
      SELECT t.*, u."telegramId" as "userTelegramId"
      FROM tracked_items t
      JOIN users u ON t."userId" = u.id
      WHERE t."isActive" = true
        AND t."isFrozen" = false
        AND t."lastCheckedAt" + (t."checkIntervalMinutes" * interval '1 minute') < NOW()
      ORDER BY u.priority DESC, t."lastCheckedAt" ASC
    `;

    return rawItems.map(item => ({
      ...item,
      user: { telegramId: item.userTelegramId },
    })) as (TrackedItem & { user: { telegramId: bigint } })[];
  }

  async getAllActiveItems(): Promise<(TrackedItem & { user: { telegramId: bigint } })[]> {
    return this.prisma.trackedItem.findMany({
      where: { isActive: true, isFrozen: false },
      include: { user: { select: { telegramId: true } } },
    }) as Promise<(TrackedItem & { user: { telegramId: bigint } })[]>;
  }

  /**
   * Atomically update price & stock using a single SQL statement.
   * Returns the value of `currentPrice` that was stored BEFORE this update
   * (i.e., the "old price") so the caller can compare without a separate SELECT.
   *
   * The previous two-query approach (findUnique + update) had a race window
   * where a concurrent cycle could overwrite `currentPrice` between the two
   * statements, making the comparison always equal and suppressing notifications.
   */
  async updateItemPrice(
    itemId: number,
    newPrice: number | null,
    inStock: boolean,
  ): Promise<{ priceBeforeUpdate: number | null }> {
    // One atomic SQL round-trip:
    //   1. copies currentPrice → previousPrice  (the OLD value is preserved)
    //   2. writes newPrice       → currentPrice
    //   3. RETURNING "previousPrice" gives us the value that WAS in currentPrice
    //      before this statement ran — no race condition, no extra SELECT.
    const rows = await this.prisma.$queryRaw<{ previousPrice: number | null }[]>`
      UPDATE tracked_items
      SET
        "previousPrice" = "currentPrice",
        "currentPrice"  = ${newPrice},
        "inStock"       = ${inStock},
        "lastCheckedAt" = NOW()
      WHERE id = ${itemId}
      RETURNING "previousPrice"
    `;

    return { priceBeforeUpdate: rows[0]?.previousPrice ?? null };
  }

  /**
   * Fetch price snapshots for a given item over the last `days` days.
   * Used by PriceAnalysisService for Scout-tier trend analysis.
   */
  async getPriceHistory(itemId: number, days = 30): Promise<PricePoint[]> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const rows = await this.prisma.priceHistory.findMany({
      where: {
        itemId,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'asc' },
      select: { price: true, createdAt: true },
    });

    return rows;
  }

  /**
   * Set or clear the target price for a Scout user's tracked item.
   * @returns updated item or null if item not found / doesn't belong to user
   */
  async setTargetPrice(
    itemId: number,
    userId: number,
    targetPrice: number | null,
  ): Promise<TrackedItem | null> {
    const item = await this.prisma.trackedItem.findFirst({
      where: { id: itemId, userId, isActive: true },
    });

    if (!item) return null;

    return this.prisma.trackedItem.update({
      where: { id: itemId },
      data: { targetPrice } as any,
    });
  }

  /**
   * Insert a price snapshot into price_history.
   * Called after every successful scrape to build the history dataset.
   */
  async recordPriceSnapshot(itemId: number, price: number): Promise<void> {
    if (price <= 0) return;
    await this.prisma.priceHistory.create({
      data: { itemId, price },
    });
  }
}
