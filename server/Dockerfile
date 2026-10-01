# Standalone image for the relay server only — deliberately not built from
# the app's own root package.json, which pulls in react/vite/electron that
# the relay never needs. Build context is this server/ directory.
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY relay.mjs roomRegistry.mjs ./

ENV RELAY_PORT=8080
EXPOSE 8080

CMD ["node", "relay.mjs"]
