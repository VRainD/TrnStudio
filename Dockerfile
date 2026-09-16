FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node prototype/ ./prototype/
COPY --chown=node:node tools/preview.mjs tools/media.mjs ./tools/
RUN mkdir -p /app/.local-media && chown node:node /app/.local-media
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173
USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "tools/preview.mjs"]
