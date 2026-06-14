import { Module } from '@nestjs/common';
import { SnipeService } from './snipe.service';
import { ItemsModule } from '../items/items.module';
import { ScraperModule } from '../scraper/scraper.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { AffiliateModule } from '../affiliate/affiliate.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [ItemsModule, ScraperModule, AnalysisModule, AffiliateModule, UsersModule],
  providers: [SnipeService],
})
export class SnipeModule {}
