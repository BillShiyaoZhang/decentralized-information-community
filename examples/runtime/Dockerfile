FROM node:24.12.0-alpine
WORKDIR /community
COPY --chown=node:node . .
RUN npm install --offline --ignore-scripts --no-audit --no-fund && npm run build && mkdir -p .runtime && chown node:node .runtime
USER node
ENV HOST=0.0.0.0 PORT=4180
EXPOSE 4180
CMD ["npm", "start"]
