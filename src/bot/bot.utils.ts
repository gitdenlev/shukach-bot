import { TrackedItem } from '@prisma/client';
import { ScrapeResult } from '../scraper/scraper.types';
import { PriceAnalysis } from '../analysis/price-analysis.service';

export function itemInlineKeyboard(itemId: number, url: string) {
  return {
    inline_keyboard: [
      [
        { text: '🔗 Відкрити сайт', url },
        { text: '❌ Видалити', callback_data: `delete_item:${itemId}` },
      ],
    ],
  };
}

export function formatItemAdded(item: TrackedItem, scraped: ScrapeResult): string {
  const priceStr = scraped.price !== null
    ? `<b>${scraped.price.toLocaleString('uk-UA')} ${currency(scraped.currency)}</b>`
    : '<i>ціна не знайдена</i>';

  const stockStr = scraped.inStock ? '✅ В наявності' : '❌ Немає в наявності';

  return (
    `✅ <b>Додано до відстеження!</b>\n\n` +
    `📦 <b>Назва:</b> ${escapeHtml(item.title)}\n` +
    `💰 <b>Ціна:</b> ${priceStr}\n` +
    `🏪 <b>Магазин:</b> ${extractStore(item.url)}\n` +
    `📊 <b>Статус:</b> ${stockStr}\n\n` +
    `<i>Сповіщу коли ціна впаде або товар з'явиться.</i>`
  );
}

export function formatItemCard(item: TrackedItem): string {
  const priceStr = item.currentPrice !== null
    ? `${item.currentPrice.toLocaleString('uk-UA')} ${currency(item.currency)}`
    : '<i>не визначена</i>';

  const stockStr = item.inStock ? '✅ В наявності' : '❌ Немає в наявності';

  return (
    `📦 <b>Назва:</b> ${escapeHtml(truncate(item.title, 60))}\n` +
    `💰 <b>Ціна:</b> ${priceStr}\n` +
    `🏪 <b>Магазин:</b> ${extractStore(item.url)}\n` +
    `📊 <b>Статус:</b> ${stockStr}\n` +
    `🕐 <i>Перевірено: ${formatDate(item.lastCheckedAt)}</i>`
  );
}

export function formatItemList(items: TrackedItem[], maxItems: string | number = 3): string {
  const header = `📋 <b>Ваші товари (${items.length}/${maxItems}):</b>`;
  const lines = items.map((item) => formatItemCard(item));
  return header + '\n\n' + lines.join('\n\n──────────────────\n\n');
}

export function formatItemDeleted(item: TrackedItem): string {
  return (
    `🗑 <b>Видалено з відстеження</b>\n\n` +
    `📦 ${escapeHtml(item.title)}\n` +
    `🏪 ${extractStore(item.url)}`
  );
}

export function formatPriceDropAlert(
  item: TrackedItem,
  oldPrice: number,
  newPrice: number,
  analysis?: PriceAnalysis,
): string {
  const diff = oldPrice - newPrice;
  const pct = ((diff / oldPrice) * 100).toFixed(1);

  let msg =
    `🔥 <b>Ціна впала!</b>\n\n` +
    `📦 <b>${escapeHtml(truncate(item.title, 60))}</b>\n\n` +
    `<s>${oldPrice.toLocaleString('uk-UA')} ${currency(item.currency)}</s>  →  <b>${newPrice.toLocaleString('uk-UA')} ${currency(item.currency)}</b>\n` +
    `📉 -${diff.toLocaleString('uk-UA')} ${currency(item.currency)} (-${pct}%)`;

  if (analysis) {
    msg += `\n\n${formatPriceAnalysis(analysis)}`;
  }

  return msg;
}

export function formatBackInStockAlert(item: TrackedItem): string {
  const priceStr = item.currentPrice !== null
    ? `${item.currentPrice.toLocaleString('uk-UA')} ${currency(item.currency)}`
    : 'не вказана';

  return (
    `🎉 <b>Товар знову в наявності!</b>\n\n` +
    `📦 <b>${escapeHtml(truncate(item.title, 60))}</b>\n` +
    `💰 ${priceStr}`
  );
}

export function formatPriceAnalysis(analysis: PriceAnalysis): string {
  return `⚖️ <b>Аналіз пропозиції:</b>\n${analysis.verdictText}`;
}


export interface NearbyStore {
  address: string;
  distanceMeters: number;
  isClosestOverall: boolean;
  mapsUrl: string;
}

export function formatStoreLocation(store: NearbyStore): string {
  const dist = store.distanceMeters < 1000
    ? `${store.distanceMeters} м`
    : `${(store.distanceMeters / 1000).toFixed(1)} км`;

  return `📍 <b>Найближчий магазин:</b> ${store.address} (${dist})`;
}

export function formatReservationAdvice(store: NearbyStore): string {
  if (store.isClosestOverall) {
    return `💡 <i>Порада: Товар є в наявності зовсім поруч! Найшвидший варіант — зарезервувати та забрати самостійно.</i>`;
  }
  return '';
}

const STORE_NAMES: Record<string, string> = {
  'rozetka.com.ua': 'Rozetka',
  'brain.com.ua': 'Brain',
  'allo.ua': 'Allo',
  'moyo.ua': 'Moyo',
  'epicentrk.ua': 'Епіцентр',
  'comfy.ua': 'Comfy',
  'foxtrot.com.ua': 'Foxtrot',
  'mau.com.ua': 'Mau',
  'eldorado.ua': 'Eldorado',
};

export function extractStore(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return STORE_NAMES[hostname] ?? hostname;
  } catch {
    return url;
  }
}

function currency(c: string): string {
  return c === 'UAH' ? '₴' : c;
}

export function formatCurrency(value: number, currencyCode: string = 'UAH'): string {
  return `${value.toLocaleString('uk-UA', { maximumFractionDigits: 0 })} ${currency(currencyCode)}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function formatDate(date: Date): string {
  return date.toLocaleString('uk-UA', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export interface NotificationKeyboardOptions {
  /** Affiliate-wrapped (or fallback direct) product URL for the buy button. */
  affiliateUrl: string;
  store?: NearbyStore;
}

/**
 * Builds the inline keyboard for a price-drop / back-in-stock notification.
 */
export function buildNotificationKeyboard(options: NotificationKeyboardOptions) {
  const buttons = [
    [{ text: '🛒 Замовити з доставкою', url: options.affiliateUrl }],
  ];

  if (options.store) {
    buttons.unshift([{ text: '🏃 Забронювати в магазині', url: options.store.mapsUrl }]);
  }

  return {
    inline_keyboard: buttons,
  };
}
