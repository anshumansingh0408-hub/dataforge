FROM node:24-alpine

WORKDIR /app

# Copy dependency definitions
COPY package*.json ./

# Install production dependencies
RUN npm install --no-audit --no-package-lock

# Copy source code
COPY . .

EXPOSE 5000

ENV PORT=5000

CMD ["node", "server.js"]
