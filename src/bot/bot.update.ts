import { Update, Start, Command, Ctx, On, Action } from "nestjs-telegraf";
import { Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { RateLimitService } from "./rate-limit.service";
import { Context } from "telegraf";
import { User } from "@prisma/client";
import { UsersService } from "../users/users.service";
import { ItemsService } from "../items/items.service";
import { ScraperService } from "../scraper/scraper.service";
import { TestUiService } from "./test-ui.service";
import { SUPPORTED_STORES } from "../scraper/scraper.service";
import {
  formatItemAdded,
  formatItemCard,
  formatItemDeleted,
  itemInlineKeyboard,
  formatCurrency,
} from "./bot.utils";

const PAYMENT_PROVIDER_TOKEN = process.env.PAYMENT_PROVIDER_TOKEN ?? "";
const BOT_NAME = process.env.BOT_NAME ?? "shukach_ua_bot";
const XTR_CURRENCY = "XTR";
const PLAN_SCOUT_MONTHLY = 149;
const SLOTS_PACK_3 = 49;
const SUBSCRIPTION_PERIOD = 2592000;
const MAX_REFERRAL_BONUSES = 3;
const ADMIN_TELEGRAM_ID = BigInt(process.env.ADMIN_TELEGRAM_ID ?? "0");

/** Ukrainian plural for "слот": 1 слот, 2-4 слоти, 5+ слотів */
function pluralSlots(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'слот';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'слоти';
  return 'слотів';
}

@Update()
export class BotUpdate {
  private readonly logger = new Logger(BotUpdate.name);
  /** userId → TTL expiry timestamp (ms). Entries are lazily evicted + cleaned by cron. */
  private readonly awaitingUrl = new Map<number, number>();
  /** userId → wizard state + TTL expiry timestamp. Entries are lazily evicted + cleaned by cron. */
  private readonly awaitingTargetPrice = new Map<number, { itemId: number; currentPrice: number; expiresAt: number }>();
  private readonly STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

  constructor(
    private readonly usersService: UsersService,
    private readonly itemsService: ItemsService,
    private readonly scraperService: ScraperService,
    private readonly testUiService: TestUiService,
    private readonly rateLimitService: RateLimitService,
  ) {}

  @Command("test_ui")
  async onTestUi(@Ctx() ctx: Context): Promise<void> {
    const tgUser = ctx.from;
    if (!tgUser) return;

    if (BigInt(tgUser.id) !== ADMIN_TELEGRAM_ID) {
      await ctx.reply("⛔️ Команда недоступна.");
      return;
    }

    await this.testUiService.runSequence(ctx);
  }

  @Action(/^test_btn:/)
  async onTestBtn(@Ctx() ctx: Context): Promise<void> {
    await ctx.answerCbQuery(
      "🛠 Це демо-режим. У production тут буде реальна дія.",
      { show_alert: true }
    );
  }

  @Command('delete_my_data')
  @Action('delete_my_data')
  async onDeleteMyData(@Ctx() ctx: Context): Promise<void> {
    // Called both as a slash command and as an inline callback from the Profile
    if ('callbackQuery' in ctx) await ctx.answerCbQuery();

    await ctx.replyWithHTML(
      `⚠️ <b>Ви впевнені?</b>\n\n` +
      `Ця дія є <b>незворотною</b>. Усі ваші дані (профіль, список товарів, налаштування) ` +
      `будуть <b>безповоротно видалені</b> з наших серверів.\n\n` +
      `Натисніть кнопку нижче для підтвердження.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🗑 Так, видалити мої дані', callback_data: 'confirm_delete_my_data' }],
            [{ text: '❌ Скасувати', callback_data: 'cancel_delete_my_data' }],
          ],
        },
      },
    );
  }

  @Action('confirm_delete_my_data')
  async onConfirmDeleteMyData(@Ctx() ctx: Context): Promise<void> {
    await ctx.answerCbQuery();
    const tgUser = ctx.from;
    if (!tgUser) return;

    try {
      const deleted = await this.usersService.deleteByTelegramId(BigInt(tgUser.id));
      if (deleted) {
        await ctx.editMessageText(
          'Ваш профіль, налаштування та історія лінків безповоротно стирані з серверів Шукача. Нам шкода, що ви йдете! 🤝',
        );
      } else {
        await ctx.editMessageText('❌ Профіль не знайдено або вже видалено.');
      }
    } catch (err) {
      this.logger.error(`deleteByTelegramId failed: ${err instanceof Error ? err.message : err}`);
      await ctx.answerCbQuery('❌ Помилка при видаленні. Спробуйте пізніше.', { show_alert: true });
    }
  }

  @Action('cancel_delete_my_data')
  async onCancelDeleteMyData(@Ctx() ctx: Context): Promise<void> {
    await ctx.answerCbQuery();
  }

  @Start()
  async onStart(@Ctx() ctx: Context): Promise<void> {
    const tgUser = ctx.from;
    if (!tgUser) return;

    // Extract referral deep-link payload: /start ref123456789
    const startPayload =
      (ctx.message as { text?: string })?.text?.split(" ")[1] ?? "";
    const referredById = startPayload.startsWith("ref")
      ? BigInt(startPayload.slice(3))
      : null;

    // findOrCreate first, then attach referrer separately for new users
    const { user, isNew } = await this.usersService.findOrCreate({
      telegramId: BigInt(tgUser.id),
      username: tgUser.username,
      firstName: tgUser.first_name,
    });

    if (isNew && referredById && referredById !== BigInt(tgUser.id)) {
      await this.usersService.setReferredBy(user.id, referredById);
    }

    const userName = tgUser.first_name ?? "друже";
    const welcome = isNew
      ? `👋 Привіт, ${userName}!`
      : `👋 З поверненням, ${userName}!`;

    await ctx.reply(
      `${welcome} Це «Шукач» — ваш особистий помічник з вигідного шопінгу.\n\n` +
        `Більше не потрібно вручну перевіряти десятки сторінок у надії, що ціна впала. Ми зробимо це за вас — автоматично та цілодобово 🔍\n\n` +
        `Як це працює:\n` +
        `✅ Надсилаєте посилання на товар.\n` +
        `✅ Ми фіксуємо поточну ціну.\n` +
        `✅ Щойно ціна впаде або товар з'явиться у наявності — ви отримаєте сповіщення першим 🔔\n\n` +
        `Бот моніторить усе у фоновому режимі 24/7, поки ви займаєтеся своїми справами ☕️\n\n` +
        `Просто натисніть «➕ Додати товар» і вставте посилання — решту зробимо ми!\n\n` +
        `<i>Натискаючи кнопку start, ви автоматично погоджуєтесь з нашими <a href="https://shukach.in.ua/terms">Правилами користування</a> та <a href="https://shukach.in.ua/privacy">Політикою конфіденційності</a>.</i>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          keyboard: [
            [{ text: "📋 Мої товари" }, { text: "➕ Додати товар" }],
            [{ text: "👤 Профіль" }, { text: "❓ Допомога" }],
          ],
          resize_keyboard: true,
          is_persistent: true,
        },
      }
    );
  }

  private async showProfile(ctx: Context): Promise<void> {
    const tgUser = ctx.from;
    if (!tgUser) return;

    const user = await this.usersService.findByTelegramId(BigInt(tgUser.id));
    if (!user) {
      await ctx.reply("Відправ /start щоб зареєструватись.");
      return;
    }

    const limits = await this.usersService.getUserLimits(user.id);
    const limit = `${limits.totalSlots}`;
    const planName = limits.plan === "SCOUT" ? "СКАУТ 🚀" : "БАЗОВИЙ 🆓";

    const refLink = `https://t.me/${BOT_NAME}?start=ref${tgUser.id}`;
    const potentialSavingsFormatted = formatCurrency(
      (user as any).totalPotentialSavings || 0
    );

    await ctx.replyWithHTML(
      `👤 <b>Ваш профіль</b>\n\n` +
        `📦 Тариф: <b>${planName}</b>\n` +
        `💸 Потенційна економія: <b>${potentialSavingsFormatted}</b>\n` +
        `📊 Ліміт товарів: <b>${limit}</b>\n` +
        `🤝 Запрошено друзів: <b>${user.referralCount} / ${MAX_REFERRAL_BONUSES}</b>\n\n` +
        `🎁 <b>Отримуйте більше слотів!</b>\n\n` +
        `Запросіть друга за посиланням нижче. Коли він додасть свій перший товар — ви обоє отримаєте <b>+1 слот</b> до ліміту назавжди!\n\n` +
        `🔗 <b>Ваше посилання:</b>\n<code>${refLink}</code>`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🗑 Видалити мій профіль', callback_data: 'delete_my_data' }],
          ],
        },
      } as any
    );
  }

  @Command("add")
  async onAdd(@Ctx() ctx: Context): Promise<void> {
    const tgUser = ctx.from;
    if (!tgUser) return;

    const msgText = (ctx.message as { text?: string })?.text ?? "";
    const url = msgText.trim().split(/\s+/)[1];

    if (!url) {
      this.setAwaitingUrl(tgUser.id);
      await ctx.reply("📎 Вставте посилання на товар:");
      return;
    }

    await this.processUrl(ctx, url);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // /tariffs
  // ─────────────────────────────────────────────────────────────────────────
  @Command(["tariffs", "shop"])
  async onTariffs(@Ctx() ctx: Context): Promise<void> {
    const scoutLink = await ctx.telegram.createInvoiceLink({
      title: "Тариф «Скаут»",
      description: "15 слотів + перевірка щогодини + пріоритет",
      payload: "tier_scout",
      provider_token: "",
      currency: XTR_CURRENCY,
      prices: [{ label: "XTR", amount: PLAN_SCOUT_MONTHLY }],
      subscription_period: SUBSCRIPTION_PERIOD,
    } as any);

    const slotsLink = await ctx.telegram.createInvoiceLink({
      title: "Пакет «Економ»",
      description: "+3 додаткові слоти назавжди",
      payload: "pack_economy",
      provider_token: "",
      currency: XTR_CURRENCY,
      prices: [{ label: "XTR", amount: SLOTS_PACK_3 }],
    });

    await ctx.replyWithHTML(
      `<b>Тарифи Шукача 🔎</b>\n\n` +
        `<b>Базовий (Безкоштовно)</b>\n` +
        `— 3 слоти\n` +
        `— перевірка раз на 12 годин\n\n` +
        `<b>Пакет «Економ» (49 ⭐️)</b>\n` +
        `— +3 слоти назавжди\n` +
        `— перевірка раз на 12 годин\n\n` +
        `<b>Скаут (149 ⭐️/міс)</b>\n` +
        `— 15 слотів\n` +
        `— перевірка щогодини\n` +
        `— Пріоритет А\n\n`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "+3 слоти (49 ⭐️)", url: slotsLink }],
            [{ text: "Скаут (149 ⭐️/міс)", url: scoutLink }],
          ],
        },
      }
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // /list
  // ─────────────────────────────────────────────────────────────────────────
  @Command("list")
  async onList(@Ctx() ctx: Context): Promise<void> {
    const tgUser = ctx.from;
    if (!tgUser) return;

    const user = await this.usersService.findByTelegramId(BigInt(tgUser.id));
    if (!user) {
      await ctx.reply("Відправ /start щоб зареєструватись.");
      return;
    }

    const items = await this.itemsService.getItemsForUser(user.id);

    if (items.length === 0) {
      await ctx.reply(
        "📭 Ви ще нічого не відстежуєте.\nНатисніть «➕ Додати товар» щоб додати перший товар."
      );
      return;
    }

    const limits = await this.usersService.getUserLimits(user.id);
    await ctx.reply(
      `📋 <b>Ваші товари (${items.length}/${limits.totalSlots}):</b>`,
      {
        parse_mode: "HTML",
      }
    );

    for (const item of items) {
      await ctx.reply(formatItemCard(item), {
        parse_mode: "HTML",
        reply_markup: itemInlineKeyboard(item.id, item.url),
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // /delete <ID>
  // ─────────────────────────────────────────────────────────────────────────
  @Command("delete")
  async onDelete(@Ctx() ctx: Context): Promise<void> {
    const tgUser = ctx.from;
    if (!tgUser) return;

    const msgText = (ctx.message as { text?: string })?.text ?? "";
    const idStr = msgText.trim().split(/\s+/)[1];
    const itemId = parseInt(idStr, 10);

    if (!idStr || isNaN(itemId)) {
      await ctx.reply("⚠️ Вкажи ID товару:\n`/delete 42`", {
        parse_mode: "Markdown",
      });
      return;
    }

    const user = await this.usersService.findByTelegramId(BigInt(tgUser.id));
    if (!user) {
      await ctx.reply("Відправ /start щоб зареєструватись.");
      return;
    }

    const deleted = await this.itemsService.deleteItem(itemId, user.id);
    if (!deleted) {
      await ctx.reply(
        `❌ Товар з ID ${itemId} не знайдено або він вже видалений.`
      );
      return;
    }

    await ctx.reply(formatItemDeleted(deleted), { parse_mode: "HTML" });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Inline: ❌ Видалити товар
  // ─────────────────────────────────────────────────────────────────────────
  @Action(/^delete_item:(\d+)$/)
  async onDeleteCallback(@Ctx() ctx: Context): Promise<void> {
    const callbackQuery = ctx.callbackQuery as {
      data?: string;
      from: { id: number };
    };
    const tgUser = callbackQuery?.from;
    if (!tgUser) return;

    const match = callbackQuery.data?.match(/^delete_item:(\d+)$/);
    if (!match) return;

    const itemId = parseInt(match[1], 10);
    const user = await this.usersService.findByTelegramId(BigInt(tgUser.id));

    if (!user) {
      await ctx.answerCbQuery("❌ Користувача не знайдено.");
      return;
    }

    const deleted = await this.itemsService.deleteItem(itemId, user.id);
    if (!deleted) {
      await ctx.answerCbQuery("❌ Товар не знайдено або вже видалено.");
      return;
    }

    await ctx.answerCbQuery("✅ Товар видалено зі списку відстеження");
    await ctx.editMessageText(
      "❌ Цей товар було видалено зі списку відстеження.",
      {
        reply_markup: { inline_keyboard: [] },
      }
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Inline: list_products
  // ─────────────────────────────────────────────────────────────────────────
  @Action("list_products")
  async onListProducts(@Ctx() ctx: Context): Promise<void> {
    await ctx.answerCbQuery();
    return this.onList(ctx);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Inline: scout_already_active (shown in Profile for premium users)
  // ─────────────────────────────────────────────────────────────────────────
  @Action("scout_already_active")
  async onScoutAlreadyActive(@Ctx() ctx: Context): Promise<void> {
    await ctx.answerCbQuery("✅ У вас вже активний тариф «Скаут»!", {
      show_alert: false,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Inline: target_pct:<itemId>:<pct>   — quick % preset for target price
  // ─────────────────────────────────────────────────────────────────────────
  @Action(/^target_pct:\d+:\d+$/)
  async onTargetPct(@Ctx() ctx: Context): Promise<void> {
    await ctx.answerCbQuery();
    const tgUser = ctx.from;
    if (!tgUser) return;

    const data = (ctx.callbackQuery as any)?.data as string;
    const [, itemIdStr, pctStr] = data.split(':');
    const itemId = parseInt(itemIdStr, 10);
    const pct    = parseInt(pctStr, 10);

    try {
      const user = await this.usersService.findByTelegramId(BigInt(tgUser.id));
      if (!user) return;

      const item = await this.itemsService.findById(itemId, user.id);
      if (!item || item.currentPrice === null) {
        await ctx.answerCbQuery('❌ Товар не знайдено.', { show_alert: true });
        return;
      }

      const targetPrice = Math.round(item.currentPrice * (1 - pct / 100));
      await this.itemsService.setTargetPrice(itemId, user.id, targetPrice);

      this.logger.log(`🎯 Target price set via pct: item=${itemId} user=${tgUser.id} pct=${pct}% price=${targetPrice}`);

      await ctx.editMessageText(
        `✅ <b>Додано до відстеження!</b>\n\n` +
        `📦 <b>${item.title.slice(0, 60)}</b>\n\n` +
        `🎯 Сповіщу, коли ціна опуститься до <b>${targetPrice.toLocaleString('uk-UA')} ₴</b> (-${pct}%)`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } } as any,
      );
    } catch (err) {
      this.logger.error(`onTargetPct failed: ${err instanceof Error ? err.message : err}`);
      await ctx.answerCbQuery('❌ Помилка. Спробуйте ще раз.', { show_alert: true });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Inline: target_custom:<itemId>   — enter custom target price
  // ─────────────────────────────────────────────────────────────────────────
  @Action(/^target_custom:\d+$/)
  async onTargetCustom(@Ctx() ctx: Context): Promise<void> {
    await ctx.answerCbQuery();
    const tgUser = ctx.from;
    if (!tgUser) return;

    const data = (ctx.callbackQuery as any)?.data as string;
    const itemId = parseInt(data.split(':')[1], 10);

    try {
      const user = await this.usersService.findByTelegramId(BigInt(tgUser.id));
      if (!user) return;

      const item = await this.itemsService.findById(itemId, user.id);
      if (!item || item.currentPrice === null) {
        await ctx.answerCbQuery('❌ Товар не знайдено.', { show_alert: true });
        return;
      }

      // Set wizard state (with TTL)
      this.setAwaitingTargetPrice(tgUser.id, {
        itemId,
        currentPrice: item.currentPrice,
      });

      // Remove inline keyboard
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] } as any);

      await ctx.reply(
        `✏️ Введіть бажану цільову ціну в гривнях (цифрами).\n\n` +
        `Поточна ціна: <b>${item.currentPrice.toLocaleString('uk-UA')} ₴</b>\n` +
        `Наприклад: ${Math.round(item.currentPrice * 0.9).toLocaleString('uk-UA')}`,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      this.logger.error(`onTargetCustom failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Inline: target_skip:<itemId>   — Scout skips target price (any drop)
  // ─────────────────────────────────────────────────────────────────────────
  @Action(/^target_skip:\d+$/)
  async onTargetSkip(@Ctx() ctx: Context): Promise<void> {
    await ctx.answerCbQuery();
    const tgUser = ctx.from;
    if (!tgUser) return;

    const data = (ctx.callbackQuery as any)?.data as string;
    const itemId = parseInt(data.split(':')[1], 10);

    try {
      const user = await this.usersService.findByTelegramId(BigInt(tgUser.id));
      if (!user) return;

      const item = await this.itemsService.findById(itemId, user.id);
      if (!item) return;

      // targetPrice stays null → notify on any drop
      await ctx.editMessageText(
        `✅ <b>Додано до відстеження!</b>\n\n` +
        `📦 <b>${item.title.slice(0, 60)}</b>\n\n` +
        `<i>Сповіщу при будь-якому зниженні ціни.</i>`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } } as any,
      );
    } catch (err) {
      this.logger.error(`onTargetSkip failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PreCheckoutQuery
  // ─────────────────────────────────────────────────────────────────────────
  @On("pre_checkout_query")
  async onPreCheckoutQuery(@Ctx() ctx: Context): Promise<void> {
    const preCheckoutQuery = (ctx.update as any).pre_checkout_query;
    if (!preCheckoutQuery) return;

    await ctx.telegram.answerPreCheckoutQuery(preCheckoutQuery.id, true);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Successful payment
  // ─────────────────────────────────────────────────────────────────────────
  @On("successful_payment")
  async onSuccessfulPayment(@Ctx() ctx: Context): Promise<void> {
    const tgUser = ctx.from;
    if (!tgUser) return;

    const payment = (
      ctx.message as { successful_payment?: { invoice_payload: string } }
    )?.successful_payment;
    if (!payment) return;

    const user = await this.usersService.findByTelegramId(BigInt(tgUser.id));
    if (!user) return;

    if (payment.invoice_payload === "pack_economy") {
      await this.usersService.addPurchasedSlots(user.id, 3);
      await ctx.replyWithHTML(
        `🎁 <b>+3 слоти додано!</b>\n\n` +
        `Тепер ви можете відстежувати більше товарів одночасно. Приємних покупок! 🛍`
      );
    } else if (payment.invoice_payload === "tier_scout") {
      await this.usersService.activateScout(user.id);
      await ctx.replyWithHTML(
        `🚀 <b>Тариф «Скаут» активовано!</b>\n\n` +
        `Тепер вам доступно <b>15 слотів</b> та перевірка цін <b>щогодини</b>. Удачного полювання за цінами! ⚡️`
      );
    }

    this.logger.log(
      `Payment: user=${tgUser.id}, payload=${payment.invoice_payload}`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Text handler
  // ─────────────────────────────────────────────────────────────────────────
  @On("text")
  async onText(@Ctx() ctx: Context): Promise<void> {
    const tgUser = ctx.from;
    if (!tgUser) return;

    // Rate limit: 20 messages / minute per user
    if (!this.rateLimitService.isAllowed(tgUser.id, 'default')) {
      await ctx.reply('⏳ Занадто багато повідомлень. Зачекайте хвилину і спробуйте знову.');
      return;
    }

    // Update activity timestamp on every user interaction
    void this.usersService.touchActivity(BigInt(tgUser.id));

    const text = (ctx.message as { text?: string })?.text ?? "";

    if (text === "📋 Мої товари") return this.onList(ctx);
    if (text === "👤 Профіль") return this.showProfile(ctx);

    if (text === "➕ Додати товар") {
      this.setAwaitingUrl(tgUser.id);
      await ctx.reply(
        "📎 Вставте посилання на товар, який хочете відстежувати:"
      );
      return;
    }

    if (text === "❓ Допомога") {
      await this.sendHelpMenu(ctx);
      return;
    }

    // ── Target Price wizard: awaiting custom price input ──────────────────
    if (this.hasAwaitingTargetPrice(tgUser.id)) {
      const state = this.getAwaitingTargetPrice(tgUser.id)!;
      const parsed = parseFloat(text.replace(/\s/g, '').replace(',', '.'));

      if (isNaN(parsed) || parsed <= 0) {
        await ctx.reply(
          `⚠️ Будь ласка, введіть число більше нуля.\n\nНаприклад: ${Math.round(state.currentPrice * 0.9).toLocaleString('uk-UA')}`,
        );
        return; // stay in wizard state
      }

      if (parsed >= state.currentPrice) {
        await ctx.reply(
          `⚠️ Цільова ціна повинна бути менша за поточну (${state.currentPrice.toLocaleString('uk-UA')} ₴).\n\nСпробуйте ще раз:`,
        );
        return; // stay in wizard state
      }

      // All good — save and confirm
      this.deleteAwaitingTargetPrice(tgUser.id);
      try {
        const user = await this.usersService.findByTelegramId(BigInt(tgUser.id));
        if (user) {
          await this.itemsService.setTargetPrice(state.itemId, user.id, parsed);
          this.logger.log(`🎯 Target price set: item=${state.itemId} user=${tgUser.id} price=${parsed}`);
        }
        await ctx.replyWithHTML(
          `🎯 <b>Цільову ціну встановлено!</b>\n\n` +
          `Я сповіщу вас, щойно товар коштуватиме <b>${parsed.toLocaleString('uk-UA')} ₴</b> або менше.`,
        );
      } catch (err) {
        this.logger.error(`setTargetPrice failed: ${err instanceof Error ? err.message : err}`);
        await ctx.reply('❌ Помилка при збереженні. Спробуйте ще раз.');
      }
      return;
    }

    // Conversational URL flow
    if (this.hasAwaitingUrl(tgUser.id)) {
      this.deleteAwaitingUrl(tgUser.id);

      if (!text.startsWith("http://") && !text.startsWith("https://")) {
        await ctx.reply(
          "❌ Це не схоже на посилання.\n\nБудь ласка, надішліть повне посилання, що починається з https://"
        );
        return;
      }

      await this.processUrl(ctx, text);
      return;
    }

    // Direct URL paste
    if (text.startsWith("http://") || text.startsWith("https://")) {
      await this.processUrl(ctx, text);
      return;
    }

    await ctx.reply(
      "Не розумію 🤔\n\nСкористайтеся кнопками внизу екрана або надішліть посилання на товар."
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Sticker / Photo / Voice — unsupported media types
  // ─────────────────────────────────────────────────────────────────────────
  private readonly UNSUPPORTED_REPLY =
    "Не розумію 🤔\n\nСкористайтеся кнопками внизу екрана або надішліть посилання на товар.";

  @On("sticker")
  async onSticker(@Ctx() ctx: Context): Promise<void> {
    await ctx.reply(this.UNSUPPORTED_REPLY);
  }

  @On("photo")
  async onPhoto(@Ctx() ctx: Context): Promise<void> {
    await ctx.reply(this.UNSUPPORTED_REPLY);
  }

  @On("voice")
  async onVoice(@Ctx() ctx: Context): Promise<void> {
    await ctx.reply(this.UNSUPPORTED_REPLY);
  }

  @On("animation")
  async onAnimation(@Ctx() ctx: Context): Promise<void> {
    await ctx.reply(this.UNSUPPORTED_REPLY);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Help Menu Handlers
  // ─────────────────────────────────────────────────────────────────────────
  private async sendHelpMenu(ctx: Context, edit = false): Promise<void> {
    const text =
      `📖 <b>Як користуватись ботом:</b>\n\n` +
      `➕ <b>Додати товар:</b>\nНатисніть «➕ Додати товар» і вставте посилання\n\n` +
      `📋 <b>Мої товари:</b>\nПереглянути список відстежуваних товарів\n\n` +
      `👤 <b>Профіль:</b>\nВаш ліміт та реферальне посилання для +1 слоту\n\n` +
      `🗑 <b>Видалити товар:</b>\nНатисніть кнопку «❌ Видалити» під товаром\n\n` +
      `<i>Бот перевіряє ціни автоматично та сповіщає вас про зміни 🔔</i>`;

    const markup = {
      inline_keyboard: [
        [
          {
            text: "🌐 Підтримувані магазини",
            url: "https://shukach.in.ua/#stores",
          },
        ],
      ],
    };

    if (edit) {
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: markup,
      });
    } else {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: markup });
    }
  }



  // ─────────────────────────────────────────────────────────────────────────
  // Private: validate → duplicate → limit → scrape → save → referral
  // ─────────────────────────────────────────────────────────────────────────
  private async processUrl(ctx: Context, url: string): Promise<void> {
    const tgUser = ctx.from!;

    try {
      new URL(url);
    } catch {
      await ctx.reply(
        "❌ Невірний URL. Перевірте посилання і спробуйте ще раз."
      );
      return;
    }

    // Rate limit: max 5 scrape requests / minute (heavy external HTTP calls)
    if (!this.rateLimitService.isAllowed(tgUser.id, 'scrape')) {
      await ctx.reply('⏳ Забагато запитів на додавання товарів. Зачекайте хвилину і спробуйте знову.');
      return;
    }

    const { user } = await this.usersService.findOrCreate({
      telegramId: BigInt(tgUser.id),
      username: tgUser.username,
      firstName: tgUser.first_name,
    });

    // Duplicate check
    const existing = await this.itemsService.findByUrl(user.id, url);
    if (existing) {
      await ctx.replyWithHTML(
        `ℹ️ <b>Цей товар вже у вашому списку!</b>\n\n` +
          `📦 <b>${existing.title}</b>\n` +
          `💰 Остання відома ціна: ${existing.currentPrice?.toLocaleString("uk-UA") ?? "невідома"} ₴\n` +
          `📊 Статус: ${existing.inStock ? "✅ В наявності" : "❌ Немає в наявності"}\n\n` +
          `<i>Натисніть «📋 Мої товари» щоб переглянути список.</i>`,
        { reply_markup: itemInlineKeyboard(existing.id, existing.url) } as any
      );
      return;
    }

    // Limit check
    const limits = await this.usersService.getUserLimits(user.id);
    if (!limits.canAddProduct) {
      await this.sendLimitReachedMessage(ctx, limits.totalSlots);
      return;
    }

    const loadingMsg = await ctx.reply("🔍 Зчитую сторінку, зачекайте...");

    try {
      const scraped = await this.scraperService.scrape(url);
      const item = await this.itemsService.addItem({
        userId: user.id,
        url,
        title: scraped.title,
        currentPrice: scraped.price,
        inStock: scraped.inStock,
      });

      await ctx.telegram
        .deleteMessage(ctx.chat!.id, loadingMsg.message_id)
        .catch(() => void 0);

      // ── Scout: show target price onboarding ──────────────────────────────
      if (limits.plan === 'SCOUT' && scraped.price !== null) {
        await this.sendTargetPriceSetup(ctx, item.id, scraped.price, scraped.title);
      } else {
        // BASE: standard confirmation
        await ctx.replyWithHTML(formatItemAdded(item, scraped), {
          reply_markup: itemInlineKeyboard(item.id, item.url),
        } as any);
      }

      // Referral reward on first item
      const itemCount = await this.itemsService.getItemCountForUser(user.id);
      if (
        itemCount === 1 &&
        user.referredById &&
        !user.isReferralBonusClaimed
      ) {
        await this.processReferralReward(ctx, user);
      }
    } catch (err) {
      await ctx.telegram
        .deleteMessage(ctx.chat!.id, loadingMsg.message_id)
        .catch(() => void 0);
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`processUrl failed: ${errMsg}`);
      await ctx.reply(`❌ ${this.getSafeErrorMessage(errMsg)}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: grant referral bonuses to both sides
  // ─────────────────────────────────────────────────────────────────────────
  private async processReferralReward(
    ctx: Context,
    newUser: User
  ): Promise<void> {
    try {
      await this.usersService.claimReferralBonus(newUser.id);
      await ctx.replyWithHTML(
        `🎁 <b>Бонус за запрошення!</b>\n\n` +
          `Вас запросив друг — ви отримуєте <b>+1 слот</b> до ліміту назавжди! 🙌`
      );

      if (!newUser.referredById) return;

      const referrer = await this.usersService.findByTelegramId(
        newUser.referredById
      );
      if (!referrer || referrer.referralCount >= MAX_REFERRAL_BONUSES) return;

      await this.usersService.rewardReferrer(referrer.id);

      await ctx.telegram.sendMessage(
        Number(referrer.telegramId),
        `🎉 <b>Ваш друг приєднався!</b>\n\n` +
          `Хтось скористався вашим реферальним посиланням і додав перший товар.\n` +
          `Ви отримуєте <b>+1 слот</b> до ліміту відстежень!\n\n` +
          `🤝 Запрошено: <b>${referrer.referralCount + 1} / ${MAX_REFERRAL_BONUSES}</b>`,
        { parse_mode: "HTML" }
      );

      this.logger.log(
        `Referral bonus granted: referrer_db=${referrer.id} ← new_db=${newUser.id}`
      );
    } catch (err) {
      this.logger.error(
        `processReferralReward failed: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  private async sendLimitReachedMessage(
    ctx: Context,
    totalSlots: number
  ): Promise<void> {
    const scoutLink = await ctx.telegram.createInvoiceLink({
      title: "Тариф «Скаут»",
      description: "15 слотів + перевірка щогодини + пріоритет",
      payload: "tier_scout",
      provider_token: "",
      currency: XTR_CURRENCY,
      prices: [{ label: "XTR", amount: PLAN_SCOUT_MONTHLY }],
      subscription_period: SUBSCRIPTION_PERIOD,
    } as any);

    const slotsLink = await ctx.telegram.createInvoiceLink({
      title: "Пакет «Економ»",
      description: "+3 додаткові слоти назавжди",
      payload: "pack_economy",
      provider_token: "",
      currency: XTR_CURRENCY,
      prices: [{ label: "XTR", amount: SLOTS_PACK_3 }],
    });

    await ctx.replyWithHTML(
      `⚠️ <b>Ліміт відстежень досягнуто!</b>\n\n` +
        `Ви вже відстежуєте ${totalSlots} ${pluralSlots(totalSlots)}. Щоб ми могли моніторити ціни для вас 24/7, оберіть зручний варіант розширення:\n\n` +
        `🔹 <b>Пакет «Економ» — 49 ⭐️</b>\n` +
        `(+3 додаткові слоти назавжди, перевірка раз на 12 годин).\n\n` +
        `🚀 <b>Тариф «Скаут» — 149 ⭐️/міс</b>\n` +
        `(15 слотів + перевірка кожні 6 годин + аналіз цін).\n\n` +
        `<i>Або запросіть друга через 👤 Профіль — отримайте +1 слот безкоштовно!</i>`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "➕ Додати +3 слоти (49 ⭐️)", url: slotsLink }],
            [{ text: "🚀 Пакет «Скаут» (149 ⭐️/міс)", url: scoutLink }],
          ],
        },
      } as any
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: Scout onboarding — target price selection after adding item
  // ─────────────────────────────────────────────────────────────────────────
  // ───────────────────────────────────────────────────────────────────────────
  // State TTL helpers — prevent memory leaks from abandoned wizard flows
  // ───────────────────────────────────────────────────────────────────────────

  private setAwaitingUrl(userId: number): void {
    this.awaitingUrl.set(userId, Date.now() + this.STATE_TTL_MS);
  }

  private hasAwaitingUrl(userId: number): boolean {
    const expiresAt = this.awaitingUrl.get(userId);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) { this.awaitingUrl.delete(userId); return false; }
    return true;
  }

  private deleteAwaitingUrl(userId: number): void {
    this.awaitingUrl.delete(userId);
  }

  private setAwaitingTargetPrice(userId: number, data: { itemId: number; currentPrice: number }): void {
    this.awaitingTargetPrice.set(userId, { ...data, expiresAt: Date.now() + this.STATE_TTL_MS });
  }

  private hasAwaitingTargetPrice(userId: number): boolean {
    const state = this.awaitingTargetPrice.get(userId);
    if (!state) return false;
    if (Date.now() > state.expiresAt) { this.awaitingTargetPrice.delete(userId); return false; }
    return true;
  }

  private getAwaitingTargetPrice(userId: number): { itemId: number; currentPrice: number } | undefined {
    const state = this.awaitingTargetPrice.get(userId);
    if (!state) return undefined;
    if (Date.now() > state.expiresAt) { this.awaitingTargetPrice.delete(userId); return undefined; }
    return { itemId: state.itemId, currentPrice: state.currentPrice };
  }

  private deleteAwaitingTargetPrice(userId: number): void {
    this.awaitingTargetPrice.delete(userId);
  }

  /** Purge entries that have passed their TTL. Runs every 10 minutes. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  cleanupExpiredStates(): void {
    const now = Date.now();
    for (const [userId, expiresAt] of this.awaitingUrl) {
      if (now > expiresAt) this.awaitingUrl.delete(userId);
    }
    for (const [userId, state] of this.awaitingTargetPrice) {
      if (now > state.expiresAt) this.awaitingTargetPrice.delete(userId);
    }
    // Also clean RateLimitService store
    this.rateLimitService.cleanup();
  }

  /**
   * Returns a safe, user-facing message — never exposes internal error details,
   * stack traces, HTTP status codes or external service responses.
   */
  private getSafeErrorMessage(internalMsg: string): string {
    if (internalMsg.includes('не підтримується')) {
      return 'Цей магазин поки не підтримується. Перегляньте список доступних у розділі Допомога.';
    }
    if (internalMsg.includes('timed out') || internalMsg.includes('ECONNABORTED') || internalMsg.includes('ENOTFOUND')) {
      return 'Сайт магазину не відповів вчасно. Спробуйте ще раз пізніше.';
    }
    if (internalMsg.includes('не знайдено товару')) {
      return 'За цим посиланням не знайдено товару. Переконайтесь, що це сторінка конкретного товару.';
    }
    if (internalMsg.includes('HTTP 4') || internalMsg.includes('HTTP 5')) {
      return 'Магазин тимчасово недоступний. Спробуйте пізніше.';
    }
    // Fallback — never expose raw internal messages to the user
    return 'Сталася помилка при обробці посилання. Спробуйте ще раз.';
  }

  private async sendTargetPriceSetup(
    ctx: Context,
    itemId: number,
    currentPrice: number,
    title: string,
  ): Promise<void> {
    const fmt = (n: number) => Math.round(n).toLocaleString('uk-UA');

    const p5  = Math.round(currentPrice * 0.95);
    const p10 = Math.round(currentPrice * 0.90);
    const p15 = Math.round(currentPrice * 0.85);

    await ctx.replyWithHTML(
      `✅ <b>Додано до відстеження!</b>\n\n` +
      `📦 <b>${title.slice(0, 60)}</b>\n` +
      `💰 Поточна ціна: <b>${fmt(currentPrice)} ₴</b>\n\n` +
      `Оскільки у вас активовано тариф <b>«Скаут»</b>, ви можете обрати,\n` +
      `коли саме надіслати сповіщення:`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: `📉 -5% (~${fmt(p5)} ₴)`,  callback_data: `target_pct:${itemId}:5`  },
              { text: `📉 -10% (~${fmt(p10)} ₴)`, callback_data: `target_pct:${itemId}:10` },
            ],
            [
              { text: `📉 -15% (~${fmt(p15)} ₴)`, callback_data: `target_pct:${itemId}:15` },
              { text: `✏️ Вказати свою ціну`,       callback_data: `target_custom:${itemId}` },
            ],
            [
              { text: `🔔 При будь-якій знижці`,    callback_data: `target_skip:${itemId}` },
            ],
          ],
        },
      } as any,
    );
  }
}
