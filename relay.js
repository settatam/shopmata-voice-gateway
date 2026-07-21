import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

// ─── Twilio ConversationRelay handler ───────────────────────────────────────
//
// PSTN ingress for the phone concierge. Twilio does ASR/TTS/barge-in and
// streams transcribed caller turns here; every turn goes to the salesman
// brain (POST /api/storefront/voice-message, surface=phone) and the reply
// text goes back for TTS. The six load-bearing behaviours from the Amazon
// Connect bridge (connect/handler.py) survive here:
//
//   1. visitor_id = "phone-" + sha1(caller)[:24]  — person-graph join key
//   2. chat_session_id carried across turns       — one conversation per call
//   3. shop resolved once (Laravel embeds it in the signed wss URL)
//   4. strip_for_speech                           — TTS reads markdown aloud
//   5. transfer_to hand-off                       — via end + handoffData
//   6. graceful failure                           — spoken apology, not dead air
//
// Twilio does not sign WebSocket connects, so Laravel signs the URL instead:
// sig = HMAC-SHA256("shop|caller|call_sid|exp", VOICE_GATEWAY_INTERNAL_KEY).

export function verifyRelayAuth(params, internalKey, nowSeconds = Math.floor(Date.now() / 1000)) {
  const { shop, caller = '', call_sid: callSid = '', exp, sig } = params;

  if (!shop || !exp || !sig || !internalKey) return false;
  if (Number(exp) < nowSeconds) return false;

  const expected = crypto
    .createHmac('sha256', internalKey)
    .update(`${shop}|${caller}|${callSid}|${exp}`)
    .digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig));

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function visitorIdForCaller(caller) {
  return 'phone-' + crypto.createHash('sha1').update(caller || 'unknown').digest('hex').slice(0, 24);
}

// TTS reads punctuation literally — strip tables, markdown marks, links and
// bare URLs before speaking. Port of connect/handler.py strip_for_speech.
export function stripForSpeech(text) {
  return String(text || '')
    .replace(/\|[^\n]*\|/g, ' ')
    .replace(/[*_#`>]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 2900);
}

const APOLOGY = "I'm having a little trouble right now. Please call back in a few minutes, or leave your name and number with the store.";

export function createRelaySession({ shop, caller, apiUrl, internalKey, fetchImpl = fetch }) {
  const state = { chatSessionId: null };

  async function respondTo(voicePrompt) {
    const res = await fetchImpl(`${apiUrl}/api/storefront/voice-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': internalKey,
      },
      body: JSON.stringify({
        shop,
        visitor_id: visitorIdForCaller(caller),
        session_id: state.chatSessionId,
        message: voicePrompt,
        surface: 'phone',
        caller_number: caller || null,
      }),
    });

    if (!res.ok) throw new Error(`voice-message ${res.status}`);

    const data = await res.json();
    state.chatSessionId = data.session_id || state.chatSessionId;

    return {
      reply: stripForSpeech(data.reply || 'Could you tell me a bit more?'),
      transfer: data.transfer && data.transfer.number ? data.transfer : null,
    };
  }

  return { state, respondTo };
}

export function attachRelay(server, { apiUrl, internalKey, fetchImpl = fetch, log = console } = {}) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://relay.local');
    if (url.pathname !== '/relay') return;

    const params = Object.fromEntries(url.searchParams.entries());

    if (!verifyRelayAuth(params, internalKey)) {
      log.warn?.('[relay] rejected connection: bad signature');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => handleRelaySocket(ws, params, { apiUrl, internalKey, fetchImpl, log }));
  });

  return wss;
}

export function handleRelaySocket(ws, params, { apiUrl, internalKey, fetchImpl = fetch, log = console }) {
  const session = createRelaySession({ shop: params.shop, caller: params.caller, apiUrl, internalKey, fetchImpl });
  let turn = 0;

  const speak = (text) => ws.send(JSON.stringify({ type: 'text', token: text, last: true }));

  ws.on('message', async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (message.type) {
      case 'setup':
        log.info?.(`[relay] session start shop=${params.shop} call=${params.call_sid || message.callSid || ''}`);
        break;

      case 'prompt': {
        const thisTurn = ++turn;
        const voicePrompt = (message.voicePrompt || '').trim();
        if (!voicePrompt) {
          speak("Sorry, I didn't catch that — could you say it again?");
          break;
        }

        try {
          const { reply, transfer } = await session.respondTo(voicePrompt);

          // Barge-in: if the caller spoke again while we were thinking,
          // Twilio already interrupted the TTS — drop the stale reply.
          if (thisTurn !== turn) break;

          speak(reply || 'Could you tell me a bit more?');

          if (transfer) {
            ws.send(JSON.stringify({
              type: 'end',
              handoffData: JSON.stringify({ transfer_number: transfer.number, reason: transfer.reason || null }),
            }));
          }
        } catch (err) {
          log.error?.(`[relay] turn failed: ${err.message}`);
          if (thisTurn === turn) speak(APOLOGY);
        }
        break;
      }

      case 'dtmf':
        log.info?.(`[relay] dtmf digit=${message.digit}`);
        break;

      case 'error':
        log.error?.(`[relay] twilio error: ${JSON.stringify(message)}`);
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    log.info?.(`[relay] session closed shop=${params.shop} turns=${turn}`);
  });
}
