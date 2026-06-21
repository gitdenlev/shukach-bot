# Stage 1: Build stage
FROM node:20-slim AS builder

# Install OpenSSL (needed for Prisma client)
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency configs
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies (including devDependencies)
RUN npm ci

# Copy source code
COPY tsconfig*.json ./
COPY nest-cli.json ./
COPY src ./src/

# Generate Prisma Client
RUN npx prisma generate

# Build Nest.js application
RUN npm run build

# Prune development dependencies
RUN npm prune --production

# Stage 2: Production stage
FROM node:20-slim AS runner

# ── System deps: OpenSSL (Prisma) + Chromium system libraries (Playwright) ───
RUN apt-get update && apt-get install -y \
    openssl \
    # Chromium / Playwright dependencies
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libasound2 \
    libxrandr2 \
    libxdamage1 \
    libxfixes3 \
    libxcomposite1 \
    libxext6 \
    libx11-6 \
    libxcb1 \
    libxcursor1 \
    libxi6 \
    libxtst6 \
    fonts-liberation \
    libpango-1.0-0 \
    libcairo2 \
    wget \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy production node_modules and built app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma

# Download Playwright's Chromium binary into /app/.playwright-browsers
# (avoids writing to /root in a non-root container)
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers
RUN npx playwright install chromium --with-deps 2>/dev/null || true

EXPOSE 3000

# Set environment
ENV NODE_ENV=production

# Copy entrypoint script
COPY docker-entrypoint.sh /app/
RUN chmod +x /app/docker-entrypoint.sh

ENTRYPOINT ["/app/docker-entrypoint.sh"]
