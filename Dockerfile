# PolyPack as one container: the Node server, which also serves the built website.
FROM node:24-slim
WORKDIR /app

# Dependencies first, so that this layer is reused while only source files change.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/volunteer/package.json apps/volunteer/
COPY packages/geometry/package.json packages/geometry/
COPY packages/solver/package.json packages/solver/
COPY packages/surface/package.json packages/surface/
COPY packages/curved/package.json packages/curved/
COPY packages/sphere/package.json packages/sphere/
COPY packages/torus/package.json packages/torus/
COPY packages/spaces/package.json packages/spaces/
COPY packages/polyhedra/package.json packages/polyhedra/
COPY packages/boundary/package.json packages/boundary/
COPY packages/balls/package.json packages/balls/
COPY packages/view3d/package.json packages/view3d/
RUN npm ci --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
COPY data/records.json data/records.json
# the new spaces' research records (served by /api/spaces); their certificates and raw runs stay out
COPY data/surface/records.json data/surface/records.json
COPY data/curved/records.json data/curved/records.json
COPY data/sphere/records.json data/sphere/records.json
COPY data/torus/records.json data/torus/records.json
COPY data/boundary/records.json data/boundary/records.json
COPY data/polyhedra/records.json data/polyhedra/records.json
# polyhedra configurations, one file per problem, read on demand (records.json is their index)
COPY data/polyhedra/configs data/polyhedra/configs
# balls: the index, and the configurations one file per problem, read on demand as polyhedra's are
COPY data/balls/records.json data/balls/records.json
COPY data/balls/configs data/balls/configs
RUN npm run build

ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATABASE_PATH=/data/polypack.sqlite
EXPOSE 8080
# Node runs the server itself, as `npm run start` would from apps/server but without the npm and tsx
# processes around it: on a 512 MB machine those took about 130 MB [CALC, measured in this image
# under a 470 MB limit: 348 MB with npm, 217 MB without]. The server is then process 1 and handles
# SIGTERM itself, so a deploy stops it cleanly.
WORKDIR /app/apps/server
CMD ["node", "--import", "tsx", "src/node.ts"]
