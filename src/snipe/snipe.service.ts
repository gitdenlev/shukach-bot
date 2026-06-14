import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Telegraf } from 'telegraf';
import { InjectBot } from 'nestjs-telegraf';
import { ItemsService } from '../items/items.service';
import { ScraperService } from '../scraper/scraper.service';
import { PriceAnalysisService } from '../analysis/price-analysis.service';
import { AffiliateService } from '../affiliate/affiliate.service';
import { UsersService } from '../users/users.service';
import {
  formatPriceDropAlert,
  formatBackInStockAlert,
  buildNotificationKeyboard,
} from '../bot/bot.utils';

/** Minimum price drop percentage to trigger a notification (avoids noise from tiny fluctuations) */
const MIN_DROP_PERCENT = 0.5;

@Injectable()
export class SnipeService {
  private readonly logger = new Logger(SnipeService.name);
  private isRunning = false;

  constructor(
    private readonly itemsService: ItemsService,
    private readonly scraperService: ScraperService,
    private readonly priceAnalysis: PriceAnalysisService,
    private readonly affiliate: AffiliateService,
    private readonly usersService: UsersService,
    @InjectBot() private readonly bot: Telegraf,
  ) {}

  /**
   * The Sniper Cron — runs every minute to process the priority queue.
   * Scrapes due URLs, compares prices and stock status,
   * sends push notifications when something changes.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async runSniper(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Sniper cycle already running — skipping this tick');
      return;
    }

    this.isRunning = true;

    try {
      const items = await this.itemsService.getItemsDueForCheck();
      if (items.length === 0) {
        return;
      }

      this.logger.log(`🎯 Sniper cycle started: Checking ${items.length} due item(s)...`);

      let notified = 0;
      /** Safety net: never let the cycle block for more than 55 s (cron fires every 60 s) */
      const CYCLE_TIMEOUT_MS = 55_000;
      const cycleStart = Date.now();

      for (const item of items) {
        // Abort remaining items if cycle is running too long
        if (Date.now() - cycleStart > CYCLE_TIMEOUT_MS) {
          this.logger.warn(
            `⏱️ Sniper cycle timeout — processed ${items.indexOf(item)} of ${items.length} items. Remaining deferred to next tick.`,
          );
          break;
        }

        // Stagger requests to avoid hammering servers simultaneously
        await sleep(randomDelay(500, 2000));

        try {
          const scraped = await this.scraperService.scrape(item.url);
          const telegramId = item.user.telegramId;

          // ── Price drop check ────────────────────────────────────────────
          if (
            item.currentPrice !== null &&
            scraped.price !== null &&
            scraped.price < item.currentPrice
          ) {
            const dropPct = ((item.currentPrice - scraped.price) / item.currentPrice) * 100;
            const targetPrice = (item as any).targetPrice as number | null;

            // Decide whether to fire notification:
            // • targetPrice set (Scout) → notify ONLY when price reaches/beats target
            // • targetPrice null (BASE or Scout "any drop") → notify on any drop ≥ MIN_DROP_PERCENT
            const shouldNotify = targetPrice !== null
              ? scraped.price <= targetPrice
              : dropPct >= MIN_DROP_PERCENT;

            if (shouldNotify) {
              const affiliateUrl = this.affiliate.wrap(item.url, telegramId);
              const keyboard     = buildNotificationKeyboard({ affiliateUrl });

              // ── Scout-only: algorithmic price trend analysis ────────────
              const user = await this.usersService.findByUserId(item.userId);
              const isScout = user?.plan === 'SCOUT';

              let analysis;
              if (isScout) {
                const history = await this.itemsService.getPriceHistory(item.id, 30);
                analysis = this.priceAnalysis.analyzePriceTrends(
                  item.currentPrice,
                  scraped.price,
                  history,
                );
                this.logger.debug(
                  `📊 Scout analysis for item ${item.id}: verdict=${analysis.verdict} drop=${analysis.pctDrop.toFixed(1)}%`,
                );
              }

              const message = formatPriceDropAlert(item, item.currentPrice, scraped.price, analysis);

              this.logger.log(
                `💸 Price drop on item ${item.id}: ${item.currentPrice} → ${scraped.price}` +
                ` (-${dropPct.toFixed(1)}%)` +
                (targetPrice !== null ? ` [target=${targetPrice} reached ✅]` : '') +
                (isScout ? ' [Scout ✅]' : ' [BASE]') +
                (this.affiliate.hasAffiliate(item.url) ? ' [affiliate ✅]' : ' [affiliate ✗]'),
              );

              // Send with inline keyboard
              await this.sendNotification(telegramId, message, keyboard);
              notified++;
            }
          }

          // ── Back-in-stock check ─────────────────────────────────────────
          if (!item.inStock && scraped.inStock) {
            const affiliateUrl = this.affiliate.wrap(item.url, telegramId);
            const keyboard     = buildNotificationKeyboard({ affiliateUrl });
            const message = formatBackInStockAlert({ ...item, currentPrice: scraped.price });
            this.logger.log(`📦 Back in stock: item ${item.id}`);
            await this.sendNotification(telegramId, message, keyboard);
            notified++;
          }

          // ── Record price snapshot (builds history for future analysis) ──
          if (scraped.price !== null) {
            await this.itemsService.recordPriceSnapshot(item.id, scraped.price);
          }

          // ── Potential Savings check ─────────────────────────────────────
          const currentLowest = (item as any).lowestPrice ?? item.currentPrice;
          if (scraped.price !== null && currentLowest !== null && scraped.price < currentLowest) {
            const priceDrop = currentLowest - scraped.price;
            await this.usersService.incrementPotentialSavings(item.userId, item.id, priceDrop, scraped.price);
            (item as any).lowestPrice = scraped.price;
          }

          // ── Always update DB with latest data ──────────────────────────
          await this.itemsService.updateItemPrice(item.id, scraped.price, scraped.inStock);
        } catch (err) {
          this.logger.warn(
            `Failed to check item ${item.id} (${item.url}): ${(err as Error).message}`,
          );
          // Continue with next item — don't abort the entire cycle
        }
      }

      this.logger.log(`✅ Sniper cycle complete. ${notified} notification(s) sent.`);
    } catch (err) {
      this.logger.error(
        `Sniper cycle failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // Always release the lock — even on unexpected errors or DB failures
      this.isRunning = false;
    }
  }

  private async sendNotification(
    telegramId: bigint,
    message: string,
    replyMarkup?: { inline_keyboard: { text: string; url: string }[][] },
  ): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(telegramId.toString(), message, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    } catch (err) {
      this.logger.error(
        `Failed to send notification to user_tail=***${String(telegramId).slice(-3)}: ${(err as Error).message}`,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
