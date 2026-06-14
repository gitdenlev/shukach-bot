import { PriceAnalysisService, PricePoint } from './price-analysis.service';

/** Helper: build a price history array */
function history(prices: number[]): PricePoint[] {
  return prices.map((price, i) => ({
    price,
    createdAt: new Date(Date.now() - (prices.length - i) * 86_400_000),
  }));
}

describe('PriceAnalysisService', () => {
  let service: PriceAnalysisService;

  beforeEach(() => {
    service = new PriceAnalysisService();
  });

  // ── analyzePriceTrends ──────────────────────────────────────────────────────

  describe('analyzePriceTrends', () => {
    // ── real_discount ─────────────────────────────────────────────────────────

    describe('real_discount verdict', () => {
      it('should detect real discount: large drop, price at/near historical low', () => {
        // History shows stable prices around 10 000 — current 9 000 is a genuine new low
        const result = service.analyzePriceTrends(10000, 9000, history([10100, 10050, 10000, 9950]));
        expect(result.verdict).toBe('real_discount');
        expect(result.pctDrop).toBeCloseTo(10, 1);
        expect(result.verdictText).toContain('Чесна знижка');
      });

      it('should detect real discount with empty history (no data to contradict)', () => {
        // No history → cannot detect artificial increase → fall through to real_discount
        const result = service.analyzePriceTrends(10000, 9000, []);
        expect(result.verdict).toBe('real_discount');
      });

      it('should detect real discount for exactly 5% drop (minimum threshold)', () => {
        // 5% is exactly the REAL_DISCOUNT_MIN_PCT boundary
        const result = service.analyzePriceTrends(10000, 9500, history([10100, 10000, 9900]));
        expect(result.verdict).toBe('real_discount');
        expect(result.pctDrop).toBeCloseTo(5, 1);
      });
    });

    // ── marketing_move ────────────────────────────────────────────────────────

    describe('marketing_move verdict', () => {
      it('should detect marketing move: drop is less than 2.5%', () => {
        const result = service.analyzePriceTrends(10000, 9800, history([10000, 10100]));
        expect(result.verdict).toBe('marketing_move');
        expect(result.pctDrop).toBeCloseTo(2, 1);
        expect(result.verdictText).toContain('Маркетинговий');
      });

      it('should detect marketing move for tiny 0.5% drop', () => {
        const result = service.analyzePriceTrends(10000, 9950, history([10000]));
        expect(result.verdict).toBe('marketing_move');
      });

      it('should detect marketing move for exactly 0% change', () => {
        const result = service.analyzePriceTrends(10000, 10000, []);
        expect(result.verdict).toBe('marketing_move');
      });

      it('should detect marketing move: drop 3% (between 2.5% and 5% thresholds)', () => {
        // 3% is > marketing threshold but < real_discount threshold — still marketing_move as fallback
        const result = service.analyzePriceTrends(10000, 9700, history([10000, 9800]));
        expect(result.verdict).toBe('marketing_move');
      });
    });

    // ── artificial_increase ───────────────────────────────────────────────────

    describe('artificial_increase verdict', () => {
      it('should detect artificial increase: price bumped before sale, current still above histMin*1.05', () => {
        // History shows item was at 18 000 before price was pumped to 22 000
        // Current "sale" price 20 500 > 18 000 * 1.05 = 18 900 → artificial
        const result = service.analyzePriceTrends(22000, 20500, history([18000, 17800, 18200, 22000]));
        expect(result.verdict).toBe('artificial_increase');
        expect(result.verdictText).toContain('Штучне завищення');
      });

      it('should NOT detect artificial increase if current price is at/below histMin*1.05', () => {
        // History min = 18 000, threshold = 18 900. Current = 18 500 < 18 900 → real_discount
        const result = service.analyzePriceTrends(22000, 18500, history([18000, 19000, 22000]));
        expect(result.verdict).toBe('real_discount');
      });

      it('should NOT detect artificial increase with empty history', () => {
        // No history to compare → cannot fire artificial_increase
        const result = service.analyzePriceTrends(22000, 20500, []);
        // Drop = 6.8% >= 5% → real_discount
        expect(result.verdict).toBe('real_discount');
      });
    });

    // ── pctDrop calculation ───────────────────────────────────────────────────

    describe('pctDrop calculation', () => {
      it('should calculate correct percentage for a 50% drop', () => {
        const result = service.analyzePriceTrends(10000, 5000, []);
        expect(result.pctDrop).toBeCloseTo(50, 1);
      });

      it('should return all three verdict types from a single service instance', () => {
        const marketing = service.analyzePriceTrends(10000, 9900, []);
        const real      = service.analyzePriceTrends(10000, 9000, []);
        const artificial = service.analyzePriceTrends(22000, 20500, history([18000]));

        expect(marketing.verdict).toBe('marketing_move');
        expect(real.verdict).toBe('real_discount');
        expect(artificial.verdict).toBe('artificial_increase');
      });
    });

    // ── verdictText ───────────────────────────────────────────────────────────

    describe('verdictText content', () => {
      it('real_discount should mention historical minimum', () => {
        const { verdictText } = service.analyzePriceTrends(10000, 9000, []);
        expect(verdictText).toContain('мінімум');
      });

      it('marketing_move should mention insignificant drop', () => {
        const { verdictText } = service.analyzePriceTrends(10000, 9900, []);
        expect(verdictText).toContain('незначно');
      });

      it('artificial_increase should mention price was raised before sale', () => {
        const { verdictText } = service.analyzePriceTrends(22000, 20500, history([18000]));
        expect(verdictText).toContain('перед акцією');
      });
    });
  });

  // ── getPriceVerdict (deprecated wrapper) ────────────────────────────────────

  describe('getPriceVerdict (backward-compat wrapper)', () => {
    it('should return real_discount for a significant drop with no history', () => {
      const result = service.getPriceVerdict(9000, 10000, null);
      expect(result.verdict).toBe('real_discount');
      expect(result.pctDrop).toBeCloseTo(10, 1);
    });

    it('should return marketing_move for a tiny drop', () => {
      const result = service.getPriceVerdict(9950, 10000, null);
      expect(result.verdict).toBe('marketing_move');
    });

    it('should detect artificial_increase via synthetic one-point history', () => {
      // olderPrice = 18000 → passed as single history point
      // current = 20500 > 18000*1.05 = 18900 → artificial_increase
      const result = service.getPriceVerdict(20500, 22000, 18000);
      expect(result.verdict).toBe('artificial_increase');
    });

    it('should always return an object with verdictText', () => {
      const result = service.getPriceVerdict(9000, 10000, null);
      expect(result.verdictText).toBeTruthy();
      expect(typeof result.verdictText).toBe('string');
    });

    it('should calculate correct pctDrop for a 50% drop', () => {
      const result = service.getPriceVerdict(5000, 10000, null);
      expect(result.pctDrop).toBeCloseTo(50, 1);
    });
  });
});
