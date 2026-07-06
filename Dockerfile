FROM node:24-alpine

WORKDIR /app

RUN apk add --no-cache bash

COPY server.js ./

ENV HOST=0.0.0.0
ENV PORT=8787
ENV ENABLE_BASH_TOOL=1
ENV BASH_TOOL_SHELL=/bin/bash

EXPOSE 8787

CMD ["node", "server.js"]
