import { Module } from '@nestjs/common';
import { BotUpdate } from './bot.update';
import { BotLauncherService } from './bot-launcher.service';
import { TestUiService } from './test-ui.service';
import { RateLimitService } from './rate-limit.service';
import { UsersModule } from '../users/users.module';
import { ItemsModule } from '../items/items.module';
import { ScraperModule } from '../scraper/scraper.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { AffiliateModule } from '../affiliate/affiliate.module';

@Module({
  imports: [UsersModule, ItemsModule, ScraperModule, AnalysisModule, AffiliateModule],
  providers: [BotUpdate, BotLauncherService, TestUiService, RateLimitService],
})
export class BotModule {}
