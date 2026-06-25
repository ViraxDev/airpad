#!/usr/bin/env python3
"""
AirPad — control this PC's mouse + keyboard from any web browser.

Backend: FastAPI + WebSocket. Mouse via XTEST (python-xlib), keyboard via
xdotool, clipboard in pure Xlib, screen capture via mss, audio via wpctl.
The web page is served on the LAN; access is protected by a PIN code.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import queue
import secrets
import select
import socket
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

import mss
from PIL import Image

from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from Xlib import X, Xatom, display
from Xlib.ext import xtest
from Xlib.protocol import event

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
TOKEN_FILE = BASE_DIR / ".token"

PORT = int(os.environ.get("PORT", "8000"))
HOST = os.environ.get("HOST", "0.0.0.0")  # 0.0.0.0 = reachable on the LAN

# ---------------------------------------------------------------------------
# Authentication (6-digit PIN, generated once) + brute-force throttling
# ---------------------------------------------------------------------------

def load_or_create_pin() -> str:
    # An empty/whitespace-only PIN env var is ignored on purpose: it must never
    # collapse to "" (which would let an empty token authenticate).
    forced = (os.environ.get("PIN") or "").strip()
    if forced:
        return forced
    if TOKEN_FILE.exists():
        pin = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if pin:
            return pin
    pin = f"{secrets.randbelow(1_000_000):06d}"
    TOKEN_FILE.write_text(pin, encoding="utf-8")
    return pin


PIN = load_or_create_pin()

# Per-IP failed-attempt tracking to slow brute-force of the PIN.
_AUTH_MAX_FAILS = 8        # failures within the window before a temporary block
_AUTH_WINDOW = 60.0        # seconds the failure counter spans
_AUTH_BLOCK = 60.0         # seconds an IP stays blocked after too many failures
_auth_fails: dict[str, dict] = {}


def auth_ok(ip: str, token: str) -> bool:
    """Constant-time PIN check with per-IP lockout after repeated failures."""
    now = time.monotonic()
    rec = _auth_fails.get(ip)
    if rec and rec["until"] > now:
        return False  # currently locked out
    if secrets.compare_digest(token or "", PIN):
        _auth_fails.pop(ip, None)
        return True
    if not rec or now - rec["first"] > _AUTH_WINDOW:
        rec = {"count": 0, "first": now, "until": 0.0}
        _auth_fails[ip] = rec
    rec["count"] += 1
    if rec["count"] >= _AUTH_MAX_FAILS:
        rec["until"] = now + _AUTH_BLOCK
    return False

# ---------------------------------------------------------------------------
# Injection — mouse via XTEST (fast, persistent), keyboard via xdotool
# ---------------------------------------------------------------------------

_dpy = display.Display()

BUTTONS = {"left": 1, "middle": 2, "right": 3}

# key names -> xdotool keysym
SPECIAL_KEYS = {
    "enter": "Return", "return": "Return",
    "backspace": "BackSpace", "delete": "Delete",
    "tab": "Tab", "esc": "Escape", "escape": "Escape", "space": "space",
    "up": "Up", "down": "Down", "left": "Left", "right": "Right",
    "home": "Home", "end": "End", "pageup": "Prior", "pagedown": "Next",
    "caps": "Caps_Lock",
    "f1": "F1", "f2": "F2", "f3": "F3", "f4": "F4", "f5": "F5", "f6": "F6",
    "f7": "F7", "f8": "F8", "f9": "F9", "f10": "F10", "f11": "F11", "f12": "F12",
}

MEDIA_KEYS = {
    "volup": "XF86AudioRaiseVolume",
    "voldown": "XF86AudioLowerVolume",
    "mute": "XF86AudioMute",
    "playpause": "XF86AudioPlay",
    "next": "XF86AudioNext",
    "prev": "XF86AudioPrev",
    "fullscreen": "F11",
}

MODIFIERS = {
    "ctrl": "ctrl", "control": "ctrl", "alt": "alt", "shift": "shift",
    "meta": "super", "cmd": "super", "super": "super", "win": "super",
}


def _run(*cmd: str, capture: bool = False) -> str:
    """Run an external command, swallowing errors (including a missing binary)."""
    try:
        out = subprocess.run(
            list(cmd), check=False, text=True,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.DEVNULL)
        return out.stdout or ""
    except FileNotFoundError:
        print(f"[airpad] command not found: {cmd[0]}")
        return ""


def _xdotool(*args: str) -> None:
    _run("xdotool", *args)


def _button(name: str) -> int:
    return BUTTONS.get(name, 1)


# Sub-pixel accumulator for scrolling (touch deltas are fine-grained).
_scroll_acc = {"x": 0.0, "y": 0.0}
SCROLL_STEP = 18.0  # pixels per wheel notch


# ---------------------------------------------------------------------------
# Clipboard — pure Xlib (owns the CLIPBOARD selection)
# ---------------------------------------------------------------------------

class Clipboard:
    """Manages the X11 clipboard with no external dependency (no xclip/xsel)."""

    def __init__(self) -> None:
        self.d = display.Display()
        self.win = self.d.screen().root.create_window(
            0, 0, 1, 1, 0, self.d.screen().root_depth)
        self.SEL = self.d.intern_atom("CLIPBOARD")
        self.TARGETS = self.d.intern_atom("TARGETS")
        self.UTF8 = self.d.intern_atom("UTF8_STRING")
        self.PROP = self.d.intern_atom("AIRPAD_CLIP")
        self.text = ""
        self._res = ""
        self._got = threading.Event()
        self._cmd_r, self._cmd_w = os.pipe()
        self._cmds: "queue.Queue" = queue.Queue()
        threading.Thread(target=self._loop, daemon=True).start()

    def set_text(self, text: str) -> None:
        self._cmds.put(("set", text))
        os.write(self._cmd_w, b"x")

    def get_text(self, timeout: float = 0.6) -> str:
        self._got.clear()
        self._cmds.put(("get", None))
        os.write(self._cmd_w, b"x")
        self._got.wait(timeout)
        return self._res

    def _loop(self) -> None:
        fd = self.d.fileno()
        while True:
            r, _, _ = select.select([fd, self._cmd_r], [], [])
            if self._cmd_r in r:
                os.read(self._cmd_r, 4096)
                while not self._cmds.empty():
                    cmd, arg = self._cmds.get()
                    (self._do_set if cmd == "set" else self._do_get)(arg)
            if fd in r:
                for _ in range(self.d.pending_events()):
                    self._handle(self.d.next_event())

    def _do_set(self, text: str) -> None:
        self.text = text
        self.win.set_selection_owner(self.SEL, X.CurrentTime)
        self.d.flush()

    def _do_get(self, _arg=None) -> None:
        owner = self.d.get_selection_owner(self.SEL)
        own_id = getattr(owner, "id", owner)
        if own_id == 0 or own_id == self.win.id:
            self._res = self.text
            self._got.set()
            return
        self.win.convert_selection(self.SEL, self.UTF8, self.PROP, X.CurrentTime)
        self.d.flush()

    def _handle(self, e) -> None:
        if e.type == X.SelectionRequest:
            self._serve(e)
        elif e.type == X.SelectionNotify:
            if e.property == X.NONE:
                self._res = ""
            else:
                data = self.win.get_full_property(self.PROP, X.AnyPropertyType)
                self._res = data.value.decode("utf-8", "replace") if data else ""
                self.win.delete_property(self.PROP)
            self._got.set()

    def _serve(self, e) -> None:
        client = e.requestor
        prop = e.property if e.property != X.NONE else e.target
        if e.target == self.TARGETS:
            client.change_property(prop, Xatom.ATOM, 32, [self.UTF8, self.TARGETS])
        elif e.target in (self.UTF8, Xatom.STRING):
            client.change_property(prop, e.target, 8, self.text.encode("utf-8"))
        else:
            prop = X.NONE
        client.send_event(event.SelectionNotify(
            time=e.time, requestor=e.requestor, selection=e.selection,
            target=e.target, property=prop))
        self.d.flush()


clipboard = Clipboard()


# ---------------------------------------------------------------------------
# Audio (wpctl / PipeWire) and system controls
# ---------------------------------------------------------------------------

SINK = "@DEFAULT_AUDIO_SINK@"


def volume_get() -> dict:
    out = _run("wpctl", "get-volume", SINK, capture=True)
    parts = out.split()
    try:
        v = float(parts[1]) if len(parts) > 1 else 0.0
    except ValueError:
        v = 0.0
    return {"t": "vol", "v": round(v, 2), "muted": "[MUTED]" in out}


def volume_set(v: float) -> float:
    v = max(0.0, min(1.0, float(v)))
    _run("wpctl", "set-volume", SINK, f"{v:.2f}")
    return v


def volume_mute_toggle() -> None:
    _run("wpctl", "set-mute", SINK, "toggle")


SYSTEM_ACTIONS = {
    "lock": ["xdg-screensaver", "lock"],
    "suspend": ["systemctl", "suspend"],
    "poweroff": ["systemctl", "poweroff"],
    "reboot": ["systemctl", "reboot"],
}


def system_action(action: str) -> None:
    cmd = SYSTEM_ACTIONS.get(action)
    if cmd:
        _run(*cmd)


# ---------------------------------------------------------------------------
# Message routing
# ---------------------------------------------------------------------------

INSTANT = {"m", "click", "down", "up", "scroll"}  # mouse: handled inline (fast)


def handle_instant(msg: dict) -> None:
    """High-frequency mouse events — local Xlib calls, ~microseconds."""
    t = msg.get("t")

    if t == "m":
        dx = int(round(msg.get("dx", 0)))
        dy = int(round(msg.get("dy", 0)))
        if dx or dy:
            xtest.fake_input(_dpy, X.MotionNotify, detail=True, x=dx, y=dy)
            _dpy.flush()

    elif t == "click":
        b = _button(msg.get("b", "left"))
        for _ in range(2 if msg.get("double") else 1):
            xtest.fake_input(_dpy, X.ButtonPress, b)
            xtest.fake_input(_dpy, X.ButtonRelease, b)
        _dpy.flush()

    elif t == "down":
        xtest.fake_input(_dpy, X.ButtonPress, _button(msg.get("b", "left")))
        _dpy.flush()

    elif t == "up":
        xtest.fake_input(_dpy, X.ButtonRelease, _button(msg.get("b", "left")))
        _dpy.flush()

    elif t == "scroll":
        _scroll_acc["x"] += msg.get("dx", 0)
        _scroll_acc["y"] += msg.get("dy", 0)
        sy = int(_scroll_acc["y"] / SCROLL_STEP)
        sx = int(_scroll_acc["x"] / SCROLL_STEP)
        if sy:
            _scroll_acc["y"] -= sy * SCROLL_STEP
            btn = 4 if sy > 0 else 5  # 4 = wheel up, 5 = wheel down
            for _ in range(abs(sy)):
                xtest.fake_input(_dpy, X.ButtonPress, btn)
                xtest.fake_input(_dpy, X.ButtonRelease, btn)
        if sx:
            _scroll_acc["x"] -= sx * SCROLL_STEP
            btn = 7 if sx > 0 else 6  # 6/7 = horizontal scroll
            for _ in range(abs(sx)):
                xtest.fake_input(_dpy, X.ButtonPress, btn)
                xtest.fake_input(_dpy, X.ButtonRelease, btn)
        _dpy.flush()


def handle_blocking(msg: dict):
    """Anything that may block (subprocess, clipboard). Runs off the asyncio
    loop via to_thread; may return a response to push back to the client."""
    t = msg.get("t")

    if t == "type":  # printable text (handles accents/unicode via xdotool)
        text = msg.get("text", "")
        if text:
            _xdotool("type", "--clearmodifiers", "--", text)

    elif t == "special":
        key = SPECIAL_KEYS.get(str(msg.get("k", "")).lower())
        if key:
            _xdotool("key", "--clearmodifiers", key)

    elif t == "media":
        key = MEDIA_KEYS.get(str(msg.get("k", "")).lower())
        if key:
            _xdotool("key", key)

    elif t == "combo":  # e.g. Ctrl+C
        mods = [MODIFIERS[m] for m in msg.get("mods", []) if m in MODIFIERS]
        main = msg.get("k")
        if not main:
            return None
        main = SPECIAL_KEYS.get(str(main).lower(), main)
        _xdotool("key", "--clearmodifiers", "+".join(mods + [main]))

    elif t == "clip_set":  # put text into the PC clipboard
        clipboard.set_text(msg.get("text", ""))

    elif t == "clip_get":  # read the PC clipboard -> sent back to the phone
        return {"t": "clip", "text": clipboard.get_text()}

    elif t == "vol_set":
        # the slider already knows the value; no need to read the hardware back
        volume_set(msg.get("v", 0.5))

    elif t == "vol_mute":
        volume_mute_toggle()
        return volume_get()

    elif t == "vol_get":
        return volume_get()

    elif t == "sys":
        system_action(str(msg.get("action", "")))

    return None


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(title="AirPad")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    return resp


def _client_ip(scope_client) -> str:
    return scope_client.host if scope_client else "?"


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


_capture_local = threading.local()


def _sct():
    """mss instance reused per thread (FastAPI serves /screen.jpg in a threadpool)
    — avoids reopening an X connection on every capture."""
    sct = getattr(_capture_local, "sct", None)
    if sct is None:
        sct = _capture_local.sct = mss.MSS()
    return sct


def _capture_jpeg(width: int, quality: int) -> bytes:
    """Capture the primary screen, resize and encode as JPEG (blocking call)."""
    sct = _sct()
    shot = sct.grab(sct.monitors[1])
    img = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
    width = max(160, min(1280, width))
    if img.width > width:
        img = img.resize((width, max(1, round(width * img.height / img.width))))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=max(20, min(85, quality)))
    return buf.getvalue()


@app.get("/screen.jpg")
def screen(request: Request, token: str = "", w: int = 480, q: int = 50):
    # token stays in the query string (an <img> can't send headers); it is
    # rate-limited like the WebSocket and never written to logs (log_level=warning).
    if not auth_ok(_client_ip(request.client), token):
        return Response(status_code=403)
    try:
        data = _capture_jpeg(w, q)
    except Exception as exc:
        return Response(content=f"capture error: {exc}", status_code=500)
    return Response(content=data, media_type="image/jpeg",
                    headers={"Cache-Control": "no-store"})


def _same_origin(websocket: WebSocket) -> bool:
    """Reject cross-site WebSocket connections (CSWSH). A missing Origin (native
    clients) is allowed; a present Origin must match the Host we were reached on."""
    origin = websocket.headers.get("origin")
    if not origin:
        return True
    return urlparse(origin).netloc == websocket.headers.get("host", "")


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    if not _same_origin(websocket):
        await websocket.close(code=1008)
        return
    ip = _client_ip(websocket.client)
    # First message must authenticate (keeps the PIN out of the connection URL).
    try:
        first = json.loads(await websocket.receive_text())
    except Exception:
        await websocket.close(code=1008)
        return
    token = first.get("token", "") if first.get("t") == "auth" else ""
    if not auth_ok(ip, token):
        await websocket.send_text(json.dumps({"t": "auth", "ok": False}))
        await asyncio.sleep(0.4)  # slow down credential stuffing
        await websocket.close(code=1008)
        return
    await websocket.send_text(json.dumps({"t": "auth", "ok": True}))
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
                if msg.get("t") in INSTANT:
                    handle_instant(msg)  # mouse: inline, minimal latency
                else:
                    resp = await asyncio.to_thread(handle_blocking, msg)
                    if resp is not None:
                        await websocket.send_text(json.dumps(resp))
            except Exception as exc:  # a malformed message must not kill the session
                print(f"[airpad] ignored message: {exc}")
    except WebSocketDisconnect:
        pass


app.mount("/", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ---------------------------------------------------------------------------
# Startup + banner (URL + QR code to scan)
# ---------------------------------------------------------------------------

def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # sends nothing, just resolves the local IP
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def banner() -> None:
    ip = lan_ip()
    url = f"http://{ip}:{PORT}/?token={PIN}"
    line = "─" * 52
    print(f"\n┌{line}┐")
    print("  📱  AirPad — control your mouse/keyboard from the web")
    print(f"└{line}┘\n")
    print(f"  Open this URL on your phone (same WiFi):\n")
    print(f"      \033[1;36m{url}\033[0m\n")
    print(f"  PIN code: \033[1;33m{PIN}\033[0m   (saved in .token)\n")
    try:
        import qrcode
        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.make(fit=True)
        qr.print_ascii(invert=True)
        print("\n  ⤴  Scan this QR code with your phone's camera.\n")
    except Exception:
        print("  (install 'qrcode' to show a scannable QR code)\n")


if __name__ == "__main__":
    import uvicorn

    banner()
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
