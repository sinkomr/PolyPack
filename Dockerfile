# PolyPack as one container: the Node server, which also serves the built website.
FROM node:24-slim
WORKDIR /app

# Dependencies first, so that this layer is reused while only source files change.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/geometry/package.json packages/geometry/
COPY packages/solver/package.json packages/solver/
RUN npm ci --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
COPY data/records.json data/records.json
RUN npm run build

ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATABASE_PATH=/data/polypack.sqlite
EXPOSE 8080
CMD ["npm", "run", "start"]
