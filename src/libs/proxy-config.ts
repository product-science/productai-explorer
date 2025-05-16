// Configuration for the proxy server

// Use default values - override with environment variables in production
export const PROXY_SERVER_HOST = 'http://localhost:3000';

// API and RPC paths on the proxy server
export const API_PATH = '/api';
export const RPC_PATH = '/rpc';

// Helper function to convert node endpoint to proxy endpoint
export function getProxyEndpoint(originalEndpoint: string, endpointType: 'api' | 'rpc'): string {
  // Get the endpoint type (api or rpc)
  const isRPC = originalEndpoint.includes(':26657') || endpointType === 'rpc';
  const proxyPath = isRPC ? RPC_PATH : API_PATH;
  
  // Return the full proxy URL
  return `${PROXY_SERVER_HOST}${proxyPath}`;
} 