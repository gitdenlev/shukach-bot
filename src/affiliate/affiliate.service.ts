import { Injectable, Logger } from '@nestjs/common';

const HOSTNAME_TO_ENV_KEY: Record<string, string> = {
  'rozetka.com.ua':  'AFFILIATE_LINK_PREFIX_ROZETKA',
  'brain.com.ua':    'AFFILIATE_LINK_PREFIX_BRAIN',
  'allo.ua':         'AFFILIATE_LINK_PREFIX_ALLO',
  'moyo.ua':         'AFFILIATE_LINK_PREFIX_MOYO',
  'epicentrk.ua':    'AFFILIATE_LINK_PREFIX_EPICENTR',
  'comfy.ua':        'AFFILIATE_LINK_PREFIX_COMFY',
  'foxtrot.com.ua':  'AFFILIATE_LINK_PREFIX_FOXTROT',
  'eldorado.ua':     'AFFILIATE_LINK_PREFIX_ELDORADO',
};

@Injectable()
export class AffiliateService {
  private readonly logger = new Logger(AffiliateService.name);

  wrap(productUrl: string, userId?: number | bigint): string {
    try {
      const hostname = new URL(productUrl).hostname.replace(/^www\./, '');
      const envKey   = HOSTNAME_TO_ENV_KEY[hostname];

      if (!envKey) {
        this.logger.debug(`No affiliate mapping for host: ${hostname}`);
        return productUrl;
      }

      const prefix = process.env[envKey];
      if (!prefix) {
        this.logger.debug(`${envKey} is not configured — using direct URL`);
        return productUrl;
      }

      const encodedUrl = encodeURIComponent(productUrl);
      const subidParam = userId ? `&subid=${userId}` : '';

      return `${prefix}${encodedUrl}${subidParam}`;
    } catch {
      return productUrl;
    }
  }

  hasAffiliate(productUrl: string): boolean {
    try {
      const hostname = new URL(productUrl).hostname.replace(/^www\./, '');
      const envKey   = HOSTNAME_TO_ENV_KEY[hostname];
      return !!(envKey && process.env[envKey]);
    } catch {
      return false;
    }
  }
}
