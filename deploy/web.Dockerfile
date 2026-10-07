# The studio's web app: pages, API, previews and uploads. No ffmpeg, no Chrome, no provider keys.
# Build context: the repository root.
FROM node:26-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run web:build
ENV NODE_ENV=production
WORKDIR /app/web
EXPOSE 3131
# 0.0.0.0 inside the Compose network only: the port is not published, and the proxy is the one way in
CMD ["node", "/app/node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3131"]
