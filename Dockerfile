# 零运行时依赖：node 24 原生剥离 TS 直接跑源码，无需 install。
# docker-cli 用于常驻沙箱：项目容器借宿主 daemon 起兄弟容器（sock 由 compose 挂入）。
FROM node:24-alpine
RUN apk add --no-cache docker-cli
WORKDIR /app
COPY src ./src
COPY prompts ./prompts
COPY public ./public
COPY assets ./assets
CMD ["node", "src/index.ts"]
