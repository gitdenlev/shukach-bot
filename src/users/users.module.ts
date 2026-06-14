import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { DatabaseOptimizationService } from './database-optimization.service';

@Module({
  providers: [UsersService, DatabaseOptimizationService],
  exports: [UsersService],
})
export class UsersModule {}
