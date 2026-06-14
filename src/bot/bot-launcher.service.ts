import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';

const INITIAL_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;

@Injectable()
export class BotLauncherService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(BotLauncherService.name);
  private isShuttingDown = false;

  constructor(@InjectBot() private readonly bot: Telegraf) {}

  onApplicationBootstrap(): void {
    void this.launchWithRetry();
  }

  onApplicationShutdown(signal?: string): void {
    this.isShuttingDown = true;

    try {
      this.bot.stop(signal ?? 'SIGTERM');
    } catch (err) {
      this.logger.warn(
        `Telegram bot stop skipped: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async launchWithRetry(): Promise<void> {
    let retryDelayMs = INITIAL_RETRY_DELAY_MS;

    while (!this.isShuttingDown) {
      try {
        this.logger.log('Starting Telegram bot polling...');
        await this.bot.launch();

        if (!this.isShuttingDown) {
          this.logger.warn('Telegram bot polling stopped unexpectedly.');
        }
      } catch (err) {
        if (this.isShuttingDown) {
          return;
        }

        this.logger.error(
          `Telegram bot launch failed: ${err instanceof Error ? err.message : err}`,
        );
      }

      if (!this.isShuttingDown) {
        this.logger.warn(`Retrying Telegram bot launch in ${retryDelayMs / 1000}s...`);
        await sleep(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
