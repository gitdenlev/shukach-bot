import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { TelegrafModule } from "nestjs-telegraf";
import { PrismaModule } from "./prisma/prisma.module";
import { UsersModule } from "./users/users.module";
import { ItemsModule } from "./items/items.module";
import { ScraperModule } from "./scraper/scraper.module";
import { BotModule } from "./bot/bot.module";
import { SnipeModule } from "./snipe/snipe.module";

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN environment variable is not set");
}

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TelegrafModule.forRoot({
      token: process.env.TELEGRAM_BOT_TOKEN,
      launchOptions: false,
    }),
    PrismaModule,
    UsersModule,
    ItemsModule,
    ScraperModule,
    BotModule,
    SnipeModule,
  ],
})
export class AppModule {}
