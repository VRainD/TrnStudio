FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg tini ca-certificates python3 python3-numpy \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node prototype/ ./prototype/
COPY --chown=node:node tools/preview.mjs tools/media.mjs tools/jobs.mjs ./tools/
COPY --chown=node:node tools/billing ./tools/billing/
COPY --chown=node:node tools/auth ./tools/auth/
COPY --chown=node:node tools/clickhouse ./tools/clickhouse/
COPY --chown=node:node clickhouse/schema.sql ./clickhouse/schema.sql
COPY --chown=node:node worker/longform_transcribe.py ./worker/
COPY --chown=node:node worker/asr ./worker/asr/
RUN mkdir -p /app/.local-media /app/.local-billing /app/.local-auth \
    && chown node:node /app/.local-media /app/.local-billing /app/.local-auth /app/worker
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173 TRANSCRIBE_BACKEND=auto PYTHON=python3 \
    BILLING_ENABLED=false PAYMENT_DRIVER=stub AUTH_DEMO_SEED=false \
    CLICKHOUSE_ENABLED=true CLICKHOUSE_URL=http://clickhouse:8123 CLICKHOUSE_DATABASE=gorizont
USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "tools/preview.mjs"]
