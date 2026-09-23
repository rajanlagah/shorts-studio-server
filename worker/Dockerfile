FROM node:22-bookworm-slim
# Caption fonts are bundled in ./fonts (passed to libass via fontsdir);
# fonts-noto-core stays as the glyph fallback for non-Latin scripts.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-core ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY fonts ./fonts
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "src/index.js"]
