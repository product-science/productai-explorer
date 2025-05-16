#!/bin/sh

echo "Starting ProductAI Explorer with proxy server..."

# Start the proxy server in the background
node server/index.js &
PROXY_PID=$!

# Wait to ensure the proxy server starts
sleep 3

# Check if proxy server is running
if kill -0 $PROXY_PID 2>/dev/null; then
  echo "Proxy server started successfully on port 3000"
else
  echo "Failed to start proxy server"
  exit 1
fi

# Start the frontend application
echo "Starting frontend application..."
CHAIN_REGISTRY=false yarn serve 