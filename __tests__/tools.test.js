import { jest } from '@jest/globals';

// Mock fetch globally for tool tests
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Set env before importing
process.env.SHOPMATA_API_URL = 'https://test.shopmata.com';
process.env.SHOPMATA_INTERNAL_KEY = 'test-key';

const { searchProducts, getProductDetails, checkAvailability, getStoreInfo, compareProducts, addToCart } = await import('../tools/index.js');

const storeConfig = { store_id: 1 };

beforeEach(() => {
  mockFetch.mockReset();
});

describe('searchProducts', () => {
  test('calls API with correct params', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ found: true, count: 1, products: [{ id: 1, title: 'Gold Ring' }] }),
    });

    const result = await searchProducts({ query: 'gold ring' }, storeConfig);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://test.shopmata.com/api/storefront/tools/search_products',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"query":"gold ring"'),
      })
    );
    expect(result.found).toBe(true);
  });
});

describe('getProductDetails', () => {
  test('calls API with product_id', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ found: true, product: { id: 42, title: 'Diamond Necklace' } }),
    });

    const result = await getProductDetails({ product_id: 42 }, storeConfig);
    expect(result.found).toBe(true);
    expect(result.product.title).toBe('Diamond Necklace');
  });
});

describe('addToCart', () => {
  test('calls API with product_id and quantity', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, shopify_variant_id: '12345', product_title: 'Ring' }),
    });

    const result = await addToCart({ product_id: 1, quantity: 2 }, storeConfig);
    expect(result.success).toBe(true);
    expect(result.shopify_variant_id).toBe('12345');
  });

  test('handles API errors', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    const result = await addToCart({ product_id: 999 }, storeConfig);
    expect(result.error).toBeDefined();
  });
});
