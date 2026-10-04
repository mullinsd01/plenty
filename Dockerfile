# syntax=docker/dockerfile:1
#
# Plenty production image (Next.js standalone server + the operational tools).
#
#   docker build -t plenty .
#   docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/plenty:<tag> --push .
#
# Run it (docs/deploy.md has the full guide):
#   docker run --rm --env-file prod.env <image> setup      # migrations + catalog + recipes: before every new version
#   docker run -d --env-file prod.env -p 3000:3000 -v plenty-photos:/data/uploads <image>
#   docker run --rm --env-file prod.env <image> check      # the go-live check
#
# Nothing secret goes into the image: every setting is read from the environment when the container starts.
# The build runs on the machine it is for, so on an arm64 builder (or buildx with arm64) the native modules
# (sharp, argon2) and the WASM OCR engine are fetched for arm64; the last build step proves they work.

ARG NODE_VERSION=22

# ── deps: every dependency, development ones included (the build needs them) ──
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ── build: the web server (.next/standalone) and the bundled tools ─────────────
FROM deps AS build
COPY . .
# `next build` loads the server modules, and the database module insists a DATABASE_URL exists. Nothing connects
# during the build, and this value is not carried into the final image.
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
RUN npm run build && node scripts/build-tools.mjs tools
# Fail here, not at the first receipt, if file tracing left out anything the receipt reader loads by path.
RUN set -eu; \
    for f in \
      node_modules/tesseract.js/src/worker-script/node/getCore.js \
      node_modules/tesseract.js-core/tesseract-core.wasm \
      node_modules/tesseract.js-core/tesseract-core-simd.wasm \
      node_modules/tesseract.js-core/tesseract-core-relaxedsimd.wasm \
      node_modules/tesseract.js-core/tesseract-core-lstm.wasm \
      node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm \
      node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm \
      node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz \
      node_modules/wasm-feature-detect/dist/cjs/index.cjs \
      node_modules/bmp-js/lib/decoder.js \
      node_modules/sharp/package.json \
      node_modules/@node-rs/argon2/package.json \
      node_modules/@aws-sdk/client-s3/package.json; do \
      test -e ".next/standalone/$f" || { echo "Missing from the standalone output: $f" >&2; exit 1; }; \
    done

# ── runtime: only what the server needs ────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    STORAGE_DIR=/data/uploads
# Receipt photos (when STORAGE_DRIVER is local) live in /data/uploads: mount a volume there. The server runs as the
# unprivileged `node` user; the entrypoint makes a root-owned volume over to it on start.
RUN mkdir -p /data/uploads && chown -R node:node /data /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=build --chown=node:node /app/tools ./tools
COPY --chown=node:node --chmod=755 scripts/docker-entrypoint.sh ./docker-entrypoint.sh
# Prove this image, on this platform, can hash passwords, process photos, read a receipt and store it, as the
# unprivileged user the server runs as. (Skip with --build-arg SMOKE_TEST=0, for example on a slow emulated cross-build.)
ARG SMOKE_TEST=1
USER node
RUN if [ "$SMOKE_TEST" = "1" ]; then node tools/smoke.cjs; fi && node tools/check-prod.cjs --help
# The entrypoint starts as root only to fix the ownership of a freshly mounted photo volume, then drops to `node`.
USER root
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["serve"]
