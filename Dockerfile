# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app

COPY packages/kawaii-signal /tmp/kawaii-signal
COPY package.json ./
RUN node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json','utf8')); p.dependencies['kawaii-signal']='file:/tmp/kawaii-signal'; fs.writeFileSync('package.json', JSON.stringify(p,null,2));"
RUN npm install --omit=dev

COPY server.js ./
COPY static-proxy.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
