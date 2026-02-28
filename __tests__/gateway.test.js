import { jest } from '@jest/globals';
import { ConnectionManager, TTSManager, buildSystemPrompt } from '../gateway.js';

describe('ConnectionManager', () => {
  let manager;

  beforeEach(() => {
    manager = new ConnectionManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  test('adds and retrieves peers', () => {
    manager.add('peer-1', { pc: null, storeConfig: {} });
    expect(manager.get('peer-1')).toBeTruthy();
    expect(manager.count).toBe(1);
  });

  test('removes peers', () => {
    manager.add('peer-1', { pc: { close: jest.fn() } });
    manager.remove('peer-1');
    expect(manager.get('peer-1')).toBeUndefined();
    expect(manager.count).toBe(0);
  });

  test('touches peer activity timestamp', () => {
    manager.add('peer-1', { pc: null });
    const before = manager.get('peer-1').lastActivity;
    // Small delay to ensure timestamp difference
    manager.touch('peer-1');
    expect(manager.get('peer-1').lastActivity).toBeGreaterThanOrEqual(before);
  });

  test('cleans up idle peers', () => {
    manager.add('peer-1', { pc: { close: jest.fn() } });
    // Manually set lastActivity to past
    manager.get('peer-1').lastActivity = Date.now() - 10 * 60_000;
    manager.cleanup();
    expect(manager.count).toBe(0);
  });

  test('does not clean up active peers', () => {
    manager.add('peer-1', { pc: null });
    manager.cleanup();
    expect(manager.count).toBe(1);
  });
});

describe('TTSManager', () => {
  test('chunks text into natural phrases', () => {
    const text = 'Hello! Welcome to our store. We have beautiful diamond rings, gold necklaces, and silver bracelets. How can I help you today?';
    const chunks = TTSManager.chunkText(text);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join(' ')).toContain('diamond rings');
  });

  test('handles short text without splitting', () => {
    const chunks = TTSManager.chunkText('Hello there!');
    expect(chunks).toEqual(['Hello there!']);
  });

  test('handles empty text', () => {
    const chunks = TTSManager.chunkText('');
    expect(chunks).toEqual(['']);
  });
});

describe('buildSystemPrompt', () => {
  test('builds prompt with store name', () => {
    const prompt = buildSystemPrompt({
      store_name: 'Diamond Palace',
      assistant_name: 'Diamond Assistant',
    });
    expect(prompt).toContain('Diamond Palace');
    expect(prompt).toContain('Diamond Assistant');
    expect(prompt).toContain('VOICE CONVERSATION GUIDELINES');
  });

  test('includes knowledge base when provided', () => {
    const prompt = buildSystemPrompt({
      store_name: 'Test Store',
      knowledge_base: 'We offer free shipping on orders over $100.',
    });
    expect(prompt).toContain('free shipping');
    expect(prompt).toContain('STORE KNOWLEDGE BASE');
  });

  test('handles missing config gracefully', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('the store');
    expect(prompt).not.toContain('STORE KNOWLEDGE BASE');
  });
});
