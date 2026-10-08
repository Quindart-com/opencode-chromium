const OPENCODE_CURSOR_VERSION = 4;

if (!globalThis.__opencodeCursorInstalledVersion || globalThis.__opencodeCursorInstalledVersion < OPENCODE_CURSOR_VERSION) {
  globalThis.__opencodeCursorInstalledVersion = OPENCODE_CURSOR_VERSION;

  const theme = globalThis.__opencodeCursorTheme;
  const replaceArtwork = (target, markup) => theme ? theme.replaceArtwork(target, markup) : target.replaceChildren();
  const ROOT_ID = "opencode-agent-cursor-root";
  const SCALE = theme ? theme.DISPLAY_SIZE / theme.CANVAS : 42 / 128;
  const HOTSPOT_LEFT = theme ? theme.HOTSPOT.x * SCALE : 18.05;
  const HOTSPOT_TOP = theme ? theme.HOTSPOT.y * SCALE : 9.84;
  const CUE_PIVOT = { x: 32, y: 31 };
  const GLIDE_SPEED = 1.7;
  const MIN_GLIDE_MS = 180;
  const MAX_GLIDE_MS = 900;
  const ARC_SIZE = 0.25;
  const HANDLE = 0.3;
  const SEED_OFFSET = 140;
  const HOLD_ACTION_MS = 2400;
  const LABEL_HOLD_MS = 2000;
  const LABEL_MAX_CHARS = 28;
  const BADGE_GAP = 25;
  const ANCHOR_OFFSET = 16;
  const FLOAT_PERIOD_MS = 4000;
  const ARRIVAL_DISTANCE = 0.8;

  let host;
  let shadow;
  let listenersActive = false;
  const cursors = new Map();

  const reducedMotion = () => {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
  };
  // Animation only earns its frames when someone can see them: the tab has to be
  // on screen and its window focused. Everything else is drawn directly at the
  // target, which also keeps a background run off the CPU entirely.
  const isWatched = () => {
    if (document.hidden || reducedMotion()) return false;
    try { return document.hasFocus(); } catch { return true; }
  };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const easeOut = (value) => 1 - (1 - value) ** 3;

  function clampPoint(value) {
    const viewport = window.visualViewport;
    const minX = viewport?.offsetLeft ?? 0;
    const minY = viewport?.offsetTop ?? 0;
    const maxX = minX + (viewport?.width ?? window.innerWidth);
    const maxY = minY + (viewport?.height ?? window.innerHeight);
    return { x: clamp(value.x, minX, maxX), y: clamp(value.y, minY, maxY) };
  }

  function truncateLabel(value) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    return text.length > LABEL_MAX_CHARS ? `${text.slice(0, LABEL_MAX_CHARS - 1)}…` : text;
  }

  function mixText(base, session, ratio) {
    const mixed = theme ? theme.mix(base, session, ratio) : base;
    return `${mixed[0]},${mixed[1]},${mixed[2]}`;
  }

  function ensureHost() {
    if (shadow) return shadow;
    document.getElementById(ROOT_ID)?.remove();
    host = document.createElement("div");
    host.id = ROOT_ID;
    host.style.cssText = "position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none; overflow: visible; contain: style;";
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .cursor { position: fixed; left: 0; top: 0; width: 0; height: 0; opacity: 0; transition: opacity 140ms ease-out; }
      .cursor.visible { opacity: 1; }
      .art {
        position: absolute; left: ${-HOTSPOT_LEFT}px; top: ${-HOTSPOT_TOP}px;
        width: ${theme.DISPLAY_SIZE}px; height: ${theme.DISPLAY_SIZE}px;
        overflow: visible; transform-origin: ${HOTSPOT_LEFT}px ${HOTSPOT_TOP}px; will-change: transform;
      }
      .cue { transform-box: view-box; transform-origin: ${CUE_PIVOT.x}px ${CUE_PIVOT.y}px; }
      .cue > g, .pointer { transform-box: view-box; transform-origin: 0 0; }
      .badge {
        position: absolute; top: ${BADGE_GAP}px; left: 0; transform: translateX(-50%);
        display: flex; align-items: center; gap: 4px; box-sizing: border-box;
        min-width: 55px; max-width: 188px; height: 28px; padding: 0 10px; border-radius: 14px;
        color: #fff; white-space: nowrap; opacity: 0; transition: opacity 400ms ease;
        font: 500 11.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.34); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.31), 0 0 14px var(--glow);
      }
      .badge.visible { opacity: 1; }
      .badge .chip {
        display: none; flex: none; width: 18px; height: 18px; border-radius: 5px;
        background: var(--chip); border: 0.75px solid rgba(255, 255, 255, 0.72);
      }
      .badge.has-chip .chip { display: block; }
      .badge .label { overflow: hidden; text-overflow: ellipsis; }
    `;
    shadow.append(style);
    return shadow;
  }

  function badgeStyle(session) {
    const stop = (base, ratio, alpha) => `rgba(${mixText(base, session, ratio)}, ${alpha})`;
    return `background: linear-gradient(135deg, ${stop([94, 151, 178], 0.66, 0.925)} 0%, ${stop([43, 92, 119], 0.52, 0.937)} 46%, ${stop([13, 27, 38], 0.26, 0.961)} 100%);` +
      ` border: 1px solid rgba(${mixText([255, 255, 255], session, 0.55)}, 0.745);` +
      ` --chip: rgba(${session[0]},${session[1]},${session[2]}, 0.863);` +
      ` --glow: rgba(${mixText([13, 27, 38], session, 0.7)}, 0.1);`;
  }

  function createCursor(cursorId) {
    ensureHost();
    const session = theme ? theme.sessionColor(cursorId) : [94, 192, 232];

    const cursor = document.createElement("div");
    cursor.className = "cursor";
    cursor.dataset.cursorId = cursorId;

    const art = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    art.setAttribute("class", "art");
    art.setAttribute("viewBox", `0 0 ${theme ? theme.CANVAS : 128} ${theme ? theme.CANVAS : 128}`);
    const floatGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
    floatGroup.setAttribute("class", "float");
    const cue = document.createElementNS("http://www.w3.org/2000/svg", "g");
    cue.setAttribute("class", "cue");
    const pointer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    pointer.setAttribute("class", "pointer");
    replaceArtwork(pointer, theme ? theme.pointerMarkup(session) : "");
    floatGroup.append(cue, pointer);
    art.append(floatGroup);

    const badge = document.createElement("div");
    badge.className = "badge";
    badge.setAttribute("style", badgeStyle(session));
    for (const name of ["chip", "label"]) { const span = document.createElement("span"); span.className = name; badge.append(span); }
    const chip = badge.querySelector(".chip");
    const label = badge.querySelector(".label");

    cursor.append(art, badge);
    shadow.append(cursor);

    return {
      cursorId,
      session,
      cursor,
      art,
      cue,
      pointer,
      badge,
      chip,
      label,
      labelText: null,
      current: { x: -100, y: -100 },
      target: { x: -100, y: -100 },
      heading: Math.PI / 4,
      plan: null,
      action: "idle",
      actionStartedAt: 0,
      actionUntil: 0,
      labelTimer: null,
      moveSequence: 0,
      pendingArrival: null,
      raf: null,
      frame: 0,
      visible: false,
      seeded: false,
      cueAction: null,
      layerNodes: [],
      chipAction: null,
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

  function planGlide(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    const normalX = distance > 0 ? -dy / distance : 0;
    const normalY = distance > 0 ? dx / distance : 0;
    const bulge = Math.min(distance * ARC_SIZE, 90);
    return {
      from: { ...from },
      to: { ...to },
      distance,
      control1: { x: from.x + dx * HANDLE + normalX * bulge, y: from.y + dy * HANDLE + normalY * bulge },
      control2: { x: from.x + dx * (1 - HANDLE) + normalX * bulge, y: from.y + dy * (1 - HANDLE) + normalY * bulge },
      duration: clamp(distance / GLIDE_SPEED, MIN_GLIDE_MS, MAX_GLIDE_MS),
      startedAt: performance.now(),
    };
  }

  function pointAt(plan, progress) {
    const u = 1 - progress;
    const a = u * u * u;
    const b = 3 * u * u * progress;
    const c = 3 * u * progress * progress;
    const d = progress * progress * progress;
    return {
      x: a * plan.from.x + b * plan.control1.x + c * plan.control2.x + d * plan.to.x,
      y: a * plan.from.y + b * plan.control1.y + c * plan.control2.y + d * plan.to.y,
    };
  }

  function headingAt(plan, progress) {
    const u = 1 - progress;
    const dx = 3 * u * u * (plan.control1.x - plan.from.x) + 6 * u * progress * (plan.control2.x - plan.control1.x) + 3 * progress * progress * (plan.to.x - plan.control2.x);
    const dy = 3 * u * u * (plan.control1.y - plan.from.y) + 6 * u * progress * (plan.control2.y - plan.control1.y) + 3 * progress * progress * (plan.to.y - plan.control2.y);
    return dx === 0 && dy === 0 ? null : Math.atan2(dy, dx);
  }

  function seedFor(entry, target) {
    const seed = clampPoint({ x: target.x - SEED_OFFSET, y: target.y - SEED_OFFSET });
    entry.current = seed;
    entry.seeded = true;
  }

  // Each published move sequence is answered exactly once, wherever the pointer
  // happens to settle: a finished glide, a hidden tab, or a reduced-motion jump.
  function reportArrival(entry) {
    if (entry.pendingArrival !== entry.moveSequence) return;
    const sequence = entry.pendingArrival;
    entry.pendingArrival = null;
    notifyArrived(entry, sequence);
  }

  function finishAtTarget(entry) {
    stopAnimation(entry);
    entry.current = { ...entry.target };
    entry.plan = null;
    applyTransform(entry);
    reportArrival(entry);
  }

  function stopAnimation(entry) {
    if (entry.raf != null) cancelAnimationFrame(entry.raf);
    entry.raf = null;
  }

  function floatOffset(now) {
    if (reducedMotion()) return { dx: 0, dy: 0, rotation: 0 };
    const progress = (now % FLOAT_PERIOD_MS) / FLOAT_PERIOD_MS;
    const angle = progress * Math.PI * 2;
    return { dx: Math.sin(angle) * 5, dy: 6 * Math.cos(angle) - 5, rotation: 2.5 * Math.cos(angle) };
  }

  function applyTransform(entry) {
    const float = floatOffset(performance.now());
    const rotation = (entry.heading * 180) / Math.PI - 45 + float.rotation;
    entry.cursor.style.transform = `translate3d(${entry.current.x + float.dx * SCALE}px, ${entry.current.y + float.dy * SCALE}px, 0)`;
    entry.art.style.transform = `rotate(${rotation}deg)`;
    // The label trails the pointer's anchor, which the source places one
    // POINTER_ANCHOR_OFFSET along the heading from the tip, then BADGE_GAP below.
    entry.badge.style.left = `${Math.cos(entry.heading) * ANCHOR_OFFSET}px`;
    entry.badge.style.top = `${BADGE_GAP + Math.sin(entry.heading) * ANCHOR_OFFSET}px`;
  }

  function applyAction(entry, actionId) {
    const id = theme && theme.ACTIONS[actionId] ? actionId : "idle";
    if (entry.cueAction !== id) {
      entry.cueAction = id;
      replaceArtwork(entry.cue, theme ? theme.cueMarkup(id, entry.session) : "");
      entry.layerNodes = [...entry.cue.children];
    }
    entry.action = id;
    entry.actionStartedAt = performance.now();
    const duration = theme ? theme.ACTIONS[id].duration : 0;
    entry.actionUntil = id === "idle" ? 0 : performance.now() + Math.max(duration, HOLD_ACTION_MS);
    if (entry.chipAction !== id) {
      entry.chipAction = id;
      replaceArtwork(entry.chip, theme ? theme.chipGlyph(id) : "");
      entry.badge.classList.toggle("has-chip", id !== "idle");
    }
  }

  function scaleAbout(x, y, scale) {
    return scale === 1 ? "" : `translate(${x}px, ${y}px) scale(${scale}) translate(${-x}px, ${-y}px)`;
  }

  function applyActionFrame(entry, now) {
    if (entry.action === "idle") {
      entry.cue.style.transform = "";
      for (const node of entry.layerNodes) node.style.opacity = "";
      entry.pointer.style.transform = "";
      return;
    }
    if (now > entry.actionUntil) {
      applyAction(entry, "idle");
      return;
    }
    const definition = theme.ACTIONS[entry.action];
    const elapsed = now - entry.actionStartedAt;
    // Reduced motion paints the animation's designated still frame instead of
    // animating, which is what the source does with `still_frame`.
    const progress = reducedMotion() ? theme.staticProgress(entry.action)
      : definition.mode === "oneshot" ? Math.min(1, elapsed / definition.duration) : (elapsed % definition.duration) / definition.duration;
    const motion = theme.actionMotion(entry.action, progress);
    entry.cue.style.transform = `translate(${motion.group.dx}px, ${motion.group.dy}px) rotate(${motion.group.rotate}deg) scale(${motion.group.scale})`;
    motion.layers.forEach((layer, index) => {
      const node = entry.layerNodes[index];
      if (!node) return;
      node.style.opacity = String(layer.opacity);
      node.style.transform = scaleAbout(CUE_PIVOT.x, CUE_PIVOT.y, layer.scale);
    });
    entry.pointer.style.transform = scaleAbout(theme.HOTSPOT.x, theme.HOTSPOT.y, motion.pointer.scale);
  }

  function revealLabel(entry) {
    entry.badge.classList.add("visible");
    clearTimeout(entry.labelTimer);
    entry.labelTimer = setTimeout(() => entry.badge.classList.remove("visible"), LABEL_HOLD_MS);
  }

  function animate(entry) {
    const now = performance.now();
    if (entry.plan) {
      const raw = Math.min(1, (now - entry.plan.startedAt) / entry.plan.duration);
      const progress = easeOut(raw);
      entry.current = pointAt(entry.plan, progress);
      const heading = headingAt(entry.plan, Math.max(progress, 0.02));
      if (heading !== null) entry.heading = heading;
      if (raw >= 1) {
        entry.current = { ...entry.target };
        entry.plan = null;
        reportArrival(entry);
      }
    }
    applyActionFrame(entry, now);
    applyTransform(entry);
    if (entry.visible && isWatched()) {
      entry.raf = requestAnimationFrame(() => animate(entry));
    } else {
      entry.raf = null;
    }
  }

  function ensureAnimating(entry) {
    if (!isWatched()) return;
    if (entry.raf == null) entry.raf = requestAnimationFrame(() => animate(entry));
  }

  function applyState(state) {
    const x = Number(state.x);
    const y = Number(state.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const entry = entryFor(state.cursorId);
    const wasVisible = entry.visible;

    const nextLabel = truncateLabel(state.label ?? state.cursorLabel ?? entry.cursorId);
    if (nextLabel !== entry.labelText) {
      entry.labelText = nextLabel;
      entry.label.textContent = nextLabel;
    }

    entry.target = clampPoint({ x, y });
    entry.moveSequence = Number.isInteger(state.moveSequence) ? state.moveSequence : entry.moveSequence + 1;
    entry.pendingArrival = entry.moveSequence;
    if (state.action) applyAction(entry, state.action);

    const visible = state.visible !== false;
    entry.visible = visible;
    entry.cursor.classList.toggle("visible", visible);

    if (!visible) {
      stopAnimation(entry);
      entry.plan = null;
      reportArrival(entry);
      return;
    }

    if (!wasVisible) revealLabel(entry);

    if (!entry.seeded || wasVisible === false) seedFor(entry, entry.target);
    // Nothing is watching, so the pointer is placed rather than flown. It is
    // still in the right place the moment anyone looks, and a background run
    // costs no animation frames at all.
    if (!isWatched()) {
      entry.current = { ...entry.target };
      entry.plan = null;
      applyTransform(entry);
      if (reducedMotion()) applyActionFrame(entry, performance.now());
      reportArrival(entry);
      return;
    }

    const distance = Math.hypot(entry.target.x - entry.current.x, entry.target.y - entry.current.y);
    if (distance <= ARRIVAL_DISTANCE) {
      finishAtTarget(entry);
      ensureAnimating(entry);
      return;
    }
    entry.plan = planGlide(entry.current, entry.target);
    ensureAnimating(entry);
  }

  function refreshCurrentState() {
    sendRuntimeMessage({ type: "OPENCODE_GET_CURSOR_STATE" }, (response) => {
      if (chrome.runtime.lastError) return;
      const states = Array.isArray(response?.states) ? response.states : response?.state ? [response.state] : [];
      for (const state of states) applyState(state);
    });
  }

  function refreshBounds() {
    for (const entry of cursors.values()) {
      entry.target = clampPoint(entry.target);
      entry.current = clampPoint(entry.current);
      if (entry.plan) entry.plan = planGlide(entry.current, entry.target);
      applyTransform(entry);
    }
  }

  // The synthetic cursor is pointer-events:none, so re-revealing the label when
  // the real pointer comes near is a proximity test rather than a hover event.
  function handlePointerMove(event) {
    for (const entry of cursors.values()) {
      if (entry.visible && Math.hypot(event.clientX - entry.current.x, event.clientY - entry.current.y) < 40) revealLabel(entry);
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "OPENCODE_CURSOR_STATE") return false;
    applyState(message);
    sendResponse({ ok: true });
    return true;
  });

  // Losing focus or visibility stops every animation immediately, so an
  // unwatched run costs nothing. Regaining it brings the label back so the
  // session is identifiable, and the pointer is already on its target because
  // moves made while unwatched were placed rather than flown.
  function handleVisibility() {
    for (const entry of cursors.values()) {
      if (!isWatched() || !entry.visible) {
        stopAnimation(entry);
        continue;
      }
      revealLabel(entry);
      ensureAnimating(entry);
    }
  }

  // Read-only introspection for the browser verification script and for field
  // diagnosis. Content scripts run in an isolated world, so page scripts cannot
  // reach this and it exposes no way to drive the overlay.
  globalThis.__opencodeCursorInspect = () => [...cursors.values()].map((entry) => ({
    cursorId: entry.cursorId,
    x: entry.current.x,
    y: entry.current.y,
    target: { ...entry.target },
    fill: [...entry.session],
    heading: entry.heading,
    action: entry.action,
    visible: entry.visible,
    label: entry.labelText,
    labelVisible: entry.badge.classList.contains("visible"),
    transform: entry.cursor.style.transform,
    artTransform: entry.art.style.transform,
    cueAction: entry.cueAction,
    layers: entry.layerNodes.length,
  }));

  if (!listenersActive) {
    listenersActive = true;
    window.addEventListener("resize", refreshBounds);
    window.addEventListener("mousemove", handlePointerMove, { passive: true });
    window.addEventListener("focus", handleVisibility);
    window.addEventListener("blur", handleVisibility);
    document.addEventListener("visibilitychange", handleVisibility);
    window.visualViewport?.addEventListener("resize", refreshCurrentState);
    window.visualViewport?.addEventListener("scroll", refreshCurrentState);
    refreshCurrentState();
  }
}
