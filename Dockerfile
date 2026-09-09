FROM node:24.12.0-alpine
WORKDIR /app
COPY --chown=node:node . .
ARG GRAPH_FILE=
ARG COMMUNITY_CONFIG=community.config.json
ENV GRAPH_FILE=${GRAPH_FILE} COMMUNITY_CONFIG=${COMMUNITY_CONFIG}
RUN node scripts/build.mjs && mkdir -p /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=4173 DATA_DIR=/data
EXPOSE 4173
CMD ["node", "server/main.mjs"]
