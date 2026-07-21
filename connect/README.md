# Amazon Connect phone concierge (production, being re-platformed to Twilio)

This is the **live** inbound phone path for the Shopmata salesman. It ran only
in AWS until now — nothing here was in version control, so the reference
implementation for the phone concierge existed in exactly one place that no
one could review or roll back. That's what this directory fixes.

## Architecture

```
PSTN ──▶ Connect DID +17186638040
           │  contact flow: shopmata-ai-salesman
           │    sets caller_number = $.CustomerEndpoint.Address
           │         dialed_number = $.SystemEndpoint.Address
           │    plays a STATIC greeting
           ▼
        ConnectParticipantWithLexBot ──▶ Lex V2 bot "shopmata-concierge"
                                           │  every utterance
                                           ▼
                                         handler.py (Lambda: shopmata-connect-lex-bridge)
                                           │  POST /api/storefront/voice-message
                                           │       surface=phone, X-Internal-Key
                                           ▼
                                         Shopmata (Laravel) — the brain
```

Laravel owns everything that matters: the session, memory, tools, outcome
attribution. Connect is transport only. That's why swapping it for Twilio is a
transport change, not a rewrite.

## Resources (account 277503816012, us-east-1)

| Resource | Identifier |
|---|---|
| Connect instance | `shopmata-voice` — `1463ffcb-6a85-4649-8aae-e8e597e472c2` |
| DID | `+17186638040` |
| Lex V2 bot | `shopmata-concierge` — `LU05C8ELLT` |
| Lambda | `shopmata-connect-lex-bridge` (python3.12, handler `handler.handler`, 30s, 128MB) |
| Inbound flow | `shopmata-ai-salesman` — `1b7346ac-54f4-480c-9732-77c84bfe7abb` |
| Outbound flow | `shopmata-demo-tryout-outbound` — `fb70ce93-a5af-4d1a-8192-c868ad353ce0` |

## Environment (names only — never commit values)

| Var | Purpose |
|---|---|
| `SHOPMATA_INTERNAL_KEY` | Shared secret for `X-Internal-Key`. Must match Laravel's `services.voice_gateway.internal_key`. |
| `SHOP_DOMAIN` | Single-store pilot fallback when the dialed number isn't mapped. |
| `SHOPMATA_API_BASE` | Defaults to `https://shopmata.com`. |

## Deploy

```sh
cd connect && zip -j /tmp/bridge.zip handler.py
aws lambda update-function-code \
  --function-name shopmata-connect-lex-bridge \
  --zip-file fileb:///tmp/bridge.zip --region us-east-1 --profile shopmata
```

Flows are exported for reference, not deployed from here — Connect flow import
rewrites ARNs, so re-import needs care.

## Behaviour that must survive the move to Twilio

These are load-bearing and were learned in production. Anything replacing this
bridge has to reproduce them:

1. **`visitor_id = "phone-" + sha1(caller_number)[:24]`** — stable per caller
   across calls. This is the key the person graph joins on; change it and every
   returning caller becomes a stranger.
2. **Session continuity** — `chat_session_id` is echoed back into session
   attributes so the whole call is ONE Shopmata conversation.
3. **Shop resolution once per call** — `dialed_number` → `/phone/resolve` →
   `shop`, then cached. Falls back to `SHOP_DOMAIN`.
4. **`strip_for_speech`** — removes tables, markdown, links and bare URLs, caps
   length. TTS reads punctuation literally; skipping this makes the AI say
   "asterisk asterisk".
5. **Live transfer** — when the brain approves a handoff, `transfer.number` is
   put in `transfer_to` and the Lex loop closes so the flow dials it. On Twilio
   this becomes a `<Dial>`, either mid-call or from the `action` URL.
6. **Graceful failure** — API error and empty-transcript paths both answer with
   a spoken apology rather than dead air.

## Known limitation this design can't fix

The greeting is a **static string in the contact flow** — currently hardcoded
to "Thanks for calling Aurelia Fine Jewelers!". `handler.py` resolves
`caller_first_name` from `/phone/resolve` and notes it's usable "when the
contact flow supports it" — it doesn't. So the personalized
"Hi Sarah, is this about the Datejust?" open is **not live today**, and it's
awkward to do in Connect because the greeting plays before the Lambda runs.

Twilio's ConversationRelay takes `welcomeGreeting` as an attribute of the TwiML
we generate per call, after we've already resolved the caller. So the
re-platform unlocks the personalized greeting rather than merely porting parity.
