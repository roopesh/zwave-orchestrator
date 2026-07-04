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
    POLICIES_FILE=/data/policies.yaml
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
COPY gangs.example.yaml ./gangs.example.yaml
RUN mkdir -p /data
EXPOSE 8090
# Configure the controller with -e ZWS_HOST=... -e ZWS_PORT=3000 and mount -v ./data:/data
CMD ["node", "dist/server.js"]
