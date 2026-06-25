/* AirPad — browser client. Handles PIN, WebSocket, gestures, keyboard, media. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // -------------------------------------------------------- Settings
  const settings = {
    sens: parseFloat(localStorage.getItem("ap_sens") || "1.6"),
    natural: localStorage.getItem("ap_natural") !== "0",
    haptics: localStorage.getItem("ap_haptics") !== "0",
  };

  function haptic(ms = 8) {
    if (!settings.haptics) return;
    if (navigator.vibrate) navigator.vibrate(ms);
  }

  // -------------------------------------------------------- WebSocket
  let ws = null;
  let connected = false;
  let queue = [];
  let token = localStorage.getItem("ap_token") || new URLSearchParams(location.search).get("token");

  function setStatus(ok, text) {
    $("statusDot").classList.toggle("ok", ok);
    $("statusText").textContent = text;
  }

  function send(obj) {
    if (connected && ws.readyState === 1) {
      ws.send(JSON.stringify(obj));
    } else {
      // only buffer discrete actions, not the motion stream
      if (obj.t !== "m" && obj.t !== "scroll") queue.push(obj);
    }
  }

  // shortcut for the dominant "send + vibrate" gesture
  function tap(obj, ms = 8) { send(obj); haptic(ms); }

  function connect() {
    if (!token) return showPin();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    setStatus(false, "Connexion…");
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    // authenticate via the first message (keeps the PIN out of the URL)
    ws.onopen = () => ws.send(JSON.stringify({ t: "auth", token }));

    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === "auth") {
        if (m.ok) {
          connected = true;
          localStorage.setItem("ap_token", token);
          setStatus(true, "Connecté");
          hidePin();
          queue.forEach((q) => ws.send(JSON.stringify(q)));
          queue = [];
        } else {
          connected = false;
          localStorage.removeItem("ap_token");
          token = null;
          showPin("Code PIN incorrect");
        }
      } else if (m.t === "vol") {
        applyVol(m);
      } else if (m.t === "clip") {
        applyClip(m);
      }
    };
    ws.onclose = () => {
      connected = false;
      setStatus(false, "Déconnecté — reconnexion…");
      if (token) setTimeout(connect, 1200);
    };
    ws.onerror = () => ws.close();
  }

  // -------------------------------------------------------- PIN screen
  const pinScreen = $("pinScreen");
  let pinBuf = "";

  function showPin(err = "") {
    pinBuf = "";
    renderPinDots();
    $("pinError").textContent = err;
    pinScreen.classList.remove("hidden");
    $("app").classList.add("hidden");
    if (err) {
      pinScreen.classList.remove("shake");
      void pinScreen.offsetWidth; // restart the animation
      pinScreen.classList.add("shake");
      haptic(30);
    }
  }
  function hidePin() {
    pinScreen.classList.add("hidden");
    $("app").classList.remove("hidden");
  }
  function renderPinDots() {
    const dots = $("pinDots").children;
    for (let i = 0; i < dots.length; i++) dots[i].classList.toggle("filled", i < pinBuf.length);
  }
  function pinDigit(d) {
    if (pinBuf.length >= 6) return;
    pinBuf += d;
    haptic(6);
    renderPinDots();
    if (pinBuf.length === 6) {
      token = pinBuf;
      setTimeout(connect, 150);
    }
  }
  document.querySelectorAll(".pin-pad button[data-d]").forEach((b) =>
    b.addEventListener("click", () => pinDigit(b.dataset.d))
  );
  $("pinDel").addEventListener("click", () => { pinBuf = pinBuf.slice(0, -1); renderPinDots(); });

  // -------------------------------------------------------- Trackpad
  const pad = $("pad");
  const padHint = $("padHint");

  // gesture state
  let mode = null;          // null | "move" | "scroll"
  let lastX = 0, lastY = 0; // last position (1 finger)
  let startX = 0, startY = 0, startT = 0, moved = false;
  let twoLastX = 0, twoLastY = 0, twoMoved = false;
  let accDx = 0, accDy = 0; // sub-pixel motion accumulator
  let lastTapUp = 0;        // for double-tap-drag
  let dragging = false;

  const MOVE_THRESH = 4;    // px before a touch counts as a move
  const TAP_MAX_MS = 250;
  const DOUBLE_TAP_MS = 320;

  function fadeHint() { padHint.classList.add("fade"); }  // idempotent

  function accel(d) {
    return d * settings.sens;  // applies the configured sensitivity
  }

  pad.addEventListener("touchstart", (e) => {
    e.preventDefault();
    pad.classList.add("active");
    const now = e.timeStamp;
    if (e.touches.length === 1) {
      const t = e.touches[0];
      // double-tap-drag: a new touch right after a tap => grab (press)
      if (now - lastTapUp < DOUBLE_TAP_MS && !dragging) {
        dragging = true;
        send({ t: "down", b: "left" });
        haptic(14);
      }
      mode = "move";
      lastX = t.clientX; lastY = t.clientY;
      startX = t.clientX; startY = t.clientY; startT = now;
      moved = false;
      accDx = accDy = 0;
    } else if (e.touches.length === 2) {
      mode = "scroll";
      const a = e.touches[0], b = e.touches[1];
      twoLastX = (a.clientX + b.clientX) / 2;
      twoLastY = (a.clientY + b.clientY) / 2;
      twoMoved = false;
    }
  }, { passive: false });

  pad.addEventListener("touchmove", (e) => {
    e.preventDefault();
    if (mode === "move" && e.touches.length === 1) {
      const t = e.touches[0];
      const dx = t.clientX - lastX, dy = t.clientY - lastY;
      lastX = t.clientX; lastY = t.clientY;
      if (!moved && Math.hypot(t.clientX - startX, t.clientY - startY) > MOVE_THRESH) {
        moved = true; fadeHint();
      }
      if (moved) {
        accDx += accel(dx); accDy += accel(dy);
        const ix = Math.trunc(accDx), iy = Math.trunc(accDy);
        if (ix || iy) {
          accDx -= ix; accDy -= iy;
          send({ t: "m", dx: ix, dy: iy });
        }
      }
    } else if (mode === "scroll" && e.touches.length === 2) {
      const a = e.touches[0], b = e.touches[1];
      const cx = (a.clientX + b.clientX) / 2, cy = (a.clientY + b.clientY) / 2;
      const dx = cx - twoLastX, dy = cy - twoLastY;
      twoLastX = cx; twoLastY = cy;
      if (Math.hypot(dx, dy) > 0.5) { twoMoved = true; fadeHint(); }
      const dir = settings.natural ? 1 : -1;
      send({ t: "scroll", dx: dx * dir, dy: dy * dir });
    }
  }, { passive: false });

  pad.addEventListener("touchend", (e) => {
    const now = e.timeStamp;
    pad.classList.remove("active");

    if (dragging && e.touches.length === 0) {
      dragging = false;
      send({ t: "up", b: "left" });
      haptic(10);
    }

    if (mode === "move" && e.touches.length === 0) {
      // tap = left click
      if (!moved && (now - startT) < TAP_MAX_MS) {
        send({ t: "click", b: "left" });
        haptic(8);
        lastTapUp = now;
      } else {
        lastTapUp = 0;
      }
    } else if (mode === "scroll") {
      // two fingers pressed-released without moving = right click
      if (!twoMoved && e.touches.length === 0) {
        send({ t: "click", b: "right" });
        haptic(12);
      }
    }
    if (e.touches.length === 0) mode = null;
  }, { passive: false });

  pad.addEventListener("touchcancel", () => {
    pad.classList.remove("active");
    if (dragging) { dragging = false; send({ t: "up", b: "left" }); }
    mode = null;
  });

  // -------------------------------------------------------- Mouse (desktop)
  // The trackpad also works with a mouse on a large screen.
  let mouseDown = false, mLastX = 0, mLastY = 0;
  pad.addEventListener("mousedown", (e) => { mouseDown = true; mLastX = e.clientX; mLastY = e.clientY; });
  window.addEventListener("mouseup", () => { mouseDown = false; });
  pad.addEventListener("mousemove", (e) => {
    if (!mouseDown) return;
    fadeHint();
    const dx = e.clientX - mLastX, dy = e.clientY - mLastY;
    mLastX = e.clientX; mLastY = e.clientY;
    send({ t: "m", dx: accel(dx), dy: accel(dy) });
  });
  pad.addEventListener("wheel", (e) => {
    e.preventDefault();
    const dir = settings.natural ? -1 : 1;
    send({ t: "scroll", dx: e.deltaX * dir, dy: e.deltaY * dir });
  }, { passive: false });

  // -------------------------------------------------------- Click buttons
  $("btnLeft").addEventListener("click", () => { send({ t: "click", b: "left" }); haptic(8); });
  $("btnRight").addEventListener("click", () => { send({ t: "click", b: "right" }); haptic(8); });

  // -------------------------------------------------------- Keyboard
  const kbd = $("kbd");
  const btnKeyboard = $("btnKeyboard");
  const specialBar = $("specialBar");
  let kbdOpen = false;
  let ctrlArmed = false;
  const PAD = " ".repeat(12); // buffer used to detect backspace

  function resetPad() {
    kbd.value = PAD;
    kbd.selectionStart = kbd.selectionEnd = PAD.length;
  }

  function openKeyboard() {
    kbdOpen = true;
    btnKeyboard.classList.add("on");
    specialBar.classList.remove("hidden");
    resetPad();
    kbd.focus();
  }
  function closeKeyboard() {
    kbdOpen = false;
    btnKeyboard.classList.remove("on");
    specialBar.classList.add("hidden");
    kbd.blur();
  }
  btnKeyboard.addEventListener("click", () => { kbdOpen ? closeKeyboard() : openKeyboard(); haptic(6); });
  kbd.addEventListener("blur", () => { if (kbdOpen) closeKeyboard(); });

  // de-dupe between keydown (desktop) and input (mobile)
  let lastSpecial = { k: "", t: 0 };
  function sendSpecial(k) {
    lastSpecial = { k, t: performance.now() };
    send({ t: "special", k });
    haptic(5);
  }
  function recentlyHandled(k) {
    return lastSpecial.k === k && (performance.now() - lastSpecial.t) < 120;
  }

  function sendChar(text) {
    if (!text) return;
    if (ctrlArmed) {
      send({ t: "combo", mods: ["ctrl"], k: text });
      disarmCtrl();
    } else {
      send({ t: "type", text });
    }
  }

  // Touch typing (native iOS/Android keyboard) -> via the input event
  kbd.addEventListener("input", (e) => {
    const it = e.inputType || "";
    if (it.startsWith("insert")) {
      if (it === "insertLineBreak" || it === "insertParagraph") {
        if (!recentlyHandled("enter")) sendSpecial("enter");
      } else if (e.data) {
        sendChar(e.data);
      } else {
        // composition / prediction: pick up whatever overflows the buffer
        const extra = kbd.value.replace(PAD, "");
        if (extra) sendChar(extra);
      }
    } else if (it.startsWith("delete")) {
      if (!recentlyHandled("backspace")) sendSpecial("backspace");
    }
    resetPad();
  });

  // Hardware keystrokes (desktop, iPad BT keyboard) -> via keydown
  kbd.addEventListener("keydown", (e) => {
    const k = e.key;
    const map = {
      Enter: "enter", Backspace: "backspace", Tab: "tab", Escape: "esc",
      ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
      Delete: "delete", Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
    };
    if (e.metaKey || e.ctrlKey || e.altKey) {
      // shortcut such as Ctrl+C
      if (k.length === 1) {
        e.preventDefault();
        const mods = [];
        if (e.ctrlKey || e.metaKey) mods.push("ctrl");
        if (e.altKey) mods.push("alt");
        if (e.shiftKey) mods.push("shift");
        send({ t: "combo", mods, k: k.toLowerCase() });
        return;
      }
    }
    if (map[k]) {
      e.preventDefault();
      sendSpecial(map[k]);
    }
    // printable characters go through the input event
  });

  // [data-special] buttons (keyboard bar, remote, D-pad) are wired by the
  // global click delegation further down.
  const ctrlBtn = $("ctrlToggle");
  function disarmCtrl() { ctrlArmed = false; ctrlBtn.classList.remove("mod-on"); }
  ctrlBtn.addEventListener("click", (e) => {
    e.preventDefault();
    ctrlArmed = !ctrlArmed;
    ctrlBtn.classList.toggle("mod-on", ctrlArmed);
    haptic(6);
    if (kbdOpen) kbd.focus();
  });

  // -------------------------------------------------------- Sheets
  // Convention: each sheet has #<name>Sheet + #<name>Backdrop. Only one panel
  // open at a time. Declarative opening via [data-open-sheet].
  const SHEETS = {};
  let openName = null;

  function registerSheet(name, onOpen) {
    const sheet = $(name + "Sheet"), backdrop = $(name + "Backdrop");
    backdrop.addEventListener("click", () => closeSheet(name));
    SHEETS[name] = { sheet, backdrop, onOpen };
  }
  function openSheet(name) {
    if (openName && openName !== name) closeSheet(openName);
    const s = SHEETS[name];
    if (!s) return;
    s.backdrop.classList.remove("hidden");
    s.sheet.classList.remove("hidden");
    openName = name;
    if (s.onOpen) s.onOpen();
  }
  function closeSheet(name) {
    const s = SHEETS[name];
    if (!s) return;
    s.backdrop.classList.add("hidden");
    s.sheet.classList.add("hidden");
    if (openName === name) openName = null;
  }

  registerSheet("media", () => send({ t: "vol_get" }));  // read volume on open
  ["settings", "more", "text", "remote", "system"].forEach((n) => registerSheet(n));

  const sens = $("sens"); sens.value = settings.sens;
  sens.addEventListener("input", () => { settings.sens = parseFloat(sens.value); localStorage.setItem("ap_sens", sens.value); });
  const natural = $("natural"); natural.checked = settings.natural;
  natural.addEventListener("change", () => { settings.natural = natural.checked; localStorage.setItem("ap_natural", natural.checked ? "1" : "0"); });
  const hap = $("haptics"); hap.checked = settings.haptics;
  hap.addEventListener("change", () => { settings.haptics = hap.checked; localStorage.setItem("ap_haptics", hap.checked ? "1" : "0"); });
  $("btnForget").addEventListener("click", () => {
    localStorage.removeItem("ap_token");
    token = null;
    if (ws) ws.close();
    closeSheet("settings");
    showPin();
  });

  // -------------------------------------------------------- Screen preview
  const screenImg = $("screenImg");
  const btnScreen = $("btnScreen");
  let screenOn = false, screenTimer = null;

  // a single reused Image to preload the next frame (zero alloc per tick)
  const screenLoader = new Image();
  screenLoader.onload = () => { if (screenOn) screenImg.src = screenLoader.src; scheduleScreen(); };
  screenLoader.onerror = () => scheduleScreen();

  function screenTick() {
    if (!screenOn || !token) return;
    const w = Math.min(900, Math.round(pad.clientWidth * (window.devicePixelRatio || 1)));
    screenLoader.src = `/screen.jpg?token=${encodeURIComponent(token)}&w=${w}&q=50&_=${performance.now()}`;
  }
  function scheduleScreen() { if (screenOn) screenTimer = setTimeout(screenTick, 120); }

  btnScreen.addEventListener("click", () => {
    screenOn = !screenOn;
    btnScreen.classList.toggle("on", screenOn);
    screenImg.classList.toggle("hidden", !screenOn);
    haptic(6);
    if (screenOn) { fadeHint(); screenTick(); }
    else { clearTimeout(screenTimer); screenImg.removeAttribute("src"); }
  });

  // -------------------------------------------------------- Volume
  const volSlider = $("volSlider"), volPct = $("volPct"), volMute = $("volMute");
  let volThrottle = 0;

  function applyVol(m) {
    const pct = Math.round((m.v || 0) * 100);
    volSlider.value = pct;
    volPct.textContent = pct + "%";
    volMute.classList.toggle("muted", !!m.muted);
    volMute.textContent = m.muted ? "🔇" : "🔊";
  }
  volSlider.addEventListener("input", () => {
    volPct.textContent = volSlider.value + "%";
    const now = performance.now();
    if (now - volThrottle > 90) { volThrottle = now; send({ t: "vol_set", v: volSlider.value / 100 }); }
  });
  volSlider.addEventListener("change", () => send({ t: "vol_set", v: volSlider.value / 100 }));
  volMute.addEventListener("click", () => { send({ t: "vol_mute" }); haptic(6); });

  // -------------------------------------------------------- Text / clipboard
  const textArea = $("textArea");
  function applyClip(m) { textArea.value = m.text || ""; }
  $("textSend").addEventListener("click", () => {
    const txt = textArea.value;
    if (txt) { send({ t: "type", text: txt }); haptic(10); }
  });
  $("clipPush").addEventListener("click", () => {
    send({ t: "clip_set", text: textArea.value });
    haptic(8);
    flash($("clipPush"), "Copié ✓");
  });
  $("clipPull").addEventListener("click", () => { send({ t: "clip_get" }); haptic(6); });

  function flash(btn, msg) {
    const old = btn.textContent;
    btn.textContent = msg;
    setTimeout(() => { btn.textContent = old; }, 1100);
  }

  // -------------------------------------------------------- System (2-tap confirm)
  // Note: the remote (D-pad) relies entirely on [data-special] / [data-media],
  // wired by the global click delegation further down.
  const sysArmed = {};
  $("systemSheet").querySelectorAll("[data-sys]").forEach((b) => {
    b.addEventListener("click", () => {
      const a = b.dataset.sys;
      const danger = b.classList.contains("sys-danger");
      const span = b.querySelector("span");
      if (danger && !sysArmed[a]) {
        sysArmed[a] = true;
        b.dataset.orig = span.textContent;
        span.textContent = "Confirmer ?";
        b.style.background = "rgba(255,69,58,.32)";
        haptic(20);
        setTimeout(() => {
          if (sysArmed[a]) { sysArmed[a] = false; span.textContent = b.dataset.orig; b.style.background = ""; }
        }, 3000);
        return;
      }
      sysArmed[a] = false;
      if (span && b.dataset.orig) { span.textContent = b.dataset.orig; b.style.background = ""; }
      send({ t: "sys", action: a });
      haptic(15);
      closeSheet("system");
    });
  });

  // -------------------------------------------------------- Click delegation
  // One handler for: opening sheets, special keys and media keys, wherever
  // they live (keyboard bar, remote, D-pad, media sheet…).
  document.addEventListener("click", (e) => {
    const opener = e.target.closest("[data-open-sheet]");
    if (opener) { openSheet(opener.dataset.openSheet); haptic(6); return; }
    const sp = e.target.closest("[data-special]");
    if (sp) { sendSpecial(sp.dataset.special); if (kbdOpen) kbd.focus(); return; }
    const md = e.target.closest("[data-media]");
    if (md) { tap({ t: "media", k: md.dataset.media }); return; }
  });

  // -------------------------------------------------------- Startup
  // strip the token from the URL so it doesn't linger
  if (location.search.includes("token=")) {
    history.replaceState(null, "", location.pathname);
  }
  // prevent rubber-banding / accidental zoom
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("touchmove", (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

  connect();
})();
