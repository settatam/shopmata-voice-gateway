import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { verifyRelayAuth, visitorIdForCaller, stripForSpeech, handleRelaySocket } from '../relay.js';

const KEY = 'internal-secret';

function signedParams({ shop = 's.myshopify.com', caller = '+15551234567', callSid = 'CA1', exp } = {}) {
  exp = exp ?? Math.floor(Date.now() / 1000) + 300;
  const sig = crypto.createHmac('sha256', KEY).update(`${shop}|${caller}|${callSid}|${exp}`).digest('hex');
  return { shop, caller, call_sid: callSid, exp: String(exp), sig };
}

describe('verifyRelayAuth', () => {
  test('accepts a validly signed, unexpired URL', () => {
    expect(verifyRelayAuth(signedParams(), KEY)).toBe(true);
  });

  test('rejects an expired signature', () => {
    const params = signedParams({ exp: Math.floor(Date.now() / 1000) - 10 });
    expect(verifyRelayAuth(params, KEY)).toBe(false);
  });

  test('rejects a tampered shop', () => {
    const params = { ...signedParams(), shop: 'attacker.myshopify.com' };
    expect(verifyRelayAuth(params, KEY)).toBe(false);
  });

  test('rejects when unsigned or key missing', () => {
    expect(verifyRelayAuth({ shop: 's' }, KEY)).toBe(false);
    expect(verifyRelayAuth(signedParams(), '')).toBe(false);
  });
});

describe('visitorIdForCaller', () => {
  test('is stable per caller — the person-graph join key', () => {
    expect(visitorIdForCaller('+15551234567')).toBe(visitorIdForCaller('+15551234567'));
    expect(visitorIdForCaller('+15551234567')).not.toBe(visitorIdForCaller('+15550000000'));
    expect(visitorIdForCaller('+15551234567')).toMatch(/^phone-[0-9a-f]{24}$/);
  });
});

describe('stripForSpeech', () => {
  test('removes markdown, links and urls', () => {
    expect(stripForSpeech('**Bold** and [a link](https://x.test) plus https://y.test end'))
      .toBe('Bold and a link plus end');
  });

  test('drops table rows', () => {
    expect(stripForSpeech('Before\n| a | b |\nAfter')).toBe('Before After');
  });
});

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.send = jest.fn((raw) => this.sent.push(JSON.parse(raw)));
  }

  message(obj) {
    this.emit('message', Buffer.from(JSON.stringify(obj)));
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeFetch(responses) {
  let call = 0;
  const impl = jest.fn(async () => {
    const r = responses[Math.min(call++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return { ok: true, json: async () => r };
  });
  return impl;
}

function connect(ws, fetchImpl) {
  handleRelaySocket(ws, signedParams(), {
    apiUrl: 'https://shopmata.test',
    internalKey: KEY,
    fetchImpl,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

describe('handleRelaySocket', () => {
  test('a prompt goes to the brain and the reply is spoken', async () => {
    const ws = new FakeSocket();
    const fetchImpl = makeFetch([{ session_id: 'sess-1', reply: '**We have** the Datejust.' }]);
    connect(ws, fetchImpl);

    ws.message({ type: 'prompt', voicePrompt: 'Do you have a Datejust?' });
    await flush();

    expect(ws.sent).toEqual([{ type: 'text', token: 'We have the Datejust.', last: true }]);

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.surface).toBe('phone');
    expect(body.shop).toBe('s.myshopify.com');
    expect(body.visitor_id).toBe(visitorIdForCaller('+15551234567'));
  });

  test('the chat session id carries across turns — one conversation per call', async () => {
    const ws = new FakeSocket();
    const fetchImpl = makeFetch([
      { session_id: 'sess-1', reply: 'First.' },
      { session_id: 'sess-1', reply: 'Second.' },
    ]);
    connect(ws, fetchImpl);

    ws.message({ type: 'prompt', voicePrompt: 'Hello' });
    await flush();
    ws.message({ type: 'prompt', voicePrompt: 'And also' });
    await flush();

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).session_id).toBeNull();
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).session_id).toBe('sess-1');
  });

  test('an approved transfer speaks the hand-off line then ends with handoffData', async () => {
    const ws = new FakeSocket();
    const fetchImpl = makeFetch([{
      session_id: 'sess-1',
      reply: 'Connecting you now.',
      transfer: { number: '+15551112222', reason: 'asked for a human' },
    }]);
    connect(ws, fetchImpl);

    ws.message({ type: 'prompt', voicePrompt: 'Get me a person' });
    await flush();

    expect(ws.sent[0]).toEqual({ type: 'text', token: 'Connecting you now.', last: true });
    expect(ws.sent[1].type).toBe('end');
    expect(JSON.parse(ws.sent[1].handoffData)).toEqual({ transfer_number: '+15551112222', reason: 'asked for a human' });
  });

  test('a brain failure gets a spoken apology, never dead air', async () => {
    const ws = new FakeSocket();
    const fetchImpl = makeFetch([new Error('boom')]);
    connect(ws, fetchImpl);

    ws.message({ type: 'prompt', voicePrompt: 'Hello?' });
    await flush();

    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0].token).toMatch(/call back in a few minutes/);
  });

  test('an empty transcription asks the caller to repeat', async () => {
    const ws = new FakeSocket();
    const fetchImpl = makeFetch([{}]);
    connect(ws, fetchImpl);

    ws.message({ type: 'prompt', voicePrompt: '   ' });
    await flush();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ws.sent[0].token).toMatch(/say it again/);
  });
});
