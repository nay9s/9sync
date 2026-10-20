FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY plugin/package.json ./plugin/package.json
RUN npm ci --workspace server --include-workspace-root=false
COPY server/tsconfig.json ./server/tsconfig.json
COPY server/src ./server/src
RUN npm run build --workspace server

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY plugin/package.json ./plugin/package.json
RUN npm ci --omit=dev --workspace server --include-workspace-root=false && npm cache clean --force
COPY --from=build /app/server/dist ./server/dist
COPY server/public ./server/public
RUN mkdir -p /app/data/blobs && chown -R node:node /app
USER node
EXPOSE 3001
CMD ["node", "server/dist/index.js"]
