FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public/ ./public/

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "server.js"]
