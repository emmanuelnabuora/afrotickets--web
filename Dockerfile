# Cloud Run builds this automatically from source too (Buildpacks), but an
# explicit Dockerfile is more predictable and faster to iterate on.
FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Cloud Run sets PORT itself (usually 8080) and injects it as an env var —
# the app already reads process.env.PORT, so nothing else is needed here.
EXPOSE 8080

CMD ["node", "src/index.js"]
