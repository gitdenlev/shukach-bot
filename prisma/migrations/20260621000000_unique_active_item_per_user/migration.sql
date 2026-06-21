-- Partial unique index: only one active tracked item per (userId, url).
-- Items that have been deleted (isActive = false) are excluded from the constraint,
-- allowing the same URL to be re-added after removal.
--
-- NOTE: Prisma does not support partial unique indexes in schema.prisma natively,
-- so this index is managed here as a raw SQL migration.
CREATE UNIQUE INDEX "tracked_items_userId_url_active_uq"
  ON "tracked_items" ("userId", "url")
  WHERE "isActive" = true;
