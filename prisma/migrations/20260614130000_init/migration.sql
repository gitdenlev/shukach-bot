-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('BASE', 'SCOUT');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "plan" "Plan" NOT NULL DEFAULT 'BASE',
    "extraSlots" INTEGER NOT NULL DEFAULT 0,
    "subscriptionExpiresAt" TIMESTAMP(3),
    "telegramSubscriptionId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "referredById" BIGINT,
    "referralCount" INTEGER NOT NULL DEFAULT 0,
    "isReferralBonusClaimed" BOOLEAN NOT NULL DEFAULT false,
    "totalPotentialSavings" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracked_items" (
    "id" SERIAL NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "currentPrice" DOUBLE PRECISION,
    "previousPrice" DOUBLE PRECISION,
    "initialPrice" DOUBLE PRECISION,
    "lowestPrice" DOUBLE PRECISION,
    "targetPrice" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'UAH',
    "inStock" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isFrozen" BOOLEAN NOT NULL DEFAULT false,
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkIntervalMinutes" INTEGER NOT NULL DEFAULT 720,
    "consecutiveErrors" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" INTEGER NOT NULL,

    CONSTRAINT "tracked_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_history" (
    "id" SERIAL NOT NULL,
    "itemId" INTEGER NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegramId_key" ON "users"("telegramId");

-- CreateIndex
CREATE INDEX "users_lastActivityAt_idx" ON "users"("lastActivityAt");

-- CreateIndex
CREATE INDEX "users_plan_idx" ON "users"("plan");

-- CreateIndex
CREATE INDEX "tracked_items_userId_idx" ON "tracked_items"("userId");

-- CreateIndex
CREATE INDEX "tracked_items_isActive_idx" ON "tracked_items"("isActive");

-- CreateIndex
CREATE INDEX "tracked_items_isActive_isFrozen_idx" ON "tracked_items"("isActive", "isFrozen");

-- CreateIndex
CREATE INDEX "price_history_itemId_createdAt_idx" ON "price_history"("itemId", "createdAt");

-- AddForeignKey
ALTER TABLE "tracked_items" ADD CONSTRAINT "tracked_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "tracked_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
