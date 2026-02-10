import fetch from 'cross-fetch';

export async function fetchData<T>(
  url: string,
  adapter: (source: any) => Promise<T>
): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status}, ${response.statusText}`);
  }
  const data = await response.json();
  return adapter(data);
}

export async function get(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    referrerPolicy: 'origin-when-cross-origin',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  });

  // Check if response is successful
  if (!response.ok) {
    let errorMessage = `HTTP error: ${response.status} ${response.statusText}`;
    try {
      // Try to get error details from response body if it exists
      const errorText = await response.text();
      if (errorText) {
        errorMessage += ` - ${errorText}`;
      }
    } catch (e) {
      // Ignore errors when reading response text
    }
    throw new Error(errorMessage);
  }

  // Check if response has content
  const contentType = response.headers.get('content-type');
  if (!contentType || !contentType.includes('application/json')) {
    const text = await response.text();
    if (!text.trim()) {
      // Return empty object for empty responses
      return {};
    }
    // Try to parse as JSON anyway, but handle the error
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`Invalid JSON response: ${text}`);
    }
  }

  // Parse JSON response
  return response.json();
}

export async function getB(url: string) {
  return (await fetch(url, { referrerPolicy: 'origin-when-cross-origin' })).arrayBuffer();
}

export async function post(url: string, data: any) {
  const response = await fetch(url, {
    method: 'POST', // *GET, POST, PUT, DELETE, etc.
    // mode: 'cors', // no-cors, *cors, same-origin
    // credentials: 'same-origin', // redirect: 'follow', // manual, *follow, error
    referrerPolicy: 'origin-when-cross-origin', // no-referrer, *no-referrer-when-downgrade, origin, origin-when-cross-origin, same-origin, strict-origin, strict-origin-when-cross-origin, unsafe-url
    headers: {
      'Content-Type': 'application/json',
      Accept: '*/*',
      // 'Accept-Encoding': 'gzip, deflate, br',
    },
    body: JSON.stringify(data), // body data type must match "Content-Type" header
  });

  // Check if response is successful
  if (!response.ok) {
    let errorMessage = `HTTP error: ${response.status} ${response.statusText}`;
    try {
      // Try to get error details from response body if it exists
      const errorText = await response.text();
      if (errorText) {
        errorMessage += ` - ${errorText}`;
      }
    } catch (e) {
      // Ignore errors when reading response text
    }
    throw new Error(errorMessage);
  }

  // Check if response has content
  const contentType = response.headers.get('content-type');
  if (!contentType || !contentType.includes('application/json')) {
    const text = await response.text();
    if (!text.trim()) {
      // Return empty object for empty responses
      return {};
    }
    // Try to parse as JSON anyway, but handle the error
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`Invalid JSON response: ${text}`);
    }
  }

  // Parse JSON response
  return response.json();
}
