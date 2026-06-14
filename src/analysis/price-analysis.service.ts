import { Injectable, Logger } from '@nestjs/common';

export type PriceVerdict = 'real_discount' | 'marketing_move' | 'artificial_increase';

export interface PriceAnalysis {
  verdict: PriceVerdict;
  pctDrop: number;
  verdictText: string;
}

export interface PricePoint {
  price: number;
  createdAt: Date;
}

const MARKETING_MOVE_MAX_PCT   = 2.5;  // < 2.5% drop → marketing move
const REAL_DISCOUNT_MIN_PCT    = 5.0;  // ≥ 5% drop → candidate for real discount
const ARTIFICIAL_BUMP_PCT      = 5.0;  // current > histMin * (1 + 5%) → price was inflated

const VERDICT_TEXTS: Record<PriceVerdict, string> = {
  real_discount:
    '✅ Чесна знижка. Товар досяг свого історичного мінімуму за час моніторингу. Можна брати!',
  marketing_move:
    '⚠️ Маркетинговий хід. Ціна знизилася незначно, раніше пропозиція була вигіднішою.',
  artificial_increase:
    '❌ Штучне завищення. Ціна була піднята безпосередньо перед акцією, фактична вигода мінімальна.',
};

@Injectable()
export class PriceAnalysisService {
  private readonly logger = new Logger(PriceAnalysisService.name);

  /**
   * Full algorithmic analysis based on 14-30 day price history.
   * Used exclusively for Scout (Premium) users.
   *
   * @param oldPrice     — price before the drop (stored in TrackedItem.currentPrice)
   * @param currentPrice — new (lower) scraped price
   * @param priceHistory — ordered list of price snapshots from PriceHistory table
   */
  analyzePriceTrends(
    oldPrice: number,
    currentPrice: number,
    priceHistory: PricePoint[],
  ): PriceAnalysis {
    try {
      const pctDrop = ((oldPrice - currentPrice) / oldPrice) * 100;

      // ── A) Marketing move: drop is too small to matter ─────────────────────
      if (pctDrop < MARKETING_MOVE_MAX_PCT) {
        return this.result('marketing_move', pctDrop);
      }

      // ── B) Artificial increase: price was bumped before this "discount" ────
      if (priceHistory.length > 0) {
        const historicalMin = Math.min(...priceHistory.map((p) => p.price));
        const thresholdAboveMin = historicalMin * (1 + ARTIFICIAL_BUMP_PCT / 100);

        if (currentPrice > thresholdAboveMin) {
          this.logger.debug(
            `Artificial increase detected: currentPrice=${currentPrice} > histMin=${historicalMin} * 1.05=${thresholdAboveMin.toFixed(0)}`,
          );
          return this.result('artificial_increase', pctDrop);
        }
      }

      // ── C) Real discount: significant drop and at/near historical minimum ──
      if (pctDrop >= REAL_DISCOUNT_MIN_PCT) {
        return this.result('real_discount', pctDrop);
      }

      // ── Fallback: borderline — treat as marketing move ─────────────────────
      return this.result('marketing_move', pctDrop);
    } catch (err) {
      this.logger.error(
        `analyzePriceTrends failed: ${err instanceof Error ? err.message : err}`,
      );
      // Return neutral fallback so a broken analysis never blocks a notification
      return this.result('marketing_move', 0);
    }
  }

  /**
   * @deprecated Use analyzePriceTrends with real price history instead.
   * Kept for backward compatibility with tests and non-production code.
   */
  getPriceVerdict(
    currentPrice: number,
    oldPrice: number,
    olderPrice?: number | null,
  ): PriceAnalysis {
    const syntheticHistory: PricePoint[] = olderPrice != null
      ? [{ price: olderPrice, createdAt: new Date() }]
      : [];

    return this.analyzePriceTrends(oldPrice, currentPrice, syntheticHistory);
  }

  private result(verdict: PriceVerdict, pctDrop: number): PriceAnalysis {
    return { verdict, pctDrop, verdictText: VERDICT_TEXTS[verdict] };
  }
}
