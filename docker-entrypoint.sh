#!/bin/sh
set -e

# Explicitly substitute only API_ENDPOINT and RPC_ENDPOINT
# using a temporary file to avoid issues
export API_ENDPOINT=${API_ENDPOINT:-http://genesis-node:1317}
export RPC_ENDPOINT=${RPC_ENDPOINT:-http://genesis-node:26657}

# Use envsubst to replace only these specific variables
# We use a pattern that matches exactly these variables to avoid replacing $host, etc.
# Note: envsubst < template > output replaces ALL variables unless arguments are given.
# Passing '$API_ENDPOINT $RPC_ENDPOINT' as argument tells it to only replace those.
envsubst '$API_ENDPOINT $RPC_ENDPOINT' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf

# Execute the CMD
exec "$@"
