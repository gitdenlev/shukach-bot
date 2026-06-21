const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  // Google / UTM campaign tags
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  // Google Ads click ID
  'gclid',
  'gad_source',
  // Facebook / Meta click ID
  'fbclid',
  // Microsoft / Bing Ads
  'msclkid',
  // Yandex Ads
  'yclid',
  // LinkedIn insight tag
  'li_fat_id',
  // Twitter / X click ID
  'twclid',
  // TikTok click ID
  'ttclid',
  // Pinterest
  'epik',
  // HubSpot
  '_hsenc',
  '_hsmi',
  '__hssc',
  '__hstc',
  '__hsfp',
  'hsCtaTracking',
  // Mailchimp
  'mc_cid',
  'mc_eid',
  // Marketo
  'mkt_tok',
  // Generic redirect / referral tokens (safe to strip)
  'ref',
  'referral',
  'affiliate',
  'partner',
]);

/**
 * Normalize a URL before storage and duplicate checking.
 *
 * Rules applied (all non-destructive to product identity):
 *  1. Lower-case the hostname (hostnames are case-insensitive per RFC 3986).
 *  2. Remove the URL fragment (`#section`), which is client-only.
 *  3. Remove known tracking query parameters.
 *  4. Sort remaining query parameters for canonical ordering.
 *  5. Remove a trailing slash from the pathname when there are no query params
 *     and the path is not just "/" (avoids changing root URLs).
 *
 * The function does NOT:
 *  - Change the path structure (preserves product slugs / IDs).
 *  - Lower-case the path or query values (some stores use case-sensitive IDs).
 *  - Force https (protocol is left as-is; scraper validation handles security).
 *
 * @param rawUrl A syntactically valid URL string (pre-validated by `new URL()`).
 * @returns The normalised URL string, or the original string if parsing fails.
 */
export function normalizeUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Caller is responsible for validating URLs; return unchanged on failure.
    return rawUrl;
  }

  // 1. Lower-case hostname.
  parsed.hostname = parsed.hostname.toLowerCase();

  // 2. Remove fragment — always client-side, never relevant to product identity.
  parsed.hash = '';

  // 3. Strip tracking query params.
  const keysToDelete: string[] = [];
  for (const key of parsed.searchParams.keys()) {
    if (
      TRACKING_PARAMS.has(key) ||
      // Also strip any key that starts with utm_ (forward-compatible)
      key.toLowerCase().startsWith('utm_')
    ) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    parsed.searchParams.delete(key);
  }

  // 4. Sort remaining params for stable canonical form.
  parsed.searchParams.sort();

  // 5. Remove trailing slash from non-root paths with no remaining query string.
  if (
    parsed.pathname.length > 1 &&
    parsed.pathname.endsWith('/') &&
    parsed.search === ''
  ) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }

  return parsed.toString();
}
