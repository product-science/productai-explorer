FROM node:18

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn --ignore-engines

COPY . .

RUN chmod +x server/start.sh

EXPOSE 5173
EXPOSE 3000
CMD ["./server/start.sh"]
