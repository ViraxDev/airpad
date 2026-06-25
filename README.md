# 📱 AirPad

Control your **Linux PC's mouse and keyboard from any device's web browser**
on the same network — iPhone, iPad, Android, another laptop. Nothing to install
on the phone, just open a URL.

Built for the "PC plugged into the TV over HDMI" case: drive it from the couch.

<p align="center"><em>Mobile-first, Apple-inspired UI · trackpad · keyboard · clipboard · live screen preview · media & system controls</em></p>

## Features

- **Trackpad** — move the cursor, tap to left-click, two-finger tap to right-click,
  two-finger scroll, double-tap-and-drag.
- **Full keyboard** — native phone keyboard, accents/Unicode, special keys
  (Esc, Tab, arrows) and `Ctrl+…` shortcuts.
- **Text & clipboard** — type a whole string at once, push it to the PC clipboard
  or read the PC clipboard back (pure-Xlib, no `xclip`/`xsel` needed).
- **Live screen preview** — a low-rate JPEG stream of the PC screen on your phone,
  overlaid on the trackpad, so you can see what you're doing without looking at the TV.
- **Media & volume** — play/pause, prev/next, real volume slider with the current level.
- **Remote (D-pad)** — ▲▼◀▶ + OK to navigate media apps without the trackpad.
- **System** — lock, suspend, reboot, power off (destructive actions need a 2-tap confirm).
- **Secure-ish** — 6-digit PIN, LAN-only, the screen preview is PIN-gated too.

## Requirements

- Linux running an **X11** session (not Wayland — see notes).
- `xdotool` for keyboard injection: `sudo apt install xdotool`
- `wpctl` (PipeWire) for the volume slider — already present on modern desktops.
- Python 3.9+.

Everything else is pure Python (`fastapi`, `uvicorn`, `python-xlib`, `mss`,
`Pillow`, `qrcode`) installed automatically into a local virtualenv.

## Quick start

```bash
git clone https://github.com/ViraxDev/airpad.git
cd airpad
./run.sh
```

The first run creates a virtualenv and installs the dependencies. The terminal
then prints a **URL and a QR code**:

1. Scan the QR code with your phone's camera (or type the URL in your browser).
2. Enter the **PIN** shown in the terminal.
3. Done.

> iOS tip: *Share → Add to Home Screen* launches it full-screen, but it's
> optional — it stays a plain web page.

## Gestures

| Gesture | Action |
|---|---|
| One finger drag | Move the cursor |
| One-finger tap | Left click |
| Two-finger tap | Right click |
| Two-finger drag | Scroll |
| Double-tap then drag | Drag-and-drop |

## How it works

```
[ phone / any browser ]  ──WiFi──>  [ Linux PC: web server + input injection ]
       (web page)                          (run once)
```

- **Backend** — FastAPI serves the page and a WebSocket. Mouse moves are injected
  inline via **XTEST** (`python-xlib`) for minimal latency; everything that can
  block (keyboard via `xdotool`, clipboard, volume, capture) runs in a thread.
- **Clipboard** — implemented in pure Xlib by owning the `CLIPBOARD` selection,
  so no `xclip`/`xsel` dependency.
- **Screen preview** — captured with `mss`, resized/encoded with `Pillow`, served
  on demand as a PIN-gated JPEG the page polls.
- **Frontend** — a single static page (HTML/CSS/JS, no build step), mobile-first,
  Apple HIG-inspired (system font, glassmorphism, safe-area insets).

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8000` | Port the server listens on |
| `PIN` | random 6 digits | Force a specific PIN (otherwise generated once into `.token`) |

```bash
PORT=9000 PIN=123456 ./run.sh
```

## Notes & limitations

- **X11 only.** Injection relies on XTEST/`xdotool`, which don't work under
  Wayland. On Wayland you'd need a `ydotool`/uinput-based backend instead.
- The PIN is stored in `.token` (git-ignored). Delete it to rotate it.
- This is meant for a trusted home network. It is not hardened for exposure to
  the public internet.

## License

MIT
