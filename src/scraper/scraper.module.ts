import { Module } from '@nestjs/common';
import { ScraperService } from './scraper.service';
import { BrowserScraperService } from './browser-scraper.service';

@Module({
  providers: [ScraperService, BrowserScraperService],
  exports: [ScraperService],
})
export class ScraperModule {}
