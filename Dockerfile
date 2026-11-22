# 零运行时依赖：node 24 原生剥离 TS 直接跑源码，无需 install。
FROM node:24-alpine
WORKDIR /app
COPY src ./src
COPY prompts ./prompts
COPY public ./public
COPY assets ./assets
CMD ["node", "src/index.ts"]
