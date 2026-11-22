ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /app
COPY --chown=node:node package.json server.mjs store.mjs telegram.mjs region.mjs governance.mjs ecosystem.mjs operator.mjs ./
COPY --chown=node:node public ./public
RUN install -d -m 0700 -o node -g node /data && touch /data/.cezeos && chown node:node /data/.cezeos
ENV NODE_ENV=production CEZEOS_BIND=0.0.0.0 CEZEOS_DATA_DIR=/data CEZEOS_PORT=4173
USER node
EXPOSE 4173
CMD ["node", "server.mjs"]
