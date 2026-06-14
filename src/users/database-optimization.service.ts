import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UsersService } from './users.service';

@Injectable()
export class DatabaseOptimizationService {
  private readonly logger = new Logger(DatabaseOptimizationService.name);

  constructor(private readonly usersService: UsersService) {}

  /**
   * Runs every Sunday at 03:00 UTC.
   * Permanently deletes user profiles (and all their data via CASCADE) that
   * had no activity for more than 12 months.
   */
  @Cron('0 3 * * 0') // Sunday 03:00 UTC
  async pruneInactiveUsers(): Promise<void> {
    this.logger.log('🧹 [DB Optimization] Starting inactive user cleanup...');

    try {
      const deleted = await this.usersService.deleteInactiveUsers(12);

      if (deleted === 0) {
        this.logger.log('🧹 [DB Optimization] No inactive profiles found. Nothing to delete.');
      } else {
        this.logger.warn(
          `🧹 [DB Optimization] Deleted ${deleted} inactive profile(s) (no activity for 12+ months).`,
        );
      }
    } catch (err) {
      this.logger.error(
        `🧹 [DB Optimization] Cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
