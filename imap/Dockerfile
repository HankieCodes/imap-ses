FROM node:24-alpine

WORKDIR /app

COPY LICENSE.txt /app/
COPY package.json /app/
# todo- rely on root `pnpm-lock.yaml` instead of loose deps
RUN npm install --omit=dev

COPY dist/server.js /app/

CMD node /app/server.js
