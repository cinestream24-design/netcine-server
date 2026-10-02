FROM mcr.microsoft.com/playwright/node:v1.48.0-noble

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

EXPOSE 8080

CMD ["node", "index.js"]
