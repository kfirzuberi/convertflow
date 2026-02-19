FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist/client ./dist/client
COPY --from=builder /app/server ./server
COPY --from=builder /app/package.json ./
EXPOSE 3000
CMD ["npx", "tsx", "server/index.ts"]
