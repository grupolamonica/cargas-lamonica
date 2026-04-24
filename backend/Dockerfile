# ── Stage 1: Build (install prod dependencies) ────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Copy manifests first for layer caching
COPY package.json package-lock.json ./

# Install production dependencies only (no devDeps: vitest, pg-mem, @types/node)
RUN npm ci --omit=dev

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# Install curl for HEALTHCHECK (node:22-slim is Debian-based, use apt)
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy prod node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application source and manifest
COPY src ./src
COPY package.json ./

# Use the built-in "node" user (uid 1000, gid 1000) — present in node:22-slim
# Do NOT create a new user; the node image already ships with "node"
RUN chown -R node:node /app

USER node

# Backend port per D-07 — must match vite.config.ts proxy target and main.js default
EXPOSE 3001

# Explicit ENV so tooling can introspect; main.js also reads process.env.PORT
ENV PORT=3001 \
    NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fs http://localhost:3001/health || exit 1

# ESM module — node src/main.js is correct (no --input-type flag needed with package.json "type":"module")
CMD ["node", "src/main.js"]
