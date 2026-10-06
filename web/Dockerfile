FROM node:22-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    STOCK_PORT=8789 \
    STOCK_HOST=0.0.0.0 \
    STOCK_DATA_DIR=/data
COPY web/package.json ./
COPY web/server.js ./
COPY web/lib/ ./lib/
# 可训练参数（"模型"）：web/config/model.json（由训练流水线产出；代码不写死策略参数）
COPY web/config/ ./config/
# 批处理脚本（每日推荐 cron：docker exec <容器> node scripts/recommend.js）
COPY web/scripts/ ./scripts/
COPY --from=build /app/dist ./dist
RUN mkdir -p /data
EXPOSE 8789
CMD ["node", "server.js"]