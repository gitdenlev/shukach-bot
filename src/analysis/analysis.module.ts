import { Module } from '@nestjs/common';
import { PriceAnalysisService } from './price-analysis.service';

@Module({
  providers: [PriceAnalysisService],
  exports: [PriceAnalysisService],
})
export class AnalysisModule {}
