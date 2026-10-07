# The studio's worker: takes jobs off the queue and runs the CLI for each. The one image with ffmpeg, the
# browser Remotion renders with, and (at run time, through its environment) the provider keys.
# Build context: the repository root.
FROM mwader/static-ffmpeg:8.1 AS ffmpeg

FROM node:25-bookworm-slim
# procps: the job runner reads a process's start time with `ps`. The rest is what headless Chrome links against.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates procps fonts-liberation \
      libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libgbm1 libasound2 libxrandr2 libxkbcommon0 \
      libxfixes3 libxcomposite1 libxdamage1 libpango-1.0-0 libcairo2 libcups2 \
    && rm -rf /var/lib/apt/lists/*
# the pipeline's filters are tested against ffmpeg 8; Debian's own package is older
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
RUN npm ci
# fetch the browser now, so the first render does not download it
RUN node -e "import('@remotion/renderer').then((r) => r.ensureBrowser())"
COPY . .
WORKDIR /app/web
CMD ["node", "--import", "tsx", "worker/main.ts"]
