# Live mode image: Socket Mode for Slack (no inbound Slack traffic needed),
# plus the webhook and health endpoints on port 3000.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

RUN mkdir -p /data && chown node:node /data
USER node

ENV MODE=live HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/data/copilot.db
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
