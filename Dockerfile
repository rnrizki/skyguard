FROM node:20-alpine

# Install ffmpeg for lossless video concatenation
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Copy dependency definitions
COPY package*.json ./

# Install production dependencies cleanly
RUN npm install --omit=dev --no-audit

# Copy application files
COPY . .

# Expose HTTP port
EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "server.js"]
