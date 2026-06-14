import { Injectable } from '@nestjs/common';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * Simple in-memory sliding-window rate limiter.
 *
 * Two tiers:
 *  • 'default' — generic messages / button taps  (20 req / 60 s)
 *  • 'scrape'  — URL-add requests that hit external stores (5 req / 60 s)
 *
 * The store is cleaned up lazily on every isAllowed() call for that user,
 * so expired entries are never kept longer than one extra window.
 */
@Injectable()
export class RateLimitService {
  private readonly store = new Map<string, RateLimitEntry>();

  private readonly WINDOW_MS = 60_000; // 1 minute

  private readonly LIMITS: Record<'default' | 'scrape', number> = {
    default: 20,
    scrape: 5,
  };

  isAllowed(userId: number, type: 'default' | 'scrape' = 'default'): boolean {
    const key = `${type}:${userId}`;
    const now = Date.now();
    const limit = this.LIMITS[type];

    const entry = this.store.get(key);

    // First request or window has expired — reset counter
    if (!entry || now > entry.resetAt) {
      this.store.set(key, { count: 1, resetAt: now + this.WINDOW_MS });
      return true;
    }

    if (entry.count >= limit) return false;

    entry.count++;
    return true;
  }

  /**
   * Purge all expired entries.
   * Call periodically (e.g. from a @Cron) to prevent unbounded growth.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.resetAt) this.store.delete(key);
    }
  }
}
