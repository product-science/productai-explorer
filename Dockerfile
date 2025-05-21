FROM node:18

# Define build argument for proxy port with default value
ARG PROXY_PORT=3000

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn --ignore-engines

COPY . .

RUN chmod +x server/start.sh

EXPOSE 5173
EXPOSE ${PROXY_PORT}
CMD ["sh", "./server/start.sh"]
