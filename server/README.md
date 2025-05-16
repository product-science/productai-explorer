# ProductAI Explorer Proxy Server

This is a simple proxy server for ProductAI Explorer that forwards API and RPC requests to a Cosmos node. It allows the browser to make requests to the node without CORS issues.

## Purpose

The proxy server serves as a middleware between the browser and the Cosmos node. It handles:

- CORS headers that allow cross-origin requests
- Forwarding API requests to the Cosmos API endpoint
- Forwarding RPC requests to the Cosmos RPC endpoint

## Configuration

The server uses the following default configuration:

- API endpoint: http://localhost:1317
- RPC endpoint: http://localhost:26657
- Proxy server port: 3000

You can override these settings using environment variables:

- `PORT`: Port for the proxy server
- `API_ENDPOINT`: Cosmos API endpoint
- `RPC_ENDPOINT`: Cosmos RPC endpoint

## Usage

### Installation

Make sure you have all dependencies installed:

```
yarn install
```

### Running the server

To start the proxy server:

```
yarn server
```

### Using Docker

The proxy server is included in the Docker setup. To run the application with Docker:

```bash
# Build and start with docker-compose
docker-compose up -d

# View logs
docker-compose logs -f
```

The Docker configuration automatically starts both the proxy server and the frontend application.

### Endpoints

The proxy server exposes the following endpoints:

- `/`: Returns status information about the proxy server
- `/config`: Returns configuration information
- `/api/*`: Proxies requests to the Cosmos API endpoint
- `/rpc/*`: Proxies requests to the Cosmos RPC endpoint

## Production Deployment

For production deployment, you might want to:

1. Configure the server with appropriate endpoints
2. Set up proper authentication if needed
3. Use a process manager like PM2 to ensure the server stays running

```bash
# Example with custom endpoints
API_ENDPOINT=https://api.yourdomain.com RPC_ENDPOINT=https://rpc.yourdomain.com PORT=4000 yarn server
```

Using Docker for production:

```bash
# Configure endpoints in docker-compose.yml
# Then run:
docker-compose up -d
```

## Frontend Integration

The frontend is configured to use the proxy server automatically. The proxy configuration is defined in `src/libs/proxy-config.ts`. 