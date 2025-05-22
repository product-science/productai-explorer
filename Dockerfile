FROM node:18-alpine
ARG PROXY_PORT=3000
RUN apk add --no-cache bash

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn --ignore-engines
COPY . .

RUN chmod +x server/start.sh

EXPOSE 5173
EXPOSE ${PROXY_PORT}
CMD ["sh", "./server/start.sh"]
