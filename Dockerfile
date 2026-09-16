# syntax=docker/dockerfile:1

# --- build: bundle src -> dist ---
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# --- runtime: dist + minimal deps ---
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8090 \
    GANGS_FILE=/data/gangs.yaml \
    POLICIES_FILE=/data/policies.yaml \
    DEVICES_FILE=/data/devices.yaml \
    CODES_FILE=/data/codes.yaml \
    MIRRORS_FILE=/data/mirrors.yaml \
    HA_CONFIG_DIR=/homeassistant
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
COPY blueprints ./blueprints
COPY gangs.example.yaml ./gangs.example.yaml
RUN mkdir -p /data
EXPOSE 8090
# Standalone: -e ZWS_HOST=... -e ZWS_PORT=3000 and mount -v ./data:/data.
# As a Home Assistant add-on: HA writes options to /data/options.json, maps its config at
# /homeassistant (for the cross-protocol/scene blueprints), and provides the Supervisor token.
CMD ["node", "dist/server.js"]
