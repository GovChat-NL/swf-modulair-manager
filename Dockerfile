FROM node:22-alpine
RUN apk add --no-cache git
WORKDIR /manager
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY manager.js ./
USER node
WORKDIR /repo
ENTRYPOINT ["node", "/manager/manager.js"]
