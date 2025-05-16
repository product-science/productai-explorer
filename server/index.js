const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const API_ENDPOINT = process.env.API_ENDPOINT;
const RPC_ENDPOINT = process.env.RPC_ENDPOINT;

// Enable CORS for all routes
app.use(cors());

// Middleware to log requests
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Handle API requests
app.use('/api', async (req, res) => {
  try {
    const targetUrl = `${API_ENDPOINT}${req.url.replace(/^\/api/, '')}`;
    console.log(`Proxying API request to: ${req.method} ${targetUrl}`);

    const response = await axios({
      method: req.method,
      url: targetUrl,
      data: req.body,
      headers: {
        ...req.headers,
        host: new URL(API_ENDPOINT).host,
      },
      timeout: 60000,
    });

    // Set CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

    // Return the response
    res.status(response.status).json(response.data);
  } catch (error) {
    console.error('API proxy error:', error.message);
    res.status(error.response?.status || 500).json({
      error: error.message,
      details: error.response?.data || 'No additional details available'
    });
  }
});

// Handle RPC requests
app.use('/rpc', async (req, res) => {
  try {
    const targetUrl = `${RPC_ENDPOINT}${req.url.replace(/^\/rpc/, '')}`;
    console.log(`Proxying RPC request to: ${req.method} ${targetUrl}`);

    const response = await axios({
      method: req.method,
      url: targetUrl,
      data: req.body,
      headers: {
        ...req.headers,
        host: new URL(RPC_ENDPOINT).host,
      },
      timeout: 60000,
    });

    // Set CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

    // Return the response
    res.status(response.status).json(response.data);
  } catch (error) {
    console.error('RPC proxy error:', error.message);
    res.status(error.response?.status || 500).json({
      error: error.message,
      details: error.response?.data || 'No additional details available'
    });
  }
});

// Status endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    services: {
      api: API_ENDPOINT,
      rpc: RPC_ENDPOINT
    },
    message: 'ProductAI Explorer Proxy Server is running!'
  });
});

// Configure endpoints
app.get('/config', (req, res) => {
  res.json({
    api_endpoint: API_ENDPOINT,
    rpc_endpoint: RPC_ENDPOINT,
    proxy_server: `http://localhost:${PORT}`
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Proxy server is running on port ${PORT}`);
  console.log(`API proxy: http://localhost:${PORT}/api -> ${API_ENDPOINT}`);
  console.log(`RPC proxy: http://localhost:${PORT}/rpc -> ${RPC_ENDPOINT}`);
}); 