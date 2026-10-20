# nsjail is built from source in its own stage so the runtime image stays slim and
# the host needs no setup at all: the binary ships inside this image.
# It must be cloned with submodules because kafel (the seccomp policy engine) is a
# git submodule; a plain tarball would fail the build.
FROM debian:bookworm-slim AS nsjail
# nsjail tags releases without a "v" prefix (3.6, not v3.6).
ARG NSJAIL_VERSION=3.6
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git make g++ protobuf-compiler libprotobuf-dev \
      libnl-route-3-dev pkg-config bison flex \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${NSJAIL_VERSION}" --recurse-submodules --shallow-submodules \
      https://github.com/google/nsjail.git /src/nsjail \
 && cd /src/nsjail \
 && make -j"$(nproc)" nsjail \
 && strip nsjail \
 && ls -la nsjail

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/ilink/package.json packages/ilink/package.json
COPY packages/net/package.json packages/net/package.json
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run typecheck && npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
# nsjail plus its runtime deps. Present in the image so the sandbox works with a
# plain `docker compose up` and nothing installed on the host.
COPY --from=nsjail /src/nsjail/nsjail /usr/local/bin/nsjail
RUN apt-get update && apt-get install -y --no-install-recommends \
      libprotobuf32 libnl-route-3-200 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY shared/prompts ./shared/prompts
COPY assets ./assets
COPY apps/api/public ./apps/api/public
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY licenses ./licenses
RUN mkdir -p /data /sandbox && chown node:node /data /sandbox
USER node
VOLUME ["/data", "/sandbox"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]