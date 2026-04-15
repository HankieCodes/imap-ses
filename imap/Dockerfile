FROM node:24-alpine

WORKDIR /app

COPY dist/server.js /app/
COPY package.json /app/
COPY LICENSE.txt /app/

# todo- rely on root `pnpm-lock.yaml` instead of loose deps
RUN npm install --omit=dev

CMD node /app/server.js
