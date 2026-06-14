import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';
import {
  formatPriceDropAlert,
  formatBackInStockAlert,
  buildNotificationKeyboard,
} from './bot.utils';
import { PriceAnalysisService, PricePoint } from '../analysis/price-analysis.service';
import { AffiliateService } from '../affiliate/affiliate.service';
import { TrackedItem } from '@prisma/client';

const DELAY_MS = 1200;

// ─────────────────────────────────────────────────────────────────────────────
// TestUiService — admin-only UI preview. Zero production side-effects.
// Trigger: /test_ui (only works for ADMIN_TELEGRAM_ID)
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal mock TrackedItem for demo */
function mockItem(overrides: Partial<TrackedItem> = {}): TrackedItem {
  return {
    id: 1,
    userId: 1,
    url: 'https://rozetka.com.ua/product/demo',
    title: 'Demo Product',
    currentPrice: 1000,
    previousPrice: null,
    initialPrice: null,
    lowestPrice: null,
    currency: 'UAH',
    inStock: true,
    isActive: true,
    isFrozen: false,
    lastCheckedAt: new Date(),
    nextCheckAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    checkIntervalMinutes: 720,
    consecutiveErrors: 0,
    ...overrides,
  } as TrackedItem;
}

/** Generate N days of fake price history for demo purposes */
function mockHistory(basePrice: number, days: number, entries: number): PricePoint[] {
  const now = Date.now();
  return Array.from({ length: entries }, (_, i) => ({
    price: basePrice * (0.95 + Math.random() * 0.1), // ±5% noise
    createdAt: new Date(now - (days - (i * days / entries)) * 86_400_000),
  }));
}

@Injectable()
export class TestUiService {
  private readonly logger = new Logger(TestUiService.name);

  constructor(
    private readonly priceAnalysis: PriceAnalysisService,
    private readonly affiliate: AffiliateService,
  ) { }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async runSequence(ctx: Context): Promise<void> {
    this.logger.log('UI test sequence triggered by admin');

    await ctx.replyWithHTML(
      `🛠 <b>Demo-режим увімкнено</b>\n\n` +
      `Зараз бот покаже всі можливі стани UI. Кнопки функціональні — натисни будь-яку, щоб перевірити.`,
    );

    await this.sleep(DELAY_MS);

    // ── Mock 0: 🎯 TARGET PRICE SETUP — Scout onboarding after adding item ─────
    {
      const currentPrice = 52000;
      const itemId = 999; // demo id
      const fmt = (n: number) => Math.round(n).toLocaleString('uk-UA');

      await ctx.replyWithHTML(
        `✅ <b>Додано до відстеження!</b>\n\n` +
        `📦 <b>iPhone 15 Pro 128GB</b>\n` +
        `💰 Поточна ціна: <b>${fmt(currentPrice)} ₴</b>\n\n` +
        `Оскільки у вас активовано тариф <b>«Скаут»</b>, ви можете обрати,\n` +
        `коли саме надіслати сповіщення:`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: `📉 -5% (~${fmt(currentPrice * 0.95)} ₴)`,  callback_data: `test_btn:target_pct_5`  },
                { text: `📉 -10% (~${fmt(currentPrice * 0.90)} ₴)`, callback_data: `test_btn:target_pct_10` },
              ],
              [
                { text: `📉 -15% (~${fmt(currentPrice * 0.85)} ₴)`, callback_data: `test_btn:target_pct_15` },
                { text: `✏️ Вказати свою ціну`,                       callback_data: `test_btn:target_custom`  },
              ],
              [
                { text: `🔔 При будь-якій знижці`,                   callback_data: `test_btn:target_skip`   },
              ],
            ],
          },
        } as any,
      );
    }

    await this.sleep(DELAY_MS);

    // ── Mock 0b: 🎯 TARGET PRICE CONFIRMATION ─────────────────────────────────
    await ctx.replyWithHTML(
      `🎯 <b>Цільову ціну встановлено!</b>\n\n` +
      `Я сповіщу вас, щойно товар коштуватиме <b>49 400 ₴</b> або менше.`,
    );

    await this.sleep(DELAY_MS);

    // ── Mock 1a: ✅ REAL DISCOUNT — Scout user sees analysis ───────────────────
    {
      const item = mockItem({
        title: 'iPhone 15 Pro 128GB',
        url: 'https://brain.com.ua/product/iphone-15-pro',
        currency: 'UAH',
      });
      const oldPrice = 52000;
      const newPrice = 48500;

      // History: prices stayed around 52 000 — this is a genuine new low
      const history: PricePoint[] = mockHistory(52000, 30, 20);
      const analysis     = this.priceAnalysis.analyzePriceTrends(oldPrice, newPrice, history);
      const affiliateUrl = this.affiliate.wrap(item.url, 1);
      const keyboard     = buildNotificationKeyboard({ affiliateUrl });

      await ctx.replyWithHTML(
        `<i>👤 Scout-підписник бачить:</i>\n\n` +
        formatPriceDropAlert(item, oldPrice, newPrice, analysis),
        { reply_markup: keyboard } as any,
      );
    }

    await this.sleep(DELAY_MS);

    // ── Mock 1b: ⚠️ MARKETING MOVE — tiny drop, Scout sees analysis ────────────
    {
      const item = mockItem({
        title: 'Samsung Galaxy S24 Ultra 256GB',
        url: 'https://comfy.ua/product/samsung-galaxy-s24',
        currency: 'UAH',
      });
      const oldPrice = 44999;
      const newPrice = 44450;

      // Small drop (<2.5%) → marketing_move verdict
      const history: PricePoint[] = mockHistory(45000, 30, 20);
      const analysis     = this.priceAnalysis.analyzePriceTrends(oldPrice, newPrice, history);
      const affiliateUrl = this.affiliate.wrap(item.url, 1);
      const keyboard     = buildNotificationKeyboard({ affiliateUrl });

      await ctx.replyWithHTML(
        `<i>👤 Scout-підписник бачить:</i>\n\n` +
        formatPriceDropAlert(item, oldPrice, newPrice, analysis),
        { reply_markup: keyboard } as any,
      );
    }

    await this.sleep(DELAY_MS);

    // ── Mock 1c: ❌ ARTIFICIAL INCREASE — price bumped before "sale" ────────────
    {
      const item = mockItem({
        title: 'Apple AirPods Pro 2nd Gen',
        url: 'https://rozetka.com.ua/product/airpods-pro-2',
        currency: 'UAH',
      });
      const oldPrice = 22000;
      const newPrice = 20500;

      // History shows the item was at 18 000 before someone pumped the price
      // current (20 500) > histMin (18 000) * 1.05 → artificial_increase
      const history: PricePoint[] = [
        ...mockHistory(18000, 30, 15),  // historical low period
        ...mockHistory(22500, 5, 5),    // recent artificial pump
      ];
      const analysis     = this.priceAnalysis.analyzePriceTrends(oldPrice, newPrice, history);
      const affiliateUrl = this.affiliate.wrap(item.url, 1);
      const keyboard     = buildNotificationKeyboard({ affiliateUrl });

      await ctx.replyWithHTML(
        `<i>👤 Scout-підписник бачить:</i>\n\n` +
        formatPriceDropAlert(item, oldPrice, newPrice, analysis),
        { reply_markup: keyboard } as any,
      );
    }

    await this.sleep(DELAY_MS);

    // ── Mock 1d: BASE user — no analysis block ─────────────────────────────────
    {
      const item = mockItem({
        title: 'Sony WH-1000XM5',
        url: 'https://allo.ua/product/sony-wh1000xm5',
        currency: 'UAH',
      });
      const oldPrice     = 13999;
      const newPrice     = 11999;
      const affiliateUrl = this.affiliate.wrap(item.url, 1);
      const keyboard     = buildNotificationKeyboard({ affiliateUrl });

      await ctx.replyWithHTML(
        `<i>👤 BASE-користувач бачить (без аналізу):</i>\n\n` +
        formatPriceDropAlert(item, oldPrice, newPrice),
        { reply_markup: keyboard } as any,
      );
    }

    await this.sleep(DELAY_MS);

    // ── Mock 2: 🎉 BACK IN STOCK ───────────────────────────────────────────────
    {
      const item = mockItem({
        title: 'Sony WH-1000XM5',
        url: 'https://allo.ua/product/sony-wh1000xm5',
        currentPrice: 11999,
        currency: 'UAH',
        inStock: true,
      });
      const affiliateUrl = this.affiliate.wrap(item.url, 1);
      const keyboard     = buildNotificationKeyboard({ affiliateUrl });

      await ctx.replyWithHTML(
        formatBackInStockAlert(item),
        { reply_markup: keyboard } as any,
      );
    }

    await this.sleep(DELAY_MS);

    // ── Mock 3: 😔 OUT OF STOCK ────────────────────────────────────────────────
    await ctx.replyWithHTML(
      `😔 <b>Товар зник з наявності</b>\n\n` +
      `📦 <b>Навушники Marshall Emberton III</b>\n\n` +
      `<i>Ми продовжуємо стежити — сповістимо, щойно він з'явиться знову.</i>`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔗 Відкрити сайт', url: 'https://allo.ua' },
            { text: '❌ Видалити', callback_data: 'test_btn:delete' },
          ]],
        },
      } as any,
    );

    await this.sleep(DELAY_MS);

    // ── Mock 4: 👤 Profile ─────────────────────────────────────────────────────
    await ctx.replyWithHTML(
      `👤 <b>Ваш профіль</b>\n\n` +
      `📦 Тариф: <b>БАЗОВИЙ 🆓</b>\n` +
      `💸 Потенційна економія: <b>4 560 ₴</b>\n` +
      `📊 Ліміт товарів: <b>3</b>\n` +
      `🤝 Запрошено друзів: <b>1 / 3</b>\n\n` +
      `🎁 <b>Отримуйте більше слотів!</b>\n\n` +
      `Запросіть друга за посиланням нижче. Коли він додасть свій перший товар — ви обоє отримаєте <b>+1 слот</b> до ліміту назавжди!\n\n` +
      `🔗 <b>Ваше посилання:</b>\n<code>https://t.me/shukach_ua_bot?start=ref123456789</code>`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🗑 Видалити мій профіль', callback_data: 'test_btn:delete_profile' }],
          ],
        },
      } as any,
    );

    await this.sleep(DELAY_MS);

    // ── Mock 5: 🤝 Referral Bonus ──────────────────────────────────────────────
    await ctx.replyWithHTML(
      `🎉 <b>Ваш друг приєднався!</b>\n\n` +
      `Хтось скористався вашим реферальним посиланням і додав перший товар.\n` +
      `Ви отримуєте <b>+1 слот</b> до ліміту відстежень!\n\n` +
      `🤝 Запрошено: <b>1 / 3</b>`,
    );

    await this.sleep(DELAY_MS);

    // ── Mock 6: ⚠️ Limit Reached ──────────────────────────────────────────────
    await ctx.replyWithHTML(
      `⚠️ <b>Ліміт відстежень досягнуто!</b>\n\n` +
      `Ви вже відстежуєте 3 слоти. Щоб ми могли моніторити ціни для вас 24/7, оберіть зручний варіант розширення:\n\n` +
      `🔹 <b>Пакет «Економ» — 49 ⭐️</b>\n` +
      `(+3 додаткові слоти назавжди, перевірка раз на 12 годин).\n\n` +
      `🚀 <b>Тариф «Скаут» — 149 ⭐️/міс</b>\n` +
      `(15 слотів + перевірка кожні 6 годин + аналіз цін).\n\n` +
      `<i>Або запросіть друга через 👤 Профіль — отримайте +1 слот безкоштовно!</i>`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Додати +3 слоти (49 ⭐️)', callback_data: 'test_btn:slots' }],
            [{ text: '🚀 Пакет «Скаут» (149 ⭐️/міс)', callback_data: 'test_btn:scout' }],
          ],
        },
      } as any,
    );

    await this.sleep(DELAY_MS);

    await ctx.replyWithHTML(`✅ <b>Demo-сесія завершена.</b> Показано всі стани UI.`);
  }
}
