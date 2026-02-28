import { jest } from '@jest/globals';
import { ConnectionManager, TTSManager, WhisperASR, buildSystemPrompt } from '../gateway.js';

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

describe('WhisperASR', () => {
  test('downsamples 48kHz to 16kHz', () => {
    // Create a simple 48kHz s16le buffer (6 samples = 12 bytes)
    const input = Buffer.alloc(12);
    input.writeInt16LE(100, 0);   // sample 0
    input.writeInt16LE(200, 2);   // sample 1
    input.writeInt16LE(300, 4);   // sample 2
    input.writeInt16LE(400, 6);   // sample 3
    input.writeInt16LE(500, 8);   // sample 4
    input.writeInt16LE(600, 10);  // sample 5

    const output = WhisperASR.downsample(input, 48000, 16000);

    // 48000/16000 = 3, so 6 samples -> 2 samples (4 bytes)
    expect(output.length).toBe(4);
    expect(output.readInt16LE(0)).toBe(100);  // sample 0
    expect(output.readInt16LE(2)).toBe(400);  // sample 3
  });

  test('returns same buffer when rates match', () => {
    const input = Buffer.alloc(8);
    input.writeInt16LE(1000, 0);
    input.writeInt16LE(2000, 2);
    const output = WhisperASR.downsample(input, 16000, 16000);
    expect(output).toBe(input);
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
