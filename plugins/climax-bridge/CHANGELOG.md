# Changelog

All notable changes to climax-bridge. Format loosely based on [Keep a Changelog](https://keepachangelog.com/).
Versions follow the `climax-bridge.yml` `version` field. Pre-1.0 means breaking changes can land in any release.

## [0.5.0] — 2026-06-24

### Added

- **Organising mode (third indicator state).** A red pill with white droplets + "ORGANISING" for when you're tidying your Stash library and don't want scrubbing to inflate play history. Entering it pauses Stash's "Enable scene play history" (`configuration.ui.trackActivity`); leaving it resumes. Climax guarantees the invariant: play history is paused ONLY while organising — never while idle or tracking. It self-heals `trackActivity` back on at app launch and on every session start, so an unclean exit mid-organise can't leave it stuck off.
- **Popover menu on the idle pill.** Clicking the grey "NOT TRACKING" pill now opens a small menu: **Start session** or **Organising mode**. Clicking the red "ORGANISING" pill exits back to idle; clicking the coral "TRACKING" pill still opens the wrap-up flow. (The pill now lives in a positioned wrapper to host the menu.)

### Protocol

- `session_state` (Climax → bridge) gains an `organising` boolean: `{ type, active, status, organising }`. `active` and `organising` are mutually exclusive (active wins if both ever appear).
- New outbound (bridge → Climax) `set_organising`: `{ type, on }` — toggles organising mode. Climax refuses `on:true` while a session is active (replies with an `error` message).

### Compatibility

- **Requires Climax with the matching `WsIn::SetOrganising` handler + the `organising` field in `session_state` + the `trackActivity` self-heal.** An older Climax won't push `organising` (the pill never goes red) and logs `invalid ws json` for `set_organising`. Bump both sides together.

---

## [0.4.0] — 2026-06-22

### Added

- **Navbar tracking indicator.** A Climax-branded pill in the Stash top navbar (left of "New") shows whether a session is being tracked: grey three-droplet glyph + "NOT TRACKING" when idle, coral droplets + a green pulsing dot + "TRACKING" when live. Injected via `PluginApi.patch.before("MainNavBar.UtilityItems")` (React-managed, survives navigation) with flex `order:-1` to sit left of New. New `showIndicator` BOOLEAN setting (defaults on) toggles it.
- **Click to start / stop.** Clicking the pill while idle starts a session and opens the tracker; clicking while tracking opens the tracker's wrap-up flow — non-destructive, since "go back" keeps the session running.

### Protocol

- New inbound (Climax → bridge) `session_state`: `{ type, active, status }` — pushed on WS connect and on every session start / stop / discard. Drives the indicator with NO polling on the bridge side; the bridge just listens and flips a class.
- New outbound (bridge → Climax): `open_tracker` (idle click → start + show tracker) and `request_stop` (tracking click → show tracker + run its Stop flow).

### Compatibility

- **Requires Climax with the matching `session_state` push + `WsIn::OpenTracker` / `WsIn::RequestStop` handlers.** An older Climax won't push state (indicator stays "NOT TRACKING") and logs `invalid ws json` for the click messages. Bump both sides together.

---

## [0.3.0] — 2026-05-30

### Added

- **Stash → Climax O-removal sync.** The fetch interceptor now also catches Stash's O-removal mutations — `sceneDeleteO` (modern o_history per-entry delete), `sceneDecrementO`, and `sceneResetO` — and forwards each removed O to Climax as a new `o_remove` message: `{ source, scene_id }` (one per deleted `times` entry for `sceneDeleteO`, else one). Climax removes the most recent matching cumshot in its active session and does NOT push back to Stash (Stash already removed it). Previously only `sceneAddO` was intercepted, so removing an O in Stash silently drifted the two out of sync. The matched mutation name is logged to the console for debugging.

### Protocol

- New outbound message type `o_remove`: `{ source, scene_id }` (no timestamp — Climax resolves "most recent in active session").
- New inbound ack `o_remove_ack` (logged only).

### Compatibility

- **Requires Climax with the matching `WsIn::ORemove` handler.** An older Climax will log `invalid ws json` for `o_remove` messages and ignore them (O-adds and heartbeats are unaffected). Bump both sides together for the removal-sync path to work.

---

## [0.2.0] — 2026-05-27

### Changed (protocol slim)

- **Bridge no longer ferries any catalog metadata.** The protocol is now:
  - Heartbeat: `{ source, tab_id, scene_id, video: { state, current_time }, sent_at }`
  - O event: `{ source, scene_id, occurred_at }`
- **Removed from heartbeat**: `scene_title`, `scene_url`, `video.duration`.
- **Removed from O event**: `scene_title`.
- Removed the `getSceneTitle()` helper that scraped Stash's DOM (`.scene-header h3` etc.) for a title.

### Why

The previous hybrid where both sides could speak for catalog data caused two real problems:

1. **Ambiguity** about which side's data wins when both spoke. The bridge's title (scraped from the DOM) could differ from Stash GraphQL's canonical title; Climax had to pick one and the choice was inconsistent across code paths.
2. **Stale data forever.** Climax's "enrich on first sighting" was a one-shot — once a `content_item` row existed, edits made in Stash (e.g. a performer removed from a scene) never propagated back. There was no refresh trigger because the bridge would just re-send the same fields it sent last time.

The fix is the architectural split: bridge owns "what's playing live", Climax owns "what is this thing." Climax now queries Stash GraphQL directly (configured via its own Settings UI — URL + optional API key) and refreshes on a TTL plus user-triggered force-refresh.

### Compatibility

- **Requires Climax ≥ the matching commit** for the metadata-refresh path to work properly. Older Climax versions accept the new bridge's slim payload fine (the fields it expected as `Option<String>` simply arrive as `null`), but they won't auto-refresh metadata over time.
- **Older bridges (v0.1.0) still work with the new Climax**: serde on the Climax side silently discards the now-removed fields, and Climax's GraphQL refresh fills in the catalog data anyway. No need to update both sides in lockstep, just both eventually.

### Updated

- `README.md` — added a "what it does NOT do" section spelling out that the bridge no longer reads scene title, performers, studio, tags, thumbnail, or duration. Updated the heartbeat shape description.

---

## [0.1.0] — 2026-05-22

### Added

- Initial release.
- Detects scene pages (`/scenes/:id`) and attaches to the main `<video>` element.
- WebSocket transport to `ws://localhost:9876/ws` (Stash's CSP whitelists `ws:` but blocks cross-origin HTTP).
- Heartbeats every 5 seconds with scene id, scene title, scene URL, video state, currentTime, and duration.
- Fetch-interception of Stash's `sceneAddO` GraphQL mutation so Stash-side O button clicks flow to Climax.
- Auto-reconnect every 5 seconds when the Climax app isn't running.
- Picks the largest `<video>` on the page (the main scene player) and ignores hover-preview videos on grid pages.
- Two settings: Climax app URL (default `http://localhost:9876`) and a master enabled toggle.
