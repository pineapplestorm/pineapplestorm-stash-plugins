// Climax Bridge - reports Stash scene playback to the Climax desktop app.
//
// Transport: WebSocket. Stash's CSP whitelists `ws:` to any host but blocks
// cross-origin HTTP fetches, so a plain fetch() to localhost:9876 fails. The
// WS approach also gives us a persistent connection (less overhead per heartbeat)
// and bidirectional messaging (the app can push commands back later).
//
// What we send to Climax:
//
//   Heartbeat: { source, tab_id, scene_id, video: {state, current_time}, sent_at }
//   O event:   { source, scene_id, occurred_at }   (user clicked O in Stash)
//   O remove:  { source, scene_id }                (user decremented O in Stash)
//
// What we DO NOT send: scene title, scene URL, video duration, performers,
// studio, tags. As of bridge v0.2.0 Climax queries Stash GraphQL directly
// for all catalog data — the bridge only owns realtime/playback state.
//
// Behaviour:
// - Opens a WebSocket to ws://localhost:9876/ws on init.
// - On scene pages, sends heartbeats every 5s while playing.
// - Reconnects every 5s if the connection drops (Climax app not running yet, etc).

(function () {
  "use strict";

  const PLUGIN_ID = "climax-bridge";
  const DEFAULT_URL = "http://localhost:9876"; // /ws path appended automatically
  const HEARTBEAT_INTERVAL_MS = 5000;
  const RECONNECT_DELAY_MS = 5000;
  const SCENE_PATH_RE = /^\/scenes\/(\d+)/;
  const LOG_PREFIX = "[Climax Bridge]";

  console.log(LOG_PREFIX, "script loaded");

  let climaxUrl = DEFAULT_URL;
  let enabled = true;
  let showIndicator = true;
  // Set true once config is loaded AND the indicator should render. The navbar
  // patch is registered early (so it catches the first render) but renders
  // nothing until this flips.
  let indicatorEnabled = false;
  // Latest tracking state pushed by Climax over the WS (session_state message).
  // `organising` is the third pill state: the user is tidying their Stash
  // library with play-history tracking paused (mutually exclusive with active).
  let trackingState = { active: false, status: null, organising: false };

  // Per-tab unique id, regenerated on page load.
  const TAB_ID = "tab_" + Math.random().toString(36).slice(2) + Date.now().toString(36);

  // ---------- Plugin config load ----------

  function loadPluginConfig() {
    return fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ configuration { plugins } }" }),
    })
      .then((r) => r.json())
      .then((j) => {
        const cfg = j?.data?.configuration?.plugins?.[PLUGIN_ID];
        if (cfg) {
          if (typeof cfg.climaxUrl === "string" && cfg.climaxUrl.trim()) {
            climaxUrl = cfg.climaxUrl.trim().replace(/\/+$/, "");
          }
          if (typeof cfg.enabled === "boolean") {
            enabled = cfg.enabled;
          }
          if (typeof cfg.showIndicator === "boolean") {
            showIndicator = cfg.showIndicator;
          }
        }
      })
      .catch(() => { /* defaults */ });
  }

  // ---------- WebSocket connection (with auto-reconnect) ----------

  let ws = null;
  let wsState = "disconnected"; // disconnected | connecting | connected
  let reconnectTimer = null;
  let messageCount = 0;

  function wsUrlFor(base) {
    // Convert http://localhost:9876 -> ws://localhost:9876/ws
    return base.replace(/^http/i, "ws") + "/ws";
  }

  function connect() {
    if (!enabled) return;
    if (ws || wsState === "connecting") return;

    const url = wsUrlFor(climaxUrl);
    wsState = "connecting";
    console.log(LOG_PREFIX, "connecting to", url);

    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.warn(LOG_PREFIX, "WS create failed:", e.message);
      ws = null;
      wsState = "disconnected";
      scheduleReconnect();
      return;
    }

    ws.addEventListener("open", () => {
      wsState = "connected";
      messageCount = 0;
      console.log(LOG_PREFIX, "WS connected");
    });

    ws.addEventListener("close", (e) => {
      console.log(LOG_PREFIX, "WS closed", e.code, e.reason || "");
      ws = null;
      wsState = "disconnected";
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // close event will follow with the reconnect.
    });

    ws.addEventListener("message", (e) => {
      messageCount++;
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "hello") {
          console.log(LOG_PREFIX, "hello from", msg.service);
        } else if (msg.type === "ack") {
          if (msg.recorded) {
            console.log(LOG_PREFIX, "heartbeat recorded in session", msg.session_id);
          } else if (!msg.session_active) {
            console.log(LOG_PREFIX, "no active session - press Ctrl+Shift+L or click Start in Climax");
          }
        } else if (msg.type === "o_ack") {
          console.log(LOG_PREFIX, "O event acknowledged by Climax");
        } else if (msg.type === "o_remove_ack") {
          console.log(LOG_PREFIX, "O removal acknowledged by Climax");
        } else if (msg.type === "session_state") {
          // Climax pushes this on connect and whenever a session starts / stops /
          // pauses / resumes, or organising mode is toggled. Drives the navbar
          // indicator (no polling our side).
          trackingState = {
            active: !!msg.active,
            status: msg.status || null,
            organising: !!msg.organising,
          };
          window.dispatchEvent(new CustomEvent("climax:state", { detail: trackingState }));
        } else if (msg.type === "error") {
          console.warn(LOG_PREFIX, "server error:", msg.message);
        }
      } catch (err) {
        console.warn(LOG_PREFIX, "bad message from server:", e.data);
      }
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
  }

  function send(obj) {
    if (wsState !== "connected" || !ws) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      console.warn(LOG_PREFIX, "WS send failed:", e.message);
      return false;
    }
  }

  // ---------- Scene id capture ----------

  function getCurrentSceneId() {
    const m = window.location.pathname.match(SCENE_PATH_RE);
    return m ? m[1] : null;
  }

  // ---------- Heartbeat ----------

  let heartbeatTimer = null;
  let currentVideo = null;
  let currentSceneId = null;

  function buildHeartbeat(state) {
    return {
      type: "heartbeat",
      source: "stash",
      tab_id: TAB_ID,
      scene_id: currentSceneId,
      video: {
        state,
        current_time: currentVideo ? currentVideo.currentTime || 0 : 0,
      },
      sent_at: Date.now(),
    };
  }

  // ---------- Stash O button interception ----------
  // When the user clicks the O button in Stash's UI, Stash fires a sceneAddO
  // GraphQL mutation. We monkey-patch window.fetch to detect that and forward
  // it to Climax as an o_event. Climax records the O with skip_stash_sync=true
  // so we don't double-increment.

  let fetchPatched = false;

  function patchFetchForStashO() {
    if (fetchPatched) return;
    fetchPatched = true;

    const origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input?.url;
      const method = (init?.method || (typeof input === "object" ? input?.method : "GET") || "GET").toUpperCase();
      const body = init?.body;

      // Snapshot body before it's consumed - only useful for POST /graphql with a body.
      // sceneAddO -> user logged an O in Stash -> forward as o_event.
      // O removal in Stash's UI has gone by several mutation names across
      // versions, so match any of them and forward as o_remove:
      //   sceneDeleteO(id, times)  - modern o_history: delete specific entries
      //   sceneDecrementO(id)      - older: pop the most recent
      //   sceneResetO(id)          - clear all (treated as a single remove for now)
      let addSnapshot = null;
      let removeSnapshot = null;
      let removeMutation = null;
      if (
        method === "POST" &&
        typeof url === "string" &&
        url.indexOf("/graphql") !== -1 &&
        typeof body === "string"
      ) {
        if (body.indexOf("sceneAddO") !== -1) {
          addSnapshot = body;
        } else {
          for (const name of ["sceneDeleteO", "sceneDecrementO", "sceneResetO"]) {
            if (body.indexOf(name) !== -1) {
              removeSnapshot = body;
              removeMutation = name;
              break;
            }
          }
        }
      }

      const result = origFetch(input, init);

      if (addSnapshot || removeSnapshot) {
        // Wait for Stash to confirm the mutation succeeded before recording.
        result
          .then(async (resp) => {
            if (!resp.ok) return;
            try {
              if (addSnapshot) handleStashOMutation(addSnapshot);
              if (removeSnapshot) handleStashODecrement(removeSnapshot, removeMutation);
            } catch (e) {
              console.warn(LOG_PREFIX, "stash O intercept handler failed:", e);
            }
          })
          .catch(() => { /* network failure - Stash will surface it */ });
      }

      return result;
    };
    console.log(LOG_PREFIX, "fetch patched for sceneAddO + O-removal (sceneDeleteO/sceneDecrementO/sceneResetO) interception");
  }

  function handleStashOMutation(rawBody) {
    let parsed;
    try { parsed = JSON.parse(rawBody); } catch { return; }

    const vars = parsed?.variables;
    if (!vars) return;

    // Stash mutations vary in shape - try common ones:
    //   { input: { ids: [...], times: [...] } }
    //   { ids: [...], times: [...] }
    //   { id: "...", times: [...] } (singular)
    const ids = vars.input?.ids || vars.ids || (vars.id ? [vars.id] : null);
    const times = vars.input?.times || vars.times || [];

    if (!ids || ids.length === 0) return;

    // For each scene ID in the mutation, send one o_event per time
    // (or one with "now" if no times given).
    for (const sceneId of ids) {
      const sceneIdStr = String(sceneId);
      if (times.length === 0) {
        sendStashOEvent(sceneIdStr, Date.now());
      } else {
        for (const t of times) {
          const ms = typeof t === "number" ? t : Date.parse(t);
          if (!Number.isNaN(ms)) sendStashOEvent(sceneIdStr, ms);
        }
      }
    }
  }

  function sendStashOEvent(sceneId, occurredAtMs) {
    const ok = send({
      type: "o_event",
      source: "stash",
      scene_id: sceneId,
      occurred_at: occurredAtMs,
    });
    if (ok) {
      console.log(LOG_PREFIX, "stash O detected -> Climax for scene", sceneId);
    } else {
      console.log(LOG_PREFIX, "stash O detected for scene", sceneId, "but WS not connected");
    }
  }

  // A Stash O-removal mutation fired. Forward one o_remove per O removed so
  // Climax can drop the matching cumshot(s) from its active session. For
  // sceneDeleteO the `times` array tells us how many entries were removed
  // (one o_remove each); sceneDecrementO/sceneResetO have no times, so we
  // forward a single removal.
  function handleStashODecrement(rawBody, mutationName) {
    let parsed;
    try { parsed = JSON.parse(rawBody); } catch { return; }

    const vars = parsed?.variables;
    if (!vars) return;

    const ids = vars.input?.ids || vars.ids || (vars.id ? [vars.id] : null);
    if (!ids || ids.length === 0) return;

    const times = vars.input?.times || vars.times || [];
    const removeCount = times.length > 0 ? times.length : 1;

    console.log(LOG_PREFIX, "stash O-removal via", mutationName, "- forwarding", removeCount, "removal(s)");

    for (const sceneId of ids) {
      for (let i = 0; i < removeCount; i++) {
        sendStashORemove(String(sceneId));
      }
    }
  }

  function sendStashORemove(sceneId) {
    const ok = send({
      type: "o_remove",
      source: "stash",
      scene_id: sceneId,
    });
    if (ok) {
      console.log(LOG_PREFIX, "stash O-remove detected -> Climax for scene", sceneId);
    } else {
      console.log(LOG_PREFIX, "stash O-remove detected for scene", sceneId, "but WS not connected");
    }
  }

  function sendHeartbeat(state) {
    if (!enabled) return;
    if (!currentSceneId) return;

    const ok = send(buildHeartbeat(state));
    if (ok) {
      console.log(LOG_PREFIX, "heartbeat ->", state, "scene", currentSceneId);
    } else {
      console.log(LOG_PREFIX, "heartbeat queued (waiting for WS), scene", currentSceneId);
    }
  }

  function startHeartbeatTimer() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      if (!currentVideo) {
        sendHeartbeat("idle");
        return;
      }
      // If our attached video is no longer in the DOM (route change, plugin
      // re-mounted the player, etc), re-attach to the current one.
      if (!currentVideo.isConnected) {
        console.log(LOG_PREFIX, "previous video detached from DOM, re-finding");
        detachVideo();
        const v = findSceneVideo();
        if (v) attachVideo(v);
        if (!currentVideo) {
          sendHeartbeat("idle");
          return;
        }
      }
      const paused = currentVideo.paused;
      const ended = currentVideo.ended;
      const ct = currentVideo.currentTime || 0;
      const readyState = currentVideo.readyState;
      // A video that hasn't loaded enough data (HAVE_NOTHING=0, HAVE_METADATA=1)
      // isn't really "playing" even if paused=false. Treat as paused.
      const notReady = readyState < 2; // HAVE_CURRENT_DATA
      const state = !paused && !ended && !notReady ? "playing" : "paused";
      sendHeartbeat(state);
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeatTimer() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // ---------- Video element wiring ----------

  function findSceneVideo() {
    // Filter to videos that are actually visible AND large enough to be
    // the main scene player (not hover-previews on grid cards, not
    // Floating-Scene-Player's hidden mount-point video, etc).
    const all = Array.from(document.querySelectorAll("video"));
    const candidates = all.filter((v) => {
      // offsetParent is null for display:none / visibility:hidden ancestors.
      if (!v.offsetParent && v !== document.body) return false;
      // Tiny videos = hover previews. Main player is big.
      if (v.offsetWidth < 200 || v.offsetHeight < 100) return false;
      return true;
    });
    if (candidates.length === 0) {
      console.log(LOG_PREFIX, "no usable video. total <video> on page:", all.length);
      return null;
    }
    candidates.sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight));
    if (candidates.length > 1) {
      console.log(LOG_PREFIX, "multiple candidate videos (" + candidates.length + ") - picking largest:", candidates[0].offsetWidth + "x" + candidates[0].offsetHeight);
    }
    return candidates[0];
  }

  function attachVideo(video) {
    if (!video || video.dataset.climaxBridge === "1") return;
    video.dataset.climaxBridge = "1";
    currentVideo = video;

    video.addEventListener("play", () => sendHeartbeat("playing"));
    video.addEventListener("pause", () => sendHeartbeat("paused"));
    video.addEventListener("ended", () => sendHeartbeat("paused"));

    if (!video.paused && !video.ended) sendHeartbeat("playing");
  }

  function detachVideo() {
    if (currentVideo) {
      delete currentVideo.dataset.climaxBridge;
      currentVideo = null;
    }
  }

  // ---------- Page lifecycle ----------

  let videoObserver = null;

  function onScenePageEnter(sceneId) {
    currentSceneId = sceneId;
    console.log(LOG_PREFIX, "entered scene page", sceneId);

    const tryAttach = () => {
      const v = findSceneVideo();
      if (v) {
        attachVideo(v);
        return true;
      }
      return false;
    };

    if (!tryAttach()) {
      videoObserver = new MutationObserver(() => {
        if (tryAttach() && videoObserver) {
          videoObserver.disconnect();
          videoObserver = null;
        }
      });
      videoObserver.observe(document.body, { childList: true, subtree: true });
    }

    startHeartbeatTimer();
    sendHeartbeat("idle"); // initial ping
  }

  function onScenePageLeave() {
    console.log(LOG_PREFIX, "left scene page");
    if (videoObserver) {
      videoObserver.disconnect();
      videoObserver = null;
    }
    stopHeartbeatTimer();
    detachVideo();
    currentSceneId = null;
  }

  function evaluateRoute() {
    const sceneId = getCurrentSceneId();
    if (sceneId && sceneId !== currentSceneId) {
      if (currentSceneId) onScenePageLeave();
      onScenePageEnter(sceneId);
    } else if (!sceneId && currentSceneId) {
      onScenePageLeave();
    }
  }

  function setupRouteObserver() {
    let lastPath = window.location.pathname;
    const observer = new MutationObserver(() => {
      if (window.location.pathname !== lastPath) {
        lastPath = window.location.pathname;
        evaluateRoute();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", evaluateRoute);
  }

  // ---------- Navbar tracking indicator ----------
  // A Climax-branded pill in the Stash navbar (left of "New") showing whether a
  // session is being tracked. State arrives via the WS session_state push (no
  // polling our side). Clicking it asks Climax to start tracking + open the
  // tracker. Injected as a React component via PluginApi.patch.before so React
  // keeps it rendered across navigation (no DOM MutationObserver to maintain).

  // The three-droplet Climax cumshot glyph (matches Icon.Cumshot in the app).
  const CX_DROP_PATHS = [
    "M14 2c-2 2.5-3.5 4.5-3.5 6.5a3.5 3.5 0 0 0 7 0C17.5 6.5 16 4.5 14 2Z",
    "M7 9c-1.4 1.8-2.5 3.4-2.5 4.8a2.8 2.8 0 0 0 5.5 0c0-1.4-1-3-2.5-4.8Z",
    "M19 13c-1.2 1.6-2.2 3-2.2 4.2a2.5 2.5 0 0 0 5 0c0-1.2-1-2.6-2.2-4.2Z",
  ];
  let indicatorPatched = false;
  let indicatorStylesInjected = false;

  function injectIndicatorStyles() {
    if (indicatorStylesInjected) return;
    indicatorStylesInjected = true;
    const font = document.createElement("link");
    font.rel = "stylesheet";
    font.href = "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap";
    document.head.appendChild(font);
    const s = document.createElement("style");
    s.textContent = [
      // Wrapper carries the navbar placement (order/margin) + is the positioning
      // context for the idle popover menu; the pill button sits inside it.
      ".climax-indicator-wrap{position:relative;display:inline-flex;align-self:center;margin:0 24px 0 6px;order:-1;font-family:'Geist',system-ui,sans-serif}",
      ".climax-indicator{display:inline-flex;align-items:center;gap:10px;height:34px;padding:0 14px 0 12px;border-radius:999px;border:1px solid #252934;background:#13151b;cursor:pointer;font-family:inherit;line-height:1}",
      ".climax-indicator:hover{background:#1B1E26;border-color:#353A47}",
      ".climax-indicator .cx-drops{color:#8A909E;display:block;flex-shrink:0;transition:color .2s,fill .2s}",
      ".climax-indicator .cx-dot{width:7px;height:7px;border-radius:50%;background:#5C6273;flex-shrink:0;transition:background .2s}",
      ".climax-indicator .cx-label{font-size:12px;font-weight:400;letter-spacing:.15em;text-transform:uppercase;color:#8A909E;white-space:nowrap;transition:color .2s}",
      ".climax-indicator.is-live{border-color:#2c3a2e;background:#15171E}",
      ".climax-indicator.is-live .cx-drops,.climax-indicator.is-live .cx-drops path{color:#EF6B7A;fill:#EF6B7A !important}",
      ".climax-indicator.is-live .cx-label{color:#F2E8D4}",
      ".climax-indicator.is-live .cx-dot{background:#4ADE80;animation:climax-pulse 1.6s infinite}",
      "@keyframes climax-pulse{0%{box-shadow:0 0 0 0 rgba(74,222,128,.45)}70%{box-shadow:0 0 0 6px rgba(74,222,128,0)}100%{box-shadow:0 0 0 0 rgba(74,222,128,0)}}",
      // Organising: red pill, white droplets + label, static white dot. A loud,
      // unmistakable "Stash play history is paused" signal.
      ".climax-indicator.is-organising{border-color:#c43349;background:#a81d2e}",
      ".climax-indicator.is-organising:hover{background:#bd2236;border-color:#d6485c}",
      ".climax-indicator.is-organising .cx-drops,.climax-indicator.is-organising .cx-drops path{color:#fff;fill:#fff !important}",
      ".climax-indicator.is-organising .cx-label{color:#fff}",
      ".climax-indicator.is-organising .cx-dot{background:#fff;animation:none;box-shadow:none}",
      // Idle popover menu (Start session / Organising mode).
      ".climax-indicator-menu{position:absolute;top:calc(100% + 6px);left:0;min-width:178px;background:#13151b;border:1px solid #252934;border-radius:12px;padding:6px;box-shadow:0 12px 32px rgba(0,0,0,.5);z-index:10000;display:flex;flex-direction:column;gap:2px}",
      ".climax-indicator-menu button{display:flex;align-items:center;gap:9px;width:100%;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:#C7CCD6;font-family:inherit;font-size:13px;font-weight:400;text-align:left;cursor:pointer;white-space:nowrap}",
      ".climax-indicator-menu button:hover{background:#1B1E26;color:#F7F8FA}",
      ".climax-indicator-menu .cx-menu-organise:hover{background:#a81d2e;color:#fff}",
      ".climax-indicator-menu .cx-menu-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;display:inline-block}",
    ].join("");
    document.head.appendChild(s);
  }

  function makeIndicatorComponent(React) {
    return function ClimaxIndicator() {
      const [st, setSt] = React.useState(trackingState);
      const [shown, setShown] = React.useState(indicatorEnabled);
      const [menuOpen, setMenuOpen] = React.useState(false);
      const wrapRef = React.useRef(null);

      React.useEffect(function () {
        function onState(e) { setSt(e.detail); }
        function onToggle() { setShown(indicatorEnabled); }
        window.addEventListener("climax:state", onState);
        window.addEventListener("climax:indicator-toggle", onToggle);
        return function () {
          window.removeEventListener("climax:state", onState);
          window.removeEventListener("climax:indicator-toggle", onToggle);
        };
      }, []);

      // Close the idle popover on any click outside it.
      React.useEffect(function () {
        if (!menuOpen) return undefined;
        function onDocDown(e) {
          if (wrapRef.current && !wrapRef.current.contains(e.target)) setMenuOpen(false);
        }
        document.addEventListener("mousedown", onDocDown, true);
        return function () { document.removeEventListener("mousedown", onDocDown, true); };
      }, [menuOpen]);

      if (!shown) return null;

      // Precedence: an active session always wins over organising (they're
      // mutually exclusive server-side, but be defensive).
      const mode = st.active ? "tracking" : (st.organising ? "organising" : "idle");
      const LABEL = { tracking: "tracking", organising: "organising", idle: "not tracking" };
      const TITLE = {
        tracking: "Climax is tracking this session - click to stop",
        organising: "Organising mode - Stash play history is paused. Click to resume.",
        idle: "Climax - click for session / organising options",
      };

      function onPillClick() {
        if (mode === "tracking") { send({ type: "request_stop" }); return; }
        if (mode === "organising") { send({ type: "set_organising", on: false }); return; }
        setMenuOpen(function (v) { return !v; });
      }

      const pill = React.createElement(
        "button",
        {
          type: "button",
          className: "climax-indicator" +
            (mode === "tracking" ? " is-live" : "") +
            (mode === "organising" ? " is-organising" : ""),
          title: TITLE[mode],
          onClick: onPillClick,
        },
        React.createElement(
          "svg",
          { className: "cx-drops", viewBox: "0 0 24 24", width: 18, height: 18, fill: "currentColor", "aria-hidden": "true" },
          CX_DROP_PATHS.map(function (d, i) { return React.createElement("path", { key: i, d: d }); })
        ),
        React.createElement("span", { className: "cx-dot" }),
        React.createElement("span", { className: "cx-label" }, LABEL[mode])
      );

      let menu = null;
      if (mode === "idle" && menuOpen) {
        menu = React.createElement(
          "div",
          { className: "climax-indicator-menu" },
          React.createElement(
            "button",
            {
              type: "button",
              className: "cx-menu-start",
              onClick: function () { setMenuOpen(false); send({ type: "open_tracker" }); },
            },
            React.createElement("span", { className: "cx-menu-dot", style: { background: "#EF6B7A" } }),
            "Start session"
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: "cx-menu-organise",
              onClick: function () { setMenuOpen(false); send({ type: "set_organising", on: true }); },
            },
            React.createElement("span", { className: "cx-menu-dot", style: { background: "#fff" } }),
            "Organising mode"
          )
        );
      }

      return React.createElement(
        "div",
        { className: "climax-indicator-wrap", ref: wrapRef },
        pill,
        menu
      );
    };
  }

  function registerIndicatorPatch() {
    if (indicatorPatched) return;
    const PluginApi = window.PluginApi;
    if (!PluginApi || !PluginApi.React || !PluginApi.patch || typeof PluginApi.patch.before !== "function") {
      setTimeout(registerIndicatorPatch, 300); // PluginApi not ready yet
      return;
    }
    indicatorPatched = true;
    injectIndicatorStyles();
    const React = PluginApi.React;
    const Indicator = makeIndicatorComponent(React);
    // Prepend our item to the navbar utility cluster so it sits just left of "New".
    PluginApi.patch.before("MainNavBar.UtilityItems", function (props) {
      return [Object.assign({}, props, {
        children: React.createElement(
          React.Fragment,
          null,
          React.createElement(Indicator),
          props.children
        ),
      })];
    });
    console.log(LOG_PREFIX, "navbar indicator patch registered");
  }

  // ---------- Init ----------

  function init() {
    // Register the navbar patch early so it applies to the first render; the
    // component renders nothing until indicatorEnabled flips below.
    registerIndicatorPatch();
    loadPluginConfig().finally(() => {
      console.log(LOG_PREFIX, "init complete. enabled=", enabled, "url=", climaxUrl, "indicator=", showIndicator);
      if (!enabled) {
        console.log(LOG_PREFIX, "disabled in plugin settings - exiting");
        return;
      }
      patchFetchForStashO();
      connect();
      setupRouteObserver();
      evaluateRoute();
      // Reveal the indicator now that config is known.
      indicatorEnabled = !!showIndicator;
      window.dispatchEvent(new Event("climax:indicator-toggle"));
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
