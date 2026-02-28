import os
import time
import math
import logging
import asyncio
from typing import Optional, Tuple, Deque, Dict, Any
from collections import deque
import uuid

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

import webrtcvad
from faster_whisper import WhisperModel

# -----------------------
# Configuration
# -----------------------
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "auto")
WHISPER_COMPUTE = os.getenv("WHISPER_COMPUTE", "float16")
WHISPER_LANG = os.getenv("WHISPER_LANG", None)

# VAD settings
VAD_AGGR = int(os.getenv("VAD_AGGR", "2"))
VAD_START_MS = int(os.getenv("VAD_START_MS", "200"))
VAD_END_MS = int(os.getenv("VAD_END_MS", "500"))
FRAME_MS = 20
SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2
FRAME_BYTES = int(SAMPLE_RATE * (FRAME_MS / 1000.0) * SAMPLE_WIDTH)
MAX_UTTER_MS = int(os.getenv("MAX_UTTER_MS", "45000"))
PRE_ROLL_MS = int(os.getenv("PRE_ROLL_MS", "200"))

# Gate settings
MIN_UTTER_MS = int(os.getenv("MIN_UTTER_MS", "900"))
MIN_RMS_DBFS = float(os.getenv("MIN_RMS_DBFS", "-45"))
DEDUP_TTL_MS = int(os.getenv("DEDUP_TTL_MS", "5000"))

# Logging
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
LOG_TRANSCRIPTS = os.getenv("LOG_TRANSCRIPTS", "final").lower()
LOG_CHUNK_BYTES = os.getenv("LOG_CHUNK_BYTES", "0").lower() in ("1", "true", "yes")

# Performance
MAX_CONNECTIONS = int(os.getenv("MAX_CONNECTIONS", "100"))
TRANSCRIPTION_TIMEOUT = float(os.getenv("TRANSCRIPTION_TIMEOUT", "30.0"))

# -----------------------
# Logging setup
# -----------------------
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL.upper(), logging.INFO),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
log = logging.getLogger("asr")


def preview(s: str, n: int = 300) -> str:
    if not s:
        return s
    t = " ".join(s.split())
    return (t[:n] + "\u2026") if len(t) > n else t


# -----------------------
# Global model instance
# -----------------------
_model: Optional[WhisperModel] = None
_device_actual = "cpu"


def _pick_device():
    global _device_actual
    if WHISPER_DEVICE == "cuda":
        _device_actual = "cuda"
    elif WHISPER_DEVICE == "cpu":
        _device_actual = "cpu"
    else:
        try:
            import torch
            _device_actual = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            _device_actual = "cpu"
    return _device_actual


def load_model():
    global _model, _device_actual
    try:
        _device_actual = _pick_device()
        log.info(f"Loading Whisper model: {WHISPER_MODEL} on {_device_actual} with {WHISPER_COMPUTE}")

        _model = WhisperModel(
            WHISPER_MODEL,
            device=_device_actual,
            compute_type=WHISPER_COMPUTE,
            cpu_threads=4,
            num_workers=2
        )

        # Test the model with empty audio
        test_audio = np.zeros(16000, dtype=np.float32)
        segments, info = _model.transcribe(test_audio, beam_size=1)
        list(segments)

        log.info("Whisper model loaded successfully")
        return True

    except Exception as e:
        log.error(f"Failed to load Whisper model: {e}")
        return False


# -----------------------
# FastAPI app
# -----------------------
app = FastAPI(
    title="Shopmata Whisper ASR Service",
    description="Real-time speech recognition with WebSocket streaming",
    version="1.0.0"
)


@app.on_event("startup")
def startup_event():
    if not load_model():
        log.error("Failed to load model during startup")


# -----------------------
# Core components
# -----------------------
class VADGate:
    def __init__(self, aggressiveness: int, start_ms: int, end_ms: int):
        self.vad = webrtcvad.Vad(int(aggressiveness))
        self.frame_bytes = FRAME_BYTES
        self.start_frames = max(1, math.ceil(start_ms / FRAME_MS))
        self.end_frames = max(1, math.ceil(end_ms / FRAME_MS))
        self.voiced = 0
        self.silence = 0
        self.active = False

    def feed(self, frame: bytes) -> Optional[str]:
        if len(frame) != self.frame_bytes:
            return None

        try:
            is_voiced = self.vad.is_speech(frame, SAMPLE_RATE)
        except Exception as e:
            log.warning(f"VAD processing error: {e}")
            return None

        if is_voiced:
            self.voiced += 1
            self.silence = 0
            if not self.active and self.voiced >= self.start_frames:
                self.active = True
                return "speech_start"
        else:
            self.silence += 1
            self.voiced = 0
            if self.active and self.silence >= self.end_frames:
                self.active = False
                return "speech_end"

        return None


class ASRConnectionManager:
    def __init__(self, max_connections: int = 100):
        self.max_connections = max_connections
        self.active_connections: Dict[str, Any] = {}
        self._lock = asyncio.Lock()

    async def connect(self, session_id: str, session_data: Any) -> bool:
        async with self._lock:
            if len(self.active_connections) >= self.max_connections:
                return False
            self.active_connections[session_id] = session_data
            log.info(f"Connection established: {session_id} (total: {len(self.active_connections)})")
            return True

    def disconnect(self, session_id: str):
        if session_id in self.active_connections:
            del self.active_connections[session_id]
            log.info(f"Connection closed: {session_id} (total: {len(self.active_connections)})")

    def get_connection_count(self) -> int:
        return len(self.active_connections)


connection_manager = ASRConnectionManager(MAX_CONNECTIONS)


# -----------------------
# Audio processing utilities
# -----------------------
def int16_bytes_to_float32(arr_bytes: bytes) -> np.ndarray:
    if not arr_bytes:
        return np.zeros(0, dtype=np.float32)
    i16 = np.frombuffer(arr_bytes, dtype=np.int16)
    return i16.astype(np.float32) / 32768.0


def calculate_rms_dbfs(audio_f32: np.ndarray) -> float:
    if audio_f32.size == 0:
        return -120.0
    squared = np.square(audio_f32)
    if squared.size == 0:
        return -120.0
    rms = np.sqrt(np.mean(squared))
    return 20.0 * np.log10(rms) if rms > 1e-9 else -120.0


def is_canned_phrase(text: str) -> bool:
    canned_phrases = (
        "thanks for watching",
        "thanks for tuning in",
        "don't forget to like and subscribe",
        "see you next time",
        "please like and subscribe",
    )
    clean_text = (text or "").strip().lower().strip(" .!?,;:")
    if len(clean_text) > 80:
        return False
    return any(clean_text.startswith(phrase) or clean_text == phrase
               for phrase in canned_phrases)


# -----------------------
# Transcription service
# -----------------------
async def transcribe_utterance(audio_bytes: bytes) -> Tuple[str, Optional[float]]:
    if not _model:
        raise RuntimeError("Whisper model not loaded")

    if not audio_bytes:
        return "", None

    audio_float = int16_bytes_to_float32(audio_bytes)

    def _transcribe_sync():
        segments, info = _model.transcribe(
            audio_float,
            language=WHISPER_LANG,
            beam_size=5,
            vad_filter=False,
            word_timestamps=False,
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            log_prob_threshold=-0.6,
            compression_ratio_threshold=2.4,
        )
        text = "".join(segment.text for segment in segments).strip()
        return text, info.avg_logprob if hasattr(info, 'avg_logprob') else None

    try:
        text, avg_logprob = await asyncio.wait_for(
            run_in_threadpool(_transcribe_sync),
            timeout=TRANSCRIPTION_TIMEOUT
        )

        if LOG_TRANSCRIPTS in ("final", "all"):
            log.info(f"Transcription completed: {preview(text, 400)}")

        return text, avg_logprob

    except asyncio.TimeoutError:
        log.error("Transcription timeout")
        raise
    except Exception as e:
        log.error(f"Transcription error: {e}")
        raise


# -----------------------
# HTTP endpoints
# -----------------------
@app.get("/health")
async def health_check():
    status = "healthy" if _model else "unhealthy"
    return JSONResponse({
        "status": status,
        "service": "shopmata-whisper-asr",
        "timestamp": time.time(),
        "model": {
            "loaded": _model is not None,
            "name": WHISPER_MODEL,
            "device": _device_actual,
            "compute_type": WHISPER_COMPUTE
        },
        "connections": {
            "active": connection_manager.get_connection_count(),
            "max": MAX_CONNECTIONS
        },
        "audio": {
            "sample_rate": SAMPLE_RATE,
            "frame_ms": FRAME_MS,
            "max_utterance_ms": MAX_UTTER_MS
        },
        "vad": {
            "aggressiveness": VAD_AGGR,
            "start_ms": VAD_START_MS,
            "end_ms": VAD_END_MS
        }
    })


@app.get("/stats")
async def get_stats():
    return JSONResponse({
        "active_connections": connection_manager.get_connection_count(),
        "max_connections": MAX_CONNECTIONS,
        "model_loaded": _model is not None
    })


# -----------------------
# WebSocket session state
# -----------------------
class SessionState:
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.vad = VADGate(VAD_AGGR, VAD_START_MS, VAD_END_MS)
        self.capturing = False
        self.utter = bytearray()
        self.utter_start_ts = 0.0
        pre_roll_frames = max(0, math.ceil(PRE_ROLL_MS / FRAME_MS))
        self.recent_frames: Deque[bytes] = deque(maxlen=pre_roll_frames)
        self.last_final_text = ""
        self.last_final_time = 0.0
        self.bytes_received = 0
        self.frames_processed = 0
        self.last_stats_time = time.time()


# -----------------------
# WebSocket endpoint
# -----------------------
@app.websocket("/v1/asr/stream")
async def websocket_endpoint(websocket: WebSocket):
    session_id = websocket.query_params.get("session_id") or f"sess-{uuid.uuid4().hex[:8]}"
    session_state = SessionState(session_id)

    if not await connection_manager.connect(session_id, session_state):
        await websocket.close(code=1008, reason="Server at capacity")
        return

    try:
        await websocket.accept()
        log.info(f"WebSocket connected: {session_id}")
        await websocket.send_json({"event": "connected", "session_id": session_id})

        carry = b""

        while True:
            data = await websocket.receive_bytes()
            session_state.bytes_received += len(data)

            if LOG_CHUNK_BYTES and log.isEnabledFor(logging.DEBUG):
                log.debug(f"[{session_id}] received {len(data)} bytes")

            carry = await process_audio_data(websocket, session_state, carry + data)
            await log_session_stats(session_state)

    except WebSocketDisconnect:
        log.info(f"WebSocket disconnected: {session_id}")
    except Exception as e:
        log.error(f"WebSocket error [{session_id}]: {e}")
        try:
            await websocket.send_json({"error": "Internal server error"})
        except Exception:
            pass
    finally:
        connection_manager.disconnect(session_id)


async def process_audio_data(websocket: WebSocket, session: SessionState, buffer: bytes) -> bytes:
    offset = 0
    while offset + FRAME_BYTES <= len(buffer):
        frame = buffer[offset:offset + FRAME_BYTES]
        offset += FRAME_BYTES

        session.frames_processed += 1
        session.recent_frames.append(frame)

        vad_event = session.vad.feed(frame)
        current_time = time.time()

        if vad_event == "speech_start":
            await handle_speech_start(websocket, session, current_time)
        elif vad_event == "speech_end":
            await handle_speech_end(websocket, session, current_time)

        max_utter_bytes = (MAX_UTTER_MS * SAMPLE_RATE * SAMPLE_WIDTH) // 1000
        if session.capturing and len(session.utter) < max_utter_bytes:
            session.utter.extend(frame)

    return buffer[offset:]


async def handle_speech_start(websocket: WebSocket, session: SessionState, timestamp: float):
    session.capturing = True
    session.utter.clear()

    if session.recent_frames:
        pre_frames = list(session.recent_frames)
        seeded_audio = b"".join(pre_frames)
        max_utter_bytes = (MAX_UTTER_MS * SAMPLE_RATE * SAMPLE_WIDTH) // 1000
        if len(seeded_audio) <= max_utter_bytes:
            session.utter.extend(seeded_audio)

        pre_ms = len(pre_frames) * FRAME_MS
        log.info(f"Speech started [{session.session_id}]: pre_roll={pre_ms}ms")

    session.utter_start_ts = timestamp - (len(session.recent_frames) * FRAME_MS / 1000.0)
    await websocket.send_json({"event": "speech_start"})


async def handle_speech_end(websocket: WebSocket, session: SessionState, timestamp: float):
    duration_ms = int((timestamp - session.utter_start_ts) * 1000) if session.utter_start_ts else 0
    log.info(f"Speech ended [{session.session_id}]: duration={duration_ms}ms, bytes={len(session.utter)}")

    await websocket.send_json({"event": "speech_end"})

    if not session.capturing or not session.utter:
        return

    if duration_ms < MIN_UTTER_MS:
        log.info(f"Utterance too short [{session.session_id}]: {duration_ms}ms < {MIN_UTTER_MS}ms")
        session.capturing = False
        session.utter.clear()
        return

    audio_float = int16_bytes_to_float32(bytes(session.utter))
    rms_db = calculate_rms_dbfs(audio_float)

    if rms_db < MIN_RMS_DBFS:
        log.info(f"Utterance too quiet [{session.session_id}]: {rms_db:.1f}dB < {MIN_RMS_DBFS}dB")
        session.capturing = False
        session.utter.clear()
        return

    try:
        text, _ = await transcribe_utterance(bytes(session.utter))

        if not text:
            session.capturing = False
            session.utter.clear()
            return

        if is_canned_phrase(text):
            log.info(f"Filtered canned phrase [{session.session_id}]: {preview(text, 120)}")
            session.capturing = False
            session.utter.clear()
            return

        current_time = time.time()
        if (text.strip().lower() == session.last_final_text.strip().lower() and
                (current_time - session.last_final_time) * 1000 <= DEDUP_TTL_MS):
            log.info(f"Filtered duplicate [{session.session_id}]: {preview(text, 120)}")
            session.capturing = False
            session.utter.clear()
            return

        if LOG_TRANSCRIPTS in ("final", "all"):
            log.info(f"Final transcript [{session.session_id}]: {preview(text, 400)}")

        await websocket.send_json({"text": text, "final": True})
        session.last_final_text = text
        session.last_final_time = current_time

    except Exception as e:
        log.error(f"Transcription failed [{session.session_id}]: {e}")
        await websocket.send_json({"error": "Transcription failed"})
    finally:
        session.capturing = False
        session.utter.clear()
        session.utter_start_ts = 0.0


async def log_session_stats(session: SessionState):
    current_time = time.time()
    if current_time - session.last_stats_time >= 5.0:
        if log.isEnabledFor(logging.DEBUG):
            kb_received = session.bytes_received / 1024
            log.debug(
                f"Session stats [{session.session_id}]: "
                f"frames={session.frames_processed}, "
                f"data={kb_received:.1f}KB"
            )
        session.last_stats_time = current_time

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
