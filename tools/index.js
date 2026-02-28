const SHOPMATA_API_URL = process.env.SHOPMATA_API_URL || 'https://shopmata.com';
const SHOPMATA_INTERNAL_KEY = process.env.SHOPMATA_INTERNAL_KEY || '';

/**
 * Execute a tool via the Shopmata API.
 */
async function callTool(toolName, params, storeConfig) {
  const res = await fetch(`${SHOPMATA_API_URL}/api/storefront/tools/${toolName}`, {
    method: 'POST',
    headers: {
      'X-Internal-Key': SHOPMATA_INTERNAL_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      ...params,
      store_id: storeConfig.store_id,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { error: `Tool API error: ${res.status} - ${text}` };
  }

  return res.json();
}

export async function searchProducts(params, storeConfig) {
  return callTool('search_products', params, storeConfig);
}

export async function getProductDetails(params, storeConfig) {
  return callTool('get_product_details', params, storeConfig);
}

export async function checkAvailability(params, storeConfig) {
  return callTool('check_availability', params, storeConfig);
}

export async function getStoreInfo(params, storeConfig) {
  return callTool('get_store_info', params, storeConfig);
}

export async function compareProducts(params, storeConfig) {
  return callTool('compare_products', params, storeConfig);
}

export async function addToCart(params, storeConfig) {
  return callTool('add_to_cart', params, storeConfig);
}
