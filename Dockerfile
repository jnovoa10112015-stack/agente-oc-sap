ARG BUN_VERSION=1.4.4
FROM oven/bun:${BUN_VERSION}-slim AS base
WORKDIR /app

FROM base AS dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production PORT=8080
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun web ./web
COPY --chown=bun:bun fixtures ./fixtures
RUN mkdir -p /app/out && chown bun:bun /app/out
USER bun
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD bun -e 'const r = await fetch(`http://127.0.0.1:${process.env.PORT}/api/live`); process.exit(r.ok ? 0 : 1)'
CMD ["bun", "src/server.ts"]
