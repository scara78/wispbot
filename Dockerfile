FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    ADMIN_HOST=0.0.0.0 \
    ADMIN_PORT=3000

WORKDIR /app

# Dependencies required by native packages such as sqlite3 and sharp
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm ci --omit=dev \
    && npm cache clean --force

COPY . .

RUN mkdir -p \
        /app/data \
        /app/data/images \
        /app/data/audio \
        /app/data/group_memories \
        /app/auth_session \
    && chown -R node:node /app

USER node

EXPOSE 3000

VOLUME ["/app/data", "/app/auth_session"]

CMD ["npm", "run", "start:silent"]