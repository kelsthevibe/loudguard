FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV DB_PATH=/app/data/loudguard.db
VOLUME /app/data
CMD ["node", "src/index.js"]
