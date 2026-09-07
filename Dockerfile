FROM oven/bun:1.3.9-debian AS web-build

WORKDIR /app

COPY package.json bun.lock bunfig.toml /app/
COPY web/package.json /app/web/package.json
RUN bun install --frozen-lockfile

COPY web /app/web
RUN bun run build:web

FROM oven/bun:1.3.9-debian

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg file jpegoptim libimage-exiftool-perl optipng util-linux webp \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 sago-media \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin sago-media

WORKDIR /app

COPY --chmod=755 scripts/sago-media-optimize /usr/local/bin/sago-media-optimize
COPY --chmod=755 scripts/sago-media-pin /usr/local/bin/sago-media-pin
COPY --chmod=755 scripts/sago-media-prune /usr/local/bin/sago-media-prune
COPY --chmod=755 scripts/sago-media-upload /usr/local/bin/sago-media-upload
COPY --chmod=755 scripts/sago-media-verify /usr/local/bin/sago-media-verify
COPY server /app/server
COPY --from=web-build /app/web/dist /app/web/dist

ENV MEDIA_ROOT=/srv/sago-media
ENV MEDIA_MAX_VIDEO_BYTES=95000000

EXPOSE 3000
USER 10001:10001
CMD ["bun", "/app/server/index.ts"]
