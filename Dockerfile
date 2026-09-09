FROM node:24.12.0-alpine
WORKDIR /app
COPY --chown=node:node . .
RUN node scripts/build.mjs && mkdir -p /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=4173 DATA_DIR=/data
EXPOSE 4173
CMD ["node", "server/main.mjs"]
