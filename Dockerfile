FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg tini ca-certificates python3 python3-numpy \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node prototype/ ./prototype/
COPY --chown=node:node tools/preview.mjs tools/media.mjs tools/jobs.mjs ./tools/
COPY --chown=node:node worker/longform_transcribe.py ./worker/
COPY --chown=node:node worker/asr ./worker/asr/
RUN mkdir -p /app/.local-media && chown node:node /app/.local-media /app/worker
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173 TRANSCRIBE_BACKEND=auto PYTHON=python3
USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "tools/preview.mjs"]
