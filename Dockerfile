FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY backend ./backend
COPY frontend ./frontend

USER node
EXPOSE 3000

CMD ["node", "--use-system-ca", "backend/server.js"]
