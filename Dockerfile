FROM node:18

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn --ignore-engines

COPY . .
EXPOSE 5173
CMD ["sh", "-c", "yarn --ignore-engines && yarn serve"]
