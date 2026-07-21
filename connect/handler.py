"""
Lex V2 fulfillment bridge: every caller utterance -> Shopmata's salesman
brain (voice-message, surface=phone) -> spoken reply via ElicitIntent so
the conversation stays open. The chat session id rides in Lex session
attributes, so the whole call is ONE Shopmata conversation with full
memory, tools, and outcome attribution.

Multi-store: the contact flow passes the dialed number (dialed_number) and
caller id (caller_number) as session attributes. On the first turn we
resolve the dialed number to a store via /api/storefront/phone/resolve and
cache the shop domain in session attributes for the rest of the call.
Falls back to the SHOP_DOMAIN env (single-store pilot) when the number
isn't mapped or the attribute is missing.
"""
import hashlib
import json
import os
import urllib.parse
import urllib.request

API_BASE = os.environ.get("SHOPMATA_API_BASE", "https://shopmata.com")
INTERNAL_KEY = os.environ["SHOPMATA_INTERNAL_KEY"]
FALLBACK_SHOP = os.environ.get("SHOP_DOMAIN", "")  # pilot fallback


def handler(event, context):
    transcript = (event.get("inputTranscript") or "").strip()
    attrs = (event.get("sessionState", {}) or {}).get("sessionAttributes") or {}

    caller = attrs.get("caller_number", "unknown")
    visitor_id = "phone-" + hashlib.sha1(caller.encode()).hexdigest()[:24]

    shop = attrs.get("shop_domain") or resolve_shop(attrs)
    if not shop:
        return respond(attrs, "I'm sorry, this line isn't set up yet. Please call the store directly during business hours.")
    attrs["shop_domain"] = shop

    if not transcript:
        return respond(attrs, "Sorry, I didn't catch that — could you say it again?")

    body = json.dumps({
        "shop": shop,
        "visitor_id": visitor_id,
        "session_id": attrs.get("chat_session_id") or None,
        "message": transcript,
        "surface": "phone",
        "caller_number": attrs.get("caller_number") or None,
        "demo_token": attrs.get("demo_token") or None,
    }).encode()

    req = urllib.request.Request(
        API_BASE + "/api/storefront/voice-message",
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Internal-Key": INTERNAL_KEY,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = json.loads(resp.read().decode())
    except Exception:
        return respond(attrs, "I'm having a little trouble right now. Please call back in a few minutes, or leave your name and number with the store.")

    attrs["chat_session_id"] = data.get("session_id", attrs.get("chat_session_id", ""))
    reply = strip_for_speech(data.get("reply") or "Could you tell me a bit more?")

    # Live transfer: the brain approved handing this call to a human. Close
    # the Lex loop (control returns to the contact flow) with the AI's
    # hand-off line; the flow branches on transfer_to and dials it.
    transfer = data.get("transfer") or {}
    if transfer.get("number"):
        attrs["transfer_to"] = transfer["number"]
        return close(event, attrs, reply or "One moment — connecting you now.")

    return respond(attrs, reply)


def resolve_shop(attrs):
    """Dialed number -> store (once per call; result cached by the caller).

    Also passes the caller id so the API can recognize returning customers
    (resolve stores the recognition server-side; greeting personalization
    consumes attrs['caller_first_name'] when the contact flow supports it).
    """
    dialed = (attrs.get("dialed_number") or "").strip()
    if not dialed:
        return FALLBACK_SHOP or None

    query = urllib.parse.urlencode({
        "number": dialed,
        "caller": attrs.get("caller_number", ""),
    })
    req = urllib.request.Request(
        API_BASE + "/api/storefront/phone/resolve?" + query,
        headers={"X-Internal-Key": INTERNAL_KEY},
    )

    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode())
    except Exception:
        return FALLBACK_SHOP or None

    caller_info = data.get("caller") or {}
    if caller_info.get("first_name"):
        attrs["caller_first_name"] = caller_info["first_name"]
    attrs["store_open_now"] = "1" if data.get("open_now") else "0"
    attrs["store_name"] = data.get("store_name") or ""

    return data.get("shop") or FALLBACK_SHOP or None


def strip_for_speech(text):
    import re
    text = re.sub(r"\|[^\n]*\|", " ", text)          # tables
    text = re.sub(r"[*_#`>]+", "", text)              # markdown marks
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)  # links -> label
    text = re.sub(r"https?://\S+", "", text)          # bare urls
    text = re.sub(r"\s{2,}", " ", text).strip()
    return text[:2900]  # stay under Lex message limits


def close(event, attrs, message):
    """End the Lex conversation so the contact flow resumes (and transfers)."""
    intent = (event.get("sessionState", {}) or {}).get("intent") or {"name": "FallbackIntent"}
    intent["state"] = "Fulfilled"
    return {
        "sessionState": {
            "sessionAttributes": attrs,
            "dialogAction": {"type": "Close"},
            "intent": intent,
        },
        "messages": [{"contentType": "PlainText", "content": message}],
    }


def respond(attrs, message):
    return {
        "sessionState": {
            "sessionAttributes": attrs,
            "dialogAction": {"type": "ElicitIntent"},
        },
        "messages": [{"contentType": "PlainText", "content": message}],
    }
