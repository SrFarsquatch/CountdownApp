FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
COPY package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./server.js
COPY updater.js ./updater.js
COPY casaos-update.js ./casaos-update.js
COPY public ./public
COPY eink ./eink

RUN mkdir -p /data && chown -R node:node /app /data

# The app needs access to the mounted Docker socket for the in-app updater.
# Docker socket access is already host-equivalent, so run as root to avoid host docker-group GID mismatches.
USER root
VOLUME ["/data"]
EXPOSE 8080

CMD ["node", "server.js"]
