# Imagen de producción (Render).
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# Primero las dependencias, para aprovechar la caché de capas.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health" > /dev/null || exit 1

# node directo y no npm start: así el proceso recibe SIGTERM y cierra ordenadamente.
CMD ["node", "src/server.js"]
