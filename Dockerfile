FROM node:22.16.0-bookworm-slim

ARG NPM_VERSION=11.18.0

RUN npm install --global "npm@${NPM_VERSION}" \
    && npm --version

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --loglevel=info \
    && npm cache clean --force

COPY src ./src
RUN mkdir -p data/evidence

ENV NODE_ENV=production
CMD ["node", "src/index.js"]
