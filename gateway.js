import { createRequire } from 'module';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { v4 as uuidv4 } from 'uuid';
import { spawn } from 'child_process';
import { searchProducts, getProductDetails, checkAvailability, getStoreInfo, compareProducts, addToCart } from './tools/index.js';

const require = createRequire(import.meta.url);

// Load .env if present
try { const { config } = await import('dotenv'); config(); } catch { /* dotenv not required */ }

const {
  PORT = 5050,
  OPENAI_API_KEY,
  ANTHROPIC_API_KEY,
  ELEVEN_API_KEY,
  ELEVEN_VOICE_ID,
  ELEVEN_MODEL_ID = 'eleven_multilingual_v2',
  SHOPMATA_API_URL = 'https://shopmata.com',
  SHOPMATA_INTERNAL_KEY,
  ALLOWED_ORIGINS = '',
  FFMPEG_BIN = 'ffmpeg',
} = process.env;

// ─── Tool Registry ──────────────────────────────────────────────────────────

const TOOLS = { searchProducts, getProductDetails, checkAvailability, getStoreInfo, compareProducts, addToCart };

const CLAUDE_TOOLS = [
  {
    name: 'search_products',
    description: 'Search for products in the store. Use when a customer asks about products, wants to browse, or is looking for something specific.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g. "gold ring", "diamond earrings")' },
        category: { type: 'string', description: 'Filter by category name' },
        min_price: { type: 'number', description: 'Minimum price filter' },
        max_price: { type: 'number', description: 'Maximum price filter' },
        limit: { type: 'integer', description: 'Max results (default 5, max 10)' },
      },
    },
  },
  {
    name: 'get_product_details',
    description: 'Get detailed information about a specific product including variants, images, and attributes.',
    input_schema: {
      type: 'object',
      properties: { product_id: { type: 'integer', description: 'Product ID' } },
      required: ['product_id'],
    },
  },
  {
    name: 'check_availability',
    description: 'Check if a product is currently in stock.',
    input_schema: {
      type: 'object',
      properties: { product_id: { type: 'integer', description: 'Product ID' } },
      required: ['product_id'],
    },
  },
  {
    name: 'get_store_info',
    description: 'Get store information like return policy, shipping info, care instructions, FAQ, or about the store.',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', enum: ['return_policy', 'shipping_info', 'care_instructions', 'faq', 'about', 'all'], description: 'Topic to query' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'compare_products',
    description: 'Compare 2-4 products side by side.',
    input_schema: {
      type: 'object',
      properties: { product_ids: { type: 'array', items: { type: 'integer' }, description: 'Array of 2-4 product IDs' } },
      required: ['product_ids'],
    },
  },
  {
    name: 'add_to_cart',
    description: 'Generate an add-to-cart link for a product. Use when a customer wants to buy or add something to their cart.',
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'integer', description: 'Product ID' },
        variant_id: { type: 'integer', description: 'Variant ID (optional, uses default)' },
        quantity: { type: 'integer', description: 'Quantity (default 1)' },
      },
      required: ['product_id'],
    },
  },
];

const TOOL_NAME_MAP = {
  search_products: 'searchProducts',
  get_product_details: 'getProductDetails',
  check_availability: 'checkAvailability',
  get_store_info: 'getStoreInfo',
  compare_products: 'compareProducts',
  add_to_cart: 'addToCart',
};

// ─── Connection Manager ─────────────────────────────────────────────────────

class ConnectionManager {
  constructor() {
    /** @type {Map<string, object>} */
    this.peers = new Map();
    this.cleanupInterval = setInterval(() => this.cleanup(), 30_000);
  }

  add(peerId, peerData) {
    this.peers.set(peerId, { ...peerData, createdAt: Date.now(), lastActivity: Date.now() });
  }

  get(peerId) {
    return this.peers.get(peerId);
  }

  touch(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) peer.lastActivity = Date.now();
  }

  remove(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      try { peer.pc?.close(); } catch {}
      this.peers.delete(peerId);
    }
  }

  cleanup() {
    const now = Date.now();
    const timeout = 5 * 60_000; // 5 min idle timeout
    for (const [id, peer] of this.peers) {
      if (now - peer.lastActivity > timeout) {
        console.log(`[cleanup] Removing idle peer ${id}`);
        this.remove(id);
      }
    }
  }

  get count() {
    return this.peers.size;
  }

  destroy() {
    clearInterval(this.cleanupInterval);
    for (const id of this.peers.keys()) this.remove(id);
  }
}

// ─── TTS Manager ────────────────────────────────────────────────────────────

class TTSManager {
  constructor(apiKey, voiceId, modelId, ffmpegBin) {
    this.apiKey = apiKey;
    this.voiceId = voiceId;
    this.modelId = modelId;
    this.ffmpegBin = ffmpegBin;
    this.queue = [];
    this.processing = false;
    this.aborted = false;
    this.onAudioChunk = null;
    this.onSpeakingStart = null;
    this.onSpeakingEnd = null;
  }

  /**
   * Split text into natural phrases for TTS chunking.
   */
  static chunkText(text) {
    const chunks = [];
    // Split on sentence boundaries, commas, semicolons, and conjunctions
    const parts = text.split(/(?<=[.!?])\s+|(?<=,)\s+|(?<=;)\s+/);
    let current = '';

    for (const part of parts) {
      if ((current + ' ' + part).trim().length > 120 && current.length > 0) {
        chunks.push(current.trim());
        current = part;
      } else {
        current = current ? current + ' ' + part : part;
      }
    }
    if (current.trim()) chunks.push(current.trim());

    return chunks.length > 0 ? chunks : [text];
  }

  async speak(text) {
    const chunks = TTSManager.chunkText(text);
    this.aborted = false;

    for (const chunk of chunks) {
      if (this.aborted) break;
      await this.synthesize(chunk);
    }

    this.onSpeakingEnd?.();
  }

  interrupt() {
    this.aborted = true;
    this.queue = [];
  }

  async synthesize(text) {
    if (!this.apiKey || !this.voiceId) {
      console.warn('[tts] Missing ElevenLabs credentials, skipping TTS');
      return;
    }

    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': this.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text,
            model_id: this.modelId,
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
            output_format: 'pcm_24000',
          }),
        }
      );

      if (!res.ok) {
        console.error(`[tts] ElevenLabs error: ${res.status} ${res.statusText}`);
        return;
      }

      this.onSpeakingStart?.();

      // Convert PCM 24kHz to 48kHz s16le for WebRTC using ffmpeg
      const ffmpeg = spawn(this.ffmpegBin, [
        '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
        '-f', 's16le', '-ar', '48000', '-ac', '1', 'pipe:1',
      ], { stdio: ['pipe', 'pipe', 'ignore'] });

      ffmpeg.stdout.on('data', (pcmData) => {
        if (!this.aborted) this.onAudioChunk?.(pcmData);
      });

      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done || this.aborted) break;
        ffmpeg.stdin.write(Buffer.from(value));
      }

      ffmpeg.stdin.end();
      await new Promise((resolve) => ffmpeg.on('close', resolve));
    } catch (err) {
      console.error('[tts] Synthesis error:', err.message);
    }
  }
}

// ─── ASR (OpenAI Whisper API) ────────────────────────────────────────────────

class WhisperASR {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.buffer = Buffer.alloc(0);
    this.silenceThreshold = 500; // ms of silence before sending
    this.lastSpeechAt = 0;
    this.timer = null;
    this.onTranscript = null;
  }

  /**
   * Feed raw PCM audio data (s16le, 48kHz, mono).
   */
  feed(pcmData) {
    this.buffer = Buffer.concat([this.buffer, pcmData]);
    this.lastSpeechAt = Date.now();

    if (this.hasEnergy(pcmData)) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), this.silenceThreshold);
    }
  }

  hasEnergy(pcmData) {
    let energy = 0;
    for (let i = 0; i < pcmData.length - 1; i += 2) {
      const sample = pcmData.readInt16LE(i);
      energy += Math.abs(sample);
    }
    return (energy / (pcmData.length / 2)) > 200;
  }

  async flush() {
    if (this.buffer.length < 4800) return; // Less than 50ms of audio

    const audioBuffer = this.buffer;
    this.buffer = Buffer.alloc(0);

    try {
      const wavBuffer = this.pcmToWav(audioBuffer, 48000, 1, 16);

      const form = new FormData();
      form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
      form.append('model', 'whisper-1');
      form.append('language', 'en');

      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
      });

      if (!res.ok) {
        console.error(`[asr] Whisper error: ${res.status}`);
        return;
      }

      const data = await res.json();
      if (data.text?.trim()) {
        this.onTranscript?.(data.text.trim());
      }
    } catch (err) {
      console.error('[asr] Transcription error:', err.message);
    }
  }

  pcmToWav(pcmData, sampleRate, channels, bitsPerSample) {
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmData.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcmData.length, 40);

    return Buffer.concat([header, pcmData]);
  }

  destroy() {
    clearTimeout(this.timer);
    this.buffer = Buffer.alloc(0);
  }
}

// ─── Store Context Loader ───────────────────────────────────────────────────

async function loadStoreContext(shop) {
  const res = await fetch(`${SHOPMATA_API_URL}/api/storefront/voice-config?shop=${encodeURIComponent(shop)}`, {
    headers: {
      'X-Internal-Key': SHOPMATA_INTERNAL_KEY,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to load store config: ${res.status}`);
  }

  return res.json();
}

// ─── LLM (Claude) ───────────────────────────────────────────────────────────

async function* streamClaude(systemPrompt, messages, tools) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 512,
      system: systemPrompt,
      messages,
      tools,
      stream: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API error: ${res.status} - ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          yield data;
        } catch {}
      }
    }
  }
}

/**
 * Build voice-optimized system prompt from store context.
 */
function buildSystemPrompt(storeConfig) {
  const storeName = storeConfig.store_name || 'the store';
  const assistantName = storeConfig.assistant_name || `${storeName} Assistant`;
  const knowledgeBase = storeConfig.knowledge_base || '';

  return `You are ${assistantName}, a friendly and knowledgeable voice assistant for ${storeName}.

VOICE CONVERSATION GUIDELINES:
- Keep responses SHORT and conversational — this is spoken aloud, not read
- Use 1-2 sentences per response when possible
- Be warm, natural, and enthusiastic about the products
- When listing products, mention 2-3 key details (name, price, availability)
- Don't use markdown, bullet points, or formatting — speak naturally
- Format prices as spoken words when natural (e.g., "twelve hundred dollars" or "$1,200")
- Ask follow-up questions to help narrow down what the customer wants
- When a customer wants to buy, use the add_to_cart tool

TOOL USAGE:
- Use search_products when browsing or looking for items
- Use get_product_details for specifics about a single item
- Use check_availability to verify stock
- Use compare_products when comparing options
- Use get_store_info for policies, shipping, returns, etc.
- Use add_to_cart when the customer decides to purchase

NEVER:
- Reveal product costs, margins, or supplier information
- Share exact inventory quantities — only say "in stock" or "out of stock"
- Discuss other customers or sales data
- Process orders directly — only generate add-to-cart links
- Discuss topics unrelated to the store

${knowledgeBase ? `\nSTORE KNOWLEDGE BASE:\n${knowledgeBase}` : ''}`;
}

// ─── Audio Pipeline (per peer) ──────────────────────────────────────────────

async function handleAudioPipeline(peerId, storeConfig, connectionManager) {
  const peer = connectionManager.get(peerId);
  if (!peer) return;

  const { pc, dataChannel, audioSource, audioSink } = peer;
  const conversationHistory = [];

  // Set up TTS
  const tts = new TTSManager(ELEVEN_API_KEY, ELEVEN_VOICE_ID, ELEVEN_MODEL_ID, FFMPEG_BIN);

  tts.onAudioChunk = (pcmData) => {
    connectionManager.touch(peerId);
    // Feed 48kHz s16le PCM into WebRTC audio source
    const samples = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.length / 2);
    const floatSamples = Float32Array.from(samples, (s) => s / 32768);

    // WebRTC AudioSource expects { samples, sampleRate, bitsPerSample, channelCount, numberOfFrames }
    audioSource.onData({
      samples: floatSamples,
      sampleRate: 48000,
      bitsPerSample: 16,
      channelCount: 1,
      numberOfFrames: floatSamples.length,
    });
  };

  // Set up ASR
  const asr = new WhisperASR(OPENAI_API_KEY);

  asr.onTranscript = async (text) => {
    connectionManager.touch(peerId);
    console.log(`[asr] Peer ${peerId}: "${text}"`);

    // Send transcript to client
    if (dataChannel?.readyState === 'open') {
      dataChannel.send(JSON.stringify({ type: 'transcript', text }));
    }

    // Interrupt TTS if speaking
    tts.interrupt();

    // Add to conversation history
    conversationHistory.push({ role: 'user', content: text });

    // Generate response
    try {
      await generateAndSpeak(peerId, storeConfig, conversationHistory, tts, dataChannel, connectionManager);
    } catch (err) {
      console.error(`[llm] Error for peer ${peerId}:`, err.message);
      if (dataChannel?.readyState === 'open') {
        dataChannel.send(JSON.stringify({ type: 'error', message: 'Sorry, I encountered an error. Please try again.' }));
      }
    }
  };

  // Connect audio sink to ASR
  audioSink.ondata = (data) => {
    asr.feed(Buffer.from(data.samples.buffer));
  };

  // Store references for cleanup
  peer.tts = tts;
  peer.asr = asr;

  // Send welcome message
  const welcomeMessage = storeConfig.welcome_message || `Hi! Welcome to ${storeConfig.store_name}. How can I help you today?`;

  if (dataChannel?.readyState === 'open') {
    dataChannel.send(JSON.stringify({ type: 'response', text: welcomeMessage }));
  }

  conversationHistory.push({ role: 'assistant', content: welcomeMessage });
  tts.speak(welcomeMessage);
}

async function generateAndSpeak(peerId, storeConfig, conversationHistory, tts, dataChannel, connectionManager) {
  const systemPrompt = buildSystemPrompt(storeConfig);
  let fullResponse = '';
  let toolUse = null;
  let toolInput = '';

  for await (const event of streamClaude(systemPrompt, conversationHistory, CLAUDE_TOOLS)) {
    if (event.type === 'content_block_start') {
      if (event.content_block?.type === 'tool_use') {
        toolUse = { id: event.content_block.id, name: event.content_block.name };
        toolInput = '';
      }
    } else if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta') {
        fullResponse += event.delta.text;
      } else if (event.delta?.type === 'input_json_delta') {
        toolInput += event.delta.partial_json;
      }
    } else if (event.type === 'content_block_stop' && toolUse) {
      // Execute tool
      const toolFn = TOOL_NAME_MAP[toolUse.name];
      if (toolFn && TOOLS[toolFn]) {
        if (dataChannel?.readyState === 'open') {
          dataChannel.send(JSON.stringify({ type: 'tool_use', name: toolUse.name, status: 'executing' }));
        }

        let params;
        try { params = JSON.parse(toolInput || '{}'); } catch { params = {}; }

        const result = await TOOLS[toolFn](params, storeConfig);

        // Handle add_to_cart specially — send to widget
        if (toolUse.name === 'add_to_cart' && result.success && dataChannel?.readyState === 'open') {
          dataChannel.send(JSON.stringify({
            type: 'add_to_cart',
            variant_id: result.shopify_variant_id,
            product_title: result.product_title,
            quantity: params.quantity || 1,
          }));
        }

        // Continue conversation with tool result
        conversationHistory.push({
          role: 'assistant',
          content: [
            { type: 'text', text: fullResponse },
            { type: 'tool_use', id: toolUse.id, name: toolUse.name, input: params },
          ],
        });
        conversationHistory.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) }],
        });

        // Get follow-up response after tool result
        fullResponse = '';
        toolUse = null;

        for await (const followUp of streamClaude(systemPrompt, conversationHistory, CLAUDE_TOOLS)) {
          if (followUp.type === 'content_block_delta' && followUp.delta?.type === 'text_delta') {
            fullResponse += followUp.delta.text;
          }
        }
      }

      toolUse = null;
    }
  }

  if (fullResponse) {
    conversationHistory.push({ role: 'assistant', content: fullResponse });

    if (dataChannel?.readyState === 'open') {
      dataChannel.send(JSON.stringify({ type: 'response', text: fullResponse }));
    }

    await tts.speak(fullResponse);
  }
}

// ─── Express Server ─────────────────────────────────────────────────────────

const app = express();
const connManager = new ConnectionManager();

app.use(helmet());
app.use(express.json());

const allowedOrigins = ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : true,
  methods: ['POST', 'GET'],
}));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', peers: connManager.count, uptime: process.uptime() });
});

// WebRTC signaling
app.post('/offer', async (req, res) => {
  const { sdp, shop, visitor_id, session_id } = req.body;

  if (!sdp || !shop) {
    return res.status(400).json({ error: 'Missing sdp or shop' });
  }

  try {
    // Load store context
    const storeConfig = await loadStoreContext(shop);

    // Import WebRTC (CommonJS module)
    const wrtc = require('@roamhq/wrtc');
    const { RTCPeerConnection, RTCAudioSource, RTCAudioSink, MediaStream } = wrtc;

    const peerId = uuidv4();

    // Create peer connection
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    // Create audio source for TTS → client
    const audioSource = new RTCAudioSource();
    const audioTrack = audioSource.createTrack();
    const outStream = new MediaStream([audioTrack]);
    pc.addTrack(audioTrack, outStream);

    // Create data channel for text messages
    const dataChannel = pc.createDataChannel('messages');

    // Track audio sink (will be set when remote track arrives)
    let audioSink = null;

    pc.ontrack = (event) => {
      if (event.track.kind === 'audio') {
        audioSink = new RTCAudioSink(event.track);
        const peer = connManager.get(peerId);
        if (peer) {
          peer.audioSink = audioSink;
          handleAudioPipeline(peerId, storeConfig, connManager);
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(pc.iceConnectionState)) {
        console.log(`[webrtc] Peer ${peerId} disconnected`);
        const peer = connManager.get(peerId);
        if (peer) {
          peer.asr?.destroy();
          peer.tts?.interrupt();
        }
        connManager.remove(peerId);
      }
    };

    // Register peer
    connManager.add(peerId, {
      pc,
      audioSource,
      audioSink: null,
      dataChannel,
      storeConfig,
      visitorId: visitor_id,
      sessionId: session_id,
    });

    // Handle data channel for barge-in / VAD
    dataChannel.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'vad_state' && msg.state === 'speaking') {
          const peer = connManager.get(peerId);
          peer?.tts?.interrupt();
        }
      } catch {}
    };

    // Set remote description and create answer
    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Wait for ICE gathering
    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') resolve();
      };
    });

    res.json({
      peerId,
      sdp: pc.localDescription.sdp,
      sessionId: session_id || uuidv4(),
    });
  } catch (err) {
    console.error('[offer] Error:', err.message);
    res.status(500).json({ error: 'Failed to establish connection' });
  }
});

// Disconnect
app.post('/disconnect', (req, res) => {
  const { peerId } = req.body;
  if (peerId) {
    const peer = connManager.get(peerId);
    if (peer) {
      peer.asr?.destroy();
      peer.tts?.interrupt();
    }
    connManager.remove(peerId);
  }
  res.json({ ok: true });
});

// ─── Start Server ───────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`[gateway] Shopmata Voice Gateway running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[gateway] Shutting down...');
  connManager.destroy();
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  connManager.destroy();
  server.close(() => process.exit(0));
});

export { app, connManager, ConnectionManager, TTSManager, WhisperASR, buildSystemPrompt };
