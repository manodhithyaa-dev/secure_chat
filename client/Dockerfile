# SecureChat web tier: builds the React/Vite app and serves it through nginx,
# which also reverse-proxies /api and /socket.io to the backend container.
# Build context is the repository root.

# ---- build stage ----------------------------------------------------------
FROM node:24-slim AS build

WORKDIR /app

# Install dependencies for the client workspace (needs devDeps: tsc + vite).
# Both workspace manifests must be present for `npm ci` to validate the lockfile.
COPY package.json package-lock.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN npm ci --workspace client && npm cache clean --force

COPY client ./client
RUN npm run build -w client

# ---- runtime stage --------------------------------------------------------
FROM nginx:1.27-alpine

COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
