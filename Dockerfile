# Rank It container image.
# Shared by every deployment option (local Docker today, AWS later).
FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    VOTE_PORT=8080 \
    MANAGE_PORT=8081

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

# run as the unprivileged "node" user; /data holds the database file
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

EXPOSE 8080 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.VOTE_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
