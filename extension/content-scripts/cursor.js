const OPENCODE_CURSOR_VERSION = 2;

if (globalThis.__opencodeCursorInstalledVersion !== OPENCODE_CURSOR_VERSION) {
  globalThis.__opencodeCursorInstalledVersion = OPENCODE_CURSOR_VERSION;

  const ROOT_ID = "opencode-agent-cursor-root";
  const CURSOR_SIZE = 36;
  const BOUNDS_MARGIN = 0;
  const SPRING = 0.32;
  const ARRIVAL_DISTANCE = 0.8;

  let host;
  let shadow;
  const cursors = new Map();

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function viewportBounds() {
    const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const offsetLeft = viewport?.offsetLeft ?? 0;
    const offsetTop = viewport?.offsetTop ?? 0;
    return {
      minX: offsetLeft + BOUNDS_MARGIN,
      minY: offsetTop + BOUNDS_MARGIN,
      maxX: offsetLeft + width - BOUNDS_MARGIN,
      maxY: offsetTop + height - BOUNDS_MARGIN,
    };
  }

  function clampPoint(point) {
    const bounds = viewportBounds();
    return {
      x: clamp(point.x, bounds.minX, bounds.maxX),
      y: clamp(point.y, bounds.minY, bounds.maxY),
    };
  }

  function ensureHost() {
    if (shadow) return shadow;

    document.getElementById(ROOT_ID)?.remove();
    host = document.createElement("div");
    host.id = ROOT_ID;
    host.style.cssText = [
      "position: fixed",
      "left: 0",
      "top: 0",
      "z-index: 2147483647",
      "pointer-events: none",
      "contain: layout style paint",
    ].join(";");
    document.documentElement.appendChild(host);

    shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .cursor {
        position: fixed;
        left: 0;
        top: 0;
        width: ${CURSOR_SIZE}px;
        height: ${CURSOR_SIZE}px;
        transform: translate3d(-100px, -100px, 0) rotate(-8deg);
        transform-origin: 7px 7px;
        opacity: 0;
        filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.24));
        transition: opacity 140ms ease-out;
        will-change: transform, opacity;
      }

      .cursor.visible {
        opacity: 1;
      }

      .cursor img,
      .fallback svg {
        display: block;
        width: 100%;
        height: 100%;
      }

      .fallback {
        display: none;
      }

      .cursor.image-error img {
        display: none;
      }

      .cursor.image-error .fallback {
        display: block;
      }
    `;
    shadow.append(style);
    return shadow;
  }

  function createCursor(cursorId) {
    ensureHost();

    const cursor = document.createElement("div");
    cursor.className = "cursor";
    cursor.dataset.cursorId = cursorId;

    const image = document.createElement("img");
    image.alt = "";
    image.decoding = "async";
    image.addEventListener("error", () => cursor.classList.add("image-error"));

    const fallback = document.createElement("div");
    fallback.className = "fallback";
    fallback.innerHTML = `
      <svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M5 3L31 16L19.7 20L15 32L5 3Z" fill="#10A37F" stroke="white" stroke-width="3"/>
      </svg>
    `;

    cursor.append(image, fallback);
    shadow.append(cursor);

    return {
      cursorId,
      cursor,
      image,
      current: { x: -100, y: -100 },
      target: { x: -100, y: -100 },
      moveSequence: 0,
      pendingArrival: null,
      raf: null,
    };
  }

  function entryFor(cursorId) {
    const id = typeof cursorId === "string" && cursorId.length > 0 ? cursorId : "default";
    let entry = cursors.get(id);
    if (!entry) {
      entry = createCursor(id);
      cursors.set(id, entry);
    }
    return entry;
  }

  function transformFor(entry, point) {
    const dx = entry.target.x - entry.current.x;
    const dy = entry.target.y - entry.current.y;
    const angle = Math.atan2(dy, dx) * 180 / Math.PI + 45;
    const stretch = clamp(Math.hypot(dx, dy) / 160, 0, 0.18);
    return `translate3d(${point.x}px, ${point.y}px, 0) rotate(${angle}deg) scale(${1 + stretch}, ${1 - stretch * 0.45})`;
  }

  function sendRuntimeMessage(message, callback) {
    try {
      const result = chrome.runtime.sendMessage(message, callback);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      // The page may be unloading while an animation callback fires.
    }
  }

  function notifyArrived(entry, sequence) {
    sendRuntimeMessage({ type: "OPENCODE_CURSOR_ARRIVED", cursorId: entry.cursorId, moveSequence: sequence });
  }

  function animate(entry) {
    const dx = entry.target.x - entry.current.x;
    const dy = entry.target.y - entry.current.y;
    const distance = Math.hypot(dx, dy);

    if (distance <= ARRIVAL_DISTANCE) {
      entry.current = entry.target;
      entry.cursor.style.transform = transformFor(entry, entry.current);
      entry.raf = null;
      if (entry.pendingArrival === entry.moveSequence) {
        const sequence = entry.pendingArrival;
        entry.pendingArrival = null;
        notifyArrived(entry, sequence);
      }
      return;
    }

    entry.current = {
      x: entry.current.x + dx * SPRING,
      y: entry.current.y + dy * SPRING,
    };
    entry.cursor.style.transform = transformFor(entry, entry.current);
    entry.raf = requestAnimationFrame(() => animate(entry));
  }

  function applyState(state) {
    const entry = entryFor(state.cursorId);
    if (state.imageUrl && entry.image.src !== state.imageUrl) {
      entry.cursor.classList.remove("image-error");
      entry.image.src = state.imageUrl;
    }

    entry.target = clampPoint({ x: Number(state.x), y: Number(state.y) });
    entry.moveSequence = Number.isInteger(state.moveSequence) ? state.moveSequence : entry.moveSequence + 1;
    entry.pendingArrival = entry.moveSequence;
    const visible = state.visible !== false;
    entry.cursor.classList.toggle("visible", visible);

    if (!visible) {
      entry.pendingArrival = null;
      notifyArrived(entry, entry.moveSequence);
      return;
    }

    if (entry.raf == null) entry.raf = requestAnimationFrame(() => animate(entry));
  }

  function applyStates(states) {
    for (const state of states) applyState(state);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "OPENCODE_CURSOR_STATE") return false;
    applyState(message);
    sendResponse({ ok: true });
    return true;
  });

  function refreshCurrentState() {
    sendRuntimeMessage({ type: "OPENCODE_GET_CURSOR_STATE" }, (response) => {
      if (chrome.runtime.lastError) return;
      if (Array.isArray(response?.states)) applyStates(response.states);
      else if (response?.state) applyState(response.state);
    });
  }

  function refreshBounds() {
    for (const entry of cursors.values()) {
      entry.target = clampPoint(entry.target);
      entry.current = clampPoint(entry.current);
      entry.cursor.style.transform = transformFor(entry, entry.current);
    }
  }

  window.addEventListener("resize", refreshBounds);
  window.visualViewport?.addEventListener("resize", refreshCurrentState);
  window.visualViewport?.addEventListener("scroll", refreshCurrentState);
  refreshCurrentState();
}
