FROM node:24-alpine

WORKDIR /app

COPY server.js ./

ENV HOST=0.0.0.0
ENV PORT=8787

EXPOSE 8787

CMD ["node", "server.js"]
