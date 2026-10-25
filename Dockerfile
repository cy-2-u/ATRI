# nsjail 从源码单独构建（kafel 是子模块，必须带 submodules 克隆），
# 运行镜像因此自带沙箱能力，宿主机零配置。
FROM debian:bookworm-slim AS nsjail
ARG NSJAIL_VERSION=3.6
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git make g++ protobuf-compiler libprotobuf-dev \
      libnl-route-3-dev pkg-config bison flex \
 && rm -rf /var/lib/apt/lists/* \
 && git clone --depth 1 --branch "${NSJAIL_VERSION}" --recurse-submodules --shallow-submodules \
      https://github.com/google/nsjail.git /src/nsjail \
 && cd /src/nsjail && make -j"$(nproc)" nsjail && strip nsjail

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run typecheck && npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
COPY --from=nsjail /src/nsjail/nsjail /usr/local/bin/nsjail
RUN apt-get update && apt-get install -y --no-install-recommends \
      libprotobuf32 libnl-route-3-200 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY shared/prompts ./shared/prompts
COPY assets ./assets
COPY public ./public
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY licenses ./licenses
RUN mkdir -p /data /sandbox && chown node:node /data /sandbox
USER node
VOLUME ["/data", "/sandbox"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
