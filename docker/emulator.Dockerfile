# Emulador de Firestore para desarrollo local y pruebas. No se usa en producción.
FROM node:24-bookworm-slim

# El emulador es un JAR: necesita Java. curl es para el healthcheck de docker-compose.
RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends openjdk-17-jre-headless curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Descarga el JAR durante el build para no repetirlo en cada arranque.
RUN npx firebase setup:emulators:firestore

EXPOSE 8080
CMD ["npx", "firebase", "emulators:start", "--only", "firestore", "--project", "demo-stockseguro"]
