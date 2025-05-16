FROM node:18

WORKDIR /app

# Copy package.json and yarn.lock for dependency installation
COPY package.json yarn.lock ./
RUN yarn --ignore-engines

# Copy the rest of the application
COPY . .

# Make the start script executable
RUN chmod +x server/start.sh

# Expose ports for both the frontend and the proxy server
EXPOSE 5173
EXPOSE 3000

# Start both the proxy server and the frontend
CMD ["./server/start.sh"]
