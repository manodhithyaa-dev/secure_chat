# SecureChat backend (Express + Socket.IO + SQLite)
# Build context is the repository root so the npm workspace lockfile is used.
FROM node:24-slim

ENV NODE_ENV=production \
    PORT=4000 \
    DATABASE_FILE=/data/securechat.sqlite \
    ATTACHMENT_DIR=/data/attachments

WORKDIR /app

# Install production dependencies for the server workspace only.
# Both workspace manifests must be present for `npm ci` to validate the lockfile.
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci --omit=dev --workspace server \
    && npm cache clean --force

COPY server ./server

# Persist the SQLite database and encrypted attachments across restarts.
RUN mkdir -p /data
VOLUME ["/data"]

WORKDIR /app/server

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
