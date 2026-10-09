FROM mcr.microsoft.com/playwright:v1.64.0-noble

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js ./

ENV NODE_ENV=production
ENV PORT=8080

USER pwuser

EXPOSE 8080
CMD ["node", "server.js"]
