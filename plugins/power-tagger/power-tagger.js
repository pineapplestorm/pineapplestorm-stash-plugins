"use strict";

// =============================================================================
// Power Tagger (Tag Categories) — v0.1.0
//
// A fast scene-tagging modal grouped by Tag Category. Reads taxonomy from the
// Tag Categories plugin's config. Without that plugin installed, every tag
// falls into a single "Uncategorised" bucket.
//
// Layout:
//   - Modal overlay at ~85% viewport.
//   - Left: Stash's native ScenePlayer mounted via PluginApi.components.
//   - Right: scrollable list of category sections (collapsible). Configuration
//     pinned to the top. Hidden categories omitted entirely.
//   - Bottom: Stash's native TagSelect — the source of truth for what's
//     applied. Adding/removing tags here is the same as Stash's normal flow,
//     and the Tag Sets plugin's button shows up next to it automatically (it
//     patches all TagSelect instances).
//   - When you click a tag chip in the category sections above, it moves into
//     the bottom TagSelect. When removed from TagSelect, it reappears above.
//
// Save flow:
//   - All staged changes are committed via one SceneUpdate mutation.
//   - On success, the modal closes and the user is navigated to the scene
//     detail page (NOT the edit page).
//
// Launch:
//   - A "Power Tagger" button is injected on the scene edit page next to
//     Save / Delete / Scrape With.
// =============================================================================

(() => {
  const PluginApi = window.PluginApi;
  if (!PluginApi) {
    console.error("[power-tagger] window.PluginApi not found");
    return;
  }
  const React = PluginApi.React;
  const ReactDOM = PluginApi.ReactDOM;
  const Components = PluginApi.components || {};

  const PLUGIN_ID = "power-tagger";
  const TAG_CATEGORIES_PLUGIN_ID = "tag-categories";
  const OPEN_EVENT_NAME = "power-tagger:open";
  const OPEN_SETTINGS_EVENT = "power-tagger:open-settings";
  // Event published by the Tag Categories plugin's settings host. We
  // dispatch this to jump from the Power Tagger rules editor straight
  // into Tag Categories' editor (so the user can fix taxonomy without
  // leaving Stash + manually clicking through Settings).
  const TAG_CATEGORIES_OPEN_EVENT = "tag-categories:open-settings";
  // v0.14.0: per-configuration colour. Configurations own their colour
  // (set in the rules editor), independent of any linked tag's
  // category — a tagless config has no category to inherit from, and a
  // category colour is shared by every tag in it. PLAIN_MODE_COLOUR is
  // the fixed red shown when tagging with NO configuration.
  // CONFIG_COLOUR_PALETTE seeds new and migrated configs with distinct
  // colours; it omits red so red stays unambiguous as "no config".
  const PLAIN_MODE_COLOUR = "#c8362a";
  // Blue — the default colour for a newly added configuration, and
  // first in the swatch palette.
  const DEFAULT_CONFIG_COLOUR = "#4a9eff";
  const CONFIG_COLOUR_PALETTE = [
    "#4a9eff", "#c67241", "#b08a3d", "#4a8a5f",
    "#4a8aa8", "#8d4a85", "#b35c83", "#6b6b6b",
  ];
  const BUTTON_MARKER_CLASS = "power-tagger-launch-btn";
  // v0.11.6: separate marker for the scenes-list toolbar button so we
  // can singleton-guard it independently from the scene-edit-page
  // launch button (both can coexist on the same Stash session).
  const TOOLBAR_BUTTON_MARKER_CLASS = "power-tagger-toolbar-btn";
  const SETTINGS_BTN_MARKER = "data-power-tagger-settings-hooked";

  // -------------------------------------------------------------------------
  // Numeric coercion helpers
  // -------------------------------------------------------------------------
  //
  // **Why this exists**: Stash serialises plugin config to YAML on shutdown
  // and reads it back on startup. The round-trip stringifies all numeric
  // values stored deep in nested objects. So a cap that was `{ base: 2,
  // perFemale: 1 }` in memory comes back as `{ base: "2", perFemale: "1" }`
  // after a Stash restart.
  //
  // The save path is fine — every input handler does `parseInt` before
  // committing — so it's load-side normalisation that matters. We:
  //
  //   1. Normalise all known-numeric fields when reading config in
  //      `readPowerTaggerConfig` below — so the in-memory shape after read
  //      always has real numbers regardless of disk shape.
  //   2. Defensively coerce on every read in the evaluator + editor (belt
  //      and braces — if we ever miss a normalisation, the consumer still
  //      does the right thing).
  //
  // **Fields known to be affected by the YAML round-trip:**
  //   - `categories[*].maxSelections`
  //   - `categories[*].subMaxSelections[*]`
  //   - `performerRules[*].groups[*].cap.{base,perMale,perFemale,perOther,hardCap}`
  //   - `performerRules[*].performerTriggers.{male,female,other}.{value,max}`
  //   - `conditionals[*].performerTriggers.{male,female,other}.{value,max}`
  //
  // ID fields are stored as strings already, so they aren't affected.
  function toInt(v, def) {
    if (v === null || v === undefined || v === "") return def;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.floor(n);
  }

  function normaliseCap(cap) {
    if (!cap || typeof cap !== "object") {
      return { base: 0, perMale: 0, perFemale: 0, perOther: 0, hardCap: null };
    }
    const hc = toInt(cap.hardCap, null);
    return {
      base:      toInt(cap.base, 0),
      perMale:   toInt(cap.perMale, 0),
      perFemale: toInt(cap.perFemale, 0),
      perOther:  toInt(cap.perOther, 0),
      hardCap:   (hc !== null && hc > 0) ? hc : null,
    };
  }

  // v0.11.13: gender-icon resolver for the popout header. Paths match
  // the ones Stash uses internally (verified from the user's own
  // browser, not lifted from FA stock — Stash's male path has a
  // different starting point, and the trans paths use negative-y
  // coordinates so need a shifted viewBox of "0 -32 576 512"). The
  // function returns { viewBox, path } or null when the gender is
  // unset / unknown (caller renders no icon at all in that case).
  function genderIconFor(genderValue) {
    const g = (genderValue || "").toUpperCase();
    if (g === "MALE") {
      return {
        viewBox: "0 0 512 512",
        path: "M320 32c0-17.7 14.3-32 32-32L480 0c17.7 0 32 14.3 32 32l0 128c0 17.7-14.3 32-32 32s-32-14.3-32-32l0-50.7-95 95c19.5 28.4 31 62.7 31 99.8 0 97.2-78.8 176-176 176S32 401.2 32 304 110.8 128 208 128c37 0 71.4 11.4 99.8 31l95-95-50.7 0c-17.7 0-32-14.3-32-32zM208 416a112 112 0 1 0 0-224 112 112 0 1 0 0 224z",
      };
    }
    if (g === "FEMALE") {
      return {
        viewBox: "0 0 384 512",
        path: "M80 176a112 112 0 1 1 224 0 112 112 0 1 1 -224 0zM223.9 349.1C305.9 334.1 368 262.3 368 176 368 78.8 289.2 0 192 0S16 78.8 16 176c0 86.3 62.1 158.1 144.1 173.1-.1 1-.1 1.9-.1 2.9l0 64-32 0c-17.7 0-32 14.3-32 32s14.3 32 32 32l32 0 0 32c0 17.7 14.3 32 32 32s32-14.3 32-32l0-32 32 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-32 0 0-64c0-1 0-1.9-.1-2.9z",
      };
    }
    if (g === "TRANSGENDER_MALE" || g === "TRANSGENDER_FEMALE") {
      // The trans path starts at y=-32 — shifted viewBox brings it on-canvas.
      return {
        viewBox: "0 -32 576 512",
        path: "M128-32c17.7 0 32 14.3 32 32s-14.3 32-32 32L97.9 32 136 70.1 151 55c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9l-15 15 14.2 14.2c27.9-23.8 64.2-38.2 103.8-38.2 36.7 0 70.6 12.4 97.6 33.2L466.7 32 448 32c-17.7 0-32-14.3-32-32s14.3-32 32-32l96 0c17.7 0 32 14.3 32 32l0 96c0 17.7-14.3 32-32 32s-32-14.3-32-32l0-18.7-84.4 84.4c13 23.1 20.4 49.9 20.4 78.3 0 77.4-55 142-128 156.8l0 35.2 32 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-32 0 0 16c0 17.7-14.3 32-32 32s-32-14.3-32-32l0-16-32 0c-17.7 0-32-14.3-32-32s14.3-32 32-32l32 0 0-35.2c-73-14.8-128-79.4-128-156.8 0-31.4 9-60.7 24.7-85.4l-16.7-16.7-15 15c-9.4 9.4-24.6 9.4-33.9 0s-9.4-24.6 0-33.9l15-15-38.1-38.1 0 30.1c0 17.7-14.3 32-32 32S0 113.7 0 96L0 0C0-17.7 14.3-32 32-32l96 0zM288 336a96 96 0 1 0 0-192 96 96 0 1 0 0 192z",
      };
    }
    if (g === "NON_BINARY" || g === "INTERSEX") {
      // Stash uses the same NB-style symbol for INTERSEX as well —
      // verified from the user's instance.
      return {
        viewBox: "0 0 384 576",
        path: "M192 544c-97.2 0-176-78.8-176-176 0-86.3 62.1-158 144-173l0-47.2-49.7 24.8-3 1.3c-15.2 5.7-32.5-.8-39.9-15.7-7.4-14.8-2.2-32.6 11.5-41.3l2.8-1.6 38.8-19.4-38.8-19.4c-15.8-7.9-22.2-27.1-14.3-42.9 7.4-14.8 24.8-21.4 40-15.6l3 1.3 49.7 24.8 0-44.2c0-17.7 14.3-32 32-32s32 14.3 32 32l0 44.2 49.7-24.8 3-1.3c15.2-5.8 32.5 .8 39.9 15.6s2.2 32.7-11.5 41.3l-2.8 1.6-38.7 19.4 38.7 19.3c15.8 7.9 22.2 27.1 14.3 42.9-7.4 14.8-24.7 21.4-39.9 15.6l-3-1.3-49.7-24.8 0 47.2c81.9 15.1 144 86.8 144 173 0 97.2-78.8 176-176 176zm0-64a112 112 0 1 0 0-224 112 112 0 1 0 0 224z",
      };
    }
    return null;
  }

  // Coerce a gender block's numeric fields. Returns a NEW object (so callers
  // can safely store the result without mutating the original).
  function normaliseGenderBlock(block) {
    if (!block || typeof block !== "object") return block;
    const out = { ...block };
    if ("value" in out) out.value = toInt(out.value, 0);
    if ("max" in out)   out.max   = toInt(out.max, out.value);
    return out;
  }

  function normalisePerformerTriggers(pt) {
    if (!pt || typeof pt !== "object") return pt;
    const out = { ...pt };
    if (out.male)   out.male   = normaliseGenderBlock(out.male);
    if (out.female) out.female = normaliseGenderBlock(out.female);
    if (out.other)  out.other  = normaliseGenderBlock(out.other);
    return out;
  }

  // Walk a rulesets object and coerce all known-numeric fields to real
  // numbers. Idempotent — running it on already-clean rulesets returns
  // an equivalent shape. Pure (does not mutate the input).
  function normaliseRulesetsNumerics(rulesets) {
    if (!rulesets || typeof rulesets !== "object") return rulesets;
    const out = {};
    for (const cid of Object.keys(rulesets)) {
      const rs = rulesets[cid];
      if (!rs || typeof rs !== "object") { out[cid] = rs; continue; }
      const nextRs = { ...rs };

      // Categories — maxSelections + subMaxSelections.
      if (rs.categories && typeof rs.categories === "object") {
        const nextCats = {};
        for (const catName of Object.keys(rs.categories)) {
          const c = rs.categories[catName];
          if (!c || typeof c !== "object") { nextCats[catName] = c; continue; }
          const nextCat = { ...c };
          if ("maxSelections" in nextCat) {
            nextCat.maxSelections = toInt(nextCat.maxSelections, 0);
          }
          if (nextCat.subMaxSelections && typeof nextCat.subMaxSelections === "object") {
            const nextSub = {};
            for (const subName of Object.keys(nextCat.subMaxSelections)) {
              nextSub[subName] = toInt(nextCat.subMaxSelections[subName], 0);
            }
            nextCat.subMaxSelections = nextSub;
          }
          nextCats[catName] = nextCat;
        }
        nextRs.categories = nextCats;
      }

      // Constraint rules — group caps + performerTriggers.
      if (Array.isArray(rs.performerRules)) {
        nextRs.performerRules = rs.performerRules.map((r) => {
          if (!r || typeof r !== "object") return r;
          const nextR = { ...r };
          if (Array.isArray(r.groups)) {
            nextR.groups = r.groups.map((g) => {
              if (!g || typeof g !== "object") return g;
              return { ...g, cap: normaliseCap(g.cap) };
            });
          }
          if (r.performerTriggers) {
            nextR.performerTriggers = normalisePerformerTriggers(r.performerTriggers);
          }
          return nextR;
        });
      }

      // Conditionals — performerTriggers only.
      if (Array.isArray(rs.conditionals)) {
        nextRs.conditionals = rs.conditionals.map((c) => {
          if (!c || typeof c !== "object") return c;
          if (!c.performerTriggers) return c;
          return { ...c, performerTriggers: normalisePerformerTriggers(c.performerTriggers) };
        });
      }

      // Cascades — migrate single `trigger` (legacy) → `triggers` array.
      // Older cascade entries used { trigger: tagId } for a single
      // trigger; new entries support multiple triggers + a triggerMode
      // (any/all). Auto-promote on load so the rest of the code only
      // ever sees the new shape.
      if (Array.isArray(rs.cascades)) {
        nextRs.cascades = rs.cascades.map((c) => {
          if (!c || typeof c !== "object") return c;
          const nextC = { ...c };
          // If legacy single trigger present and no triggers array yet,
          // wrap it. If both are present (re-runs of this normaliser),
          // the array wins.
          if (!Array.isArray(nextC.triggers)) {
            nextC.triggers = nextC.trigger ? [String(nextC.trigger)] : [];
          }
          // Default mode to "any" — matches Stash conventions for
          // multi-trigger combinators.
          if (nextC.triggerMode !== "all") nextC.triggerMode = "any";
          // Drop the legacy field so writes don't keep two-shape data.
          delete nextC.trigger;
          return nextC;
        });
      }

      // Auto-select rule \u2014 v0.11.4 supports an array of rules; each
      // rule has its own mode (all/any) + conditions list. Rules are
      // OR'd together at the top: a config matches if ANY rule matches.
      //
      // Backward compat: previous shape was a single rule shaped as
      // { mode, conditions }. Detect that and wrap as { rules: [...] }
      // so the evaluator + editor only ever see the new shape.
      if (rs.autoSelectRule && typeof rs.autoSelectRule === "object") {
        const ar = rs.autoSelectRule;
        // Single-condition normaliser shared by old + new shapes.
        function normCondition(c) {
          if (!c || typeof c !== "object") return c;
          const nc = { ...c };
          if ("value" in nc) nc.value = toInt(nc.value, 0);
          if ("max" in nc) nc.max = toInt(nc.max, 0);
          if (Array.isArray(nc.tagIds)) nc.tagIds = nc.tagIds.map(String);
          if (Array.isArray(nc.studioIds)) nc.studioIds = nc.studioIds.map(String);
          if (Array.isArray(nc.performerIds)) nc.performerIds = nc.performerIds.map(String);
          if (nc.tagId != null) nc.tagId = String(nc.tagId);
          if (nc.studioId != null) nc.studioId = String(nc.studioId);
          return nc;
        }
        function normRule(r) {
          if (!r || typeof r !== "object") return { mode: "all", conditions: [] };
          return {
            mode: r.mode === "any" ? "any" : "all",
            conditions: Array.isArray(r.conditions)
              ? r.conditions.map(normCondition)
              : [],
          };
        }

        let rules;
        if (Array.isArray(ar.rules)) {
          // New shape: array of rules.
          rules = ar.rules.map(normRule);
        } else if (Array.isArray(ar.conditions)) {
          // Legacy shape: single rule. Wrap and migrate.
          rules = [normRule({ mode: ar.mode, conditions: ar.conditions })];
        } else {
          rules = [];
        }
        nextRs.autoSelectRule = { rules };
      }

      // Description \u2014 normalise to string, trim whitespace. No clamp
      // on write (lets users keep longer notes if they want; display
      // truncates at MAX_DESCRIPTION_CHARS).
      if (rs.description != null) {
        nextRs.description = String(rs.description).trim();
      }

      out[cid] = nextRs;
    }
    return out;
  }

  // Maximum description chars displayed in the picker preview. Longer
  // descriptions are truncated with an ellipsis. Not enforced at write
  // time; users can keep longer text and we display the prefix.
  const MAX_DESCRIPTION_CHARS = 150;

  // -------------------------------------------------------------------------
  // GraphQL helpers — raw fetch for reads outside React
  // -------------------------------------------------------------------------
  async function gqlFetch(query, variables) {
    const r = await fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json();
    if (j.errors && j.errors.length) {
      throw new Error("GraphQL: " + j.errors.map((e) => e.message).join("; "));
    }
    return j.data;
  }

  // Fetch a scene with all the fields ScenePlayer expects (and a bit more,
  // since the component will just ignore what it doesn't use).
  //
  // The ScenePlayer source (ui/v2.5/src/components/ScenePlayer/ScenePlayer.tsx)
  // touches scene.files, scene.paths, scene.scene_markers (with primary_tag
  // + tags), scene.interactive, scene.performers, scene.studio.name,
  // scene.title, scene.id, scene.paths.funscript. We supply all of them.
  async function fetchSceneForPlayer(sceneId) {
    // Verified May 2026 via React DevTools: ScenePlayer is called with a
    // scene object containing (among others) sceneStreams, resume_time,
    // interactive_speed, captions, plus the standard SceneData fragment.
    // The handover noted "sceneStreams missing" as the crash from v0.1 —
    // it's the critical field, fetched here.
    const query = `query($id: ID!) {
      findScene(id: $id) {
        id
        title
        code
        details
        director
        urls
        date
        rating100
        o_counter
        organized
        interactive
        interactive_speed
        resume_time
        play_count
        play_duration
        created_at
        updated_at
        files {
          id
          path
          basename
          size
          duration
          video_codec
          audio_codec
          width
          height
          frame_rate
          bit_rate
          format
        }
        paths {
          screenshot
          preview
          stream
          webp
          vtt
          sprite
          funscript
          interactive_heatmap
          caption
        }
        sceneStreams {
          url
          mime_type
          label
        }
        scene_markers {
          id
          title
          seconds
          end_seconds
          primary_tag { id name }
          tags { id name }
        }
        performers {
          id
          name
          gender
          image_path
          birthdate
          country
          ethnicity
          hair_color
          eye_color
          height_cm
          fake_tits
          measurements
          tattoos
          piercings
          circumcised
        }
        studio { id name }
        tags { id name }
        galleries { id }
        groups { group { id name } scene_index }
        stash_ids { endpoint stash_id }
        captions {
          language_code
          caption_type
        }
      }
    }`;
    const data = await gqlFetch(query, { id: String(sceneId) });
    return data?.findScene || null;
  }

  // Fetch all tags. Used for the category sections (and the picker uses
  // Stash's TagSelect which fetches its own data).
  async function fetchAllTags() {
    const data = await gqlFetch(
      `query { findTags(filter: { per_page: -1, sort: "name" }) { tags { id name image_path } } }`,
      {}
    );
    return data?.findTags?.tags || [];
  }

  // v0.11.10: Fetch slim metadata for a list of scene IDs in parallel.
  // Used by the queue sidebar to render each scene's row. Selection set
  // is intentionally minimal — title, basename (fallback for display
  // when title is empty), screenshot path, studio name, performer names,
  // and date. Returns a { sceneId: meta } map.
  //
  // The lessons-learned doc says "findScenes filter by an array of IDs
  // doesn't exist" — we work around with N parallel findScene queries.
  // For typical queue sizes (3-20) this is plenty fast and avoids the
  // alternative of fetching ALL scenes and filtering in JS.
  async function fetchQueueMetadata(sceneIds) {
    const query = `query($id: ID!) {
      findScene(id: $id) {
        id
        title
        date
        paths { screenshot }
        files { basename }
        studio { name }
        performers { name }
      }
    }`;
    const results = await Promise.all(
      sceneIds.map((id) =>
        gqlFetch(query, { id: String(id) })
          .then((d) => d?.findScene || null)
          .catch(() => null)
      )
    );
    const map = {};
    for (let i = 0; i < sceneIds.length; i += 1) {
      const r = results[i];
      if (r) map[String(sceneIds[i])] = r;
    }
    return map;
  }

  // Read the Tag Categories plugin config (taxonomy + assignments).
  async function readTagCategoriesConfig() {
    const data = await gqlFetch(`query { configuration { plugins } }`, {});
    const allPlugins = data?.configuration?.plugins || {};
    const ours = allPlugins[TAG_CATEGORIES_PLUGIN_ID] || {};
    return {
      assignments: ours.assignments || {},
      taxonomy: ours.taxonomy || { categories: [] },
    };
  }

  // Read the user's Stash interface preferences that affect ScenePlayer
  // behaviour. Currently just showScrubber — Stash's setting for whether
  // the sprite-thumbnail scrubber strip is visible. ScenePlayer takes a
  // `hideScrubberOverride` prop; we set it to !showScrubber so the persona
  // respects the user's global preference.
  async function readInterfaceConfig() {
    const data = await gqlFetch(
      `query { configuration { interface { showScrubber } } }`,
      {}
    );
    return data?.configuration?.interface || {};
  }

  // Read this plugin's own stored configuration. The shape we manage:
  //   {
  //     rulesets: {
  //       "<configTagId>": {
  //         categories: {
  //           "<catName>": {
  //             hidden: bool,           // skip slide entirely
  //             maxSelections: int,     // 0 = unlimited; >=1 = auto-advance after N picks
  //             hiddenTags: [tagId,...] // individual tags hidden within this cat
  //           }
  //         }
  //       }
  //     }
  //   }
  // Missing rulesets / categories / fields fall back to defaults — see
  // `resolveRule()` below. Storage is via Stash's plugin config (same
  // mechanism Tag Categories uses).
  async function readPowerTaggerConfig() {
    const data = await gqlFetch(`query { configuration { plugins } }`, {});
    const allPlugins = data?.configuration?.plugins || {};
    const ours = allPlugins[PLUGIN_ID] || {};
    // Stash YAML-serialises plugin config on shutdown; numeric values
    // nested in objects (e.g. constraint-rule group caps, maxSelections,
    // performer-trigger values) come back as strings. Normalise here so
    // every consumer sees real numbers.
    const rulesets = normaliseRulesetsNumerics(ours.rulesets || {});
    return {
      rulesets,
      uiState: ours.uiState || {},
      defaultConfigId: ours.defaultConfigId || null,
      // v0.14.0: Power-Tagger-owned list of configurations, each
      // { id, name, tagId|null }. `null` means it has never been
      // written, which triggers the one-time migration from the legacy
      // "Configuration" Tag Categories category (see ensureConfigurations).
      configurations: Array.isArray(ours.configurations)
        ? ours.configurations
        : null,
      // v0.11.5: BOOLEAN settings. Storage keys are prefixed
      // (b_/c_/d_) so Stash's alphabetical-by-key settings UI
      // displays them in our chosen order. In-memory we keep the
      // unprefixed names so usage sites stay readable. Translation
      // happens here on read + savePowerTaggerPartial on write.
      // Stash may return strings "true"/"false" depending on version;
      // coerce defensively.
      askForSaveConfirm:
        ours.b_askForSaveConfirm === true || ours.b_askForSaveConfirm === "true",
      organiseOnSaveDefault:
        ours.c_organiseOnSaveDefault === true || ours.c_organiseOnSaveDefault === "true",
    };
  }

  async function savePowerTaggerConfig(cfg) {
    const mutation = `mutation($pluginId: ID!, $input: Map!) {
      configurePlugin(plugin_id: $pluginId, input: $input)
    }`;
    await gqlFetch(mutation, { pluginId: PLUGIN_ID, input: cfg });
  }

  // IMPORTANT — about partial saves:
  //
  // Stash's configurePlugin mutation REPLACES the per-plugin settings
  // object on the server. It does NOT merge top-level keys. So calling
  // `configurePlugin(plugin_id, { uiState: ... })` overwrites the plugin
  // config with ONLY uiState — wiping out rulesets and defaultConfigId.
  //
  // To avoid that, every save must include the full current state. The
  // helpers below all read the current config first, then write it back
  // with the requested change applied. This is a read-modify-write, so
  // there's a tiny race window where two near-simultaneous saves could
  // step on each other — but in practice users don't fire concurrent
  // edits, and the cost of getting this wrong (data loss) is much worse
  // than the cost of the extra read.
  async function savePowerTaggerPartial(patch) {
    const current = await readPowerTaggerConfig();
    const next = {
      rulesets: current.rulesets,
      uiState: current.uiState,
      defaultConfigId: current.defaultConfigId,
      // v0.14.0: preserve the configurations list on every save, same
      // reason as the keys above (configurePlugin replaces the object).
      configurations: current.configurations,
      // v0.11.5: preserve the BOOLEAN settings on every save. Stash's
      // setting UI writes these keys when the user toggles them; if
      // we don't include them here, our own save paths (cascade
      // edits, ruleset saves, etc) would wipe them. Storage keys are
      // prefixed (b_/c_) for display order; in-memory names are
      // unprefixed — translation happens here.
      b_askForSaveConfirm: current.askForSaveConfirm,
      c_organiseOnSaveDefault: current.organiseOnSaveDefault,
      ...patch,
    };
    await savePowerTaggerConfig(next);
  }

  async function savePowerTaggerRulesets(rulesets) {
    await savePowerTaggerPartial({ rulesets });
  }

  async function savePowerTaggerUiState(uiState) {
    await savePowerTaggerPartial({ uiState });
  }

  async function savePowerTaggerDefaultConfig(configId) {
    await savePowerTaggerPartial({
      defaultConfigId: configId ? String(configId) : null,
    });
  }

  // v0.14.0: persist the configurations list.
  async function savePowerTaggerConfigurations(configurations) {
    await savePowerTaggerPartial({
      configurations: Array.isArray(configurations) ? configurations : [],
    });
  }

  // v0.14.0: create a new Stash tag. Used when the user adds a
  // configuration and chooses to back it with a fresh tag.
  async function createTag(name) {
    const data = await gqlFetch(
      `mutation($input: TagCreateInput!) {
        tagCreate(input: $input) { id name }
      }`,
      { input: { name: String(name || "").trim() } }
    );
    return (data && data.tagCreate) || null;
  }

  // v0.14.0: rename an existing Stash tag. Used when a tag-linked
  // configuration is renamed.
  async function renameTag(id, name) {
    await gqlFetch(
      `mutation($input: TagUpdateInput!) {
        tagUpdate(input: $input) { id name }
      }`,
      { input: { id: String(id), name: String(name || "").trim() } }
    );
  }

  // v0.14.0: generate a stable id for a brand-new configuration. New
  // configs are NOT keyed by a tag id (they may be tagless), so they
  // need their own unique key. Prefer crypto.randomUUID; fall back to
  // a timestamp+random string on the off chance it isn't available.
  function genConfigId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
      }
    } catch (e) { /* fall through */ }
    return (
      "cfg-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 10)
    );
  }

  // v0.14.0: build the configurations list from legacy data. A
  // configuration used to be any tag assigned to the "Configuration"
  // category in the Tag Categories plugin; rulesets were keyed by that
  // tag's ID. This reconstructs an explicit list from those tags plus
  // any tag that already has a ruleset, so the migrated ids equal the
  // existing tag ids and every ruleset key stays valid.
  function buildMigratedConfigurations(rulesets, tagCategoriesConfig, allTags) {
    const byId = {};
    for (const t of allTags || []) byId[String(t.id)] = t;
    const assignments =
      (tagCategoriesConfig && tagCategoriesConfig.assignments) || {};
    const seen = new Set();
    const list = [];
    function add(id) {
      const sid = String(id);
      if (seen.has(sid)) return;
      seen.add(sid);
      const tag = byId[sid];
      list.push({ id: sid, name: tag ? tag.name : sid, tagId: sid });
    }
    for (const tid of Object.keys(assignments)) {
      const a = assignments[tid];
      if (a && a.category === "Configuration") add(tid);
    }
    for (const key of Object.keys(rulesets || {})) add(key);
    list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }

  // v0.14.0: return the configurations list, running the one-time
  // migration the first time (when the stored list is absent). Also
  // backfills a `colour` on any entry missing one — covers both fresh
  // migrations and lists saved by an earlier 0.14.0 build (before
  // per-config colour existed). Distinct palette colours are assigned
  // by position so configs start visually separable.
  async function ensureConfigurations(powerTaggerConfig, tagCategoriesConfig, allTags) {
    const migrating = !Array.isArray(powerTaggerConfig.configurations);
    const base = migrating
      ? buildMigratedConfigurations(
          powerTaggerConfig.rulesets,
          tagCategoriesConfig,
          allTags
        )
      : powerTaggerConfig.configurations;
    let changed = migrating;
    const list = base.map((c, i) => {
      if (c && c.colour) return c;
      changed = true;
      return {
        ...c,
        colour: CONFIG_COLOUR_PALETTE[i % CONFIG_COLOUR_PALETTE.length],
      };
    });
    if (changed) await savePowerTaggerConfigurations(list);
    return list;
  }

  // Resolve the effective rule for a (configTagId, catName) pair. Returns
  // an object with safe defaults regardless of what's stored. Callers can
  // pass an empty/undefined ruleset and still get a sensible result.
  //
  // Defensive: coerces stringified numerics (post-YAML-round-trip) to
  // real numbers so downstream comparisons work.
  function resolveRule(rulesets, configTagId, catName) {
    const rs = (rulesets || {})[String(configTagId)] || {};
    const cats = rs.categories || {};
    const c = cats[catName] || {};
    // Normalise subMaxSelections values to ints (the map keys are subnames,
    // values are caps that might have been stringified by YAML round-trip).
    const rawSubMax = c.subMaxSelections || {};
    const subMaxSelections = {};
    for (const k of Object.keys(rawSubMax)) {
      subMaxSelections[k] = toInt(rawSubMax[k], 0);
    }
    return {
      hidden: !!c.hidden,
      maxSelections: toInt(c.maxSelections, 0),
      hiddenTags: new Set((c.hiddenTags || []).map(String)),
      subMaxSelections,
    };
  }

  // Resolve the effective max selections for a (configTagId, catName,
  // subName) triple. Sub-level overrides category-level when set; 0 in
  // either means "unlimited at this level, fall through". The first
  // non-zero value wins (sub > cat). If both are 0/unset, returns 0
  // (unlimited).
  function resolveSubMax(rulesets, configTagId, catName, subName) {
    const rule = resolveRule(rulesets, configTagId, catName);
    const subVal = toInt(rule.subMaxSelections[subName], 0);
    if (subVal > 0) return subVal;
    return rule.maxSelections || 0;
  }

  // Cascades: when one or more trigger tags are staged, optionally stage
  // additional tags. Each cascade is now:
  //   { triggers: [tagId, ...], triggerMode: "any"|"all", addTags: [...] }
  //
  // Legacy single-trigger entries ({ trigger, addTags }) are migrated at
  // load time (normaliseRulesetsNumerics) to the new shape.
  //
  // FIRING SEMANTICS: a cascade fires when its trigger condition
  // transitions from NOT-met to MET as a result of staging a new tag.
  // - "any" mode: met when at least one trigger is staged.
  // - "all" mode: met when every trigger is staged.
  //
  // This "edge-triggered" definition means:
  //   - Stage trigger A alone (in an "all" cascade with [A, B]) → no fire.
  //   - Stage trigger B too → fire (transition not-met → met).
  //   - Remove B → no un-fire (cascade-added tags stay; matches single-
  //     trigger spec).
  //   - Re-add B → re-fire (transition not-met → met again).
  //
  // Returns the list of tag IDs to ADD given the before/after staged
  // sets. Pure: doesn't read or modify React state.
  function resolveCascades(rulesets, configTagId, stagedBefore, stagedAfter) {
    const rs = (rulesets || {})[String(configTagId)] || {};
    const cascades = rs.cascades || [];
    const out = new Set();

    // Normalise to Sets of strings for fast membership tests.
    const before = stagedBefore instanceof Set
      ? stagedBefore
      : new Set((stagedBefore || []).map(String));
    const after = stagedAfter instanceof Set
      ? stagedAfter
      : new Set((stagedAfter || []).map(String));

    function firesFor(triggers, mode, staged) {
      if (!triggers || triggers.length === 0) return false;
      if (mode === "all") {
        return triggers.every((tid) => staged.has(String(tid)));
      }
      return triggers.some((tid) => staged.has(String(tid)));
    }

    for (const c of cascades) {
      if (!c) continue;
      const triggers = Array.isArray(c.triggers) ? c.triggers : [];
      if (triggers.length === 0) continue;
      const mode = c.triggerMode === "all" ? "all" : "any";

      const wasFiring = firesFor(triggers, mode, before);
      const isFiring = firesFor(triggers, mode, after);
      // Only edge-trigger: skip if condition was already met before.
      if (wasFiring || !isFiring) continue;

      for (const tid of (c.addTags || [])) out.add(String(tid));
    }
    return [...out];
  }

  // Conditionals: per-config rules that REVEAL or HIDE categories / subs
  // / individual tags based on triggers.
  //
  // Triggers come in two flavours, evaluated together under one
  // `triggerMode` combinator:
  //   - Tag triggers — listed in `triggers`. "Is tag X currently staged?"
  //   - Performer triggers — `performerTriggers` block, same shape as a
  //     performer rule's condition. "Do scene performer counts match?"
  //
  // Rule shape:
  //   {
  //     triggers: [tagId, ...],
  //     performerTriggers: {                  // optional, may be null
  //       mode: "any" | "all",                // combines gender blocks
  //       male: {mode, value, max?} | null,
  //       female: {...} | null,
  //       other: {...} | null
  //     } | null,
  //     triggerMode: "any" | "all",           // combines tag + performer sides
  //     direction: "reveal" | "hide",
  //     targets: { cats, subs, tags }
  //   }
  //
  // Evaluation:
  //   - Compute tagSatisfied (boolean, or "absent" if triggers is empty).
  //   - Compute perfSatisfied (boolean, or "absent" if performerTriggers
  //     is null/missing).
  //   - If both sides absent -> rule never fires.
  //   - If one side absent -> evaluation reduces to whichever side is
  //     present.
  //   - Otherwise: any-of -> OR; all-of -> AND.
  function resolveActiveConditionals(rulesets, configTagId, selectedSet, performerCounts) {
    const rs = (rulesets || {})[String(configTagId)] || {};
    const conds = rs.conditionals || [];
    const active = [];
    for (const c of conds) {
      if (!c) continue;

      const tagTriggers = Array.isArray(c.triggers) ? c.triggers : [];
      const hasTagSide = tagTriggers.length > 0;
      const hasPerfSide = !!c.performerTriggers;

      if (!hasTagSide && !hasPerfSide) continue;

      const mode = c.triggerMode === "all" ? "all" : "any";

      let tagSatisfied = null;
      if (hasTagSide) {
        tagSatisfied =
          mode === "any"
            ? tagTriggers.some((tid) => selectedSet.has(String(tid)))
            : tagTriggers.every((tid) => selectedSet.has(String(tid)));
      }

      let perfSatisfied = null;
      if (hasPerfSide) {
        perfSatisfied = conditionMatches(
          c.performerTriggers,
          performerCounts || { male: 0, female: 0, other: 0 }
        );
      }

      let fires;
      if (tagSatisfied !== null && perfSatisfied !== null) {
        fires = mode === "any"
          ? (tagSatisfied || perfSatisfied)
          : (tagSatisfied && perfSatisfied);
      } else if (tagSatisfied !== null) {
        fires = tagSatisfied;
      } else {
        fires = perfSatisfied;
      }

      // Negation gate: if ANY tag in notTags is currently staged, the
      // conditional is dormant. Lets users write "reveal X when Y staged
      // UNLESS Z also staged" patterns.
      const notTags = Array.isArray(c.notTags) ? c.notTags : [];
      if (fires && notTags.length > 0) {
        if (notTags.some((tid) => selectedSet.has(String(tid)))) {
          fires = false;
        }
      }

      if (fires) active.push(c);
    }
    return active;
  }

  // Build visibility predicates layering BASE visibility (from rule.hidden
  // and rule.hiddenTags) with CONDITIONAL overlay (reveal / hide).
  //
  // Returns three predicates:
  //   catVisible(catName)
  //   subVisible(catName, subName)
  //   tagVisible(catName, tagId)
  //
  // Layering rules: conditionals overlay on top of base. A "reveal"
  // conditional makes a target visible even if it's base-hidden. A "hide"
  // conditional makes a target hidden even if it's base-visible. If a
  // target is touched by BOTH a reveal and a hide conditional in the same
  // resolution, hide wins (safer default — last-writer-wins would be too
  // surprising).
  function resolveVisibility(rulesets, configTagId, selectedSet, performerCounts, assignments) {
    const rs = (rulesets || {})[String(configTagId)] || {};
    const cats = rs.categories || {};
    const active = resolveActiveConditionals(rulesets, configTagId, selectedSet, performerCounts);

    // Collect overlay decisions.
    const revealCats = new Set();
    const hideCats = new Set();
    const revealSubs = new Set();   // "cat::sub"
    const hideSubs = new Set();
    const revealTags = new Set();
    const hideTags = new Set();
    for (const c of active) {
      const t = c.targets || {};
      if (c.direction === "reveal") {
        for (const x of (t.cats || [])) revealCats.add(x);
        for (const x of (t.subs || [])) revealSubs.add(`${x.cat}::${x.sub}`);
        for (const x of (t.tags || [])) revealTags.add(String(x));
      } else if (c.direction === "hide") {
        for (const x of (t.cats || [])) hideCats.add(x);
        for (const x of (t.subs || [])) hideSubs.add(`${x.cat}::${x.sub}`);
        for (const x of (t.tags || [])) hideTags.add(String(x));
      }
    }

    function baseCatHidden(catName) {
      return !!(cats[catName] && cats[catName].hidden);
    }
    function baseTagHidden(catName, tagId) {
      const c = cats[catName] || {};
      const list = c.hiddenTags || [];
      return list.map(String).includes(String(tagId));
    }

    function catVisible(catName) {
      // Hide overlay always wins.
      if (hideCats.has(catName)) return false;
      if (revealCats.has(catName)) return true;
      return !baseCatHidden(catName);
    }

    // Is this cat visible BECAUSE of a conditional reveal (vs base)? Used
    // by sub/tag visibility to know whether to ignore base hide at lower
    // levels. When you "reveal a category" via a conditional, the user
    // expects everything inside to come along too — otherwise the slide
    // ends up empty because base-hiding a cat in the editor also writes
    // hiddenTags for every tag inside.
    function catRevealedByConditional(catName) {
      if (hideCats.has(catName)) return false;
      return revealCats.has(catName);
    }

    function subVisible(catName, subName) {
      // Parent cat being hidden suppresses everything beneath it.
      if (!catVisible(catName)) return false;
      const key = `${catName}::${subName}`;
      if (hideSubs.has(key)) return false;
      if (revealSubs.has(key)) return true;
      // Base sub visibility — we don't have a per-sub "hidden" flag in
      // the data model. A sub is base-hidden only if ALL its tags are
      // in the cat's hiddenTags list. That check lives in the grouped
      // builder; for the predicate, treat sub as visible by default.
      return true;
    }

    function subRevealedByConditional(catName, subName) {
      if (!catVisible(catName)) return false;
      const key = `${catName}::${subName}`;
      if (hideSubs.has(key)) return false;
      if (revealSubs.has(key)) return true;
      // A sub is also "revealed by conditional" if its parent cat is,
      // since the user revealed the whole cat.
      return catRevealedByConditional(catName);
    }

    function tagVisible(catName, tagId) {
      if (!catVisible(catName)) return false;
      if (hideTags.has(String(tagId))) return false;
      if (revealTags.has(String(tagId))) return true;
      // If THIS tag's sub or its parent cat was revealed by a conditional,
      // we ignore base hiddenTags for this tag — the user's reveal-cat /
      // reveal-sub intent is to surface everything inside. Without this,
      // base-hiding a cat in the editor writes hiddenTags for every tag
      // inside it, which would re-hide them even after a cat reveal.
      // (Per-tag hide conditionals still win above — they're checked
      // before this branch.)
      if (catRevealedByConditional(catName)) return true;
      // Sub-level reveal — look up the tag's sub via assignments. Without
      // this branch, sub-reveal conditionals work for SHOWING the slide
      // (the orderedTagsFor path handles them) but the warning system
      // (which calls tagVisible directly) flags staged tags as "hidden"
      // and triggers a spurious warning. Fixes the bug where revealing a
      // whole sub-category via conditional made tags visible to STAGE
      // but raised a "hidden tag staged" warning.
      if (assignments) {
        const a = assignments[String(tagId)];
        const subName = (a && a.subcategory) || "";
        if (subName && subRevealedByConditional(catName, subName)) return true;
      }
      return !baseTagHidden(catName, tagId);
    }

    // Find conditionals that explain WHY this tag is currently hidden.
    // Two cases qualify:
    //
    //   1. Reveal-direction conditional that targets this tag (directly,
    //      via its sub, or via its cat) but is NOT currently firing.
    //      → "the rule would reveal this but its triggers aren't met"
    //
    //   2. Hide-direction conditional that targets this tag and IS
    //      currently firing.
    //      → "the rule is actively hiding this right now"
    //
    // Both produce a hard warning attributed to the conditional via
    // describeConditional. The two cases are symmetric: in (1) the
    // conditional's absence is the reason; in (2) the conditional's
    // presence is the reason. Either way, the user authored a rule that
    // explains the current hidden state.
    //
    // Returns an array of conditional objects (in editor order). Empty
    // if the tag is purely base-hidden with no conditional involvement
    // — in which case the soft "Hidden tags staged" warning fires
    // instead.
    //
    // Identity check via `active.includes(c)` is valid because `active`
    // is built from `rs.conditionals` by reference (see
    // resolveActiveConditionals), so any conditional object in `active`
    // is the same reference as one in `allConds`.
    function findBlockingConditionals(catName, tagId) {
      const allConds = rs.conditionals || [];
      const tagIdStr = String(tagId);
      const a = assignments && assignments[tagIdStr];
      const subName = (a && a.subcategory) || "";
      const out = [];
      for (const c of allConds) {
        if (!c) continue;
        const isFiring = active.includes(c);
        // Reveal case: not firing.
        // Hide case: firing.
        let qualifies;
        if (c.direction === "reveal") qualifies = !isFiring;
        else if (c.direction === "hide") qualifies = isFiring;
        else continue;
        if (!qualifies) continue;
        const targets = c.targets || {};
        const tagTargets = (targets.tags || []).map(String);
        const subTargets = targets.subs || [];
        const catTargets = targets.cats || [];
        const targetsThisTag = tagTargets.includes(tagIdStr);
        const targetsThisSub = subName && subTargets.some(
          (s) => s && s.cat === catName && s.sub === subName
        );
        const targetsThisCat = catTargets.includes(catName);
        if (targetsThisTag || targetsThisSub || targetsThisCat) {
          out.push(c);
        }
      }
      return out;
    }

    return {
      catVisible,
      subVisible,
      tagVisible,
      catRevealedByConditional,
      subRevealedByConditional,
      findBlockingConditionals,
      // Raw overlay sets — exposed so callers can distinguish between
      // "tag is hidden by conditional" vs "tag is hidden by base rules",
      // which matters for cascading reveal behaviour.
      _hideTags: hideTags,
      _hideCats: hideCats,
    };
  }

  // ---------------------------------------------------------------------
  // Performer Rules (v0.11.0)
  //
  // Per-config rules that compare the staged tags in a scope (cat or sub)
  // against the performer roster of the scene. Used to flag "you have
  // staged 2 tit-size tags but the scene has 1 female" etc.
  //
  // Authoring lives in the rules editor; evaluation lives in the
  // walkthrough warnings system. Rules don't block any flow on their own
  // — they surface as hard warnings that require explicit Proceed in
  // later stages.
  //
  // Data shape, stored per-config (see 02-project-state.md):
  //   performerRules: [
  //     {
  //       id: "<uuid>",
  //       name: string,
  //       scope: { kind: "cat" | "sub", cat: string, sub: string | null },
  //       condition: {
  //         mode: "all" | "any",
  //         male:   { mode, value, max? } | null,
  //         female: { mode, value, max? } | null,
  //         other:  { mode, value, max? } | null
  //       },
  //       limit: { base, perMale, perFemale, perOther, hardCap | null }
  //     }
  //   ]
  // ---------------------------------------------------------------------

  // v0.11.3: Pick a column count for a sub's tag grid based on how
  // many tags it has and the available pane width/height. Default
  // is 5 columns; if the sub would overflow vertically, step up to
  // 6, 7, 8, 9, or 10 (cap at 10) until it fits.
  //
  // The pane is slide-body's clientWidth/Height, which includes
  // slide-body's own padding. We subtract the chrome that sits
  // around the grid before doing the fit math:
  //
  //   SLIDE_BODY_PAD_X = 28   (left 14 + right 14)
  //   SLIDE_BODY_PAD_Y = 26   (top 12 + bottom 14)
  //   SUB_HEADER_H     = 36   (sub header bar)
  //   GRID_PAD         = 24   (grid padding: 12 top + 12 bottom; 12 left + 12 right)
  //   GAP              = 8    (gap between cards)
  //   NAME_H           = 44   (card name banner: min-height 36 + 8 line slack)
  //   CARD_BORD        = 2    (1px border top + bottom)
  //   SAFETY           = 16   (don't sit RIGHT at the edge \u2014 leaves
  //                            room for unrendered scrollbar etc.)
  //
  // Effective grid budget:
  //   gridW = paneW - SLIDE_BODY_PAD_X - GRID_PAD  (subtract horizontal grid pad too)
  //   budgetH = paneH - SLIDE_BODY_PAD_Y - SUB_HEADER_H - SAFETY
  //
  // Card sizing per col count C:
  //   cardW = (gridW - (C-1)*GAP) / C
  //   cardH = cardW + NAME_H + CARD_BORD    (image is 1:1 aspect)
  //   rows  = ceil(tagCount / C)
  //   total = rows*cardH + (rows-1)*GAP + GRID_PAD
  //
  // Return the smallest C in [5..10] where total <= budgetH.
  //
  // v0.11.4 round 2: Added explicit slide-body and grid padding
  // accounting (was implicit before; pickCols was overestimating
  // the available height by ~80px, which made 13-tag subs at 5
  // cols look like they fit when they didn't).
  function pickCols(tagCount, paneW, paneH) {
    if (!tagCount || tagCount < 1) return 5;
    if (!paneW || paneW < 100) return 5;
    if (!paneH || paneH < 100) return 5;
    const SLIDE_BODY_PAD_X = 28;
    const SLIDE_BODY_PAD_Y = 26;
    const SUB_HEADER_H = 36;
    const GRID_PAD = 24;
    const GAP = 8;
    const NAME_H = 44;
    const CARD_BORD = 2;
    const SAFETY = 16;
    const gridW = Math.max(0, paneW - SLIDE_BODY_PAD_X - GRID_PAD);
    const budgetH = Math.max(
      0,
      paneH - SLIDE_BODY_PAD_Y - SUB_HEADER_H - SAFETY
    );
    for (let C = 5; C <= 10; C++) {
      const cardW = (gridW - (C - 1) * GAP) / C;
      if (cardW < 40) continue;
      const cardH = cardW + NAME_H + CARD_BORD;
      const rows = Math.ceil(tagCount / C);
      const total = rows * cardH + (rows - 1) * GAP + GRID_PAD;
      if (total <= budgetH) return C;
    }
    return 10;
  }


  // Collapse Stash's 6-bucket gender enum to 3 buckets used by performer
  // rules. Performers with no gender are excluded (return null) and don't
  // contribute to any count.
  function bucketGender(g) {
    if (!g) return null;
    const s = String(g).toUpperCase();
    if (s === "MALE") return "male";
    if (s === "FEMALE") return "female";
    // TRANSGENDER_MALE, TRANSGENDER_FEMALE, INTERSEX, NON_BINARY — all
    // collapse to "other (any trans)". Anything else unrecognised also
    // falls through to "other" so a future enum addition fails safe.
    return "other";
  }

  // Build { male, female, other } counts from a scene's performers array.
  // Performers with no/unset gender are excluded entirely.
  function performerCountsFromScene(scene) {
    const counts = { male: 0, female: 0, other: 0 };
    const performers = (scene && scene.performers) || [];
    for (const p of performers) {
      const b = bucketGender(p && p.gender);
      if (b) counts[b] += 1;
    }
    return counts;
  }

  // ===========================================================================
  // Auto-select rule evaluator
  // ===========================================================================
  //
  // Each config can have ONE autoSelectRule object that decides whether
  // the config matches a given scene.
  //
  // Shape (v0.11.4):
  //   {
  //     rules: [
  //       { mode: "all" | "any", conditions: [Condition] },
  //       ...
  //     ]
  //   }
  //
  // The TOP-LEVEL combinator is always OR: the config matches if ANY
  // rule matches. Each rule's `mode` controls how its conditions are
  // combined (ALL=AND, ANY=OR).
  //
  // This gives users disjunction-of-conjunction expressiveness, which
  // covers nearly every realistic auto-select pattern (e.g. "twosome
  // matches if (1F+1M) OR (1F+1F) OR (1M+1M)") without exposing
  // nested boolean groups.
  //
  // Legacy shape compat: if `conditions` is present at the top level
  // (single-rule legacy), we treat it as a one-rule list. Normaliser
  // also migrates the shape at load time.
  //
  // Returns:
  //   {
  //     evaluated: bool,        // false = no rules or all rules empty
  //     matches: bool,          // overall (any rule passes)
  //     rules: [                // per-rule trace, in order
  //       { mode, matches, conditionResults: [{type, pass, summary}] }
  //     ]
  //   }
  function evaluateAutoSelectRule(rule, scene, allTagsById, assignments) {
    const out = { evaluated: false, matches: false, rules: [] };
    if (!rule || typeof rule !== "object") return out;
    // Build the list of rules to evaluate, handling legacy shape.
    let ruleList = [];
    if (Array.isArray(rule.rules)) {
      ruleList = rule.rules;
    } else if (Array.isArray(rule.conditions)) {
      // Legacy single-rule shape \u2014 wrap it.
      ruleList = [{ mode: rule.mode, conditions: rule.conditions }];
    }
    // Filter empty rules (no conditions = nothing to match against)
    // for the "evaluated" determination.
    const nonEmptyRules = ruleList.filter(
      (r) => r && Array.isArray(r.conditions) && r.conditions.length > 0
    );
    if (nonEmptyRules.length === 0) return out;
    out.evaluated = true;

    for (const r of ruleList) {
      const conditions = Array.isArray(r.conditions) ? r.conditions : [];
      const mode = r.mode === "any" ? "any" : "all";
      // Skip empty rules from the trace entirely so they don't muddy
      // the explainer. (Editor may have a half-filled "Add condition"
      // row mid-flight; ignore it for matching purposes.)
      if (conditions.length === 0) continue;
      const ruleResults = conditions.map((c) => {
        const r = resolveCondition(c, scene, allTagsById, assignments);
        // Attach the original condition object so downstream renderers
        // (the rich drift banner) can build structured per-failure
        // rows with tag chips + fix buttons. Keep .type/.pass/.summary
        // intact for existing consumers.
        return { ...r, cond: c };
      });
      const ruleMatches =
        mode === "all"
          ? ruleResults.every((rr) => rr.pass)
          : ruleResults.some((rr) => rr.pass);
      out.rules.push({
        mode,
        matches: ruleMatches,
        conditionResults: ruleResults,
      });
    }
    // Top-level OR: any rule passing means the config matches.
    out.matches = out.rules.some((r) => r.matches);
    return out;
  }

  // Summarise why an evaluated rule didn't match. Used by the picker
  // mismatch warning + the mid-walkthrough drift warning. Returns a
  // short string suitable for inline display, or "" if there's
  // nothing useful to say.
  //
  // Strategy when there's only one rule: list up to 3 failing
  // conditions verbatim. When there are multiple rules: pick the
  // rule with the FEWEST failing conditions ("closest miss") and
  // list its failures, with a "(closest miss; other rules also
  // failed)" suffix if applicable. This is much more useful than
  // dumping every condition from every rule.
  function summariseAutoSelectFailure(ruleEval) {
    if (!ruleEval || !ruleEval.evaluated) return "";
    const rules = ruleEval.rules || [];
    if (rules.length === 0) return "";
    if (rules.length === 1) {
      const failed = rules[0].conditionResults
        .filter((r) => !r.pass)
        .map((r) => r.summary);
      if (failed.length === 0) return "";
      return (
        failed.slice(0, 3).join("; ") +
        (failed.length > 3 ? "; \u2026" : "")
      );
    }
    // Multi-rule case: pick rule with the smallest miss-count.
    let best = null;
    let bestCount = Infinity;
    for (const r of rules) {
      const missing = r.conditionResults.filter((c) => !c.pass).length;
      if (missing > 0 && missing < bestCount) {
        bestCount = missing;
        best = r;
      }
    }
    if (!best) return "";
    const failed = best.conditionResults
      .filter((r) => !r.pass)
      .map((r) => r.summary);
    const head = failed.slice(0, 3).join("; ") + (failed.length > 3 ? "; \u2026" : "");
    return rules.length > 1 ? `${head} (closest of ${rules.length} alternatives)` : head;
  }

  // Return the "closest miss" rule from a multi-rule evaluation \u2014
  // the rule with the fewest failing conditions. Used by the rich
  // drift-warning renderer to show structured per-condition lines
  // (with tag chips, fix buttons, etc) for the most relevant rule.
  //
  // Returns null if no rule matched but also none has any failures
  // (shouldn't happen with evaluated:true, defensive).
  function closestMissRule(ruleEval) {
    if (!ruleEval || !ruleEval.evaluated) return null;
    const rules = ruleEval.rules || [];
    if (rules.length === 0) return null;
    if (rules.length === 1) return rules[0];
    let best = null;
    let bestCount = Infinity;
    for (const r of rules) {
      const missing = r.conditionResults.filter((c) => !c.pass).length;
      if (missing > 0 && missing < bestCount) {
        bestCount = missing;
        best = r;
      }
    }
    return best || rules[0];
  }

  // Short, human-friendly phrase for a PASSING condition. Used by
  // the picker preview's positive "matched rule" trace where the
  // full resolveCondition.summary ("Any of 2 performer(s) \u2014
  // match") is too verbose. Returns something compact like
  // "1F+1M", "Studio: Brazzers", "Compilation present", "Duration > 30min".
  //
  // Returns empty string if no good phrasing exists for this type
  // (caller skips it).
  function briefPassPhrase(cond, scene, allTagsById) {
    if (!cond || !scene) return "";
    const performers = scene.performers || [];
    const counts = performerCountsFromScene(scene);
    const studioName = (scene.studio && scene.studio.name) || "";
    function tagName(id) {
      const t = allTagsById && allTagsById[String(id)];
      return (t && t.name) || `Tag #${id}`;
    }
    const op = cond.op || "eq";
    function opSym(o) {
      switch (o) {
        case "eq": return "=";
        case "ne": return "\u2260";
        case "gt": return ">";
        case "gte": return "\u2265";
        case "lt": return "<";
        case "lte": return "\u2264";
        default: return o;
      }
    }
    switch (cond.type) {
      case "performerCount":
        return `${performers.length} performer${performers.length === 1 ? "" : "s"}`;
      case "performerCountByGender": {
        const g = cond.gender || "female";
        const letter = g === "female" ? "F" : g === "male" ? "M" : "O";
        return `${counts[g] || 0}${letter}`;
      }
      case "hasTag":
        return op === "is" ? `${tagName(cond.tagId)} present` : `${tagName(cond.tagId)} absent`;
      case "anyOfTags": {
        const ids = (cond.tagIds || []).map(String);
        const sceneTagIds = new Set((scene.tags || []).map((t) => String(t.id)));
        const matched = ids.find((id) => sceneTagIds.has(id));
        return matched ? `${tagName(matched)} present` : "";
      }
      case "allOfTags":
        return `${(cond.tagIds || []).length} tags present`;
      case "studio":
        return `Studio: ${studioName || cond.studioName || "match"}`;
      case "studioAnyOf":
        return `Studio: ${studioName || "match"}`;
      case "duration": {
        const mins = ((scene.files && scene.files[0] && scene.files[0].duration) || 0) / 60;
        if (op === "between") return `Duration ${mins.toFixed(0)}min`;
        return `Duration ${opSym(op)} ${cond.value}min`;
      }
      case "year": {
        const y = scene.date ? Number(String(scene.date).slice(0, 4)) : 0;
        return op === "between" ? `Year ${y}` : `Year ${opSym(op)} ${cond.value}`;
      }
      case "titleContains":
        return `Title contains "${cond.text || ""}"`;
      case "pathContains":
        return `Path contains "${cond.text || ""}"`;
      case "performerNameAnyOf": {
        const ids = (cond.performerIds || []).map(String);
        const matched = performers.find((p) => ids.includes(String(p.id)));
        return matched ? (matched.name || "performer match") : "performer match";
      }
      case "categoryHasAnyTag":
        return `${cond.category || "category"} has tag`;
      case "categoryTagCount":
        return `${cond.category || "category"} count match`;
      default:
        return "";
    }
  }

  // Describe a single failing condition for the rich drift-warning
  // renderer. Returns a structured object so the renderer can build
  // tag chips, fix buttons, etc \u2014 unlike resolveCondition.summary
  // which is a flat one-line string.
  //
  // Returns:
  //   {
  //     headline: string,           // bold lead text (fallback when no
  //                                 // pill, or full sentence)
  //     actual:   string,           // "Currently 4."
  //     missingTagIds: [string],    // for hasTag/allOfTags
  //     missingPerformerIds: [string], // for performerNameAnyOf
  //
  //     // Inline-pill layout (used when pill placement matters):
  //     lead:  string,              // text BEFORE the pill
  //     trail: string,              // text AFTER the pill
  //     // Renderer uses lead+pill+trail when `lead` is non-empty AND
  //     // there are missing tags to render as pills. Falls back to
  //     // headline + actual + (chips appended) otherwise.
  //   }
  function describeFailingCondition(cond, scene, allTagsById) {
    const out = {
      headline: "",
      actual: "",
      lead: "",
      trail: "",
      missingTagIds: [],
      missingPerformerIds: [],
    };
    if (!cond || !scene) return out;
    const performers = scene.performers || [];
    const sceneTagIds = new Set((scene.tags || []).map((t) => String(t.id)));
    const studioId = scene.studio && scene.studio.id ? String(scene.studio.id) : "";
    const studioName = (scene.studio && scene.studio.name) || "(none)";
    const fileDur = (scene.files && scene.files[0] && scene.files[0].duration) || 0;
    const filePath = (scene.files && scene.files[0] && scene.files[0].path) || "";
    const title = scene.title || "(no title)";
    const sceneYear = scene.date ? Number(String(scene.date).slice(0, 4)) : 0;
    const counts = performerCountsFromScene(scene);
    function tagName(id) {
      const t = allTagsById && allTagsById[String(id)];
      return (t && t.name) || `Tag #${id}`;
    }
    function opPhrase(op, value, max) {
      switch (op) {
        case "eq": return `exactly ${value}`;
        case "ne": return `not ${value}`;
        case "gt": return `more than ${value}`;
        case "gte": return `at least ${value}`;
        case "lt": return `less than ${value}`;
        case "lte": return `at most ${value}`;
        case "between": return `between ${value} and ${max}`;
        default: return `${op} ${value}`;
      }
    }
    const op = cond.op || "eq";
    switch (cond.type) {
      case "performerCount":
        out.headline = `Performer count needs to be ${opPhrase(op, cond.value, cond.max)}.`;
        out.actual = `Currently ${performers.length}.`;
        return out;
      case "performerCountByGender": {
        const g = cond.gender || "female";
        const gLabel = g[0].toUpperCase() + g.slice(1);
        out.headline = `${gLabel} performer count needs to be ${opPhrase(op, cond.value, cond.max)}.`;
        out.actual = `Currently ${counts[g] || 0}.`;
        return out;
      }
      case "hasTag": {
        const tname = tagName(cond.tagId);
        if (op === "is") {
          out.headline = `Tag required: ${tname}.`;
          out.actual = "Not on the scene.";
          out.lead = "Tag required: ";
          out.trail = ". Not on the scene.";
          out.missingTagIds = [String(cond.tagId)];
        } else {
          out.headline = `Tag must NOT be on the scene: ${tname}.`;
          out.actual = "Currently present.";
        }
        return out;
      }
      case "anyOfTags": {
        const ids = (cond.tagIds || []).map(String);
        const names = ids.map(tagName).join(", ") || "(none configured)";
        if (op === "hasAny") {
          out.headline = `Need any of: ${names}.`;
          out.actual = "None on the scene.";
          // Don't auto-fix: we don't know which one to add.
        } else {
          // hasNone: scene has at least one of them; which one(s)?
          const present = ids.filter((id) => sceneTagIds.has(id));
          out.headline = `Scene must have none of: ${names}.`;
          out.actual = `Currently has: ${present.map(tagName).join(", ")}.`;
        }
        return out;
      }
      case "allOfTags": {
        const ids = (cond.tagIds || []).map(String);
        const names = ids.map(tagName).join(", ") || "(none configured)";
        if (op === "hasAll") {
          const missing = ids.filter((id) => !sceneTagIds.has(id));
          out.headline = `Need all of: ${names}.`;
          out.actual = missing.length
            ? `Missing: ${missing.map(tagName).join(", ")}.`
            : "";
          out.missingTagIds = missing;
          // Inline form for the renderer: "Missing: [pills]. Not on the scene."
          if (missing.length > 0) {
            out.lead = `${missing.length > 1 ? "Tags required" : "Tag required"}: `;
            out.trail = `. Not on the scene.`;
          }
        } else {
          // missingAny: scene has every one of them, rule wanted at least
          // one missing.
          out.headline = `At least one of these must be missing: ${names}.`;
          out.actual = "All are currently present.";
        }
        return out;
      }
      case "studio": {
        const name = cond.studioName || cond.studioId || "(unspecified)";
        if (op === "is") {
          out.headline = `Studio must be ${name}.`;
        } else {
          out.headline = `Studio must NOT be ${name}.`;
        }
        out.actual = `Currently ${studioName}.`;
        return out;
      }
      case "studioAnyOf": {
        const ids = (cond.studioIds || []).map(String);
        const names = (cond.studioNames || []).filter(Boolean);
        const namesStr = names.length ? names.join(", ") : `${ids.length} studios`;
        if (op === "hasAny") {
          out.headline = `Studio must be one of: ${namesStr}.`;
        } else {
          out.headline = `Studio must not be one of: ${namesStr}.`;
        }
        out.actual = `Currently ${studioName}.`;
        return out;
      }
      case "duration": {
        const mins = (fileDur / 60).toFixed(1);
        out.headline = `Duration needs to be ${opPhrase(op, cond.value, cond.max)} min.`;
        out.actual = `Currently ${mins} min.`;
        return out;
      }
      case "year": {
        out.headline = `Year needs to be ${opPhrase(op, cond.value, cond.max)}.`;
        out.actual = `Currently ${sceneYear || "unknown"}.`;
        return out;
      }
      case "titleContains": {
        const text = String(cond.text || "");
        if (op === "contains") {
          out.headline = `Title needs to contain \u201C${text}\u201D.`;
        } else {
          out.headline = `Title must not contain \u201C${text}\u201D.`;
        }
        out.actual = `Title: \u201C${title}\u201D.`;
        return out;
      }
      case "pathContains": {
        const text = String(cond.text || "");
        if (op === "contains") {
          out.headline = `File path needs to contain \u201C${text}\u201D.`;
        } else {
          out.headline = `File path must not contain \u201C${text}\u201D.`;
        }
        out.actual = filePath ? `Path: \u201C${filePath}\u201D.` : "";
        return out;
      }
      case "performerNameAnyOf": {
        const ids = (cond.performerIds || []).map(String);
        const names = (cond.performerNames || []).filter(Boolean);
        const namesStr = names.length ? names.join(", ") : `${ids.length} performer(s)`;
        const currentNames = performers.map((p) => p.name).filter(Boolean).join(", ") || "(none)";
        if (op === "hasAny") {
          out.headline = `Need any of these performers: ${namesStr}.`;
          out.actual = `Currently: ${currentNames}.`;
          // Identify which referenced performers are missing.
          const sceneIds = new Set(performers.map((p) => String(p.id)));
          out.missingPerformerIds = ids.filter((id) => !sceneIds.has(id));
        } else {
          out.headline = `Scene must not have any of: ${namesStr}.`;
          const sceneIds = new Set(performers.map((p) => String(p.id)));
          const present = ids.filter((id) => sceneIds.has(id));
          const presentNames = present.map((id) => {
            const ix = ids.indexOf(id);
            return (names[ix] || performers.find((p) => String(p.id) === id)?.name || id);
          });
          out.actual = `Currently has: ${presentNames.join(", ") || "(unknown)"}.`;
        }
        return out;
      }
      case "categoryHasAnyTag": {
        const cat = cond.category || "";
        if (op === "true") {
          out.headline = `Scene needs at least one tag in \u201C${cat}\u201D.`;
          out.actual = "None present.";
        } else {
          out.headline = `Scene must have no tags in \u201C${cat}\u201D.`;
          out.actual = "Currently has at least one.";
        }
        return out;
      }
      case "categoryTagCount": {
        const cat = cond.category || "";
        out.headline = `Number of tags in \u201C${cat}\u201D needs to be ${opPhrase(op, cond.value, cond.max)}.`;
        return out;
      }
      default:
        out.headline = `Unknown condition: ${cond.type}.`;
        return out;
    }
  }

  // Operators \u2014 numeric ops on a number against a condition's value/min/max.
  function numericOp(value, op, ref, refMax) {
    const v = Number(value);
    const a = Number(ref);
    const b = Number(refMax);
    switch (op) {
      case "eq": return v === a;
      case "ne": return v !== a;
      case "gt": return v > a;
      case "gte": return v >= a;
      case "lt": return v < a;
      case "lte": return v <= a;
      case "between": return v >= a && v <= b;
      default: return false;
    }
  }
  function numericOpLabel(op) {
    switch (op) {
      case "eq": return "=";
      case "ne": return "\u2260";
      case "gt": return ">";
      case "gte": return "\u2265";
      case "lt": return "<";
      case "lte": return "\u2264";
      case "between": return "between";
      default: return op;
    }
  }

  // Resolve a single condition against the scene. Returns:
  //   { type, pass: bool, summary: string (human readable for UI) }
  function resolveCondition(cond, scene, allTagsById, assignments) {
    const out = { type: (cond && cond.type) || "unknown", pass: false, summary: "" };
    if (!cond || !cond.type || !scene) {
      out.summary = "Invalid condition";
      return out;
    }
    const performers = scene.performers || [];
    const sceneTagIds = new Set((scene.tags || []).map((t) => String(t.id)));
    const studioId = scene.studio && scene.studio.id ? String(scene.studio.id) : "";
    const fileDur = (scene.files && scene.files[0] && scene.files[0].duration) || 0;
    const filePath = (scene.files && scene.files[0] && scene.files[0].path) || "";
    const title = scene.title || "";
    const sceneYear = scene.date ? Number(String(scene.date).slice(0, 4)) : 0;
    const counts = performerCountsFromScene(scene);
    const totalPerformers = performers.length;

    function tagName(id) {
      const t = allTagsById && allTagsById[String(id)];
      return (t && t.name) || `Tag #${id}`;
    }

    switch (cond.type) {
      case "performerCount": {
        const op = cond.op || "eq";
        out.pass = numericOp(totalPerformers, op, cond.value, cond.max);
        out.summary = `Performers ${numericOpLabel(op)} ${op === "between" ? `${toInt(cond.value, 0)}\u2013${toInt(cond.max, 0)}` : toInt(cond.value, 0)} \u2014 actual ${totalPerformers}`;
        return out;
      }
      case "performerCountByGender": {
        const g = cond.gender || "female";
        const have = counts[g] || 0;
        const op = cond.op || "eq";
        out.pass = numericOp(have, op, cond.value, cond.max);
        out.summary = `${g[0].toUpperCase() + g.slice(1)} count ${numericOpLabel(op)} ${op === "between" ? `${toInt(cond.value, 0)}\u2013${toInt(cond.max, 0)}` : toInt(cond.value, 0)} \u2014 actual ${have}`;
        return out;
      }
      case "hasTag": {
        const op = cond.op || "is";
        const has = sceneTagIds.has(String(cond.tagId));
        out.pass = op === "is" ? has : !has;
        out.summary = `${op === "is" ? "Has" : "Does not have"} ${tagName(cond.tagId)} \u2014 ${has ? "present" : "absent"}`;
        return out;
      }
      case "anyOfTags": {
        const ids = (cond.tagIds || []).map(String);
        const haveAny = ids.some((id) => sceneTagIds.has(id));
        const op = cond.op || "hasAny";
        out.pass = op === "hasAny" ? haveAny : !haveAny;
        out.summary = `${op === "hasAny" ? "Has any of" : "Has none of"} ${ids.length} tag(s) \u2014 ${haveAny ? "matches" : "no match"}`;
        return out;
      }
      case "allOfTags": {
        const ids = (cond.tagIds || []).map(String);
        const haveAll = ids.length > 0 && ids.every((id) => sceneTagIds.has(id));
        const op = cond.op || "hasAll";
        out.pass = op === "hasAll" ? haveAll : !haveAll;
        out.summary = `${op === "hasAll" ? "Has all of" : "Missing any of"} ${ids.length} tag(s) \u2014 ${haveAll ? "all present" : "some missing"}`;
        return out;
      }
      case "studio": {
        const op = cond.op || "is";
        const match = studioId === String(cond.studioId || "");
        out.pass = op === "is" ? match : !match;
        out.summary = `Studio ${op === "is" ? "is" : "is not"} ${cond.studioName || cond.studioId || "?"} \u2014 ${match ? "match" : "no match"}`;
        return out;
      }
      case "studioAnyOf": {
        const ids = (cond.studioIds || []).map(String);
        const match = studioId !== "" && ids.includes(studioId);
        const op = cond.op || "hasAny";
        out.pass = op === "hasAny" ? match : !match;
        out.summary = `${op === "hasAny" ? "Studio in" : "Studio not in"} ${ids.length} studio(s) \u2014 ${match ? "match" : "no match"}`;
        return out;
      }
      case "duration": {
        // Scene duration is seconds; rule value in minutes for UX.
        const op = cond.op || "gte";
        const mins = fileDur / 60;
        out.pass = numericOp(mins, op, cond.value, cond.max);
        out.summary = `Duration ${numericOpLabel(op)} ${op === "between" ? `${toInt(cond.value, 0)}\u2013${toInt(cond.max, 0)}` : toInt(cond.value, 0)} min \u2014 actual ${mins.toFixed(1)} min`;
        return out;
      }
      case "year": {
        const op = cond.op || "eq";
        out.pass = sceneYear > 0 && numericOp(sceneYear, op, cond.value, cond.max);
        out.summary = `Year ${numericOpLabel(op)} ${op === "between" ? `${toInt(cond.value, 0)}\u2013${toInt(cond.max, 0)}` : toInt(cond.value, 0)} \u2014 actual ${sceneYear || "unknown"}`;
        return out;
      }
      case "titleContains": {
        const text = String(cond.text || "");
        const ci = cond.caseInsensitive !== false;
        const a = ci ? title.toLowerCase() : title;
        const b = ci ? text.toLowerCase() : text;
        const contains = text !== "" && a.includes(b);
        const op = cond.op || "contains";
        out.pass = op === "contains" ? contains : !contains;
        out.summary = `Title ${op === "contains" ? "contains" : "does not contain"} "${text}" \u2014 ${contains ? "match" : "no match"}`;
        return out;
      }
      case "pathContains": {
        const text = String(cond.text || "");
        const ci = cond.caseInsensitive !== false;
        const a = ci ? filePath.toLowerCase() : filePath;
        const b = ci ? text.toLowerCase() : text;
        const contains = text !== "" && a.includes(b);
        const op = cond.op || "contains";
        out.pass = op === "contains" ? contains : !contains;
        out.summary = `Path ${op === "contains" ? "contains" : "does not contain"} "${text}" \u2014 ${contains ? "match" : "no match"}`;
        return out;
      }
      case "performerNameAnyOf": {
        const ids = (cond.performerIds || []).map(String);
        const performerIdsHere = new Set(performers.map((p) => String(p.id)));
        const match = ids.some((id) => performerIdsHere.has(id));
        const op = cond.op || "hasAny";
        out.pass = op === "hasAny" ? match : !match;
        out.summary = `${op === "hasAny" ? "Any of" : "None of"} ${ids.length} performer(s) \u2014 ${match ? "match" : "no match"}`;
        return out;
      }
      case "categoryHasAnyTag": {
        const cat = cond.category || "";
        // Find tagIds assigned to this cat then intersect with scene tags.
        let has = false;
        for (const tid of sceneTagIds) {
          const a = assignments && assignments[String(tid)];
          if (a && a.category === cat) { has = true; break; }
        }
        const op = cond.op || "true";
        out.pass = op === "true" ? has : !has;
        out.summary = `${op === "true" ? "Has any tag in" : "Has no tag in"} \u201C${cat}\u201D \u2014 ${has ? "yes" : "no"}`;
        return out;
      }
      case "categoryTagCount": {
        const cat = cond.category || "";
        let n = 0;
        for (const tid of sceneTagIds) {
          const a = assignments && assignments[String(tid)];
          if (a && a.category === cat) n += 1;
        }
        const op = cond.op || "gte";
        out.pass = numericOp(n, op, cond.value, cond.max);
        out.summary = `Tags in \u201C${cat}\u201D ${numericOpLabel(op)} ${op === "between" ? `${toInt(cond.value, 0)}\u2013${toInt(cond.max, 0)}` : toInt(cond.value, 0)} \u2014 actual ${n}`;
        return out;
      }
      default:
        out.summary = `Unknown condition type: ${cond.type}`;
        return out;
    }
  }

  // For each configuration, evaluate its auto-select rule against the
  // scene and return the matching config (or null if none). Multi-
  // match resolution: pick the FIRST in display order (configTags is
  // the configurations list, in stored order). Each entry is a config
  // object { id, name, tagId }; `id` is the ruleset key.
  function pickAutoSelectConfig(configTags, rulesets, scene, allTagsById, assignments) {
    if (!Array.isArray(configTags) || !scene) return null;
    const matches = [];
    for (const tag of configTags) {
      const rs = rulesets && rulesets[String(tag.id)];
      if (!rs || typeof rs !== "object") continue;
      const result = evaluateAutoSelectRule(rs.autoSelectRule, scene, allTagsById, assignments);
      if (result.evaluated && result.matches) {
        matches.push({ tag, result });
      }
    }
    if (matches.length === 0) return null;
    return matches[0];  // first-in-order wins
  }

  // ===========================================================================
  // Auto-select rule \u2014 condition catalogue (for the Rules Editor UI)
  // ===========================================================================
  //
  // Each entry describes a condition type for the picker UI:
  //   - key:     the `type` field stored on the condition
  //   - label:   short label for the type dropdown
  //   - group:   which sub-menu group it lives in (Performers, Tags, ...)
  //   - operators: list of { value, label } for the op dropdown
  //   - valueKind: how to render the value input(s):
  //       "number"           single number (cond.value)
  //       "numberRange"      cond.value..cond.max
  //       "tagId"            single tag (cond.tagId)
  //       "tagIds"           multi tag (cond.tagIds)
  //       "studioId"         single studio (cond.studioId / cond.studioName)
  //       "studioIds"        multi studio (cond.studioIds / cond.studioNames)
  //       "performerIds"     multi performer (cond.performerIds)
  //       "text"             free text (cond.text)
  //       "category"         category-name dropdown (cond.category)
  //       "categoryAndNumber" category + value (cond.category + cond.value)
  //       "gender"           gender + op + value (uses NUM_OPS via separate render)
  //
  // The catalogue is the single source of truth for both the editor and
  // the runtime evaluator: condition types here MUST match the cases in
  // resolveCondition() above.
  const NUM_OPS = [
    { value: "eq", label: "=" },
    { value: "ne", label: "\u2260" },
    { value: "gt", label: ">" },
    { value: "gte", label: "\u2265" },
    { value: "lt", label: "<" },
    { value: "lte", label: "\u2264" },
    { value: "between", label: "between" },
  ];
  const HAS_OPS = [
    { value: "is", label: "has" },
    { value: "isNot", label: "does not have" },
  ];
  const ANY_OPS = [
    { value: "hasAny", label: "has any of" },
    { value: "hasNone", label: "has none of" },
  ];
  const ALL_OPS = [
    { value: "hasAll", label: "has all of" },
    { value: "missingAny", label: "missing any of" },
  ];
  const IS_OPS = [
    { value: "is", label: "is" },
    { value: "isNot", label: "is not" },
  ];
  const TEXT_OPS = [
    { value: "contains", label: "contains" },
    { value: "notContains", label: "does not contain" },
  ];
  const CAT_OPS_BOOL = [
    { value: "true", label: "has tag in" },
    { value: "false", label: "has no tag in" },
  ];

  const AUTO_SELECT_CONDITION_CATALOGUE = [
    { key: "performerCount",          label: "Performer count (total)",        group: "Performers",     operators: NUM_OPS,  valueKind: "numberRange" },
    { key: "performerCountByGender",  label: "Performer count by gender",      group: "Performers",     operators: NUM_OPS,  valueKind: "gender" },
    { key: "performerNameAnyOf",      label: "Performer is any of",            group: "Performers",     operators: ANY_OPS,  valueKind: "performerIds" },
    { key: "hasTag",                  label: "Scene has tag",                  group: "Tags",           operators: HAS_OPS,  valueKind: "tagId" },
    { key: "anyOfTags",               label: "Scene has any of tags",          group: "Tags",           operators: ANY_OPS,  valueKind: "tagIds" },
    { key: "allOfTags",               label: "Scene has all of tags",          group: "Tags",           operators: ALL_OPS,  valueKind: "tagIds" },
    { key: "categoryHasAnyTag",       label: "Scene has any tag in category",  group: "Tags",           operators: CAT_OPS_BOOL, valueKind: "category" },
    { key: "categoryTagCount",        label: "Count of tags in category",      group: "Tags",           operators: NUM_OPS,  valueKind: "categoryAndNumber" },
    { key: "studio",                  label: "Studio is",                      group: "Scene metadata", operators: IS_OPS,   valueKind: "studioId" },
    { key: "studioAnyOf",             label: "Studio is any of",               group: "Scene metadata", operators: ANY_OPS,  valueKind: "studioIds" },
    { key: "duration",                label: "Duration (minutes)",             group: "Scene metadata", operators: NUM_OPS,  valueKind: "numberRange" },
    { key: "year",                    label: "Year",                           group: "Scene metadata", operators: NUM_OPS,  valueKind: "numberRange" },
    { key: "titleContains",           label: "Title",                          group: "Scene metadata", operators: TEXT_OPS, valueKind: "text" },
    { key: "pathContains",            label: "File path",                      group: "Scene metadata", operators: TEXT_OPS, valueKind: "text" },
  ];

  // Sensible defaults for a freshly-added condition. The editor calls
  // this when the user picks a condition type so the row has a working
  // shape immediately (no NaN / undefined slots).
  function autoSelectConditionDefaults(type) {
    const entry = AUTO_SELECT_CONDITION_CATALOGUE.find((e) => e.key === type);
    const op = (entry && entry.operators[0] && entry.operators[0].value) || "eq";
    switch (type) {
      case "performerCount":          return { type, op, value: 2, max: 2 };
      case "performerCountByGender":  return { type, op, gender: "female", value: 1, max: 1 };
      case "performerNameAnyOf":      return { type, op, performerIds: [] };
      case "hasTag":                  return { type, op, tagId: "" };
      case "anyOfTags":               return { type, op, tagIds: [] };
      case "allOfTags":               return { type, op, tagIds: [] };
      case "categoryHasAnyTag":       return { type, op, category: "" };
      case "categoryTagCount":        return { type, op, category: "", value: 1, max: 1 };
      case "studio":                  return { type, op, studioId: "", studioName: "" };
      case "studioAnyOf":             return { type, op, studioIds: [], studioNames: [] };
      case "duration":                return { type, op, value: 30, max: 30 };
      case "year":                    return { type, op, value: 2020, max: 2024 };
      case "titleContains":           return { type, op, text: "", caseInsensitive: true };
      case "pathContains":            return { type, op, text: "", caseInsensitive: true };
      default:                        return { type, op };
    }
  }

  // Evaluate a single gender-condition block: { mode, value, max? }.
  // Returns true if `count` satisfies the block. Null blocks are treated
  // as "don't care" by the caller (this function is only called with a
  // non-null block).
  //
  // Defensive: uses `toInt` so values that slipped through stringified
  // (e.g. from a code path that bypasses `normaliseRulesetsNumerics`)
  // still compare correctly.
  function matchGenderBlock(count, block) {
    if (!block || typeof block !== "object") return true;
    const mode = block.mode || "min";
    const v = toInt(block.value, 0);
    const max = toInt(block.max, v);
    if (mode === "exact") return count === v;
    if (mode === "min")   return count >= v;
    if (mode === "max")   return count <= v;
    if (mode === "range") return count >= v && count <= max;
    if (mode === "any")   return true;
    return true;
  }

  // Test a rule's condition against performer counts.
  // condition: { mode: "all" | "any", male, female, other }.
  // All non-null gender blocks must match (mode=all) or any must match
  // (mode=any). If every gender block is null → trivially true.
  function conditionMatches(condition, counts) {
    if (!condition || typeof condition !== "object") return true;
    const blocks = [
      ["male",   condition.male],
      ["female", condition.female],
      ["other",  condition.other],
    ].filter(([, b]) => b && typeof b === "object");
    if (blocks.length === 0) return true;
    const mode = condition.mode === "any" ? "any" : "all";
    if (mode === "all") {
      return blocks.every(([k, b]) => matchGenderBlock(counts[k] || 0, b));
    }
    return blocks.some(([k, b]) => matchGenderBlock(counts[k] || 0, b));
  }

  // Resolve a group's cap given current performer counts. Each group
  // inside a rule carries its own { base, perMale, perFemale, perOther,
  // hardCap } cap object.
  // cap = base + perMale*M + perFemale*F + perOther*O, then clamped to
  // [0, hardCap] if hardCap is set.
  //
  // Defensive: uses `toInt` rather than `Number.isFinite`, so even if a
  // cap value sneaks through as a string (e.g. via a code path that
  // bypasses `normaliseRulesetsNumerics`), the math still works.
  function resolveGroupCap(group, counts) {
    const c = (group && group.cap) || {};
    const base = toInt(c.base, 0);
    const pm   = toInt(c.perMale, 0);
    const pf   = toInt(c.perFemale, 0);
    const po   = toInt(c.perOther, 0);
    let cap = base + pm * (counts.male || 0) + pf * (counts.female || 0) + po * (counts.other || 0);
    if (cap < 0) cap = 0;
    const hc = toInt(c.hardCap, null);
    if (hc !== null && hc > 0 && cap > hc) {
      cap = hc;
    }
    return cap;
  }

  // Evaluate all constraint rules (formerly "performer rules") for the
  // active config. Each rule:
  //   - Has a combined trigger model (tag triggers + performer triggers),
  //     mirroring conditionals. Either side may be absent; if both absent
  //     the rule fires unconditionally (preserves legacy behaviour where
  //     no condition meant "always").
  //   - Has a direction: "at-most" (cap is a ceiling, default) or
  //     "at-least" (cap is a floor, requirement).
  //   - Has N groups, each its own hand-picked tag list + cap.
  //
  // Returns:
  //   {
  //     perCat: Map<catName, [violation]>
  //     all: [violation]
  //   }
  // where each violation is:
  //   {
  //     rule, group, direction,
  //     stagedInGroup: [tag],
  //     cap: number,           // resolved cap given counts
  //     excess: number,        // for at-most: staged - cap (>0 fires)
  //                            // for at-least: cap - staged (>0 fires)
  //     primaryCat: string,
  //     ackKey: string
  //   }
  function evaluatePerformerRules(performerRules, performerCounts, selectedSet, assignments, allTagsById) {
    const result = { perCat: new Map(), all: [] };
    if (!Array.isArray(performerRules) || performerRules.length === 0) return result;

    const staged = selectedSet instanceof Set
      ? selectedSet
      : new Set((selectedSet || []).map(String));

    for (const rule of performerRules) {
      if (!rule) continue;

      // Trigger evaluation — mirror conditional resolver semantics.
      const tagTriggers = Array.isArray(rule.tagTriggers) ? rule.tagTriggers : [];
      const hasTagSide = tagTriggers.length > 0;
      const hasPerfSide = !!rule.performerTriggers;

      // No triggers on either side = always fire (legacy: an empty
      // condition block on an old rule meant "applies to every scene").
      let fires;
      if (!hasTagSide && !hasPerfSide) {
        fires = true;
      } else {
        const triggerMode = rule.triggerMode === "all" ? "all" : "any";
        let tagSat = null, perfSat = null;
        if (hasTagSide) {
          tagSat = triggerMode === "any"
            ? tagTriggers.some((tid) => staged.has(String(tid)))
            : tagTriggers.every((tid) => staged.has(String(tid)));
        }
        if (hasPerfSide) {
          perfSat = conditionMatches(rule.performerTriggers, performerCounts);
        }
        if (tagSat !== null && perfSat !== null) {
          fires = triggerMode === "any" ? (tagSat || perfSat) : (tagSat && perfSat);
        } else {
          fires = tagSat !== null ? tagSat : perfSat;
        }
      }
      // Negation gate: if ANY tag in notTags is currently staged, the
      // rule is dormant regardless of what the positive triggers say.
      // Lets the user author "fire when X is staged UNLESS Y is also
      // staged" patterns without having to flip every rule's logic.
      const notTags = Array.isArray(rule.notTags) ? rule.notTags : [];
      if (fires && notTags.length > 0) {
        if (notTags.some((tid) => staged.has(String(tid)))) {
          fires = false;
        }
      }
      if (!fires) continue;

      const direction = rule.direction === "at-least" ? "at-least" : "at-most";
      const groups = Array.isArray(rule.groups) ? rule.groups : [];
      if (groups.length === 0) continue;

      for (const group of groups) {
        if (!group || !Array.isArray(group.tags) || group.tags.length === 0) continue;

        const stagedInGroup = [];
        for (const tid of group.tags) {
          if (staged.has(String(tid))) {
            const tag = (allTagsById || {})[String(tid)];
            if (tag) stagedInGroup.push(tag);
          }
        }

        const cap = resolveGroupCap(group, performerCounts);

        // For at-least, "0 required" is a no-op rule.
        if (direction === "at-least" && cap <= 0) continue;

        let excess;
        if (direction === "at-most") {
          excess = stagedInGroup.length - cap;
        } else {
          excess = cap - stagedInGroup.length;
        }
        if (excess <= 0) continue;

        // Pick the dominant cat among staged tags (at-most) or among the
        // group's defined tags (at-least, since nothing is staged when
        // the violation is most severe — fall back to defined tag set).
        const catCounts = {};
        let primaryCat = "";
        const sample = stagedInGroup.length > 0
          ? stagedInGroup
          : group.tags
              .map((id) => (allTagsById || {})[String(id)])
              .filter(Boolean);
        for (const tag of sample) {
          const a = (assignments || {})[String(tag.id)];
          const cat = (a && a.category) || "";
          if (!cat) continue;
          catCounts[cat] = (catCounts[cat] || 0) + 1;
          if (!primaryCat || catCounts[cat] > catCounts[primaryCat]) {
            primaryCat = cat;
          }
        }
        if (!primaryCat && sample.length > 0) {
          const a = (assignments || {})[String(sample[0].id)];
          primaryCat = (a && a.category) || "";
        }

        // Ack key — for at-most uses the staged set (changes if staged
        // changes). For at-least uses a stable marker so a single ack
        // covers "still missing" until the user stages something from
        // the group. (Once they stage, either the rule clears, or — if
        // cap > 1 and they staged some — the staged-set portion of the
        // key flips, also clearing the ack. Correct either way.)
        const ackKey = direction === "at-most"
          ? stagedInGroup.map((t) => String(t.id)).sort().join(",")
          : "at-least:" + (group.id || "") + ":" + stagedInGroup.length;

        const violation = {
          rule, group, direction, stagedInGroup, cap, excess, primaryCat, ackKey,
        };
        result.all.push(violation);
        if (primaryCat) {
          if (!result.perCat.has(primaryCat)) result.perCat.set(primaryCat, []);
          result.perCat.get(primaryCat).push(violation);
        }
      }
    }

    return result;
  }

  // Migrate old-shape rules to the latest shape. Two legacy shapes can
  // be on disk:
  //   v0.11.0 (initial):  { scope: {cat, sub, kind}, limit: {...} }
  //   v0.11.0 rev1:       { condition, groups }
  // Target shape:        { tagTriggers, performerTriggers, triggerMode,
  //                        direction, groups }
  // Runs read-side only; disk isn't touched until the user saves.
  function migratePerformerRule(rule, assignments) {
    if (!rule || typeof rule !== "object") return rule;

    // Step 1: if a v0.11.0-initial rule (scope+limit, no groups), upgrade
    // it to v0.11.0-rev1 shape (groups[] with one group derived from
    // the scope's cat/sub).
    let r = rule;
    if (!Array.isArray(r.groups) && r.scope) {
      const scope = r.scope || {};
      const cat = scope.cat || "";
      const sub = scope.sub || "";
      const tags = [];
      const a = assignments || {};
      for (const tid of Object.keys(a)) {
        const asn = a[tid];
        if (!asn || asn.category !== cat) continue;
        if (scope.kind === "sub" && (asn.subcategory || "") !== sub) continue;
        tags.push(String(tid));
      }
      const label = scope.kind === "sub" ? `${cat} / ${sub}` : cat;
      const oldLimit = r.limit || {};
      const cap = normaliseCap(oldLimit);
      const groupId = (typeof crypto !== "undefined" && crypto.randomUUID)
        ? crypto.randomUUID()
        : "g-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
      r = {
        id: r.id,
        name: r.name,
        condition: r.condition,   // carried through; finalised in step 2
        groups: tags.length > 0
          ? [{ id: groupId, label, tags, cap }]
          : [],
      };
    }

    // Ensure groups array exists.
    if (!Array.isArray(r.groups)) r = { ...r, groups: [] };

    // Step 2: if `condition` exists and `performerTriggers` doesn't, copy
    // condition into performerTriggers. The trigger model is a superset
    // of the old condition shape, so the data is wire-compatible.
    if (r.condition && !r.performerTriggers) {
      r = { ...r, performerTriggers: r.condition };
    }

    // Defaults for the new fields.
    if (!Array.isArray(r.tagTriggers)) r = { ...r, tagTriggers: [] };
    if (!Array.isArray(r.notTags)) r = { ...r, notTags: [] };
    if (r.triggerMode !== "any" && r.triggerMode !== "all") {
      r = { ...r, triggerMode: "all" };
    }
    if (r.direction !== "at-most" && r.direction !== "at-least") {
      r = { ...r, direction: "at-most" };
    }

    // Drop the legacy `condition` key from the in-memory view — the editor
    // and evaluator both read `performerTriggers`. We leave it on disk
    // (untouched) until the user saves; once they save, the cleaned shape
    // overwrites it.
    if (r.condition) {
      const { condition, ...rest } = r;
      r = rest;
    }
    // Drop legacy `scope`/`limit` for cleanliness too.
    if (r.scope || r.limit) {
      const { scope, limit, ...rest } = r;
      r = rest;
    }

    return r;
  }

  function migratePerformerRules(rules, assignments) {
    if (!Array.isArray(rules)) return [];
    return rules.map((r) => migratePerformerRule(r, assignments));
  }

  // Lightweight summary used in the editor row collapsed view + warnings.
  function summarisePerformerRule(rule) {
    const parts = [];

    // Trigger summary.
    const tagTriggers = Array.isArray(rule && rule.tagTriggers) ? rule.tagTriggers : [];
    const cond = (rule && rule.performerTriggers) || null;
    const condParts = [];
    if (cond) {
      for (const [key, label] of [["male", "M"], ["female", "F"], ["other", "O"]]) {
        const b = cond[key];
        if (!b) continue;
        if (b.mode === "exact") condParts.push(`${label}=${b.value}`);
        else if (b.mode === "min") condParts.push(`${label}\u2265${b.value}`);
        else if (b.mode === "max") condParts.push(`${label}\u2264${b.value}`);
        else if (b.mode === "range") condParts.push(`${label}\u2208[${b.value}..${b.max}]`);
        else if (b.mode === "any") condParts.push(`${label}=any`);
      }
    }
    if (tagTriggers.length > 0) parts.push(`${tagTriggers.length} tag trigger${tagTriggers.length === 1 ? "" : "s"}`);
    if (condParts.length > 0) parts.push(condParts.join(", "));
    const condStr = parts.length ? parts.join(" + ") : "always";

    // Direction + groups summary.
    const dir = rule && rule.direction === "at-least" ? "at-least" : "at-most";
    const groups = Array.isArray(rule && rule.groups) ? rule.groups : [];
    const groupStr = groups.length === 0
      ? "no groups"
      : `${groups.length} group${groups.length === 1 ? "" : "s"}`;
    return { condStr, groupStr, directionLabel: dir === "at-least" ? "at least" : "at most" };
  }

  // Produce a human-readable description of a conditional rule.
  //
  // If the conditional has a non-empty `name` field, that's used directly.
  // Otherwise we synthesise a description from the trigger shape:
  //
  //   - Single tag trigger:           "BBG staged"
  //   - Multiple tag triggers (any):  "BBG OR Anal staged"
  //   - Multiple tag triggers (all):  "BBG AND Anal staged"
  //   - Performer-only:               "2+ male" / "1 male AND 1 female"
  //   - Combined (any/all):           "BBG staged AND 2+ male"
  //   - With notTags:                 "... UNLESS Solo staged"
  //
  // `tagsById` is the lookup map from tag id (string) to tag object — used
  // to resolve trigger tag ids back to names. Falls back to "tag#<id>" if
  // a tag isn't in the map.
  //
  // Used by warnings to attribute "hidden tag" violations to the
  // conditional that would have revealed the tag if its triggers had been
  // satisfied. Also used by the conditional editor's collapsed-row summary
  // when no name has been authored.
  function describeConditional(c, tagsById) {
    if (!c || typeof c !== "object") return "(empty rule)";
    if (typeof c.name === "string" && c.name.trim()) return c.name.trim();

    const direction = c.direction === "hide" ? "Hide" : "Reveal";
    const mode = c.triggerMode === "all" ? "all" : "any";

    const tagTriggers = Array.isArray(c.triggers) ? c.triggers : [];
    const notTags = Array.isArray(c.notTags) ? c.notTags : [];
    const pt = c.performerTriggers || null;

    const triggerNameOf = (tid) => {
      const t = tagsById && tagsById[String(tid)];
      return (t && t.name) || ("tag#" + tid);
    };

    let trigPart = "";
    if (tagTriggers.length) {
      const names = tagTriggers.map(triggerNameOf);
      trigPart = names.length === 1
        ? names[0] + " staged"
        : names.join(mode === "all" ? " AND " : " OR ") + " staged";
    }

    let perfPart = "";
    if (pt) {
      const ptMode = pt.mode === "all" ? "all" : "any";
      const blocks = [];
      for (const [k, lbl] of [["male", "male"], ["female", "female"], ["other", "other"]]) {
        const b = pt[k];
        if (!b) continue;
        if (b.mode === "exact") blocks.push(b.value + " " + lbl);
        else if (b.mode === "min") blocks.push(b.value + "+ " + lbl);
        else if (b.mode === "max") blocks.push("\u2264" + b.value + " " + lbl);
        else if (b.mode === "range") blocks.push(b.value + "-" + b.max + " " + lbl);
        else if (b.mode === "any") blocks.push("any " + lbl);
      }
      perfPart = blocks.join(ptMode === "all" ? " AND " : " OR ");
    }

    let notPart = "";
    if (notTags.length) {
      notPart = "UNLESS " + notTags.map(triggerNameOf).join(" or ") + " staged";
    }

    let result;
    if (trigPart && perfPart) {
      const combinator = mode === "all" ? " AND " : " OR ";
      result = trigPart + combinator + perfPart;
    } else if (trigPart) {
      result = trigPart;
    } else if (perfPart) {
      result = perfPart;
    } else {
      result = direction + " rule (no triggers)";
    }
    if (notPart) result += " " + notPart;
    return result;
  }

  // Console helpers — useful during Pass 1 before we have the visual
  // editor. Set a rule from devtools like:
  //   await __powerTagger.setRule("17", "Male Performer Traits", { hidden: true });
  //   await __powerTagger.setRule("17", "Hair Colour", { maxSelections: 1 });
  // Then reopen the modal.
  window.__powerTagger = window.__powerTagger || {};
  window.__powerTagger.readConfig = readPowerTaggerConfig;
  window.__powerTagger.saveConfig = savePowerTaggerConfig;
  window.__powerTagger.setRule = async function (configTagId, catName, patch) {
    const cfg = await readPowerTaggerConfig();
    const rulesets = { ...(cfg.rulesets || {}) };
    const rs = { ...(rulesets[String(configTagId)] || {}) };
    const cats = { ...(rs.categories || {}) };
    const cur = cats[catName] || {};
    cats[catName] = { ...cur, ...patch };
    rs.categories = cats;
    rulesets[String(configTagId)] = rs;
    await savePowerTaggerRulesets(rulesets);
    console.log("[power-tagger] rule saved:", configTagId, catName, cats[catName]);
  };

  // Apply staged changes to the scene as a single SceneUpdate mutation.
  // Uses tag_ids as a full replacement (Stash semantics).
  async function updateSceneTags(sceneId, tagIds, organized) {
    const mutation = `mutation($input: SceneUpdateInput!) {
      sceneUpdate(input: $input) { id }
    }`;
    const input = {
      id: String(sceneId),
      tag_ids: tagIds.map((x) => String(x)),
    };
    // v0.11.5: optional. When true, mark scene as organised in the
    // same mutation. When undefined/false, the organised flag is left
    // untouched (we don't unmark scenes).
    if (organized === true) input.organized = true;
    await gqlFetch(mutation, { input });
  }

  // v0.11.3: Replace the scene's performer list. Used by the inline
  // PerformerSelect editor under the performer row \u2014 add/remove
  // performers without leaving Power Tagger.
  async function updateScenePerformers(sceneId, performerIds) {
    const mutation = `mutation($input: SceneUpdateInput!) {
      sceneUpdate(input: $input) { id }
    }`;
    await gqlFetch(mutation, {
      input: {
        id: String(sceneId),
        performer_ids: performerIds.map((x) => String(x)),
      },
    });
  }

  // v0.12.0: Commit the scene's core metadata as a single SceneUpdate
  // mutation. Driven by the inline metadata editor under the player.
  //
  // `meta` is the editor's draft shape:
  //   { title, date, code, details, rating100,
  //     studio: {id,name}|null, urls: [string], groups: [{id,name,scene_index}] }
  //
  // Field handling (verified against SceneUpdateInput, May 2026):
  //   - title/code/details : send the string; "" clears the field.
  //   - date               : trimmed "YYYY-MM-DD", or null when cleared.
  //   - rating100           : integer 0-100, or null when unset.
  //   - studio_id          : string id, or null when cleared.
  //   - urls               : array of trimmed non-empty strings ([] clears).
  //   - groups             : [{ group_id, scene_index }] per SceneGroupInput.
  //
  // One mutation = atomic; a failure leaves the scene untouched and the
  // caller keeps its committed snapshot for retry.
  async function updateSceneMetadata(sceneId, meta) {
    const mutation = `mutation($input: SceneUpdateInput!) {
      sceneUpdate(input: $input) { id }
    }`;
    const m = meta || {};
    const dateStr = typeof m.date === "string" ? m.date.trim() : "";
    const ratingNum = toInt(m.rating100, null);
    const input = {
      id: String(sceneId),
      title: typeof m.title === "string" ? m.title : "",
      code: typeof m.code === "string" ? m.code : "",
      details: typeof m.details === "string" ? m.details : "",
      date: dateStr || null,
      rating100: ratingNum !== null && ratingNum > 0 ? ratingNum : null,
      studio_id: m.studio && m.studio.id ? String(m.studio.id) : null,
      urls: Array.isArray(m.urls)
        ? m.urls.map((u) => String(u || "").trim()).filter(Boolean)
        : [],
      groups: Array.isArray(m.groups)
        ? m.groups
            .filter((g) => g && g.id)
            .map((g) => ({
              group_id: String(g.id),
              scene_index:
                g.scene_index === null || g.scene_index === undefined
                  ? null
                  : toInt(g.scene_index, null),
            }))
        : [],
    };
    await gqlFetch(mutation, { input });
  }

  // v0.11.11: Fetch full performer records by ID, selecting the same
  // fields fetchSceneForPlayer pulls for scene.performers. Used after
  // the PerformerSelect editor adds a new performer — the entry react-
  // select hands back contains only `{ id, name }`, so the popout
  // card's detail rows (ethnicity, hair_color, height_cm, etc.) come
  // up blank until the scene is refetched. This helper backfills the
  // missing fields without a full scene refetch.
  //
  // N parallel findPerformer calls. For typical adds (1-3 performers
  // at a time) this is fast and avoids the "filter findPerformers by
  // array of IDs" pattern that doesn't exist in Stash's GraphQL.
  async function fetchPerformersByIds(ids) {
    if (!ids || !ids.length) return [];
    const query = `query($id: ID!) {
      findPerformer(id: $id) {
        id
        name
        gender
        image_path
        birthdate
        country
        ethnicity
        hair_color
        eye_color
        height_cm
        fake_tits
        measurements
        tattoos
        piercings
        circumcised
      }
    }`;
    const results = await Promise.all(
      ids.map((id) =>
        gqlFetch(query, { id: String(id) })
          .then((d) => d?.findPerformer || null)
          .catch(() => null)
      )
    );
    return results.filter(Boolean);
  }

  // -------------------------------------------------------------------------
  // Error boundary specifically for the ScenePlayer mount. If video.js / the
  // ScenePlayer trips on something, contain it and show the error in-place
  // rather than nuking the entire modal.
  // -------------------------------------------------------------------------
  class CrashBoundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { error: null };
    }
    static getDerivedStateFromError(error) {
      return { error };
    }
    componentDidCatch(error, info) {
      console.error(
        `[power-tagger] ${this.props.label || "component"} crashed:`,
        error,
        info
      );
    }
    render() {
      if (this.state.error) {
        return React.createElement(
          "div",
          {
            style: {
              padding: 20,
              color: "#f88",
              background: "#1a1a1a",
              width: "100%",
              height: "100%",
              overflow: "auto",
              fontFamily: "monospace",
              fontSize: 12,
            },
          },
          React.createElement(
            "div",
            { style: { fontSize: 14, marginBottom: 8, color: "#fcc" } },
            `${this.props.label || "Component"} failed to mount.`
          ),
          React.createElement(
            "div",
            { style: { whiteSpace: "pre-wrap", marginBottom: 8 } },
            String(this.state.error?.message || this.state.error)
          ),
          this.state.error?.stack
            ? React.createElement(
                "details",
                null,
                React.createElement("summary", null, "stack"),
                React.createElement(
                  "pre",
                  { style: { whiteSpace: "pre-wrap", fontSize: 11 } },
                  this.state.error.stack
                )
              )
            : null
        );
      }
      return this.props.children;
    }
  }

  // Backwards-compat alias for the ScenePlayer-specific wrapping.
  const ScenePlayerErrorBoundary = CrashBoundary;

  // -------------------------------------------------------------------------
  // Launch button injection on scene edit page
  // -------------------------------------------------------------------------
  function getCurrentSceneId() {
    const m = window.location.pathname.match(/^\/scenes\/(\d+)/);
    return m ? m[1] : null;
  }

  function isSceneEditPage() {
    return /^\/scenes\/\d+\/edit/.test(window.location.pathname);
  }

  function injectLaunchButtonIfNeeded() {
    if (document.querySelector("." + BUTTON_MARKER_CLASS)) return;

    // Anchor on the edit form's Save button. Verified DOM (May 2026):
    //   <div id="scene-edit-details">
    //     <form>
    //       <div class="form-container edit-buttons-container px-3 pt-3 row">
    //         <div class="edit-buttons mb-3 pl-0">
    //           <button class="edit-button btn btn-primary">Save</button>
    //           <button class="edit-button btn btn-danger">Delete</button>
    //         </div>
    //         ...scrape menu...
    //       </div>
    //     </form>
    //   </div>
    //
    // Stash renders the edit form as a TAB inside the scene detail page,
    // not as a separate /edit URL. So we don't gate on the URL — we just
    // wait for the anchor to appear in the DOM (which it does when the
    // user clicks the Edit tab).
    const editDetails = document.querySelector("#scene-edit-details");
    if (!editDetails) return;

    const saveBtn = editDetails.querySelector(
      "button.edit-button.btn.btn-primary"
    );
    if (!saveBtn) return;

    const buttonBar = saveBtn.parentElement;  // .edit-buttons
    if (!buttonBar) return;

    const sceneId = getCurrentSceneId();
    if (!sceneId) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "edit-button btn btn-info " + BUTTON_MARKER_CLASS;
    btn.textContent = "Power Tagger";
    btn.title = "Open the Power Tagger for this scene";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent(OPEN_EVENT_NAME, {
        detail: { sceneId },
      }));
    });
    buttonBar.appendChild(btn);
  }

  // v0.11.6: launch button on the scenes-LIST toolbar (next to Tag
  // Sets / Tag Categories etc). Operates on currently-checked scene
  // cards. Same DOM-anchor pattern as Tag Sets: find the toolbar
  // group containing the tagger (fa-tags) button and append.
  function isScenesListPage() {
    return /^\/scenes(\/?$|\?)/.test(window.location.pathname + window.location.search);
  }

  function injectScenesToolbarButtonIfNeeded() {
    if (!isScenesListPage()) return;
    if (document.querySelector("." + TOOLBAR_BUTTON_MARKER_CLASS)) return;

    // Anchor on the tagger (fa-tags) icon button inside the toolbar's
    // btn-group. Same anchor used by Tag Sets — verified stable.
    const fatags = document.querySelectorAll("svg.fa-tags");
    for (const icon of fatags) {
      const button = icon.closest("button");
      if (!button) continue;
      const group = button.closest('div[role="group"].btn-group');
      if (!group) continue;
      // Group needs enough buttons to be the real toolbar group, not
      // a stray fa-tags badge somewhere else on the page.
      if (group.querySelectorAll("button").length < 3) continue;

      // v0.11.6: render the toolbar button via React + Stash's own
      // react-bootstrap OverlayTrigger + Tooltip so the hover tooltip
      // matches the native Grid/List/Wall/Tagger styling exactly
      // (dark bubble + arrow, above the button, same delay + dismiss
      // behaviour). React-Bootstrap is exposed at
      // PluginApi.libraries.Bootstrap.
      const host = document.createElement("span");
      host.className = TOOLBAR_BUTTON_MARKER_CLASS;
      // span needs to behave like a flex item in the btn-group so
      // the inner button aligns correctly.
      host.style.display = "contents";
      group.appendChild(host);

      try {
        renderToolbarButton(host);
      } catch (err) {
        console.error("[power-tagger] toolbar button render error:", err);
        // If react-bootstrap rendering fails, fall back to a plain
        // DOM button so functionality isn't lost — just the tooltip
        // chrome.
        host.remove();
        injectPlainToolbarButton(group);
      }
      return;
    }
  }

  function renderToolbarButton(host) {
    const Bootstrap = (PluginApi.libraries && PluginApi.libraries.Bootstrap) || null;
    if (!Bootstrap || !Bootstrap.OverlayTrigger || !Bootstrap.Tooltip) {
      throw new Error("react-bootstrap Tooltip not available");
    }
    const { OverlayTrigger, Tooltip } = Bootstrap;

    const iconSvg = React.createElement(
      "svg",
      {
        className: "svg-inline--fa fa-rocket fa-icon",
        "aria-hidden": "true",
        focusable: "false",
        "data-prefix": "fas",
        "data-icon": "rocket",
        role: "img",
        xmlns: "http://www.w3.org/2000/svg",
        viewBox: "0 0 512 512",
      },
      React.createElement("path", {
        fill: "currentColor",
        d:
          "M505.12 19.09c-1.19-5.53-6.66-11-12.21-12.19C460.72 0 435.51 0 " +
          "410.41 0 307.18 0 245.27 55.2 199.06 128H94.84c-16.35.02-35.56 " +
          "11.88-42.86 26.48L2.02 253.61C.69 256.3 0 259.3 0 264c0 13.25 " +
          "10.74 24 24 24h103.99l-22.69 22.69c-12.5 12.5-12.5 32.76 0 " +
          "45.25l50.75 50.75c12.5 12.5 32.76 12.5 45.25 0L224 384v104c0 " +
          "13.25 10.74 24 24 24 4.7 0 7.7-.69 10.39-2.02l99.13-49.56c14.62" +
          "-7.3 26.47-26.51 26.47-42.86V312.94c72.79-46.21 128-108.13 128-" +
          "211.34 0-25.1 0-50.3-6.87-82.51zM384 168c-22.09 0-40-17.91-40-40s" +
          "17.91-40 40-40 40 17.91 40 40-17.91 40-40 40z",
      })
    );

    const tooltip = React.createElement(
      Tooltip,
      { id: "power-tagger-toolbar-tooltip" },
      "Power Tagger"
    );

    const btn = React.createElement(
      "button",
      {
        type: "button",
        className: "btn btn-secondary",
        "aria-label": "Power Tagger",
        onClick: onToolbarButtonClick,
      },
      iconSvg
    );

    const trigger = React.createElement(
      OverlayTrigger,
      { placement: "top", overlay: tooltip },
      btn
    );

    ReactDOM.render(trigger, host);
  }

  // Fallback: plain DOM button without the react-bootstrap tooltip,
  // used only if the OverlayTrigger render fails. Keeps the feature
  // alive while accepting a worse tooltip.
  function injectPlainToolbarButton(group) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-secondary " + TOOLBAR_BUTTON_MARKER_CLASS;
    btn.title = "Power Tagger";
    btn.setAttribute("aria-label", "Power Tagger");
    btn.innerHTML =
      '<svg class="svg-inline--fa fa-rocket fa-icon" ' +
      'aria-hidden="true" focusable="false" data-prefix="fas" ' +
      'data-icon="rocket" role="img" xmlns="http://www.w3.org/2000/svg" ' +
      'viewBox="0 0 512 512">' +
      '<path fill="currentColor" d="M505.12 19.09c-1.19-5.53-6.66-11-12.21-12.19' +
      'C460.72 0 435.51 0 410.41 0 307.18 0 245.27 55.2 199.06 128H94.84c-16.35' +
      '.02-35.56 11.88-42.86 26.48L2.02 253.61C.69 256.3 0 259.3 0 264c0 13.25 ' +
      '10.74 24 24 24h103.99l-22.69 22.69c-12.5 12.5-12.5 32.76 0 45.25l50.75 ' +
      '50.75c12.5 12.5 32.76 12.5 45.25 0L224 384v104c0 13.25 10.74 24 24 24 ' +
      '4.7 0 7.7-.69 10.39-2.02l99.13-49.56c14.62-7.3 26.47-26.51 26.47-42.86V' +
      '312.94c72.79-46.21 128-108.13 128-211.34 0-25.1 0-50.3-6.87-82.51zM384 ' +
      '168c-22.09 0-40-17.91-40-40s17.91-40 40-40 40 17.91 40 40-17.91 40-40 ' +
      '40z"></path></svg>';
    btn.addEventListener("click", onToolbarButtonClick);
    group.appendChild(btn);
  }

  function onToolbarButtonClick(e) {
    e.preventDefault();
    e.stopPropagation();

    // Capture all currently-checked scene cards. Same selection
    // pattern as Tag Sets / Gallery Matcher / Scene Gallery Copy.
    const checkedBoxes = document.querySelectorAll(".card-check:checked");
    const sceneIds = [];
    for (const cb of checkedBoxes) {
      const card = cb.closest(".scene-card");
      if (!card) continue;
      const link = card.querySelector('a[href^="/scenes/"]');
      if (!link) continue;
      const m = link.getAttribute("href").match(/\/scenes\/(\d+)/);
      if (m) sceneIds.push(m[1]);
    }

    if (sceneIds.length === 0) {
      alert("Select one or more scenes first.");
      return;
    }

    // v0.11.9: dispatch ALL selected sceneIds. Host handles single vs
    // multi: single (length 1) opens identically to before — no
    // confirmation, no queue UI. Multi (length > 1) shows a "Tag N
    // scenes?" confirmation, then processes the queue (Save advances
    // to next scene; Cancel exits the whole queue).
    //
    // returnUrl is informational only as of v0.11.8 (toolbar saves no
    // longer navigate — they close the modal with Apollo cache
    // refresh), but kept in case future changes want it.
    window.dispatchEvent(new CustomEvent(OPEN_EVENT_NAME, {
      detail: {
        sceneId: sceneIds[0], // back-compat: existing host reads this
        sceneIds: sceneIds,   // v0.11.9: full queue
        source: "toolbar",
        returnUrl: window.location.pathname + window.location.search + window.location.hash,
      },
    }));
  }

  // -------------------------------------------------------------------------
  // Settings → Plugins → "Edit Power Tagger Rules" button hijack.
  //
  // Same pattern as the Tag Categories plugin: declare a STRING setting in
  // the YAML so Stash renders an "Edit" button in the plugin's row, then
  // intercept the click in capture phase before Stash's default handler.
  // -------------------------------------------------------------------------
  function injectSettingsButtonHandlerIfNeeded() {
    if (!window.location.pathname.startsWith("/settings")) return;

    const editButtons = [...document.querySelectorAll("button")].filter(
      (b) => ((b.textContent || "").trim() === "Edit")
    );
    for (const btn of editButtons) {
      if (btn.getAttribute(SETTINGS_BTN_MARKER)) continue;

      // We need to find the IMMEDIATE setting-row container for this
      // button — not just any ancestor that contains our displayName, or
      // we'll match the entire settings page (which contains every plugin's
      // displayName).
      //
      // Strategy: walk up only a few levels and require our displayName
      // to be present AND for the ancestor's text to start with or be
      // dominated by it. Setting rows in Stash typically contain the
      // displayName, the description, and the Edit button only — so the
      // total text of OUR row, normalised, starts with "Edit Power Tagger
      // Rules".
      const TARGET = "edit power tagger rules";
      let p = btn.parentElement;
      let matched = false;
      for (let i = 0; i < 5 && p; i++) {
        const txt = (p.textContent || "").trim().toLowerCase();
        // Require the target string at the start. The row text begins with
        // the displayName, so this catches our row but excludes any
        // ancestor that just happens to include the phrase elsewhere.
        if (txt.startsWith(TARGET)) {
          matched = true;
          break;
        }
        p = p.parentElement;
      }
      if (!matched) continue;

      btn.setAttribute(SETTINGS_BTN_MARKER, "1");
      btn.addEventListener(
        "click",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT));
        },
        true
      );
    }
  }

  // -------------------------------------------------------------------------
  // PortalModal — same pattern as our other plugins
  //
  // v0.11.5: optional `onCloseRequest` prop. If supplied, the header
  // Close button calls it instead of `onHide`. Lets a body intercept
  // the Close click to show a confirm-discard prompt for unsaved
  // changes. If absent, falls back to `onHide` as before.
  // -------------------------------------------------------------------------
  function PortalModal({ show, onHide, onCloseRequest, title, children, leftAdornment }) {
    // Lock body scroll while the modal is open. Stash's <body> has
    // overflow-y: auto, so any absolutely-positioned descendant of body
    // (notably react-select's portalled dropdown menu when it extends
    // past the viewport) grows body's scrollHeight and brings up a page-
    // level scrollbar. That scrollbar scrolls the page *behind* the
    // modal — not the modal itself — which feels broken. We hold body's
    // overflow at hidden for the duration of the modal so that doesn't
    // happen. We restore the original value on unmount.
    React.useEffect(() => {
      if (!show) return undefined;
      const prevBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prevBodyOverflow;
      };
    }, [show]);

    if (!show) return null;
    // Outside-click dismissal removed: the modal is "modal" \u2014 only
    // explicit Close / Cancel / Save buttons should be able to close
    // it. A stray click on the dim overlay previously closed the
    // modal, which was easy to do accidentally (losing in-flight
    // staging or rule edits).
    const closeHandler = onCloseRequest || onHide;
    const modalNode = React.createElement(
      "div",
      { className: "power-tagger-modal" },
      React.createElement(
        "div",
        { className: "power-tagger-header" },
        React.createElement("h5", null, title || "Power Tagger"),
        React.createElement(
          "button",
          {
            type: "button",
            className: "btn btn-sm btn-secondary",
            onClick: closeHandler,
          },
          "Close"
        )
      ),
      React.createElement(
        "div",
        { className: "power-tagger-body" },
        children
      )
    );
    // v0.11.10: optional leftAdornment renders to the left of the modal,
    // inside the same overlay. Used by the queue sidebar in multi-scene
    // toolbar launches. When absent (every other caller, including the
    // rules editor), the modal renders alone exactly as before.
    const contents = leftAdornment
      ? React.createElement(
          "div",
          { className: "power-tagger-queue-shell" },
          leftAdornment,
          modalNode
        )
      : modalNode;
    const overlay = React.createElement(
      "div",
      { className: "power-tagger-overlay" },
      contents
    );
    return ReactDOM.createPortal(overlay, document.body);
  }

  // -------------------------------------------------------------------------
  // CategorySections — the right-side tag picker.
  //
  // Layout: a horizontal carousel. Each category is a "slide" the full width
  // of the panel; advancing moves the slide strip left by 100% via CSS
  // transform. A header strip across the top lets you jump between
  // categories. A nav bar at the bottom drives Back / Next / progress.
  //
  // Tag cards are polaroid-style: square image on top, name on a strip
  // below. Fixed 4-column grid. Tags already on the scene are filtered
  // out of display (they live in the bottom TagSelect instead).
  //
  // The "__uncategorised" pseudo-slide is appended last when there are
  // unassigned tags.
  //
  // Clicking a tag card calls onToggleTag(tagId) — stages it if absent,
  // unstages it if already staged.
  // -------------------------------------------------------------------------
  function CategorySections({
    taxonomy,
    assignments,
    allTags,
    selectedIds,
    onToggleTag,
    onRemoveTags,
    onAddTags,
    rulesets,
    configTagId,
    // v0.14.0: Set of Stash tag ids that back configurations. Excluded
    // from the grouped taggable tags so config tags never surface as
    // normal tags during the walkthrough.
    configTagIds,
    performerCounts,
    // v0.11.4: live snapshot of the scene (original + staged tags +
    // live performers). Used by the auto-select rule drift detector
    // to surface a warning when the active config no longer matches
    // the scene as it stands.
    liveScene,
    // v0.11.2: save-confirm modal is owned by CategorySections (since
    // it owns the warnings derivation). The parent's Save button calls
    // saveHandlerRef.current() to trigger the confirm-or-save flow.
    // onConfirmedSave is the parent's actual save function — invoked
    // immediately when there are no warnings, or via "Save Anyway".
    saveHandlerRef,
    onConfirmedSave,
  }) {
    const selectedSet = React.useMemo(
      () => new Set((selectedIds || []).map(String)),
      [selectedIds]
    );

    // Build (catName -> subName -> [tagObj])
    const grouped = React.useMemo(() => {
      const byId = {};
      for (const t of allTags) byId[String(t.id)] = t;
      const out = {};
      for (const tid of Object.keys(assignments || {})) {
        // Previously we skipped tags already in selectedSet to keep them
        // out of the upper panel. We now render them dimmed/ticked so the
        // user can see at-a-glance what's already on the scene — and
        // toggling re-removes from selectedSet (see handleCardClick).
        const a = assignments[tid];
        if (!a || !a.category) continue;
        // v0.14.0: skip tags that back a configuration — they are not
        // ordinary taggable tags.
        if (configTagIds && configTagIds.has(String(tid))) continue;
        const cat = a.category;
        const sub = a.subcategory || "";
        const tagObj = byId[String(tid)];
        if (!tagObj) continue;
        if (!out[cat]) out[cat] = {};
        if (!out[cat][sub]) out[cat][sub] = [];
        out[cat][sub].push(tagObj);
      }
      return out;
    }, [assignments, allTags, configTagIds]);

    // Order categories: taxonomy order, with two filters applied.
    //   - The "Configuration" category is OMITTED entirely from the
    //     carousel — it's the picker phase, not a walkthrough step.
    //   - Categories the active ruleset hides (or that conditional
    //     visibility hides based on staged tags) are also omitted.
    //
    // Tag Categories' per-category `hidden` flag is NOT consulted here.
    // That flag controls visibility on the Tags page inside the Tag
    // Categories plugin itself; Power Tagger has its own per-config
    // hide rule (cats[name].hidden inside a ruleset) which is the only
    // thing that decides whether a category appears in the walkthrough.
    //
    // Visibility resolver — combines base (category hidden, hiddenTags)
    // with conditional overlays (reveal / hide rules driven by what the
    // user has staged so far). Memoised so we don't rebuild on every
    // render, but its key inputs (selectedSet, rulesets, configTagId)
    // change frequently enough that the carousel re-renders live as the
    // user stages and unstages trigger tags.
    const visibility = React.useMemo(
      () => resolveVisibility(
        rulesets,
        configTagId,
        selectedSet,
        performerCounts || { male: 0, female: 0, other: 0 },
        assignments
      ),
      [rulesets, configTagId, selectedSet, performerCounts, assignments]
    );

    const orderedCats = React.useMemo(() => {
      const all = taxonomy.categories || [];
      const noConfig = all.filter((c) => c.name !== "Configuration");
      return noConfig.filter((c) => visibility.catVisible(c.name));
    }, [taxonomy, visibility]);

    // v0.11.2: Lookup from tag id → cat colour. Used by warning chips
    // so each chip can show the tag's category colour the same way the
    // tag cards in the picker do. Falls through to a neutral grey for
    // tags whose cat has no colour or that are uncategorised.
    //
    // Uses ALL cats (incl. hidden + Configuration), so warnings on
    // tags from hidden cats / Configuration still get coloured.
    const tagColourById = React.useMemo(() => {
      const colourByCat = {};
      for (const c of (taxonomy.categories || [])) {
        colourByCat[c.name] = c.colour || "#5a6e85";
      }
      const out = {};
      for (const tid of Object.keys(assignments || {})) {
        const a = assignments[tid];
        if (!a) continue;
        const colour = colourByCat[a.category];
        if (colour) out[String(tid)] = colour;
      }
      return out;
    }, [taxonomy, assignments]);

    // Tag order within each subcategory comes from category.tagOrder; tags
    // not in tagOrder fall to the end in insertion order. Tags hidden in
    // the active ruleset (via base hiddenTags OR an active conditional)
    // are filtered out; tags REVEALED by a conditional pass through even
    // if they're in base hiddenTags.
    function orderedTagsFor(cat, subName) {
      const list = (grouped[cat.name] && grouped[cat.name][subName]) || [];
      const order = (cat.tagOrder && cat.tagOrder[subName]) || [];
      // A tag is shown iff: cat is visible, AND it's not hide-overlay'd,
      // AND (it's reveal-overlay'd OR its sub/cat is reveal-overlay'd OR
      // it's not base-hidden).
      //
      // The sub-reveal branch surfaces tags that the editor wrote into
      // hiddenTags when the user toggled the whole cat / sub off in the
      // base rules — without it, "reveal cat" produces empty slides.
      // Per-tag HIDE conditionals still win (we check the hide overlay
      // before applying the sub-reveal override).
      const subRevealed = visibility.subRevealedByConditional(cat.name, subName);
      const filtered = list.filter((t) => {
        if (visibility.tagVisible(cat.name, t.id)) return true;
        if (!subRevealed) return false;
        // Sub-reveal override: surface the tag UNLESS it's explicitly
        // hidden by a hide-conditional (tag-level or cat-level). Those
        // win over reveals. Otherwise the tag's only "hide" reason was
        // base hide, which sub-reveal supersedes.
        if (visibility._hideTags.has(String(t.id))) return false;
        if (visibility._hideCats.has(cat.name)) return false;
        if (!visibility.catVisible(cat.name)) return false;
        return true;
      });
      const byId = {};
      for (const t of filtered) byId[String(t.id)] = t;
      const out = [];
      for (const tid of order) {
        if (byId[tid]) {
          out.push(byId[tid]);
          delete byId[tid];
        }
      }
      // Any remaining (not in tagOrder) go at the end
      for (const tid of Object.keys(byId)) out.push(byId[tid]);
      return out;
    }

    // Uncategorised — tags assigned to no category, sorted by name. Becomes
    // the trailing slide in the carousel when present. Staged tags are NOT
    // filtered out here (see grouped above) — they render dimmed with a
    // ✓ so users can see what's staged at a glance + toggle them off.
    const uncategorisedTags = React.useMemo(() => {
      const knownAssigned = new Set(Object.keys(assignments || {}).map(String));
      return allTags
        .filter((t) => !knownAssigned.has(String(t.id)))
        .sort((a, b) => a.name.localeCompare(b.name));
    }, [allTags, assignments]);

    // Build the carousel slide list. Each slide has a `name` (used for
    // currentIdx tracking + check-mark counts), a `colour`, a `subs` map of
    // sub-name → ordered tag list, and a `headerLabel` for the top strip.
    const slides = React.useMemo(() => {
      const out = orderedCats.map((cat) => {
        const subsHere = cat.subcategories && cat.subcategories.length > 0
          ? cat.subcategories
          : [""];
        const subs = subsHere
          .filter((sub) => visibility.subVisible(cat.name, sub))
          .map((sub) => ({
            name: sub,
            tags: orderedTagsFor(cat, sub),
          }))
          .filter((s) => s.tags.length > 0);
        return {
          name: cat.name,
          colour: cat.colour || "#5a6e85",
          headerLabel: cat.name,
          subs,
        };
      }).filter((slide) => slide.subs.length > 0);
      if (uncategorisedTags.length > 0) {
        out.push({
          name: "__uncategorised",
          colour: "#555555",
          headerLabel: "Uncategorised",
          subs: [{ name: "", tags: uncategorisedTags }],
        });
      }
      return out;
    }, [orderedCats, uncategorisedTags, grouped, visibility]);

    // Current position: slide index + sub index within that slide.
    // v0.11.4 introduces sub-level navigation \u2014 Next advances one sub
    // at a time, not one slide at a time. Slides with no real subs
    // still have one entry in `subs` (with name ""), so position
    // (slideIdx, 0) is valid for every slide.
    const [currentIdx, setCurrentIdx] = React.useState(0);
    const [currentSubIdx, setCurrentSubIdx] = React.useState(0);
    React.useEffect(() => {
      if (currentIdx >= slides.length && slides.length > 0) {
        setCurrentIdx(slides.length - 1);
        setCurrentSubIdx(0);
      }
    }, [slides.length, currentIdx]);

    // Count the number of visible tags in a sub. Used by "empty sub
    // skip" \u2014 a sub with no visible tags at all is skipped during
    // navigation since there's nothing to interact with.
    //
    // catName: the slide.name (cat name) the sub belongs to.
    // sub: the sub object (has .tags).
    // visibility: result of resolveVisibility \u2014 has tagVisible(cat, id).
    function subVisibleTagCount(catName, sub, visibility) {
      if (!sub || !sub.tags) return 0;
      let n = 0;
      for (const t of sub.tags) {
        if (!visibility || visibility.tagVisible(catName, t.id)) n++;
      }
      return n;
    }

    // Compute the next/previous valid (slideIdx, subIdx) position,
    // skipping empty subs. Returns null if we're already at the
    // boundary.
    function findNextPosition(fromSlideIdx, fromSubIdx, visibility) {
      let s = fromSlideIdx;
      let i = fromSubIdx + 1;
      while (s < slides.length) {
        const slide = slides[s];
        const subs = (slide && slide.subs) || [];
        while (i < subs.length) {
          // Skip empty subs (no visible tags). Single-entry "" subs
          // are kept since they're how cats-without-subs render.
          if (
            subs[i].name === "" ||
            subVisibleTagCount(slide.name, subs[i], visibility) > 0
          ) {
            return { slideIdx: s, subIdx: i };
          }
          i++;
        }
        s++;
        i = 0;
      }
      return null;
    }
    function findPrevPosition(fromSlideIdx, fromSubIdx, visibility) {
      // Step backward one sub at a time. When we drop below subIdx 0,
      // move to the previous slide's LAST sub and continue searching.
      let s = fromSlideIdx;
      let i = fromSubIdx - 1;
      while (s >= 0) {
        const slide = slides[s];
        const subs = (slide && slide.subs) || [];
        while (i >= 0) {
          if (
            subs[i].name === "" ||
            subVisibleTagCount(slide.name, subs[i], visibility) > 0
          ) {
            return { slideIdx: s, subIdx: i };
          }
          i--;
        }
        // Wrap to previous slide's last sub.
        s--;
        if (s >= 0) {
          i = (slides[s].subs || []).length - 1;
        }
      }
      return null;
    }

    function goTo(idx) {
      if (idx < 0 || idx >= slides.length) return;
      setCurrentIdx(idx);
      setCurrentSubIdx(0);
    }
    function goToPosition(slideIdx, subIdx) {
      if (slideIdx < 0 || slideIdx >= slides.length) return;
      setCurrentIdx(slideIdx);
      setCurrentSubIdx(Math.max(0, subIdx || 0));
    }
    function goBack() {
      const prev = findPrevPosition(currentIdx, currentSubIdx, visibility);
      if (!prev) return;
      // If we're crossing back into a previous slide, don't mark
      // anything completed (Back doesn't un-complete; once Next-ed
      // past, the cat stays ticked for the modal session).
      // Re-open the sub we're going back TO so the user can edit it
      // again. This matches the user's expectation that Back
      // un-does what Next did.
      const slide = slides[prev.slideIdx];
      if (slide) {
        const sub = slide.subs[prev.subIdx];
        if (sub) {
          setExpandedSubs((cur) => {
            const next = new Set(cur);
            next.add(subKey(slide.name, sub.name));
            return next;
          });
        }
      }
      setCurrentIdx(prev.slideIdx);
      setCurrentSubIdx(prev.subIdx);
    }
    function goNext() {
      const next = findNextPosition(currentIdx, currentSubIdx, visibility);
      // Auto-collapse the sub we're leaving (so it stays collapsed
      // when we return to its slide later). The user can still
      // expand it manually via its header chevron.
      const curSlide = slides[currentIdx];
      const curSub = curSlide && curSlide.subs[currentSubIdx];
      if (curSlide && curSub) {
        setExpandedSubs((cur) => {
          const set = new Set(cur);
          set.delete(subKey(curSlide.name, curSub.name));
          return set;
        });
      }
      if (!next) return;
      // If next position is in a different slide, mark the current
      // slide as completed (its top-strip pill gets a check mark).
      if (curSlide && next.slideIdx !== currentIdx) {
        setCompletedCats((prev) => {
          if (prev.has(curSlide.name)) return prev;
          const out = new Set(prev);
          out.add(curSlide.name);
          return out;
        });
      }
      setCurrentIdx(next.slideIdx);
      setCurrentSubIdx(next.subIdx);
    }
    // Skip directly to the first sub of the NEXT slide (regardless
    // of where we are within the current slide). Always-available
    // shortcut: "I'm done with this whole category." Does NOT
    // collapse intermediate subs \u2014 only marks the current cat as
    // completed.
    function skipToNextCat() {
      const curSlide = slides[currentIdx];
      if (currentIdx >= slides.length - 1) return;
      if (curSlide) {
        setCompletedCats((prev) => {
          if (prev.has(curSlide.name)) return prev;
          const out = new Set(prev);
          out.add(curSlide.name);
          return out;
        });
        // Collapse all subs of the cat we're leaving.
        setExpandedSubs((cur) => {
          const set = new Set(cur);
          for (const s of curSlide.subs) set.delete(subKey(curSlide.name, s.name));
          return set;
        });
      }
      setCurrentIdx(currentIdx + 1);
      setCurrentSubIdx(0);
    }

    // Set of category names the user has confirmed by hitting Next from.
    // Used by the top strip to render check marks.
    const [completedCats, setCompletedCats] = React.useState(new Set());

    // When configTagId changes (the user picks/changes a config), reset
    // walkthrough state so the new config starts fresh:
    //   - currentIdx back to slide 0
    //   - subClickCounts cleared (auto-advance counters)
    //   - completedCats cleared (no ticks until user re-walks)
    //   - sub-collapse state cleared (first visit to every slide of the
    //     new config gets all-subs-open behaviour again)
    // Staged tags themselves are reset in PowerTaggerBody's onConfirmConfig.
    React.useEffect(() => {
      setCurrentIdx(0);
      setCurrentSubIdx(0);
      setCompletedCats(new Set());
      // subClickCounts is declared further down — we set it via the
      // setter once that line has executed. Use a ref to capture the
      // setter at module load (this effect runs on every configTagId
      // change, by which time the setter exists).
      if (subClickCountsResetRef.current) {
        subClickCountsResetRef.current();
      }
      // Reset sub-collapse state so the new config's slides each get
      // their "first visit = all open" seeding.
      if (subCollapseResetRef.current) {
        subCollapseResetRef.current();
      }
    }, [configTagId]);
    const subClickCountsResetRef = React.useRef(null);
    const subCollapseResetRef = React.useRef(null);

    // Sub-collapse state. Each slide has independently-collapsible sub-
    // categories; we track the *currently visible* slide's open subs only,
    // and reset whenever currentIdx changes (per UX spec: "reset to first
    // sub open each time the slide is shown").
    //
    // Sub-collapse state. Each entry is a composite key
    // "slideName::subName" so subs from different slides don't collide
    // (multiple cats can have a sub named "Race", "Hair Colour", etc).
    //
    // Persistence: once the user closes a sub it STAYS closed across
    // slide navigation for the current modal session — moving away
    // and back, or auto-advancing to the next slide, won't reopen it.
    // On first visit to a slide every sub starts open; subsequent
    // visits preserve whatever the user did.
    //
    // The `seenSlides` ref tracks which slides we've already
    // initialised, so the seeding logic doesn't keep re-opening subs
    // on every re-render of the same slide.
    function firstSubName(slide) {
      return (slide && slide.subs[0] && slide.subs[0].name) || "";
    }
    function subKey(slideName, subName) {
      return `${slideName}::${subName}`;
    }
    const seenSlidesRef = React.useRef(new Set());
    const [expandedSubs, setExpandedSubs] = React.useState(() => {
      const s = new Set();
      if (slides[0]) {
        for (const sub of slides[0].subs) s.add(subKey(slides[0].name, sub.name));
        seenSlidesRef.current.add(slides[0].name);
      }
      return s;
    });
    // On slide change, seed any first-time-visited slide's subs as
    // OPEN. Don't touch anything for slides we've already initialised
    // \u2014 their state (open or closed by user action) persists.
    React.useEffect(() => {
      const slide = slides[currentIdx];
      if (!slide) return;
      if (seenSlidesRef.current.has(slide.name)) return;
      seenSlidesRef.current.add(slide.name);
      setExpandedSubs((prev) => {
        const next = new Set(prev);
        for (const sub of slide.subs) next.add(subKey(slide.name, sub.name));
        return next;
      });
    }, [currentIdx, slides]);

    function toggleSub(slideName, subName) {
      const k = subKey(slideName, subName);
      setExpandedSubs((prev) => {
        const next = new Set(prev);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        return next;
      });
    }

    // Register a reset hook callable from the config-change effect
    // above. Clears seenSlides + reseeds the current slide 0 as
    // all-open so the new config starts fresh.
    subCollapseResetRef.current = () => {
      seenSlidesRef.current = new Set();
      const slide0 = slides[0];
      const next = new Set();
      if (slide0) {
        for (const sub of slide0.subs) next.add(subKey(slide0.name, sub.name));
        seenSlidesRef.current.add(slide0.name);
      }
      setExpandedSubs(next);
    };

    // Auto-advance: when the user clicks a card, scroll the slide body so
    // the NEXT sub's header is at the top. We do NOT collapse anything —
    // all subs stay open. CSS scroll-snap on the slide body + min-height:
    // 100% on each sub means the browser handles the snap and smoothness
    // natively, with no jitter.
    //
    // Re-editing is just scrolling back up. Manual sub-header toggle is
    // still available for users who want to hide a section.
    //
    // Selections-per-sub bookkeeping: we count clicks per (slideName,
    // subName) for the current modal session. When the count reaches the
    // category's maxSelections (from the active ruleset), we auto-advance
    // to the next sub. If maxSelections is 0 (unlimited), we never auto-
    // advance — user clicks Next manually.
    const slideBodyRefs = React.useRef({});
    function setSlideBodyRef(slideName) {
      return (el) => { slideBodyRefs.current[slideName] = el; };
    }

    // v0.11.3: Auto-shrink dimensions. Track the current slide body's
    // available width + height so we can pick a column count per
    // sub that lets the sub fit without vertical scrolling. Updated
    // via ResizeObserver on the slide body plus a refresh on slide
    // change (currentIdx). The pickCols pure function below
    // consumes these to choose 5..10 cols per sub.
    const [slideBodyDims, setSlideBodyDims] = React.useState({
      width: 0,
      height: 0,
    });
    // Throttle: only update state if the new values are meaningfully
    // different (>=2 px). Stops a ResizeObserver loop in some browsers
    // where layout settles within sub-pixel jitter.
    function maybeSetDims(w, h) {
      setSlideBodyDims((prev) => {
        if (Math.abs(prev.width - w) < 2 && Math.abs(prev.height - h) < 2) {
          return prev;
        }
        return { width: w, height: h };
      });
    }
    React.useEffect(() => {
      // Measure the current slide body.
      const slide = slides[currentIdx];
      if (!slide) return undefined;
      const el = slideBodyRefs.current[slide.name];
      if (!el) {
        // Element not mounted yet \u2014 wait a frame then try again.
        const t = setTimeout(() => {
          const e2 = slideBodyRefs.current[slide.name];
          if (e2) maybeSetDims(e2.clientWidth, e2.clientHeight);
        }, 0);
        return () => clearTimeout(t);
      }
      maybeSetDims(el.clientWidth, el.clientHeight);
      if (typeof ResizeObserver === "undefined") return undefined;
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const cr = entry.contentRect;
          maybeSetDims(cr.width, cr.height);
        }
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, [currentIdx, slides]);

    // Map: `${slideName}::${subName}` -> count of clicks this session.
    // Persists across slide changes (sub doesn't auto-reset, by design —
    // it's a click counter, not a "have I been here recently" flag).
    const [subClickCounts, setSubClickCounts] = React.useState({});
    // Expose the setter to the configTagId-change effect above (declared
    // before this state, so it can't reference setSubClickCounts directly).
    subClickCountsResetRef.current = () => setSubClickCounts({});

    function scrollBodyToSub(slide, subName) {
      requestAnimationFrame(() => {
        const body = slideBodyRefs.current[slide.name];
        if (!body) return;
        const target = body.querySelector(
          `[data-sub-name="${cssEscape(subName)}"]`
        );
        if (!target) return;
        const bodyRect = body.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const delta = targetRect.top - bodyRect.top;
        body.scrollTop = body.scrollTop + delta;
      });
    }

    // v0.11.4: handleCardClick just toggles the tag now. All
    // advancement is explicit (the contextual Next button). The
    // old auto-advance based on subClickCounts + cap was unreliable
    // (only fired when a cat-level cap was set, ignored Conditional
    // visibility, surprised users) and got removed in 0.11.4. The
    // subClickCounts state remains for potential future telemetry
    // but is no longer consumed by navigation.
    function handleCardClick(slide, subName, tagId) {
      onToggleTag(tagId);
    }

    // Top strip auto-scroll: when currentIdx changes, scroll the strip so
    // the active pill is at the left edge. CSS scrollIntoView({inline:
    // "start"}) handles both "scroll right to make it visible" and
    // "scroll left when going Back".
    const stripRef = React.useRef(null);
    const activePillRef = React.useRef(null);

    // v0.11.5: scroll-arrow state. Tracks whether each arrow should be
    // visible. Initialised to false so neither arrow appears until the
    // first measure runs. Updated by the scroll handler + the resize/
    // mutation watcher below.
    const [stripCanScrollLeft, setStripCanScrollLeft] = React.useState(false);
    const [stripCanScrollRight, setStripCanScrollRight] = React.useState(false);

    // Re-measure the strip's scrollability. Called on mount, on every
    // scroll event, on slide count change (resize), and on window
    // resize. The 1px epsilon avoids flicker at the exact extremes
    // due to sub-pixel rounding.
    React.useEffect(() => {
      const el = stripRef.current;
      if (!el) return undefined;

      function measure() {
        const max = el.scrollWidth - el.clientWidth;
        // v0.11.6: arrows are now layout columns (not absolute overlays),
        // so the strip no longer needs scroll-padding to clear them. That
        // means scrollLeft lands cleanly at 0 / max at the extremes; a
        // 2px epsilon is enough to absorb sub-pixel rounding.
        // v0.11.7: bumped left threshold to 10 (= strip's padding-left:
        // 8px + a 2px epsilon). Reason: with scroll-padding-left=0, when
        // scrollIntoView targets the FIRST pill (e.g. clicking Back to
        // slide 0), the browser scrolls to scrollLeft=8 to align the
        // pill flush with the scroll viewport. That non-zero scrollLeft
        // would otherwise trip a phantom "canScrollLeft = true" and
        // display the left arrow at the leftmost state. The 10px
        // threshold absorbs that 8px without losing detection of any
        // real rightward scroll (smallest legitimate rightward scroll
        // = pill width + gap, far above 10).
        setStripCanScrollLeft(el.scrollLeft > 11);
        setStripCanScrollRight(el.scrollLeft < max - 2);
      }

      measure();
      el.addEventListener("scroll", measure, { passive: true });
      window.addEventListener("resize", measure);
      // Watch for content changes (slides count + pill widths) so the
      // right-arrow appears/disappears when the strip outgrows its
      // viewport.
      const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
      if (ro) ro.observe(el);

      return () => {
        el.removeEventListener("scroll", measure);
        window.removeEventListener("resize", measure);
        if (ro) ro.disconnect();
      };
    }, [slides.length]);

    // Scroll the strip by ~2 pill widths. Uses smooth behaviour so the
    // movement feels intentional rather than snappy.
    function scrollStripBy(direction) {
      const el = stripRef.current;
      if (!el) return;
      // ~180px ≈ 1.5 average pills; doubles to ~360px for a 2-pill jump.
      // Bounded by clientWidth so the arrow never overshoots the whole
      // viewport on very narrow strips.
      const step = Math.min(Math.round(el.clientWidth * 0.6), 360);
      el.scrollBy({ left: direction * step, behavior: "smooth" });
    }
    React.useEffect(() => {
      const pill = activePillRef.current;
      if (!pill) return;
      pill.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "start",
      });
    }, [currentIdx]);

    // v0.11.4: When currentSubIdx changes, scroll the current slide
    // body so the current sub is visible at the top. Lets Next take
    // the user "to" the sub, not just mark it conceptually current.
    React.useEffect(() => {
      const slide = slides[currentIdx];
      if (!slide) return;
      const sub = slide.subs[currentSubIdx];
      if (!sub) return;
      // Skip for single-unnamed-sub slides \u2014 nothing to scroll to.
      if (slide.subs.length === 1 && !sub.name) return;
      scrollBodyToSub(slide, sub.name);
    }, [currentIdx, currentSubIdx, slides]);

    // Check-mark counts: how many staged tags live in each category. Used
    // by the top strip to highlight categories you've touched.
    const stagedPerCat = React.useMemo(() => {
      const counts = {};
      for (const tid of selectedSet) {
        const a = (assignments || {})[tid];
        const catName = a?.category;
        if (!catName) continue;
        counts[catName] = (counts[catName] || 0) + 1;
      }
      return counts;
    }, [selectedSet, assignments]);

    // Warnings detection.
    //
    // Per visible category:
    //   - overMax: this category has more staged tags than maxSelections allows.
    //     Lists the actual staged tag objects for the warning UI.
    //   - subOverMax: per-sub over-max issues (sub-level maxSelections; each
    //     entry is { subName, allowed, actual, tags }).
    //   - hiddenTagsStaged: tags in this category that are individually hidden
    //     in the ruleset but are nevertheless staged on the scene.
    //   - performerViolations (v0.11.0): list of violations from
    //     evaluatePerformerRules whose scope cat == this cat (sub-scoped
    //     rules slot into the same per-cat bucket so the in-slide banner
    //     surfaces them on the right slide).
    //
    // Cross-cutting (top-level banner, since no slide owns them):
    //   - fromHiddenCats: tags staged on the scene whose category is HIDDEN
    //     entirely in the active ruleset (no slide exists for them).
    //   - fromConfigurationCat: tags staged from the Configuration category
    //     OTHER than the currently-active config tag when autoStage is on.
    //     The active config tag is legitimate (user opted in via autoStage)
    //     and shouldn't be flagged. Anything else in Configuration is
    //     considered stale / left over from a previous tagging pass.

    // v0.11.0: performerCounts is a prop, computed in PowerTaggerBody
    // (which owns the `scene` state). Defensive default so the rest of
    // this component can rely on the {male, female, other} shape.
    const safePerformerCounts = React.useMemo(
      () => performerCounts || { male: 0, female: 0, other: 0 },
      [performerCounts]
    );

    // v0.11.0: evaluate performer-rule violations across the active
    // config. Pure function — depends only on staged set + assignments +
    // performer counts + the rules themselves. Result is keyed by scope
    // so both the in-slide banner and the (later) top banner / save gate
    // can look up violations cheaply.
    const performerRuleViolations = React.useMemo(() => {
      const rules =
        ((rulesets || {})[String(configTagId)] || {}).performerRules || [];
      const byId = {};
      for (const t of allTags) byId[String(t.id)] = t;
      return evaluatePerformerRules(
        rules,
        safePerformerCounts,
        selectedSet,
        assignments,
        byId
      );
    }, [rulesets, configTagId, safePerformerCounts, selectedSet, assignments, allTags]);

    const warnings = React.useMemo(() => {
      const perCat = {};                  // catName -> { overMax, subOverMax, hiddenTagsStaged }
      const fromHiddenCats = [];          // [{ tag, catName }]
      const fromConfigurationCat = [];    // [{ tag, catName }]
      const allTagsById = {};
      for (const t of allTags) allTagsById[String(t.id)] = t;

      // Index visible (non-hidden, non-Configuration) cats by name.
      const visibleByName = {};
      for (const c of orderedCats) visibleByName[c.name] = c;

      // Is the active config opting into auto-stage? If so, the matching
      // config tag is legitimately present and not a warning.
      const activeRs = (rulesets || {})[String(configTagId)] || {};
      const autoStageActive = !!activeRs.autoStage;

      // Bucket staged tags by category, then evaluate.
      const stagedByCat = {};  // catName -> [tag]
      for (const tid of selectedSet) {
        const a = (assignments || {})[tid];
        if (!a || !a.category) continue;
        const tag = allTagsById[String(tid)];
        if (!tag) continue;
        if (!stagedByCat[a.category]) stagedByCat[a.category] = [];
        stagedByCat[a.category].push(tag);
      }

      // Per-cat warnings.
      for (const catName of Object.keys(stagedByCat)) {
        const stagedHere = stagedByCat[catName];

        // Special case: Configuration cat — collect under cross-cutting,
        // BUT exclude the currently-active config tag if autoStage is on.
        if (catName === "Configuration") {
          for (const tag of stagedHere) {
            const isActiveConfig =
              autoStageActive &&
              String(tag.id) === String(configTagId);
            if (isActiveConfig) continue;
            fromConfigurationCat.push({ tag, catName });
          }
          continue;
        }

        // If category is hidden in the active ruleset OR globally in
        // the taxonomy → collect those stagings as cross-cutting warnings.
        const isVisible = !!visibleByName[catName];
        if (!isVisible) {
          for (const tag of stagedHere) {
            fromHiddenCats.push({ tag, catName });
          }
          continue;
        }

        // Visible category — evaluate per-cat warnings.
        const rule = resolveRule(rulesets, configTagId, catName);
        const w = {
          overMax: null,
          subOverMax: [],
          hiddenTagsStaged: [],
          // v0.11.2: blocked-by-conditional — separate from hiddenTagsStaged.
          // Shape: [ { conditional, tag } ... ]. Grouped per-conditional in
          // the renderer so we can produce one banner per offending rule.
          conditionalBlocked: [],
        };

        // Over-max at the category level?
        if (rule.maxSelections > 0 && stagedHere.length > rule.maxSelections) {
          w.overMax = {
            allowed: rule.maxSelections,
            actual: stagedHere.length,
            tags: stagedHere,
          };
        }

        // Over-max at the sub level — bucket by sub then compare.
        const subBuckets = {};  // subName -> [tag]
        for (const tag of stagedHere) {
          const a = assignments[String(tag.id)] || {};
          const sub = a.subcategory || "";
          if (!subBuckets[sub]) subBuckets[sub] = [];
          subBuckets[sub].push(tag);
        }
        for (const subName of Object.keys(subBuckets)) {
          const subTags = subBuckets[subName];
          const subCap = toInt((rule.subMaxSelections || {})[subName], 0);
          if (subCap > 0 && subTags.length > subCap) {
            w.subOverMax.push({
              subName,
              allowed: subCap,
              actual: subTags.length,
              tags: subTags,
            });
          }
        }

        // Per-tag effective hidden? A tag is "hidden but staged" if
        // visibility.tagVisible returns false for it. This includes:
        //   - tag is in hiddenTags (base) AND not conditionally revealed
        //     (cat reveal, sub reveal, or tag reveal would override this)
        //   - tag is in a hide-conditional that's currently active
        //
        // v0.11.2: split this between two warning types:
        //   - If a reveal-conditional targets this tag (directly, via its
        //     sub, or via its cat) but isn't currently firing → hard
        //     warning, named by the blocking conditional(s) via
        //     describeConditional. Per-conditional grouping in the
        //     renderer.
        //   - Otherwise (purely base-hidden, no conditional involvement)
        //     → soft "Hidden tags staged" warning, current behaviour.
        //
        // A single tag with multiple applicable conditionals fires N hard
        // warnings (one per conditional). It does NOT also fire the soft
        // warning — the hard warning supersedes (more specific).
        for (const tag of stagedHere) {
          if (!visibility.tagVisible(catName, tag.id)) {
            const blockers = visibility.findBlockingConditionals(catName, tag.id);
            if (blockers.length > 0) {
              for (const c of blockers) {
                w.conditionalBlocked.push({ conditional: c, tag });
              }
            } else {
              w.hiddenTagsStaged.push(tag);
            }
          }
        }

        if (
          w.overMax ||
          w.subOverMax.length > 0 ||
          w.hiddenTagsStaged.length > 0 ||
          w.conditionalBlocked.length > 0
        ) {
          perCat[catName] = w;
        }
      }

      return {
        perCat,
        fromHiddenCats,
        fromConfigurationCat,
        // Convenience: total count, used to gate the top-level banner.
        crossCuttingCount: fromHiddenCats.length + fromConfigurationCat.length,
        // v0.11.0: surface the hard performer-rule violations alongside.
        // perCat[catName].performerViolations is also populated below.
        performerAll: performerRuleViolations.all,
      };
    }, [
      selectedSet,
      assignments,
      allTags,
      orderedCats,
      rulesets,
      configTagId,
      visibility,
      performerRuleViolations,
    ]);

    // Fold performer-rule violations into perCat. We mutate the result
    // outside of the useMemo body is impossible (it'd skip on hits) — so
    // do this as a second useMemo derived from `warnings` + violations.
    // The result is a *combined* perCat structure used everywhere
    // renderSlideWarnings reads from. We keep `warnings` as the source
    // for cross-cutting fields, but reach for combinedPerCat for in-slide.
    const combinedPerCat = React.useMemo(() => {
      const out = {};
      // Seed with existing soft per-cat entries.
      for (const k of Object.keys(warnings.perCat || {})) {
        out[k] = { ...warnings.perCat[k], performerViolations: [] };
      }
      // Distribute performer-rule violations into the cat they target.
      // The evaluator picks `primaryCat` as the dominant category among
      // the staged tags of a group, so the warning surfaces on the most
      // relevant slide.
      for (const v of performerRuleViolations.all) {
        const cat = v.primaryCat || "";
        if (!cat) continue;
        if (!out[cat]) {
          out[cat] = {
            overMax: null,
            subOverMax: [],
            hiddenTagsStaged: [],
            conditionalBlocked: [],
            performerViolations: [],
          };
        }
        out[cat].performerViolations.push(v);
      }
      return out;
    }, [warnings, performerRuleViolations]);

    // v0.11.2: Flat warnings list for the save-confirm modal. One entry
    // per warning. Each entry is:
    //   { kind, cat, head, bodyPrefix, bodyChipTags, bodySuffix,
    //     offendingTags }
    // where:
    //   - `head` is the bolded leading phrase (what's wrong)
    //   - `bodyPrefix` is text before any chips (e.g. "Staged 3: ")
    //   - `bodyChipTags` is the list of tag objects to render as chips
    //     in the body. Each chip is click-to-unstage.
    //   - `bodySuffix` is text after the chips (e.g. " (over by 1)")
    //   - `offendingTags` is the list of staged tag objects whose removal
    //     would resolve this warning. Empty for at-least violations.
    //     Drives the modal's per-warning Resolve button.
    //
    // Splitting head/body lets the modal bold just the headline and run
    // the body in normal weight — mirrors the inline banner style and
    // makes the list scannable at a glance. Chips in the body provide
    // visual identification (tag colours) AND per-tag removal.
    //
    // Built outside renderSlideWarnings so the modal can render even
    // when the user hasn't navigated to the offending slide.
    const flatWarnings = React.useMemo(() => {
      const out = [];
      const tagByIdLocal = {};
      for (const t of allTags) tagByIdLocal[String(t.id)] = t;

      // Cross-cutting (top banner): tags staged from hidden cats,
      // tags staged from Configuration cat.
      const hiddenCats = warnings.fromHiddenCats || [];
      if (hiddenCats.length) {
        const byCat = {};
        for (const e of hiddenCats) {
          if (!byCat[e.catName]) byCat[e.catName] = [];
          byCat[e.catName].push(e.tag);
        }
        for (const cat of Object.keys(byCat)) {
          const tags = byCat[cat];
          out.push({
            kind: "soft",
            cat,
            head: `${cat} (not used in this config):`,
            bodyPrefix: "",
            bodyChipTags: tags,
            bodySuffix: "",
            offendingTags: tags,
            // Resolved when every offender is unstaged. Same definition
            // for all "remove-these-tags" warnings; over-max + constraint
            // warnings use cap-based checks instead (see below).
            isResolved: (sel) => tags.every((t) => !sel.has(String(t.id))),
          });
        }
      }
      const fromConfig = warnings.fromConfigurationCat || [];
      if (fromConfig.length) {
        out.push({
          kind: "soft",
          cat: "Configuration",
          head: "Configuration tags staged (not shown in walkthrough):",
          bodyPrefix: "",
          bodyChipTags: fromConfig,
          bodySuffix: "",
          offendingTags: fromConfig,
          isResolved: (sel) => fromConfig.every((t) => !sel.has(String(t.id))),
        });
      }

      // v0.11.4: Auto-select rule mismatch (config drift). Surfaces
      // when the active config has an auto-select rule defined AND
      // the current scene state doesn't satisfy it. Triggered both
      // initially (if user picked a non-matching config) and on
      // drift (e.g. user added a performer that broke the rule).
      //
      // Soft warning: user can proceed if intentional. We compute the
      // "closest-miss" rule and surface its tag-fixable missing tags
      // as an `addTags` payload so the save-confirm modal can offer
      // a green Add-tag button (parallel to the regular Resolve button
      // for tag-removal warnings).
      if (liveScene && configTagId) {
        const activeRuleset = (rulesets || {})[String(configTagId)] || {};
        const ruleEval = evaluateAutoSelectRule(
          activeRuleset.autoSelectRule,
          liveScene,
          tagByIdLocal,
          assignments || {}
        );
        if (ruleEval.evaluated && !ruleEval.matches) {
          const best = closestMissRule(ruleEval);
          const failingResults = (best && best.conditionResults || []).filter((r) => !r.pass);
          // Aggregate fixable tag IDs from the closest-miss rule.
          const addTagIds = new Set();
          for (const r of failingResults) {
            const d = describeFailingCondition(r.cond, liveScene, tagByIdLocal);
            for (const id of d.missingTagIds) addTagIds.add(String(id));
          }
          const addTags = Array.from(addTagIds)
            .map((id) => tagByIdLocal[String(id)])
            .filter(Boolean);
          const configName = (() => {
            for (const t of allTags) {
              if (String(t.id) === String(configTagId)) return t.name;
            }
            return "the active config";
          })();
          // Per-condition prose lines for the modal body. We render
          // these as text (no inline pills in the modal \u2014 the
          // modal layout is tighter and the pills would crowd it).
          const lineStrings = failingResults.map((r) => {
            const d = describeFailingCondition(r.cond, liveScene, tagByIdLocal);
            return d.headline + (d.actual ? " " + d.actual : "");
          });
          out.push({
            kind: "soft",
            variant: "config",       // modal uses this to swap icon + accent
            cat: "Configuration",
            head: `Config mismatch: scene doesn\u2019t fit ${configName}.`,
            bodyPrefix: lineStrings.join(" "),
            bodyChipTags: [],
            bodySuffix: "",
            offendingTags: [],
            addTags,                 // signals: modal renders Add-tag button
            // Resolution check re-evaluates the rule against the
            // selected set. We don't have liveScene's tags here so
            // build a quick synthetic from sel (the warning resolver
            // only ever gets the staged set). Performers stay from
            // liveScene since they don't change inside this closure.
            isResolved: (sel) => {
              if (!liveScene) return false;
              const synthScene = {
                ...liveScene,
                tags: Array.from(sel).map((id) => ({ id })),
              };
              const r2 = evaluateAutoSelectRule(
                activeRuleset.autoSelectRule,
                synthScene,
                tagByIdLocal,
                assignments || {}
              );
              return r2.matches;
            },
          });
        }
      }

      // Per-cat warnings — over-max, sub over-max, hidden-tags-staged
      // (soft), conditional-blocked (hard), constraint-rule violations
      // (hard).
      const cats = Object.keys(combinedPerCat || {});
      for (const cat of cats) {
        const w = combinedPerCat[cat];
        if (!w) continue;
        if (w.overMax) {
          const overMaxTags = w.overMax.tags;
          const overMaxAllowed = w.overMax.allowed;
          out.push({
            kind: "soft",
            cat,
            head: `Too many for ${cat} \u2014 ${w.overMax.actual} staged, max ${w.overMax.allowed}.`,
            bodyPrefix: "Staged: ",
            bodyChipTags: overMaxTags,
            bodySuffix: "",
            offendingTags: overMaxTags,
            // Over-max is resolved when the count of still-staged
            // offenders drops to <= allowed. The user doesn't need to
            // remove ALL offenders — just enough to get back under the
            // cap.
            isResolved: (sel) =>
              overMaxTags.filter((t) => sel.has(String(t.id))).length <= overMaxAllowed,
          });
        }
        for (const e of (w.subOverMax || [])) {
          const label = e.subName || "(no subcategory)";
          const subTags = e.tags;
          const subAllowed = e.allowed;
          out.push({
            kind: "soft",
            cat,
            head: `Too many in ${label} \u2014 ${e.actual} staged, max ${e.allowed}.`,
            bodyPrefix: "Staged: ",
            bodyChipTags: subTags,
            bodySuffix: "",
            offendingTags: subTags,
            isResolved: (sel) =>
              subTags.filter((t) => sel.has(String(t.id))).length <= subAllowed,
          });
        }
        for (const tag of (w.hiddenTagsStaged || [])) {
          out.push({
            kind: "soft",
            cat,
            head: `Hidden tag staged in ${cat}:`,
            bodyPrefix: "",
            bodyChipTags: [tag],
            bodySuffix: "",
            offendingTags: [tag],
            isResolved: (sel) => !sel.has(String(tag.id)),
          });
        }
        // Conditional-blocked — group by conditional identity, same
        // shape as renderSlideWarnings.
        const blocked = w.conditionalBlocked || [];
        if (blocked.length) {
          const byCond = new Map();
          for (const e of blocked) {
            const arr = byCond.get(e.conditional) || [];
            arr.push(e.tag);
            byCond.set(e.conditional, arr);
          }
          for (const [cond, tags] of byCond.entries()) {
            const label = describeConditional(cond, tagByIdLocal);
            out.push({
              kind: "hard",
              cat,
              head: `${label}.`,
              bodyPrefix: `Blocked in ${cat}: `,
              bodyChipTags: tags,
              bodySuffix: "",
              offendingTags: tags,
              // Smart resolver: the warning is resolved when this
              // specific conditional is no longer blocking these tags.
              // That happens when EITHER:
              //   (a) every offending tag is unstaged \u2014 nothing
              //       left to block; OR
              //   (b) the conditional's trigger(s) are no longer
              //       satisfied in the live sel \u2014 conditional
              //       doesn't fire so it doesn't block.
              //
              // The dumb resolver (`every tag unstaged`) was the original
              // implementation; it didn't fire when the user removed the
              // OTHER side of a paired rule (e.g. "Vaginal hides Anal"
              // + "Anal hides Vaginal" \u2014 removing Anal should clear
              // BOTH warnings, but the dumb resolver only cleared the
              // one whose offending tag was the removed one).
              //
              // We re-evaluate live by calling resolveActiveConditionals
              // against the live sel + performerCounts. If `cond` isn't
              // in the active list, it doesn't fire \u2014 warning
              // resolved regardless of whether its tags are still staged.
              isResolved: (sel) => {
                if (tags.every((t) => !sel.has(String(t.id)))) return true;
                const liveActive = resolveActiveConditionals(
                  rulesets,
                  configTagId,
                  sel,
                  safePerformerCounts
                );
                return !liveActive.includes(cond);
              },
            });
          }
        }
        // Constraint-rule violations — staged tags as chips. The
        // `[rule: ...]` attribution is dropped from the modal body
        // (it was redundant clutter — rule names matter in the editor,
        // not when reviewing what to remove).
        for (const v of (w.performerViolations || [])) {
          const isAtLeast = v.direction === "at-least";
          const groupTagNames = (v.group.tags || [])
            .map((id) => (tagByIdLocal[String(id)] && tagByIdLocal[String(id)].name) || id)
            .join(", ");
          let head, bodyPrefix, bodyChipTags, bodySuffix, bodySuffixBold = false;
          if (isAtLeast) {
            head = `Need at least ${v.cap} of: ${groupTagNames}.`;
            if (v.stagedInGroup.length > 0) {
              bodyPrefix = `Staged ${v.stagedInGroup.length}: `;
              bodyChipTags = v.stagedInGroup;
              bodySuffix = "";
            } else {
              bodyPrefix = "None staged.";
              bodyChipTags = [];
              bodySuffix = "";
            }
          } else {
            const over = v.stagedInGroup.length - v.cap;
            head = `At most ${v.cap} of: ${groupTagNames}.`;
            bodyPrefix = `Staged ${v.stagedInGroup.length}: `;
            bodyChipTags = v.stagedInGroup;
            bodySuffix = over > 0 ? ` (over by ${over})` : "";
            // The (over by N) text is the actionable count — bold it so
            // it stands out from the surrounding body. Other body text
            // stays normal weight; only this suffix gets emphasis.
            bodySuffixBold = over > 0;
          }
          // At-least violations can't be resolved by removing tags
          // (removing would make it worse). Only at-most direction
          // has offending tags that can be unstaged.
          const offendingTags = isAtLeast ? [] : v.stagedInGroup;
          // Resolution checks — at-most is resolved when staged count
          // from the group drops to <= cap; at-least is resolved when
          // staged count from the group reaches >= cap. For at-least
          // we check against ALL group tags (not just stagedInGroup),
          // since the user might re-stage tags from the group that
          // weren't initially staged.
          const cap = v.cap;
          const groupTagIds = (v.group.tags || []).map(String);
          const resolverFn = isAtLeast
            ? (sel) => groupTagIds.filter((id) => sel.has(id)).length >= cap
            : (sel) => offendingTags.filter((t) => sel.has(String(t.id))).length <= cap;
          out.push({
            kind: "hard",
            cat,
            head,
            bodyPrefix,
            bodyChipTags,
            bodySuffix,
            bodySuffixBold,
            offendingTags,
            isResolved: resolverFn,
          });
        }
      }
      return out;
    }, [warnings, combinedPerCat, allTags, liveScene, configTagId, rulesets, assignments, safePerformerCounts]);

    const hasAnyWarnings = flatWarnings.length > 0;

    // v0.11.2: Sorted view for the modal — hard warnings first, then
    // soft. Array.prototype.sort is stable in ES2019+, so original
    // insertion order is preserved within each kind. Insertion order
    // groups by category, so the final list reads: hard-by-cat, then
    // soft-by-cat.
    const sortedFlatWarnings = React.useMemo(() => {
      const score = (w) => (w.kind === "hard" ? 0 : 1);
      return flatWarnings.slice().sort((a, b) => score(a) - score(b));
    }, [flatWarnings]);

    // v0.11.2: Save-confirm modal state. Owned here because the warnings
    // derivation lives here — moving the modal up would require lifting
    // a huge prop tree. The parent's Save button calls
    // saveHandlerRef.current(), which we register below.
    const [saveConfirmOpen, setSaveConfirmOpen] = React.useState(false);

    // Snapshot of sortedFlatWarnings captured at modal-open time. The
    // modal renders this snapshot, NOT the live sortedFlatWarnings,
    // so that resolving a warning (which removes tags and would
    // re-derive flatWarnings to drop that entry) doesn't cause the
    // list to re-flow. Resolution status is computed live from
    // selectedSet — see modal render below.
    const [warningsSnapshot, setWarningsSnapshot] = React.useState([]);

    // Register a save handler with the parent. When the parent's Save
    // button is clicked, it calls this function — which either opens
    // the confirm modal (if warnings exist) or calls onConfirmedSave
    // directly. The ref pattern avoids prop-drilling a stale-closure
    // version of the function.
    //
    // When opening, snapshot the current sortedFlatWarnings so the
    // modal's row list is stable for the duration of the modal session.
    React.useEffect(() => {
      if (saveHandlerRef) {
        saveHandlerRef.current = () => {
          if (hasAnyWarnings) {
            setWarningsSnapshot(sortedFlatWarnings);
            setSaveConfirmOpen(true);
          } else if (typeof onConfirmedSave === "function") {
            onConfirmedSave();
          }
        };
      }
    }, [saveHandlerRef, hasAnyWarnings, onConfirmedSave, sortedFlatWarnings]);


    // Remove the given list of staged tags. Used by the "Fix" buttons on
    // each warning. Bulk-removes via the parent's onRemoveTags handler so
    // all removals land in a single setSelectedTags call (avoids stale-
    // state issues from looping toggleTag).
    function removeStagedTags(tags) {
      onRemoveTags(tags.map((t) => t.id));
    }

    // v0.11.2: Render an offending tag as a clickable chip. The chip
    // uses the tag's category colour (via tagColourById) for the
    // background and pickTextColour for contrast.
    //
    // Two interaction modes:
    //   - **Inline (default)**: clicking removes the tag from the
    //     staged set. The chip vanishes on next render because the
    //     parent warning re-derives and no longer includes it.
    //   - **In modal (inModal=true)**: clicking toggles staged state.
    //     The chip stays visible regardless — when its tag is staged,
    //     it renders normal; when unstaged, it renders strikethrough +
    //     dimmed. Re-clicking re-stages. This matches the modal's
    //     "snapshot list, don't re-flow" pattern.
    //
    // Used in both the inline slide warning banners AND the save-
    // confirm modal, so chips look + behave the same in both places.
    // The `keyPrefix` argument disambiguates React keys when the same
    // tag appears in multiple warning lines.
    function renderTagChip(tag, keyPrefix, inModal) {
      const colour = tagColourById[String(tag.id)] || "#5a6e85";
      const textColour = pickTextColour(colour);
      const isStaged = selectedSet.has(String(tag.id));
      // In modal: chip visually flips between staged (normal) and
      // unstaged (strikethrough). Outside modal: chip is always staged
      // (it only renders if the tag IS staged — gone if unstaged).
      const showStruck = inModal && !isStaged;
      const onClick = () => {
        if (inModal && !isStaged) {
          // Re-stage this tag.
          if (typeof onAddTags === "function") onAddTags([tag]);
        } else {
          // Unstage.
          onRemoveTags([tag.id]);
        }
      };
      return React.createElement(
        "button",
        {
          key: keyPrefix + "-" + tag.id,
          type: "button",
          className: "power-tagger-tag-chip" + (showStruck ? " power-tagger-tag-chip-struck" : ""),
          style: { backgroundColor: colour, color: textColour },
          onClick,
          title: showStruck
            ? `Click to re-stage: ${tag.name}`
            : `Click to unstage: ${tag.name}`,
        },
        tag.name,
        React.createElement(
          "span",
          { className: "power-tagger-tag-chip-x", "aria-hidden": "true" },
          showStruck ? "\u21BA" : "\u00D7"
        )
      );
    }

    // v0.11.4: Non-interactive variant. Same coloured-pill shape as
    // renderTagChip but no click handler, no \u00D7, no title hint.
    // Used in the config-drift banner where the chips are reference-
    // tags (what the rule expects), not staged tags the user can
    // remove. A clickable chip in that context is misleading \u2014
    // clicking does nothing useful and the \u00D7 implies "remove me".
    function renderStaticTagChip(tag, keyPrefix) {
      const colour = tagColourById[String(tag.id)] || "#5a6e85";
      const textColour = pickTextColour(colour);
      return React.createElement(
        "span",
        {
          key: keyPrefix + "-" + tag.id,
          className: "power-tagger-tag-chip power-tagger-tag-chip-static",
          style: { backgroundColor: colour, color: textColour },
        },
        tag.name
      );
    }
    function renderStaticTagChips(tags, keyPrefix) {
      if (!tags || tags.length === 0) return null;
      const out = [];
      tags.forEach((t, i) => {
        if (i > 0) out.push(React.createElement("span", { key: keyPrefix + "-sep-" + i, className: "power-tagger-tag-chip-sep" }, " "));
        out.push(renderStaticTagChip(t, keyPrefix));
      });
      return out;
    }

    // Render a comma-spaced list of offending tag chips. Returns an
    // array of React nodes (chips separated by " " strings so they
    // wrap naturally). Empty if no offenders.
    function renderTagChips(tags, keyPrefix, inModal) {
      if (!tags || tags.length === 0) return null;
      const out = [];
      tags.forEach((t, i) => {
        if (i > 0) out.push(React.createElement("span", { key: keyPrefix + "-sep-" + i, className: "power-tagger-tag-chip-sep" }, " "));
        out.push(renderTagChip(t, keyPrefix, inModal));
      });
      return out;
    }

    // In-slide warning banner. Returns null if this slide's cat has no
    // warnings. Otherwise: one or two banners — a hard variant (red) for
    // performer-rule violations, and the soft variant for other issues.
    function renderSlideWarnings(slide) {
      const w = combinedPerCat[slide.name];
      if (!w) return null;

      // -------- Soft warnings (existing behaviour) ----------------------
      const softItems = [];
      const softOffending = [];
      if (w.overMax) {
        const chips = renderTagChips(w.overMax.tags, "ovr-" + slide.name);
        softItems.push(
          React.createElement(
            "div",
            { className: "power-tagger-warn-line", key: "overmax" },
            React.createElement(
              "strong",
              null,
              `Too many selections (${w.overMax.actual}/${w.overMax.allowed}). `
            ),
            "Staged: ",
            chips
          )
        );
        for (const t of w.overMax.tags) softOffending.push(t);
      }
      // Sub-level over-max — one line per offending sub.
      for (const entry of (w.subOverMax || [])) {
        const label = entry.subName || "(no subcategory)";
        const chips = renderTagChips(entry.tags, "sub-" + slide.name + "-" + entry.subName);
        softItems.push(
          React.createElement(
            "div",
            { className: "power-tagger-warn-line", key: "sub-" + entry.subName },
            React.createElement(
              "strong",
              null,
              `${label}: too many (${entry.actual}/${entry.allowed}). `
            ),
            "Staged: ",
            chips
          )
        );
        for (const t of entry.tags) {
          if (!softOffending.some((x) => String(x.id) === String(t.id))) {
            softOffending.push(t);
          }
        }
      }
      if ((w.hiddenTagsStaged || []).length) {
        const chips = renderTagChips(w.hiddenTagsStaged, "hid-" + slide.name);
        softItems.push(
          React.createElement(
            "div",
            { className: "power-tagger-warn-line", key: "hidden" },
            React.createElement(
              "strong",
              null,
              "Hidden tags staged. "
            ),
            "These tags are hidden by the current ruleset but appear on the scene: ",
            chips
          )
        );
        for (const t of w.hiddenTagsStaged) {
          if (!softOffending.some((x) => String(x.id) === String(t.id))) {
            softOffending.push(t);
          }
        }
      }

      const softBanner = softItems.length
        ? React.createElement(
            "div",
            { className: "power-tagger-warn-banner", key: "soft" },
            React.createElement(
              "div",
              { className: "power-tagger-warn-icon" },
              "\u26A0\uFE0E"
            ),
            React.createElement(
              "div",
              { className: "power-tagger-warn-body" },
              softItems
            ),
            softOffending.length > 0
              ? React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-sm btn-danger power-tagger-warn-fix",
                    onClick: () => removeStagedTags(softOffending),
                    title: "Unstage these tags",
                  },
                  softOffending.length > 1
                    ? `Remove ${softOffending.length} offending tags`
                    : "Remove offending tag"
                )
              : null
          )
        : null;

      // -------- Hard constraint-rule warnings (v0.11.0) ------------------
      const violations = w.performerViolations || [];
      const hardItems = [];
      const hardOffending = [];
      // Local tag lookup for at-least warnings (which list the group's
      // required tags by name when none is staged) and for the
      // conditional-blocked render (which uses describeConditional, which
      // resolves trigger tag ids back to names).
      const tagByIdLocal = {};
      for (const t of allTags) tagByIdLocal[String(t.id)] = t;

      // v0.11.2: Conditional-blocked warnings (one per applicable
      // unsatisfied reveal-conditional). Group offending tags by the
      // blocking conditional, so a conditional that's blocking N tags
      // gets one warning line listing all N tags.
      const blocked = w.conditionalBlocked || [];
      if (blocked.length > 0) {
        // Group by conditional identity. We use the conditional object
        // itself as the key — references are stable across resolve calls
        // because findBlockingConditionals returns objects from
        // rs.conditionals directly.
        const byCond = new Map();
        for (const entry of blocked) {
          const arr = byCond.get(entry.conditional) || [];
          arr.push(entry.tag);
          byCond.set(entry.conditional, arr);
        }
        let condIdx = 0;
        for (const [cond, tags] of byCond.entries()) {
          const label = describeConditional(cond, tagByIdLocal);
          const chips = renderTagChips(tags, "cond-" + slide.name + "-" + condIdx);
          hardItems.push(
            React.createElement(
              "div",
              {
                className: "power-tagger-warn-line",
                key: "cond-" + (condIdx++),
              },
              React.createElement("strong", null, `${label}. `),
              "Blocked: ",
              chips
            )
          );
          for (const t of tags) {
            if (!hardOffending.some((x) => String(x.id) === String(t.id))) {
              hardOffending.push(t);
            }
          }
        }
      }

      let anyAtLeast = false;
      for (const v of violations) {
        const isAtLeast = v.direction === "at-least";
        if (isAtLeast) anyAtLeast = true;
        const ruleName = (v.rule && v.rule.name) || "Constraint rule";
        const groupLabel = (v.group && v.group.label) ? v.group.label : "";
        // v0.11.2: lead the message with the CONSTRAINT (what's wrong),
        // not the rule identity. Rule name + group label go in a hover
        // tooltip so they're still discoverable but don't dominate the
        // line. The list of tags in the group (for at-least) gives full
        // context even when nothing is staged.
        //
        // Staged tags are rendered as chips (click to unstage); the
        // group-tag list (rule definition) stays as plain text since
        // those tags aren't necessarily staged and aren't actionable.
        const groupTagNames = (v.group.tags || [])
          .map((id) => (tagByIdLocal[String(id)] && tagByIdLocal[String(id)].name) || id);
        const groupTagList = groupTagNames.join(", ");
        const stagedChips = renderTagChips(
          v.stagedInGroup,
          "pr-" + v.rule.id + "-" + (v.group && v.group.id ? v.group.id : "")
        );
        let headLine;
        let bodyChildren;
        if (isAtLeast) {
          headLine = `Need at least ${v.cap} of: ${groupTagList}.`;
          bodyChildren = v.stagedInGroup.length > 0
            ? [`Staged ${v.stagedInGroup.length}: `, stagedChips]
            : ["None staged."];
        } else {
          headLine = `At most ${v.cap} of: ${groupTagList}.`;
          const over = v.stagedInGroup.length - v.cap;
          bodyChildren = [
            `Staged ${v.stagedInGroup.length}: `,
            stagedChips,
            over > 0
              ? React.createElement(
                  "strong",
                  { key: "ovr", className: "power-tagger-warn-overby" },
                  ` (over by ${over})`
                )
              : "",
          ];
        }
        const tooltip = groupLabel
          ? `Rule: "${ruleName}" \u2014 group "${groupLabel}"`
          : `Rule: "${ruleName}"`;
        hardItems.push(
          React.createElement(
            "div",
            {
              className: "power-tagger-warn-line",
              key: "pr-" + v.rule.id + "-" + (v.group && v.group.id ? v.group.id : ""),
              title: tooltip,
            },
            React.createElement("strong", null, `${headLine} `),
            ...bodyChildren
          )
        );
        if (!isAtLeast) {
          for (const t of v.stagedInGroup) {
            if (!hardOffending.some((x) => String(x.id) === String(t.id))) {
              hardOffending.push(t);
            }
          }
        }
      }

      const hardBanner = hardItems.length
        ? React.createElement(
            "div",
            {
              className:
                "power-tagger-warn-banner power-tagger-warn-banner-hard",
              key: "hard",
            },
            React.createElement(
              "div",
              {
                className:
                  "power-tagger-warn-icon power-tagger-warn-icon-hard",
              },
              "\u26A0\uFE0E"
            ),
            React.createElement(
              "div",
              { className: "power-tagger-warn-body" },
              hardItems
            ),
            hardOffending.length > 0
              ? React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-sm btn-danger power-tagger-warn-fix",
                    onClick: () => removeStagedTags(hardOffending),
                    title: "Unstage these tags",
                  },
                  hardOffending.length > 1
                    ? `Remove ${hardOffending.length} offending tags`
                    : "Remove offending tag"
                )
              : null
          )
        : null;

      if (!softBanner && !hardBanner) return null;
      // Render the hard banner FIRST (higher visual priority). React
      // requires keyed children when an array is returned, but since we
      // wrap in a Fragment with explicit keys above, the children of
      // this Fragment are well-formed.
      return React.createElement(
        React.Fragment,
        null,
        hardBanner,
        softBanner
      );
    }

    // Cross-cutting warnings banner — top of the right pane, above the
    // strip. Renders if any tags are staged from hidden categories or
    // from the Configuration category (which the walkthrough doesn't
    // show as a slide).
    function renderCrossCuttingWarnings() {
      const { fromHiddenCats, fromConfigurationCat } = warnings;
      if (!fromHiddenCats.length && !fromConfigurationCat.length) return null;

      const lines = [];
      const allOffending = [];
      if (fromHiddenCats.length) {
        // Group by category name for readability.
        const byCat = {};
        for (const entry of fromHiddenCats) {
          if (!byCat[entry.catName]) byCat[entry.catName] = [];
          byCat[entry.catName].push(entry.tag);
          allOffending.push(entry.tag);
        }
        for (const catName of Object.keys(byCat)) {
          const chips = renderTagChips(byCat[catName], "xc-" + catName);
          lines.push(
            React.createElement(
              "div",
              { className: "power-tagger-warn-line", key: "hc-" + catName },
              React.createElement(
                "strong",
                null,
                `${catName}: `
              ),
              chips,
              " (category hidden in this ruleset)"
            )
          );
        }
      }
      if (fromConfigurationCat.length) {
        const configTags = fromConfigurationCat.map((x) => x.tag);
        const chips = renderTagChips(configTags, "xc-config");
        lines.push(
          React.createElement(
            "div",
            { className: "power-tagger-warn-line", key: "cfg" },
            React.createElement(
              "strong",
              null,
              "Configuration tags staged: "
            ),
            chips,
            " (these aren't shown in the walkthrough; remove if outdated)"
          )
        );
        for (const x of fromConfigurationCat) allOffending.push(x.tag);
      }
      return React.createElement(
        "div",
        { className: "power-tagger-warn-banner power-tagger-warn-banner-top" },
        React.createElement(
          "div",
          { className: "power-tagger-warn-icon" },
          "\u26A0\uFE0E"
        ),
        React.createElement(
          "div",
          { className: "power-tagger-warn-body" },
          lines
        ),
        React.createElement(
          "button",
          {
            type: "button",
            className: "btn btn-sm btn-danger power-tagger-warn-fix",
            onClick: () => removeStagedTags(allOffending),
            title: "Unstage these tags",
          },
          allOffending.length > 1
            ? `Remove all ${allOffending.length}`
            : "Remove"
        )
      );
    }

    if (slides.length === 0) {
      return React.createElement(
        "div",
        { style: { color: "#888", padding: 20 } },
        "(No tags to show \u2014 install/configure the Tag Categories plugin.)"
      );
    }

    // v0.11.4: Top banner that surfaces when the active config's
    // auto-select rule no longer matches the LIVE scene (performers
    // added/removed mid-walkthrough, tags staged that break the rule,
    // etc). Same styling family as renderCrossCuttingWarnings \u2014
    // amber banner across the top of the walkthrough.
    //
    // Renders null when:
    //   - no auto-select rule defined for this config
    //   - rule matches (the absence of this banner is the affirmation)
    //   - no liveScene yet (still loading)
    //
    // The same warning is ALSO inserted into flatWarnings so it
    // appears in the save-confirm modal alongside other issues. The
    // top banner here gives it visibility during tagging.
    function renderConfigDriftWarning() {
      if (!liveScene || !configTagId) return null;
      const activeRuleset = (rulesets || {})[String(configTagId)] || {};
      if (!activeRuleset.autoSelectRule) return null;
      const tagByIdLocal = {};
      for (const t of allTags) tagByIdLocal[String(t.id)] = t;
      const ruleEval = evaluateAutoSelectRule(
        activeRuleset.autoSelectRule,
        liveScene,
        tagByIdLocal,
        assignments || {}
      );
      if (!ruleEval.evaluated || ruleEval.matches) return null;

      const best = closestMissRule(ruleEval);
      if (!best) return null;
      const failingResults = best.conditionResults.filter((r) => !r.pass);

      // Build per-condition rows + aggregate fixable tag list.
      // Each row renders either as plain prose (headline + actual)
      // or with an inline pill (lead + [pills] + trail) when the
      // describe-helper signalled that placement matters.
      const lines = [];
      const fixableTagIds = new Set();
      failingResults.forEach((res, i) => {
        const d = describeFailingCondition(res.cond, liveScene, tagByIdLocal);
        for (const id of d.missingTagIds) fixableTagIds.add(String(id));
        const usePillLayout = d.lead && d.missingTagIds.length > 0;
        let children;
        if (usePillLayout) {
          const pillObjs = d.missingTagIds
            .map((id) => tagByIdLocal[String(id)])
            .filter(Boolean);
          children = [
            React.createElement("strong", { key: "lead" }, d.lead),
            renderStaticTagChips(pillObjs, "drift-pill-" + i),
            React.createElement("strong", { key: "trail" }, d.trail),
          ];
        } else {
          children = [
            React.createElement("strong", { key: "h" }, d.headline),
          ];
          if (d.actual) children.push(" ", d.actual);
        }
        lines.push(
          React.createElement(
            "div",
            { className: "power-tagger-warn-line", key: i },
            ...children
          )
        );
      });

      // Multi-rule footnote: "(closest of N alternatives)".
      const totalRules = ruleEval.rules.length;
      if (totalRules > 1) {
        lines.push(
          React.createElement(
            "div",
            { className: "power-tagger-warn-sub", key: "footnote" },
            `(Closest match of ${totalRules} alternatives. Other rules also failed.)`
          )
        );
      }

      // Optional fix button: add the missing tags. Only renders when
      // there are tag-level fixables \u2014 performer / studio / numeric
      // mismatches aren't auto-fixable. Green ("add" action). We pass
      // the FULL tag objects (not just ids) because the consumer
      // addTags() expects {id, name, ...} and filters by t.id; passing
      // raw ids broke the resolution flow.
      const fixTagsList = Array.from(fixableTagIds)
        .map((id) => tagByIdLocal[String(id)])
        .filter(Boolean);
      const fixButton = fixTagsList.length > 0
        ? React.createElement(
            "button",
            {
              type: "button",
              className: "btn btn-sm btn-success power-tagger-warn-fix",
              onClick: () => onAddTags(fixTagsList),
              title: "Stage these tags",
            },
            fixTagsList.length > 1 ? `Add ${fixTagsList.length} tags` : "Add tag"
          )
        : null;

      const configName = getActiveConfigNameSafe();

      return React.createElement(
        "div",
        { className: "power-tagger-warn-banner power-tagger-warn-banner-top power-tagger-warn-banner-config" },
        React.createElement(
          "div",
          { className: "power-tagger-warn-icon" },
          "\u26A0\uFE0E"
        ),
        React.createElement(
          "div",
          { className: "power-tagger-warn-body" },
          React.createElement(
            "div",
            { className: "power-tagger-warn-line", key: "head" },
            React.createElement("strong", null, "Config mismatch: "),
            "scene doesn\u2019t fit ",
            React.createElement("em", null, configName),
            "."
          ),
          ...lines
        ),
        fixButton
      );
    }
    function getActiveConfigNameSafe() {
      // allTags has full tag list incl. config tags. Find by id.
      for (const t of allTags) {
        if (String(t.id) === String(configTagId)) return t.name;
      }
      return "the active config";
    }

    // ---- Top strip: clickable category pills ---------------------------
    //
    // v0.11.5: wrapped in a relative container so we can absolutely-
    // position scroll arrows at the left/right edges. The arrows
    // appear only when the strip can scroll in that direction (driven
    // by stripCanScrollLeft / Right state above) and fade out smoothly
    // when scrolling reaches an extreme.
    const topStripScroller = React.createElement(
      "div",
      { className: "power-tagger-strip", ref: stripRef },
      slides.map((s, i) => {
        const active = i === currentIdx;
        const isComplete = completedCats.has(s.name);
        // stagedPerCat counts how many staged tags live in this category
        // (computed below from selectedSet + assignments). Used to show
        // a small badge next to each pill so users can see at a glance
        // which categories already have stagings.
        const stagedCount = stagedPerCat[s.name] || 0;
        const cw = combinedPerCat[s.name];
        const hasSoftWarning = !!cw && (
          cw.overMax || (cw.subOverMax && cw.subOverMax.length) ||
          (cw.hiddenTagsStaged && cw.hiddenTagsStaged.length)
        );
        const hasHardWarning = !!cw && (
          (cw.performerViolations || []).length > 0 ||
          (cw.conditionalBlocked || []).length > 0
        );
        const hasWarning = hasSoftWarning || hasHardWarning;
        return React.createElement(
          "button",
          {
            key: s.name,
            ref: active ? activePillRef : null,
            type: "button",
            className:
              "power-tagger-strip-item" +
              (active ? " power-tagger-strip-item-active" : "") +
              (hasWarning ? " power-tagger-strip-item-warn" : "") +
              (hasHardWarning ? " power-tagger-strip-item-warn-hard" : ""),
            style: active ? { backgroundColor: s.colour, color: pickTextColour(s.colour) } : null,
            onClick: () => goTo(i),
            title: hasWarning
              ? `${s.headerLabel} — has warnings`
              : s.headerLabel,
          },
          React.createElement("span", null, s.headerLabel),
          stagedCount > 0
            ? React.createElement(
                "span",
                { className: "power-tagger-strip-badge" },
                stagedCount
              )
            : null,
          hasWarning
            ? React.createElement(
                "span",
                {
                  className:
                    "power-tagger-strip-warn" +
                    (hasHardWarning ? " power-tagger-strip-warn-hard" : ""),
                  title: hasHardWarning
                    ? "Issues — performer rule violation"
                    : "Issues to resolve",
                },
                "\u26A0\uFE0E"
              )
            : null,
          isComplete
            ? React.createElement(
                "span",
                { className: "power-tagger-strip-check" },
                "✓"
              )
            : null
        );
      })
    );

    // v0.11.5: outer wrapper with the scroll arrows. The scroller is
    // the existing flex/overflow div; the arrows sit absolutely at the
    // v0.11.6: scrollable top strip. Arrows are layout columns inside the
    // wrap (flex: 0 0 32px) — NOT absolute-positioned overlays — so they
    // never visually overlap pills. The wrap is a flex row; the strip
    // takes remaining space; each arrow is conditionally rendered based on
    // scroll position so a strip that already fits everything shows neither
    // arrow.
    const topStrip = React.createElement(
      "div",
      { className: "power-tagger-strip-wrap" },
      stripCanScrollLeft
        ? React.createElement(
            "button",
            {
              type: "button",
              className: "power-tagger-strip-arrow power-tagger-strip-arrow-left",
              onClick: () => scrollStripBy(-1),
              "aria-label": "Scroll categories left",
              title: "Scroll left",
            },
            React.createElement(
              "svg",
              {
                width: 14,
                height: 14,
                viewBox: "0 0 16 16",
                fill: "none",
                stroke: "currentColor",
                strokeWidth: 2,
                strokeLinecap: "round",
                strokeLinejoin: "round",
                "aria-hidden": "true",
              },
              React.createElement("polyline", { points: "10 4 6 8 10 12" })
            )
          )
        : null,
      topStripScroller,
      stripCanScrollRight
        ? React.createElement(
            "button",
            {
              type: "button",
              className: "power-tagger-strip-arrow power-tagger-strip-arrow-right",
              onClick: () => scrollStripBy(1),
              "aria-label": "Scroll categories right",
              title: "Scroll right",
            },
            React.createElement(
              "svg",
              {
                width: 14,
                height: 14,
                viewBox: "0 0 16 16",
                fill: "none",
                stroke: "currentColor",
                strokeWidth: 2,
                strokeLinecap: "round",
                strokeLinejoin: "round",
                "aria-hidden": "true",
              },
              React.createElement("polyline", { points: "6 4 10 8 6 12" })
            )
          )
        : null
    );

    // ---- Carousel: a strip translateX'd by -currentIdx*100% ------------
    const carousel = React.createElement(
      "div",
      { className: "power-tagger-carousel-viewport" },
      React.createElement(
        "div",
        {
          className: "power-tagger-carousel-track",
          style: { transform: `translateX(-${currentIdx * 100}%)` },
        },
        slides.map((s, slideIdx) =>
          React.createElement(
            "div",
            {
              key: s.name,
              className: "power-tagger-slide",
            },
            React.createElement(
              "div",
              {
                className: "power-tagger-slide-title",
                style: { borderColor: s.colour },
              },
              React.createElement(
                "span",
                {
                  className: "power-tagger-slide-title-swatch",
                  style: { backgroundColor: s.colour },
                }
              ),
              s.headerLabel
            ),
            // Warning banner — only renders if this category has issues.
            renderSlideWarnings(s),
            React.createElement(
              "div",
              {
                className: "power-tagger-slide-body",
                ref: setSlideBodyRef(s.name),
              },
              s.subs.map((sub, subIdx) => {
                // For slides with no real sub names (single entry with name
                // ""), skip the header and render the grid directly so the
                // UI matches the simpler one-shot slides (e.g. Acts).
                const isUnnamed = !sub.name;
                const isOnlyForThisSlide = isUnnamed && s.subs.length === 1;
                const isOpen = isOnlyForThisSlide
                  ? true
                  : expandedSubs.has(subKey(s.name, sub.name));
                // v0.11.4: Position-based state for the sub.
                //   - isCurrent: this is the sub at the user's current
                //     position. Gets a left-edge accent stripe and a
                //     subtle background highlight.
                //   - isPast: this sub comes BEFORE current position in
                //     the slide ordering. Gets a \u2713 in the header
                //     so the user can see what they've walked through.
                //     We don't track per-sub "user marked done" \u2014
                //     position alone determines past/present/future.
                const isCurrent =
                  slideIdx === currentIdx && subIdx === currentSubIdx;
                const isPast =
                  slideIdx < currentIdx ||
                  (slideIdx === currentIdx && subIdx < currentSubIdx);
                // Tag count badge for the sub header.
                const subTagCount = sub.tags.length;
                return React.createElement(
                  "div",
                  {
                    key: sub.name || "_nosub",
                    className:
                      "power-tagger-sub" +
                      (isOpen ? " power-tagger-sub-open" : "") +
                      (isCurrent ? " power-tagger-sub-current" : "") +
                      (isPast ? " power-tagger-sub-past" : ""),
                    "data-sub-name": sub.name || "",
                    // v0.11.6: cat colour exposed as a CSS variable
                    // so the .power-tagger-sub-current::before stripe
                    // can pick it up. Falls back to the hardcoded
                    // yellow if no colour set.
                    style: isCurrent ? { "--power-tagger-sub-stripe": s.colour } : null,
                  },
                  isOnlyForThisSlide
                    ? null
                    : React.createElement(
                        "div",
                        {
                          className: "power-tagger-sub-header",
                          onClick: () => toggleSub(s.name, sub.name),
                          role: "button",
                          tabIndex: 0,
                          onKeyDown: (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              toggleSub(s.name, sub.name);
                            }
                          },
                        },
                        React.createElement(
                          "span",
                          { className: "power-tagger-sub-toggle" },
                          // Append U+FE0E (text variation selector) so the
                          // right-pointing triangle isn't rendered as a
                          // colour emoji on systems that do that by default
                          // (notably Firefox/Windows on U+25B6).
                          isOpen ? "▼\uFE0E" : "▶\uFE0E"
                        ),
                        React.createElement(
                          "span",
                          { className: "power-tagger-sub-name" },
                          sub.name
                        ),
                        React.createElement(
                          "span",
                          { className: "power-tagger-sub-count" },
                          ` (${subTagCount})`
                        ),
                        // \u2713 mark on subs the user has walked past
                        // \u2014 visible whether the sub is open or closed.
                        isPast
                          ? React.createElement(
                              "span",
                              { className: "power-tagger-sub-done" },
                              "\u2713"
                            )
                          : null
                      ),
                  isOpen
                    ? React.createElement(
                        "div",
                        {
                          className: "power-tagger-card-grid",
                          // v0.11.3: per-sub auto-shrink. pickCols
                          // returns 5..10; we encode it as a
                          // gridTemplateColumns override so the sub
                          // squeezes more cards per row when it
                          // would otherwise overflow vertically.
                          // Inline style beats the CSS default
                          // (5 cols) without specificity gymnastics.
                          style: (() => {
                            const C = pickCols(
                              sub.tags.length,
                              slideBodyDims.width,
                              slideBodyDims.height
                            );
                            return C === 5
                              ? null
                              : { gridTemplateColumns: `repeat(${C}, minmax(0, 1fr))` };
                          })(),
                        },
                        sub.tags.map((t) => {
                          const isStaged = selectedSet.has(String(t.id));
                          return React.createElement(
                            "div",
                            {
                              key: t.id,
                              className:
                                "power-tagger-card" +
                                (isStaged ? " power-tagger-card-staged" : ""),
                              role: "button",
                              tabIndex: 0,
                              onClick: () => handleCardClick(s, sub.name, t.id),
                              onKeyDown: (e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  handleCardClick(s, sub.name, t.id);
                                }
                              },
                              title: isStaged
                                ? `Remove ${t.name}`
                                : `Add ${t.name}`,
                            },
                            React.createElement(
                              "div",
                              {
                                className: "power-tagger-card-img",
                                style: t.image_path
                                  ? { backgroundImage: `url("${t.image_path}")` }
                                  : null,
                              }
                            ),
                            isStaged
                              ? React.createElement(
                                  "div",
                                  { className: "power-tagger-card-check" },
                                  "\u2713"
                                )
                              : null,
                            React.createElement(
                              "div",
                              {
                                className: "power-tagger-card-name",
                                style: { backgroundColor: s.colour, color: pickTextColour(s.colour) },
                              },
                              t.name
                            )
                          );
                        })
                      )
                    : null
                );
              })
            )
          )
        )
      )
    );

    // ---- Bottom nav bar ------------------------------------------------
    //
    // v0.11.4: Contextual Next.
    //   - Default label: "Next \u2192"
    //   - If next position crosses into a new slide (last sub of
    //     current cat, or current cat has no real subs):
    //       Label becomes "Advance to [Cat] \u2192" and the button
    //       takes the next cat's colour so the user sees what they're
    //       moving toward.
    //   - If we're at the very last position (no more positions
    //     available): button becomes "Save" and clicking it
    //     triggers the save flow (with warnings confirm if any).
    //
    // Skip-cat button: secondary always-available button that jumps
    // to the first sub of the NEXT slide, regardless of current sub.
    // Sits between Back and Next so Next's location is stable (per
    // spec: Next must NEVER move or resize \u2014 muscle-memory anchor).
    const nextPos = findNextPosition(currentIdx, currentSubIdx, visibility);
    const nextSlide = nextPos ? slides[nextPos.slideIdx] : null;
    const isCrossing = nextPos && nextPos.slideIdx !== currentIdx;
    const isLastPosition = !nextPos;
    const isFirstPosition = !findPrevPosition(currentIdx, currentSubIdx, visibility);
    const canSkipCat = currentIdx < slides.length - 1;
    // Next button look:
    let nextLabel = "Next \u2192";
    let nextStyle = null;
    if (isLastPosition) {
      nextLabel = "Save";
    } else if (isCrossing && nextSlide) {
      nextLabel = `Advance to ${nextSlide.name} \u2192`;
      const c = nextSlide.colour;
      if (c) {
        nextStyle = {
          backgroundColor: c,
          borderColor: c,
          color: pickTextColour(c),
        };
      }
    }
    function onNextClick() {
      if (isLastPosition) {
        if (saveHandlerRef && saveHandlerRef.current) saveHandlerRef.current();
        return;
      }
      goNext();
    }
    const navBar = React.createElement(
      "div",
      { className: "power-tagger-nav" },
      // Left group: Back + Skip cat. Pair them so they live in the
      // same visual zone (both "go elsewhere fast" actions). Skip
      // is secondary look-and-feel so Back stays dominant.
      React.createElement(
        "div",
        { className: "power-tagger-nav-left" },
        React.createElement(
          "button",
          {
            type: "button",
            className: "btn btn-secondary power-tagger-nav-btn power-tagger-nav-back",
            disabled: isFirstPosition,
            onClick: goBack,
          },
          "\u2190 Back"
        ),
        canSkipCat
          ? React.createElement(
              "button",
              {
                type: "button",
                className: "btn power-tagger-nav-skip",
                onClick: skipToNextCat,
                title: "Skip the rest of this category and jump to the next one",
              },
              "Skip cat \u00BB"
            )
          : null
      ),
      // Centre column: progress indicator. Lives in its own grid
      // column so it stays dead-centre regardless of how many
      // buttons are on either side.
      React.createElement(
        "div",
        { className: "power-tagger-nav-centre" },
        React.createElement(
          "span",
          { className: "power-tagger-nav-progress" },
          `${currentIdx + 1} / ${slides.length}`
        )
      ),
      // Right column: Next button (or "Advance to X" / "Save"
      // depending on context).
      React.createElement(
        "div",
        { className: "power-tagger-nav-right" },
        React.createElement(
          "button",
          {
            type: "button",
            className:
              "btn btn-primary power-tagger-nav-btn power-tagger-nav-next" +
              (isLastPosition ? " power-tagger-nav-save" : "") +
              (isCrossing ? " power-tagger-nav-cross" : ""),
            onClick: onNextClick,
            style: nextStyle,
          },
          nextLabel
        )
      )
    );

    // v0.11.2: Save-confirm modal element. Rendered only when
    // saveConfirmOpen — a portal to <body> keeps it above the
    // walkthrough's overflow clipping. The modal lists every warning
    // (soft + hard, undifferentiated) and offers Go Back / Save Anyway.
    //
    // Compute outstanding count + all-resolved flag once; drives both
    // the header title text and the footer Save button styling.
    // Each entry carries its own `isResolved(selectedSet)` — the
    // definition of "resolved" differs per warning type (e.g. over-max
    // is resolved when count drops to <= allowed, not when EVERY tag
    // is unstaged).
    const outstandingWarnings = warningsSnapshot.filter((w) => {
      if (typeof w.isResolved !== "function") {
        // At-least with no offenders: can't be resolved from modal.
        return true;
      }
      return !w.isResolved(selectedSet);
    }).length;
    const totalWarnings = warningsSnapshot.length;
    const allResolved = saveConfirmOpen && outstandingWarnings === 0 && totalWarnings > 0;

    const saveConfirmModal = saveConfirmOpen
      ? ReactDOM.createPortal(
          React.createElement(
            "div",
            { className: "power-tagger-save-confirm-overlay" },
            React.createElement(
              "div",
              {
                className:
                  "power-tagger-save-confirm-modal" +
                  (allResolved ? " power-tagger-save-confirm-modal-resolved" : ""),
              },
              React.createElement(
                "div",
                { className: "power-tagger-save-confirm-header" },
                React.createElement(
                  "div",
                  { className: "power-tagger-save-confirm-icon" },
                  allResolved ? "\u2713" : "\u26A0\uFE0E"
                ),
                React.createElement(
                  "div",
                  null,
                  React.createElement(
                    "div",
                    { className: "power-tagger-save-confirm-title" },
                    allResolved
                      ? "All resolved"
                      : (outstandingWarnings === totalWarnings
                          ? `${totalWarnings} warning${totalWarnings === 1 ? "" : "s"} on your tagging`
                          : `${outstandingWarnings} of ${totalWarnings} warning${totalWarnings === 1 ? "" : "s"} remaining`)
                  ),
                  React.createElement(
                    "div",
                    { className: "power-tagger-save-confirm-sub" },
                    allResolved ? "Ready to save." : "Review before saving."
                  )
                )
              ),
              React.createElement(
                "div",
                { className: "power-tagger-save-confirm-list" },
                warningsSnapshot.map((w, i) => {
                  const offending = w.offendingTags || [];
                  const addable = w.addTags || [];
                  const canResolve = offending.length > 0;
                  // v0.11.4: parallel "add-tag resolve" for warnings
                  // whose fix is to ADD tags, not remove them (currently
                  // the config-mismatch warning). canAdd doesn't combine
                  // with canResolve in practice \u2014 a warning is one
                  // or the other.
                  const canAdd = addable.length > 0;
                  // Use the entry's own resolved-check (cap-aware for
                  // over-max + constraint rules; all-unstaged for hidden
                  // / blocked / hidden-cat / configuration). Generic
                  // "every offender unstaged" was wrong for over-max
                  // because the user only needs to drop UNDER the cap,
                  // not remove every offender.
                  const isResolved = (canResolve || canAdd) && typeof w.isResolved === "function"
                    ? w.isResolved(selectedSet)
                    : false;
                  const onResolve = () => {
                    if (typeof onRemoveTags === "function") {
                      onRemoveTags(offending.map((t) => t.id));
                    }
                  };
                  const onUndo = () => {
                    if (typeof onAddTags === "function") {
                      onAddTags(offending);
                    }
                  };
                  // Add-resolve: stage the missing tag(s). Undo:
                  // unstage them. Pass full tag objects (not ids)
                  // because addTags() filters by t.id.
                  const onAddResolve = () => {
                    if (typeof onAddTags === "function") {
                      onAddTags(addable);
                    }
                  };
                  const onAddUndo = () => {
                    if (typeof onRemoveTags === "function") {
                      onRemoveTags(addable.map((t) => t.id));
                    }
                  };
                  return React.createElement(
                    "div",
                    {
                      key: i,
                      className:
                        "power-tagger-save-confirm-item power-tagger-save-confirm-item-" + w.kind +
                        (w.variant === "config"
                          ? " power-tagger-save-confirm-item-config"
                          : "") +
                        (isResolved ? " power-tagger-save-confirm-item-resolved" : ""),
                    },
                    React.createElement(
                      "span",
                      { className: "power-tagger-save-confirm-text" },
                      React.createElement(
                        "strong",
                        { className: "power-tagger-save-confirm-head" },
                        w.head
                      ),
                      " ",
                      w.bodyPrefix || "",
                      renderTagChips(w.bodyChipTags || [], "modal-" + i, true),
                      w.bodySuffix
                        ? (w.bodySuffixBold
                            ? React.createElement(
                                "strong",
                                { className: "power-tagger-save-confirm-overby" },
                                w.bodySuffix
                              )
                            : w.bodySuffix)
                        : ""
                    ),
                    // Tag-removal resolve (existing path).
                    canResolve
                      ? React.createElement(
                          "button",
                          {
                            type: "button",
                            className:
                              "btn btn-sm power-tagger-save-confirm-resolve " +
                              (isResolved
                                ? "btn-success power-tagger-save-confirm-resolve-undo"
                                : "btn-outline-light"),
                            onClick: isResolved ? onUndo : onResolve,
                            title: isResolved
                              ? `Re-stage ${offending.length} tag${offending.length === 1 ? "" : "s"}`
                              : `Unstage ${offending.length} tag${offending.length === 1 ? "" : "s"}`,
                          },
                          isResolved
                            ? `\u2713 Undo (${offending.length})`
                            : `Resolve (${offending.length})`
                        )
                      : null,
                    // v0.11.4: Tag-addition resolve (new path). When
                    // already resolved, button flips to a green-check
                    // "Added" state that undoes on click. We never
                    // render BOTH \u2014 a warning either wants tags
                    // added or removed.
                    canAdd
                      ? React.createElement(
                          "button",
                          {
                            type: "button",
                            className:
                              "btn btn-sm power-tagger-save-confirm-resolve " +
                              (isResolved
                                ? "btn-success power-tagger-save-confirm-resolve-undo"
                                : "btn-success"),
                            onClick: isResolved ? onAddUndo : onAddResolve,
                            title: isResolved
                              ? `Unstage ${addable.length} tag${addable.length === 1 ? "" : "s"}`
                              : `Stage ${addable.length} tag${addable.length === 1 ? "" : "s"}`,
                          },
                          isResolved
                            ? `\u2713 Added (${addable.length})`
                            : (addable.length > 1 ? `Add ${addable.length} tags` : "Add tag")
                        )
                      : null
                  );
                })
              ),
              React.createElement(
                "div",
                { className: "power-tagger-save-confirm-footer" },
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-secondary",
                    onClick: () => setSaveConfirmOpen(false),
                  },
                  "Go Back"
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn " + (allResolved ? "btn-success" : "btn-danger"),
                    onClick: () => {
                      setSaveConfirmOpen(false);
                      if (typeof onConfirmedSave === "function") onConfirmedSave();
                    },
                  },
                  allResolved ? "Save" : "Save Anyway"
                )
              )
            )
          ),
          document.body
        )
      : null;

    return React.createElement(
      "div",
      { className: "power-tagger-walkthrough" },
      renderCrossCuttingWarnings(),
      renderConfigDriftWarning(),
      topStrip,
      carousel,
      navBar,
      saveConfirmModal
    );
  }

  // Escape a string for safe use in a CSS attribute selector. We use this
  // when querying `[data-sub-name="<name>"]` to find a sub block to scroll
  // into view — sub names may contain quotes, slashes, etc. Use the
  // built-in if available (modern browsers), otherwise fall back to a
  // conservative manual escape.
  function cssEscape(s) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, "\\$&");
  }

  // Pick black or white text based on background luminance (same algorithm
  // as the Tag Categories plugin).
  function pickTextColour(bgHex) {
    if (!bgHex || typeof bgHex !== "string") return "#ffffff";
    const m = bgHex.match(/^#([0-9a-fA-F]{6})$/);
    if (!m) return "#ffffff";
    const hex = m[1];
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    const toLin = (c) =>
      c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    const L = 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
    return L > 0.55 ? "#1a1a1a" : "#ffffff";
  }

  // -------------------------------------------------------------------------
  // sortTagsByTaxonomy (v0.11.5) — order a list of tag objects by:
  //   1. Category index in taxonomy.categories (or Infinity if unassigned)
  //   2. Subcategory index within that category (or Infinity)
  //   3. Tag name (case-insensitive, locale-aware)
  //   4. Tag id (numeric tiebreaker for total order — guarantees idempotence)
  //
  // Hidden categories sort in their NATURAL taxonomy position (user
  // explicit choice). Unassigned tags sort at the END alphabetical.
  //
  // Pure function. Input array not mutated. Returns a new array.
  //
  // Args:
  //   tags        — array of tag objects ({ id, name, ... })
  //   taxonomy    — { categories: [{ name, subcategories: [{name}], hidden }] }
  //   assignments — { [tagId]: { category, subcategory } }
  // -------------------------------------------------------------------------
  function sortTagsByTaxonomy(tags, taxonomy, assignments) {
    if (!Array.isArray(tags) || tags.length === 0) return [];
    const cats = (taxonomy && taxonomy.categories) || [];
    const assn = assignments || {};

    // Pre-build cat-name → idx and (cat, sub) → idx lookup maps once.
    const catIdxByName = new Map();
    const subIdxByCatAndName = new Map();  // key: "<catName>::<subName>"
    cats.forEach((c, i) => {
      catIdxByName.set(c.name, i);
      (c.subcategories || []).forEach((s, j) => {
        subIdxByCatAndName.set(`${c.name}::${s.name}`, j);
      });
    });

    // Decorate with sort keys, then sort, then strip the decoration.
    const decorated = tags.map((t) => {
      const a = assn[String(t.id)] || {};
      const catName = a.category;
      const subName = a.subcategory || "";
      const catIdx = catName != null && catIdxByName.has(catName)
        ? catIdxByName.get(catName)
        : Infinity;
      const subIdx = catIdx === Infinity
        ? Infinity
        : (subName === "" ? -1 : (subIdxByCatAndName.has(`${catName}::${subName}`)
            ? subIdxByCatAndName.get(`${catName}::${subName}`)
            : Infinity));
      const lowerName = (t.name || "").toLowerCase();
      const idNum = Number(t.id);
      return { tag: t, catIdx, subIdx, lowerName, idNum };
    });

    decorated.sort((a, b) => {
      if (a.catIdx !== b.catIdx) return a.catIdx - b.catIdx;
      if (a.subIdx !== b.subIdx) return a.subIdx - b.subIdx;
      const nameCmp = a.lowerName.localeCompare(b.lowerName);
      if (nameCmp !== 0) return nameCmp;
      // Numeric id tiebreaker (NaN-safe — Number(NaN) compared yields NaN,
      // which falls through to 0, leaving stable sort intact).
      if (Number.isFinite(a.idNum) && Number.isFinite(b.idNum)) {
        return a.idNum - b.idNum;
      }
      return 0;
    });

    return decorated.map((d) => d.tag);
  }

  // -------------------------------------------------------------------------
  // The main modal body — three areas: left player, right categories, bottom
  // TagSelect.
  // -------------------------------------------------------------------------
  function PowerTaggerBody({ sceneId, onClose, requestCloseRef, launchSource, returnUrl, onSaveSuccess, requestJumpRef }) {
    const [scene, setScene] = React.useState(null);
    const [allTags, setAllTags] = React.useState([]);
    const [tagCategoriesConfig, setTagCategoriesConfig] = React.useState({
      assignments: {},
      taxonomy: { categories: [] },
    });
    const [interfaceConfig, setInterfaceConfig] = React.useState({
      showScrubber: true,
    });
    const [powerTaggerConfig, setPowerTaggerConfig] = React.useState({
      rulesets: {},
    });
    const [selectedTags, setSelectedTags] = React.useState([]);  // [{id, name}]
    const [loading, setLoading] = React.useState(true);
    const [loadError, setLoadError] = React.useState(null);
    const [saving, setSaving] = React.useState(false);
    // v0.11.8: Apollo-aware SceneUpdate mutation. Calling this (instead
    // of the raw gqlFetch in updateSceneTags) lets Apollo's cache notice
    // the update — any open Scene cards on the page behind the modal
    // (e.g. scenes-list cards when launched from the toolbar) re-render
    // with the new tag set automatically. No page reload required.
    //
    // The raw-gqlFetch path is still used for the edit-page launch
    // (legacy code path, which navigates away anyway, so cache freshness
    // doesn't matter for it). This is intentional belt-and-braces: we
    // touch the smallest possible surface area.
    //
    // The hook MUST be called above early returns to satisfy rules-of-
    // hooks. Verified May 2026: PluginApi.GQL.useSceneUpdateMutation
    // exists as a function on every page where this plugin loads.
    const [sceneUpdateMutation] = PluginApi.GQL.useSceneUpdateMutation();
    // v0.11.2: Ref used by CategorySections to register its save
    // handler. The Save button below calls saveHandlerRef.current(),
    // which either opens the confirm modal (if warnings present) or
    // invokes onSave directly. See CategorySections useEffect.
    const saveHandlerRef = React.useRef(null);

    // v0.11.5: confirm-discard-on-close.
    //
    // `confirmCloseOpen` drives the in-modal "Discard staged changes?"
    // prompt (reuses the .power-tagger-save-confirm-* chrome from the
    // TC-jump prompt). `requestClose()` is the single entry point for
    // all close paths (Cancel buttons, header Close button) — it opens
    // the prompt if dirty, else calls onClose() immediately.
    //
    // The dirty-check baseline is the scene's tag IDs at modal-open
    // time. Seeded from the scene fetch below. Empty/null while loading
    // means isDirty=false (correct — nothing has happened yet).
    const [confirmCloseOpen, setConfirmCloseOpen] = React.useState(false);
    // v0.11.10: optional deferred action for the discard-confirm dialog.
    // When null, the dialog's "Discard & close" button runs onClose
    // (existing behaviour). When set (by requestJump for queue jumps),
    // the button runs this function INSTEAD of onClose — letting the
    // user discard their stagings and jump to another scene without
    // closing the whole modal.
    const [pendingDirtyAction, setPendingDirtyAction] = React.useState(null);
    const savedTagIdsRef = React.useRef(null);

    // v0.11.5: optional "ask for save" prompt. When the global plugin
    // setting `askForSaveConfirm` is ON and the user clicks Save with
    // ZERO warnings, this prompt appears asking them to confirm. When
    // there are warnings, the existing warnings-review modal opens
    // (unchanged) — the new prompt does NOT fire in that case.
    const [confirmSaveOpen, setConfirmSaveOpen] = React.useState(false);

    // v0.11.5: per-scene "Organise on save" checkbox state. Initialised
    // to false; seeded from the global default setting once config
    // loads (see effect below). Drives whether Save marks the scene
    // organised. User can override per-scene by toggling the checkbox
    // before saving.
    const [organiseOnSave, setOrganiseOnSave] = React.useState(false);

    // Two phases: "picker" (choose Configuration), "walkthrough" (carousel).
    // The picker is the initial phase; user picks a config tag from the
    // Configuration category, hits Confirm, then we transition to the
    // walkthrough. The header's "Change" button flips back to "picker"
    // mid-walkthrough so the user can swap configs without losing stagings.
    const [phase, setPhase] = React.useState("picker");
    const [configTagId, setConfigTagId] = React.useState(null);
    // Temporary selection inside the picker before Confirm is pressed.
    const [pendingConfigTagId, setPendingConfigTagId] = React.useState(null);
    // v0.14.0: Power-Tagger-owned configurations list. Each entry is
    // { id, name, tagId|null }. Replaces the legacy model that derived
    // configs from the Tag Categories "Configuration" category.
    // Populated by ensureConfigurations after the mount data-load
    // (which runs the one-time legacy migration on first use).
    const [configurations, setConfigurations] = React.useState([]);

    // Fetch everything on mount
    React.useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          const [sc, tags, tcCfg, ifCfg, stCfg] = await Promise.all([
            fetchSceneForPlayer(sceneId),
            fetchAllTags(),
            readTagCategoriesConfig(),
            readInterfaceConfig(),
            readPowerTaggerConfig(),
          ]);
          if (cancelled) return;
          setScene(sc);
          setAllTags(tags);
          setTagCategoriesConfig(tcCfg);
          setInterfaceConfig(ifCfg);
          setPowerTaggerConfig(stCfg);
          // Seed selected from scene's existing tag IDs
          setSelectedTags(sc?.tags || []);
          // v0.11.5: baseline snapshot for dirty-check on close.
          savedTagIdsRef.current = new Set(
            (sc?.tags || []).map((t) => String(t.id))
          );
          // v0.11.5: seed the "Organise on save" checkbox from the
          // global default setting. Independent of the scene's current
          // organised status — this is about what the next Save will
          // do, not the scene's current state.
          setOrganiseOnSave(!!stCfg.organiseOnSaveDefault);
          // v0.14.0: resolve the configurations list. Done last so the
          // (potentially write-incurring) one-time legacy migration
          // doesn't delay seeding the rest of the modal state.
          const configs = await ensureConfigurations(stCfg, tcCfg, tags);
          if (!cancelled) setConfigurations(configs);
        } catch (err) {
          if (!cancelled) setLoadError(err.message || String(err));
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      return () => { cancelled = true; };
    }, [sceneId]);

    // v0.11.8: ScenePlayer-ready tick. Stash exposes ScenePlayer as a
    // code-split, lazy-loaded component at PluginApi.loadableComponents
    // .ScenePlayer. When the user opens this modal from the scenes-list
    // toolbar (without ever visiting a scene detail page first),
    // PluginApi.components.ScenePlayer is undefined AND Stash will
    // never auto-load it on its own — the Scenes list route doesn't
    // import ScenePlayer.
    //
    // PluginApi.utils.loadComponents([loadableTarget]) actively
    // triggers the dynamic import. It returns a Promise; on resolve,
    // PluginApi.components.ScenePlayer is populated. We bump
    // spReadyTick to force the player useMemo to re-evaluate and pick
    // up the now-loaded component.
    //
    // Verified May 2026: `loadComponents` is a Promise-returning fn;
    // `loadableComponents.ScenePlayer` is a bare React lazy fn.
    //
    // No-op when ScenePlayer is already present (e.g. user previously
    // visited a scene detail page in this tab, so Stash already
    // registered it). Also no-op (graceful) if either PluginApi
    // surface is missing in some future Stash version — the player
    // falls back to the "(ScenePlayer component not loaded)" message
    // as before.
    const [spReadyTick, setSpReadyTick] = React.useState(0);
    React.useEffect(() => {
      if (PluginApi.components && PluginApi.components.ScenePlayer) return undefined;
      const loader = PluginApi.utils && PluginApi.utils.loadComponents;
      const target =
        PluginApi.loadableComponents && PluginApi.loadableComponents.ScenePlayer;
      if (typeof loader !== "function" || !target) return undefined;
      let cancelled = false;
      Promise.resolve(loader([target]))
        .then(() => {
          if (cancelled) return;
          if (PluginApi.components && PluginApi.components.ScenePlayer) {
            setSpReadyTick((t) => t + 1);
          }
        })
        .catch((err) => {
          console.warn("[power-tagger] ScenePlayer load failed:", err);
        });
      return () => { cancelled = true; };
    }, []);

    // The player — memoised so it survives unrelated state changes (e.g.
    // staging a tag rerenders PowerTaggerBody, but the rendered ScenePlayer
    // element keeps the same identity and React diffs it in place rather
    // than remounting it. Without this, every tag click tore down video.js
    // and rebuilt the <video>, causing a visible flash + playback loss.)
    //
    // CRITICAL: this hook MUST live above the early-returns (loading /
    // loadError / !scene) — React's rules-of-hooks demand hooks run in the
    // same order on every render. Putting useMemo after an early-return
    // makes it appear/disappear depending on state, which triggers React
    // error #310 and brings down the whole modal.
    //
    // Verified via React DevTools (May 2026) the production app calls
    // ScenePlayer with these props:
    //   scene, hideScrubberOverride, autoplay, permitLoop,
    //   initialTimestamp, sendSetTimestamp, onComplete, onNext, onPrevious
    //
    // The handover from v0.1.0 claimed three blockers: missing sceneStreams,
    // IntlProvider context lost through portal, and "t.el() is null".
    //   - sceneStreams: now fetched (see fetchSceneForPlayer above).
    //   - IntlProvider: empirically NOT lost — confirmed in our modal tree.
    //   - t.el() is null: was almost certainly a downstream effect of the
    //     missing sceneStreams field crashing video.js init.
    //
    // We pass `hideScrubberOverride: !interfaceConfig.showScrubber` so we
    // respect the user's "Show Scrubber" preference (sprite-thumbnail
    // strip is on/off in line with the rest of Stash).
    //
    // Stash's player is video.js under the hood. The sprite + VTT we
    // already fetch via scene.paths.sprite / scene.paths.vtt are wired up
    // automatically.
    const playerEl = React.useMemo(() => {
      // v0.11.8: read ScenePlayer fresh from PluginApi.components on every
      // render rather than from the module-level `Components` snapshot.
      // PluginApi.components is lazy-populated by Stash as routes are
      // visited. When this plugin's IIFE runs at app start (before the
      // user visits any scene-detail page), PluginApi.components.ScenePlayer
      // is undefined, so a module-level snapshot captures `undefined` and
      // stays that way for the session. Reading at render time picks up
      // the value once Stash has populated it. Same pattern as
      // TagSelect/StudioSelect/PerformerSelect re-reads elsewhere in this
      // file. Fixes the scenes-list toolbar entry path showing
      // "(ScenePlayer component not loaded — try reopening)" forever.
      const SP =
        (PluginApi.components && PluginApi.components.ScenePlayer) ||
        Components.ScenePlayer ||
        null;
      if (!scene) return null;
      if (!SP) {
        return React.createElement(
          "div",
          { style: { color: "#888", padding: 20 } },
          "(ScenePlayer component not loaded — try reopening)"
        );
      }
      return React.createElement(
        ScenePlayerErrorBoundary,
        { label: "ScenePlayer", scene },
        React.createElement(SP, {
          scene,
          hideScrubberOverride: !interfaceConfig.showScrubber,
          autoplay: false,
          permitLoop: true,
          initialTimestamp: 0,
          sendSetTimestamp: () => {},
          onComplete: () => {},
          onNext: () => {},
          onPrevious: () => {},
        })
      );
    }, [scene, interfaceConfig.showScrubber, spReadyTick]);

    // v0.11.3: Performer row + popout state. Lives under the player.
    //   - performerEditOpen: whether the inline PerformerSelect editor
    //     is showing (toggled by an Edit button at the end of the row).
    //   - performerPopoutId: id of the performer whose detail card is
    //     currently open, or null. Click another name to switch; click
    //     outside to close; click the card's X to close.
    const [performerEditOpen, setPerformerEditOpen] = React.useState(false);
    const [performerPopoutId, setPerformerPopoutId] = React.useState(null);

    // Local snapshot of the scene's performer list. Seeded from
    // `scene.performers` once loaded, then updated when the user edits
    // via PerformerSelect. We keep our own copy so the row reflects
    // edits without a full scene re-fetch.
    const [scenePerformers, setScenePerformers] = React.useState([]);
    // Tracks whether the seed effect below has run -- needed by liveScene
    // (further down) to distinguish "initial empty state, scene not yet
    // loaded" from "user removed every performer". Without this, the
    // post-seed empty case would wrongly fall back to scene.performers.
    const performersSeededRef = React.useRef(false);
    React.useEffect(() => {
      if (scene && Array.isArray(scene.performers)) {
        setScenePerformers(scene.performers);
        performersSeededRef.current = true;
      }
    }, [scene]);

    // v0.12.0: Inline scene-metadata editor state.
    //   - metaEditOpen : whether the full-width metadata panel is showing.
    //   - sceneMeta    : the COMMITTED metadata snapshot. Seeded from the
    //     scene fetch and updated ONLY on a successful save — never via
    //     setScene (that retriggers the [scene]-keyed ScenePlayer rebuild
    //     and reloads the video). Same separate-snapshot reasoning as
    //     scenePerformers above.
    //   - metaDraft    : the working copy the form edits. Re-seeded from
    //     sceneMeta each time the panel opens; discarded on close.
    //   - metaSaving / metaError : Save-button busy + inline error state.
    //
    // sceneMeta.groups is flattened to [{ id, name, scene_index }] from
    // the scene fetch's nested `groups { group { id name } scene_index }`
    // so GroupSelect (which wants {id,name} objects) can consume it.
    const [metaEditOpen, setMetaEditOpen] = React.useState(false);
    const [sceneMeta, setSceneMeta] = React.useState(null);
    const [metaDraft, setMetaDraft] = React.useState(null);
    const [metaSaving, setMetaSaving] = React.useState(false);
    const [metaError, setMetaError] = React.useState(null);
    React.useEffect(() => {
      if (!scene) return;
      setSceneMeta({
        title: scene.title || "",
        date: scene.date || "",
        code: scene.code || "",
        details: scene.details || "",
        rating100: scene.rating100 == null ? null : toInt(scene.rating100, null),
        studio: scene.studio
          ? { id: String(scene.studio.id), name: scene.studio.name || "" }
          : null,
        urls: Array.isArray(scene.urls) ? scene.urls.slice() : [],
        groups: Array.isArray(scene.groups)
          ? scene.groups
              .filter((g) => g && g.group && g.group.id)
              .map((g) => ({
                id: String(g.group.id),
                name: g.group.name || "",
                scene_index:
                  g.scene_index === null || g.scene_index === undefined
                    ? null
                    : g.scene_index,
              }))
          : [],
      });
    }, [scene]);

    // A "live" view of the scene that overlays the user's in-modal
    // edits on top of the originally fetched scene object:
    //   - scenePerformers: edited via PerformerSelect on the tagging
    //     screen. Reflects add / remove operations.
    //   - sceneMeta: edited via the inline scene-metadata editor.
    //     Covers title, date, code, studio.
    //
    // The auto-select rule engine evaluates against this object so the
    // picker's "matched rule" indicator re-runs when the user goes
    // BACK to the picker after editing the scene. Without this overlay,
    // the eval always ran against the stale initial scene state, so
    // (e.g.) a "performerCount = 2" rule stayed marked as matched even
    // after the user added a third performer in the tagging UI.
    //
    // Before the seed effects have run (one-render window per state),
    // we fall back to the raw scene field so initial auto-pick still
    // works correctly. The seeded ref + sceneMeta null-check distinguish
    // "not yet seeded" from "seeded but user-edited to empty/null".
    const liveScene = React.useMemo(() => {
      if (!scene) return null;
      const performers = performersSeededRef.current
        ? scenePerformers
        : scene.performers || [];
      if (!sceneMeta) {
        return Object.assign({}, scene, { performers });
      }
      return Object.assign({}, scene, {
        performers,
        title: sceneMeta.title,
        date: sceneMeta.date,
        code: sceneMeta.code,
        studio: sceneMeta.studio,
      });
    }, [scene, scenePerformers, sceneMeta]);

    // v0.11.12: performer row scroll arrows. Same pattern as the
    // category strip — track left/right scrollability; render arrows
    // conditionally; arrow clicks scroll by one card width. Free-
    // scroll (wheel / trackpad) behaviour is preserved — no CSS
    // scroll-snap so dragging still feels natural.
    const performerRowRef = React.useRef(null);
    const [perfCanScrollLeft, setPerfCanScrollLeft] = React.useState(false);
    const [perfCanScrollRight, setPerfCanScrollRight] = React.useState(false);
    React.useEffect(() => {
      const el = performerRowRef.current;
      if (!el) return undefined;
      function measure() {
        const max = el.scrollWidth - el.clientWidth;
        setPerfCanScrollLeft(el.scrollLeft > 2);
        setPerfCanScrollRight(el.scrollLeft < max - 2);
      }
      // v0.11.13: defer the initial measure to next animation frame so
      // the browser has actually laid out the cards. On modal-open
      // (and on scenePerformers.length changes from 0→N), a synchronous
      // measure() can fire before layout settles — scrollWidth ends up
      // equal to clientWidth, both arrows hidden, state sticks because
      // ResizeObserver only fires on clientWidth changes (which don't
      // happen — only scrollWidth grew). A rAF + a 100ms fallback
      // covers both paint-aligned and image-load-delayed layouts.
      const raf =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(measure)
          : null;
      const fallback = setTimeout(measure, 100);
      el.addEventListener("scroll", measure, { passive: true });
      window.addEventListener("resize", measure);
      // ResizeObserver picks up content-width changes (performer added
      // or removed) and viewport / column-width changes.
      const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
      if (ro) ro.observe(el);
      return () => {
        if (raf !== null && typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(raf);
        }
        clearTimeout(fallback);
        el.removeEventListener("scroll", measure);
        window.removeEventListener("resize", measure);
        if (ro) ro.disconnect();
      };
      // v0.12.0: metaEditOpen is a dep so this effect re-runs when the
      // metadata editor closes — the performer row unmounts while the
      // editor is open, so on close it remounts with a fresh ref that
      // these listeners must re-attach to.
    }, [scenePerformers.length, phase, metaEditOpen]);

    // Scroll by one card width (~120 card + 8 gap = 128px). Smooth so
    // the arrow click feels intentional rather than snappy.
    function scrollPerformerRowBy(direction) {
      const el = performerRowRef.current;
      if (!el) return;
      el.scrollBy({ left: direction * 128, behavior: "smooth" });
    }

    // v0.11.3: Popout dismissal. Earlier the popout closed on any
    // outside click; the user preferred sticky behaviour so an
    // accidental click doesn't dismiss it. The popout now ONLY
    // closes via:
    //   - the X button on the popout itself
    //   - clicking the active performer card again (toggle off)
    //   - clicking another performer card (switches popout target)
    // Clicks elsewhere on the page have no effect on the popout.
    // (No useEffect listener needed.)

    // Compute age at scene date from a performer's birthdate.
    // Returns null if either date is missing or invalid.
    function ageAtScene(performer) {
      if (!performer || !performer.birthdate) return null;
      // v0.12.0: prefer the committed metadata snapshot's date so card
      // ages update after a date edit is saved, without a refetch.
      const sceneDate =
        (sceneMeta && sceneMeta.date) || (scene && scene.date) || null;
      const refDate = sceneDate ? new Date(sceneDate) : new Date();
      const bd = new Date(performer.birthdate);
      if (isNaN(refDate.getTime()) || isNaN(bd.getTime())) return null;
      let age = refDate.getFullYear() - bd.getFullYear();
      const m = refDate.getMonth() - bd.getMonth();
      if (m < 0 || (m === 0 && refDate.getDate() < bd.getDate())) age--;
      return age >= 0 && age < 150 ? age : null;
    }

    // Format the height in cm as a clean string. Returns null if no
    // height set (so the popout row can be hidden).
    function formatHeight(p) {
      if (!p || !p.height_cm) return null;
      return `${p.height_cm} cm`;
    }

    // Build the popout card content for a performer. Field set differs
    // by gender (female sees Country, Fake Tits, Measurements; male
    // sees Circumcised instead). Empty fields are hidden \u2014 cleaner
    // than dim placeholders, and the data model assumes if you care
    // about a field for a performer you'll fill it in.
    function renderPerformerDetailRow(label, value) {
      if (value === null || value === undefined || value === "") return null;
      return React.createElement(
        "div",
        { className: "power-tagger-performer-popout-row" },
        React.createElement(
          "span",
          { className: "power-tagger-performer-popout-label" },
          label
        ),
        React.createElement(
          "span",
          { className: "power-tagger-performer-popout-value" },
          String(value)
        )
      );
    }
    function renderPerformerPopout(p) {
      const g = (p.gender || "").toUpperCase();
      const isMale = g === "MALE";
      const isFemale = g === "FEMALE";
      // v0.11.13: same "other" bucket as the performer card — trans
      // male/female, non-binary, intersex. Drives the gender-coloured
      // left stripe via CSS.
      const isOtherGender =
        g === "TRANSGENDER_MALE" ||
        g === "TRANSGENDER_FEMALE" ||
        g === "NON_BINARY" ||
        g === "INTERSEX";
      const popoutClass =
        "power-tagger-performer-popout" +
        (isMale ? " power-tagger-performer-popout-male" : "") +
        (isFemale ? " power-tagger-performer-popout-female" : "") +
        (isOtherGender ? " power-tagger-performer-popout-other" : "");
      const age = ageAtScene(p);
      // Common rows for both genders.
      const commonRows = [
        renderPerformerDetailRow("Age at scene", age),
        renderPerformerDetailRow("Ethnicity", p.ethnicity),
        renderPerformerDetailRow("Hair", p.hair_color),
        renderPerformerDetailRow("Eyes", p.eye_color),
        renderPerformerDetailRow("Height", formatHeight(p)),
        renderPerformerDetailRow("Tattoos", p.tattoos),
        renderPerformerDetailRow("Piercings", p.piercings),
      ];
      // v0.11.13: gender-conditional rows now use independent flags
      // instead of mutually-exclusive branches, so trans-female can
      // pull BOTH the female-style fields and circumcised status.
      //
      //   Male                  → Circumcised
      //   Female                → Country, Fake Tits, Measurements
      //   Non-Binary            → same as Female
      //   Transgender Female    → Female fields + Circumcised
      //   Transgender Male      → common rows only (no extras)
      //   Intersex              → common rows only (no extras)
      const showFemaleFields =
        isFemale || g === "NON_BINARY" || g === "TRANSGENDER_FEMALE";
      const showCircumcised = isMale || g === "TRANSGENDER_FEMALE";
      const circValue =
        p.circumcised === "CUT" ? "Cut"
        : p.circumcised === "UNCUT" ? "Uncut"
        : null;
      const genderRows = [
        showFemaleFields ? renderPerformerDetailRow("Country", p.country) : null,
        showFemaleFields ? renderPerformerDetailRow("Fake Tits", p.fake_tits) : null,
        showFemaleFields ? renderPerformerDetailRow("Measurements", p.measurements) : null,
        showCircumcised ? renderPerformerDetailRow("Circumcised", circValue) : null,
      ].filter(Boolean);
      return React.createElement(
        "div",
        { className: popoutClass },
        React.createElement(
          "button",
          {
            type: "button",
            className: "power-tagger-performer-popout-close",
            onClick: () => setPerformerPopoutId(null),
            title: "Close",
            "aria-label": "Close",
          },
          "\u00D7"
        ),
        // Photo column.
        p.image_path
          ? React.createElement("div", {
              className: "power-tagger-performer-popout-img",
              style: { backgroundImage: `url("${p.image_path}")` },
            })
          : React.createElement("div", {
              className:
                "power-tagger-performer-popout-img power-tagger-performer-popout-img-empty",
            }),
        // Details column.
        React.createElement(
          "div",
          { className: "power-tagger-performer-popout-body" },
          React.createElement(
            "div",
            { className: "power-tagger-performer-popout-name" },
            React.createElement(
              "span",
              { className: "power-tagger-performer-popout-name-text" },
              p.name
            ),
            // v0.11.13: gender icon to the right of the name. Tinted
            // via CSS (popout-{male/female/other} on the wrapping div
            // → cascades to the icon's fill via currentColor).
            (() => {
              const ic = genderIconFor(p.gender);
              return ic
                ? React.createElement(
                    "svg",
                    {
                      className: "power-tagger-performer-popout-gender-icon",
                      width: 14,
                      height: 14,
                      viewBox: ic.viewBox,
                      fill: "currentColor",
                      "aria-hidden": "true",
                    },
                    React.createElement("path", { d: ic.path })
                  )
                : null;
            })()
          ),
          React.createElement(
            "div",
            { className: "power-tagger-performer-popout-details" },
            commonRows.filter(Boolean).slice(0, 1), // age first
            genderRows.filter(Boolean),
            commonRows.filter(Boolean).slice(1)
          )
        )
      );
    }

    // v0.11.3: Scene info card. Sits below the player on the left,
    // displays title + studio + date + resolution + fps. Title uses
    // the largest font and follows Stash's scene-view typography
    // pattern (bold + larger). Other fields are secondary text.
    //
    // Field sources (verified May 2026 via the scene fetch above):
    //   - title: scene.title (often empty in practice; fall back to
    //     stripExtension of files[0].basename per Stash convention)
    //   - studio: scene.studio.name
    //   - date: scene.date (YYYY-MM-DD)
    //   - resolution + fps: scene.files[0].{width, height, frame_rate}
    //
    // Empty fields are hidden \u2014 cleaner than blank "Studio: \u2014"
    // placeholders for scenes with incomplete metadata.
    function sceneDisplayTitle() {
      // v0.12.0: prefer the committed metadata snapshot so a saved
      // title edit shows immediately without a scene refetch.
      if (sceneMeta && sceneMeta.title) return sceneMeta.title;
      if (scene && scene.title) return scene.title;
      const f = scene && scene.files && scene.files[0];
      if (!f || !f.basename) return "(untitled)";
      // Strip the file extension.
      const dot = f.basename.lastIndexOf(".");
      return dot > 0 ? f.basename.slice(0, dot) : f.basename;
    }
    function sceneResolutionLabel() {
      const f = scene && scene.files && scene.files[0];
      if (!f || !f.height) return null;
      // Match Stash's resolution labels for common ones.
      const h = f.height;
      if (h >= 2160) return "4K";
      if (h >= 1440) return "1440p";
      if (h >= 1080) return "1080p";
      if (h >= 720) return "720p";
      if (h >= 480) return "480p";
      return `${h}p`;
    }
    function sceneFpsLabel() {
      const f = scene && scene.files && scene.files[0];
      if (!f || !f.frame_rate) return null;
      // Frame rate is a float; round to one decimal but drop ".0".
      const fps = Math.round(f.frame_rate * 10) / 10;
      return `${fps % 1 === 0 ? fps.toFixed(0) : fps.toFixed(1)} fps`;
    }
    function sceneDurationLabel() {
      const f = scene && scene.files && scene.files[0];
      if (!f || !f.duration) return null;
      const total = Math.floor(f.duration);
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      // 1:02:03 for >=1h, 02:03 for <1h. Matches the player time display.
      if (h > 0) {
        return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      }
      return `${m}:${String(s).padStart(2, "0")}`;
    }
    function sceneFilePath() {
      const f = scene && scene.files && scene.files[0];
      return (f && f.path) || null;
    }
    function renderSceneInfo() {
      const title = sceneDisplayTitle();
      // v0.12.0: studio + date come from the committed metadata
      // snapshot so saved edits reflect here without a refetch.
      const studio =
        (sceneMeta && sceneMeta.studio && sceneMeta.studio.name) ||
        (scene && scene.studio && scene.studio.name);
      const date = (sceneMeta && sceneMeta.date) || (scene && scene.date);
      const res = sceneResolutionLabel();
      const fps = sceneFpsLabel();
      const duration = sceneDurationLabel();
      const path = sceneFilePath();
      // Meta row \u2014 the secondary fields joined by a middot. Skip
      // empties so the row only shows what's present.
      const metaParts = [];
      if (studio) metaParts.push(studio);
      if (date) metaParts.push(date);
      if (duration) metaParts.push(duration);
      if (res) metaParts.push(res);
      if (fps) metaParts.push(fps);
      return React.createElement(
        "div",
        { className: "power-tagger-scene-info" },
        // v0.12.0: header row — label on the left, Edit button on
        // the right. Mirrors the performer-row header. The button
        // opens the full-width metadata editor over the below-player
        // area. Hidden until sceneMeta has loaded.
        React.createElement(
          "div",
          { className: "power-tagger-scene-info-header" },
          React.createElement(
            "div",
            { className: "power-tagger-scene-info-label" },
            "Scene"
          ),
          sceneMeta
            ? React.createElement(
                "button",
                {
                  type: "button",
                  className:
                    "btn btn-sm btn-secondary power-tagger-scene-info-edit",
                  onClick: openMetaEditor,
                  title: "Edit scene metadata",
                },
                "Edit"
              )
            : null
        ),
        React.createElement(
          "div",
          { className: "power-tagger-scene-info-title", title: title },
          title
        ),
        metaParts.length
          ? React.createElement(
              "div",
              { className: "power-tagger-scene-info-meta" },
              metaParts.map((part, i) =>
                React.createElement(
                  React.Fragment,
                  { key: i },
                  i > 0
                    ? React.createElement(
                        "span",
                        { className: "power-tagger-scene-info-sep" },
                        "\u00B7"
                      )
                    : null,
                  React.createElement("span", null, part)
                )
              )
            )
          : null,
        // File path \u2014 monospaced, dimmer, wraps within the column.
        // Sits below the meta row as a separate section because file
        // paths are often long enough to wrap.
        path
          ? React.createElement(
              "div",
              {
                className: "power-tagger-scene-info-path",
                title: path,
              },
              path
            )
          : null
      );
    }

    // -----------------------------------------------------------------
    // v0.12.0: Inline scene-metadata editor.
    //
    // The editor is a full-width panel that replaces the below-player
    // grid (scene-info card + performer row) while open. It edits a
    // working copy (`metaDraft`); one Save button commits everything
    // via updateSceneMetadata, then copies the draft into the committed
    // `sceneMeta` snapshot — which flows into `liveScene` so rules
    // re-evaluate. The video is never reloaded (we never call setScene).
    // -----------------------------------------------------------------

    // Deep copy a metadata snapshot so the draft and the committed copy
    // never share nested references (studio object / urls / groups).
    function cloneMeta(m) {
      const src = m || {};
      return {
        title: src.title || "",
        date: src.date || "",
        code: src.code || "",
        details: src.details || "",
        rating100: src.rating100 == null ? null : toInt(src.rating100, null),
        studio: src.studio
          ? { id: String(src.studio.id), name: src.studio.name || "" }
          : null,
        urls: Array.isArray(src.urls) ? src.urls.slice() : [],
        groups: Array.isArray(src.groups)
          ? src.groups.map((g) => ({
              id: String(g.id),
              name: g.name || "",
              scene_index:
                g.scene_index === null || g.scene_index === undefined
                  ? null
                  : g.scene_index,
            }))
          : [],
      };
    }

    // Deep-equality of two metadata snapshots — drives the Save
    // button's enabled state. URLs are compared after trim+drop-empty
    // (an empty "+ Add URL" row is not a real change); groups compare
    // on id + scene_index.
    function metaEquals(a, b) {
      if (!a || !b) return a === b;
      if ((a.title || "") !== (b.title || "")) return false;
      if ((a.date || "") !== (b.date || "")) return false;
      if ((a.code || "") !== (b.code || "")) return false;
      if ((a.details || "") !== (b.details || "")) return false;
      const ar = a.rating100 == null ? null : toInt(a.rating100, null);
      const br = b.rating100 == null ? null : toInt(b.rating100, null);
      if (ar !== br) return false;
      const as = a.studio && a.studio.id ? String(a.studio.id) : "";
      const bs = b.studio && b.studio.id ? String(b.studio.id) : "";
      if (as !== bs) return false;
      const cleanUrls = (m) =>
        (m.urls || []).map((u) => String(u || "").trim()).filter(Boolean);
      const au = cleanUrls(a);
      const bu = cleanUrls(b);
      if (au.length !== bu.length || au.some((u, i) => u !== bu[i])) {
        return false;
      }
      const groupKey = (m) =>
        (m.groups || []).map(
          (g) =>
            String(g.id) +
            ":" +
            (g.scene_index == null ? "" : String(g.scene_index))
        );
      const ag = groupKey(a);
      const bg = groupKey(b);
      if (ag.length !== bg.length || ag.some((g, i) => g !== bg[i])) {
        return false;
      }
      return true;
    }

    // Open the editor: seed the draft from the committed snapshot and
    // dismiss the performer popout / inline performer editor (they sit
    // in the area the panel is about to cover).
    function openMetaEditor() {
      setMetaDraft(cloneMeta(sceneMeta));
      setMetaError(null);
      setPerformerEditOpen(false);
      setPerformerPopoutId(null);
      setMetaEditOpen(true);
    }

    // Close the editor — the draft is discarded (re-seeded on next open).
    function closeMetaEditor() {
      setMetaEditOpen(false);
    }

    // Merge a partial patch into the working draft.
    function patchMetaDraft(patch) {
      setMetaDraft((d) => (d ? { ...d, ...patch } : d));
    }

    // Commit all fields in one mutation. On success the ONLY state
    // change is setSceneMeta — no setScene, so the player is untouched
    // and `liveScene` recomputes for the rules engine.
    async function saveMetaEditor() {
      if (!metaDraft || metaSaving) return;
      const dateStr = (metaDraft.date || "").trim();
      if (dateStr && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        setMetaError("Date must be in YYYY-MM-DD format.");
        return;
      }
      setMetaSaving(true);
      setMetaError(null);
      try {
        await updateSceneMetadata(sceneId, metaDraft);
        setSceneMeta(cloneMeta(metaDraft));
      } catch (err) {
        setMetaError("Save failed: " + (err && err.message ? err.message : err));
      } finally {
        setMetaSaving(false);
      }
    }

    // URL list mutators.
    function setUrlAt(i, val) {
      setMetaDraft((d) => {
        if (!d) return d;
        const urls = d.urls.slice();
        urls[i] = val;
        return { ...d, urls };
      });
    }
    function removeUrlAt(i) {
      setMetaDraft((d) =>
        d ? { ...d, urls: d.urls.filter((_, j) => j !== i) } : d
      );
    }
    function addUrl() {
      setMetaDraft((d) => (d ? { ...d, urls: [...d.urls, ""] } : d));
    }

    // One label + control row in the form grid. `wide` spans both
    // columns (used for title / studio / groups / details / urls).
    function metaField(label, control, wide) {
      return React.createElement(
        "div",
        {
          className:
            "power-tagger-meta-field" +
            (wide ? " power-tagger-meta-field-wide" : ""),
        },
        React.createElement(
          "label",
          { className: "power-tagger-meta-field-label" },
          label
        ),
        control
      );
    }

    // Render the full-width metadata editor panel. Plain function (no
    // hooks) — the *Select components it uses are stable references on
    // `Components`, so there's no remount problem (same as the
    // performer row).
    function renderSceneMetaEditor() {
      if (!metaDraft) return null;
      const StudioSelect = Components.StudioSelect || null;
      const GroupSelect = Components.GroupSelect || null;
      const RatingSystem = Components.RatingSystem || null;
      const DateInput = Components.DateInput || null;
      // Save is enabled only when the draft differs from the committed
      // snapshot — no point firing a no-op mutation.
      const dirty = !metaEquals(metaDraft, sceneMeta);
      const selectStyles = {
        menuPortal: (base) => ({ ...base, zIndex: 100000 }),
      };

      // --- Title ---
      const titleField = metaField(
        "Title",
        React.createElement("input", {
          type: "text",
          className: "power-tagger-as-text",
          value: metaDraft.title,
          placeholder: "Scene title",
          onChange: (e) => patchMetaDraft({ title: e.target.value }),
        }),
        true
      );

      // --- Date: Stash's native DateInput (text line + calendar
      //     button, always YYYY-MM-DD). Falls back to a native date
      //     input if the component isn't loaded. ---
      const dateControl = DateInput
        ? React.createElement(DateInput, {
            value: metaDraft.date || "",
            onValueChange: (v) => patchMetaDraft({ date: v || "" }),
            placeholder: "YYYY-MM-DD",
          })
        : React.createElement("input", {
            type: "date",
            className: "power-tagger-as-text",
            value: metaDraft.date || "",
            onChange: (e) => patchMetaDraft({ date: e.target.value }),
          });
      const dateField = metaField("Date", dateControl);

      // --- Code ---
      const codeField = metaField(
        "Studio code",
        React.createElement("input", {
          type: "text",
          className: "power-tagger-as-text",
          value: metaDraft.code,
          placeholder: "Studio code",
          onChange: (e) => patchMetaDraft({ code: e.target.value }),
        })
      );

      // --- Rating: Stash's native RatingSystem (respects the user's
      //     configured rating system). Falls back to a 0-100 number
      //     input if the component isn't loaded. ---
      const ratingControl = RatingSystem
        ? React.createElement(RatingSystem, {
            value: metaDraft.rating100 == null ? undefined : metaDraft.rating100,
            onSetRating: (v) =>
              patchMetaDraft({
                rating100: v == null || v === 0 ? null : toInt(v, null),
              }),
          })
        : React.createElement("input", {
            type: "number",
            min: 0,
            max: 100,
            className: "power-tagger-as-num",
            value: metaDraft.rating100 == null ? "" : metaDraft.rating100,
            placeholder: "0-100",
            onChange: (e) => {
              const raw = e.target.value;
              patchMetaDraft({
                rating100: raw === "" ? null : toInt(raw, null),
              });
            },
          });
      const ratingField = metaField("Rating", ratingControl);

      // --- Studio (single-select) ---
      const studioControl = StudioSelect
        ? React.createElement(StudioSelect, {
            values: metaDraft.studio ? [metaDraft.studio] : [],
            isMulti: false,
            onSelect: (items) => {
              const arr = Array.isArray(items) ? items : items ? [items] : [];
              const s = arr[0];
              patchMetaDraft({
                studio: s
                  ? { id: String(s.id), name: s.name || "" }
                  : null,
              });
            },
            menuPortalTarget: document.body,
            menuPlacement: "auto",
            styles: selectStyles,
            placeholder: "Pick a studio...",
          })
        : React.createElement("input", {
            type: "text",
            className: "power-tagger-as-text",
            value: metaDraft.studio ? metaDraft.studio.id : "",
            placeholder: "Studio ID",
            onChange: (e) =>
              patchMetaDraft({
                studio: e.target.value
                  ? { id: e.target.value, name: "" }
                  : null,
              }),
          });
      const studioField = metaField("Studio", studioControl, true);

      // --- Groups (multi-select). scene_index is preserved per group
      //     across edits; new groups get a null index. ---
      const groupsControl = GroupSelect
        ? React.createElement(GroupSelect, {
            values: metaDraft.groups.map((g) => ({ id: g.id, name: g.name })),
            isMulti: true,
            onSelect: (items) => {
              const arr = items || [];
              const prevById = new Map(
                metaDraft.groups.map((g) => [String(g.id), g])
              );
              patchMetaDraft({
                groups: arr.map((it) => {
                  const id = String(it.id);
                  const prev = prevById.get(id);
                  return {
                    id,
                    name: it.name || (prev && prev.name) || "",
                    scene_index: prev ? prev.scene_index : null,
                  };
                }),
              });
            },
            menuPortalTarget: document.body,
            menuPlacement: "auto",
            styles: selectStyles,
            placeholder: "Add groups...",
          })
        : React.createElement(
            "span",
            { style: { color: "#888" } },
            "(GroupSelect not loaded)"
          );
      const groupsField = metaField("Groups", groupsControl, true);

      // --- Details ---
      const detailsField = metaField(
        "Details",
        React.createElement("textarea", {
          className: "power-tagger-as-desc",
          rows: 4,
          value: metaDraft.details,
          placeholder: "Scene details / description",
          onChange: (e) => patchMetaDraft({ details: e.target.value }),
        }),
        true
      );

      // --- URLs (variable-length list) ---
      const urlsControl = React.createElement(
        "div",
        { className: "power-tagger-meta-url-list" },
        metaDraft.urls.map((u, i) =>
          React.createElement(
            "div",
            { key: i, className: "power-tagger-meta-url-row" },
            React.createElement("input", {
              type: "text",
              className: "power-tagger-as-text",
              value: u,
              placeholder: "https://...",
              onChange: (e) => setUrlAt(i, e.target.value),
            }),
            React.createElement(
              "button",
              {
                type: "button",
                className: "btn btn-sm btn-secondary power-tagger-meta-url-remove",
                onClick: () => removeUrlAt(i),
                title: "Remove this URL",
              },
              "×"
            )
          )
        ),
        React.createElement(
          "button",
          {
            type: "button",
            className: "btn btn-sm btn-secondary power-tagger-meta-url-add",
            onClick: addUrl,
          },
          "+ Add URL"
        )
      );
      const urlsField = metaField("URLs", urlsControl, true);

      return React.createElement(
        CrashBoundary,
        { label: "Scene metadata editor" },
        React.createElement(
          "div",
          { className: "power-tagger-meta-editor" },
          // Header: title + close button.
          React.createElement(
            "div",
            { className: "power-tagger-meta-editor-header" },
            React.createElement(
              "div",
              { className: "power-tagger-meta-editor-title" },
              "Edit scene metadata"
            ),
            React.createElement(
              "button",
              {
                type: "button",
                className: "btn btn-sm btn-secondary power-tagger-meta-editor-close",
                onClick: closeMetaEditor,
                title: "Close editor",
              },
              "Close"
            )
          ),
          // Scrollable form body.
          React.createElement(
            "div",
            { className: "power-tagger-meta-editor-body" },
            React.createElement(
              "div",
              { className: "power-tagger-meta-editor-form" },
              titleField,
              dateField,
              codeField,
              ratingField,
              studioField,
              groupsField,
              detailsField,
              urlsField
            )
          ),
          // Footer: inline error + single Save button.
          React.createElement(
            "div",
            { className: "power-tagger-meta-editor-footer" },
            metaError
              ? React.createElement(
                  "div",
                  { className: "power-tagger-meta-editor-error" },
                  metaError
                )
              : null,
            React.createElement(
              "button",
              {
                type: "button",
                className: "btn btn-primary power-tagger-meta-editor-save",
                onClick: saveMetaEditor,
                disabled: metaSaving || !dirty,
              },
              metaSaving ? "Saving…" : "Save"
            )
          )
        )
      );
    }

    // Render the performer row beneath the player. Each performer is
    // a portrait-style card (photo on top, gender-coloured name
    // banner below). Click a card to open/close its popout; click a
    // different one to switch.
    //
    // v0.11.3 changed from pills \u2014 cards fill the vertical space
    // better and show the headshot directly so the user can identify
    // performers visually, not just by name.
    function renderPerformerRow() {
      const PS = Components.PerformerSelect;
      const openP = performerPopoutId
        ? scenePerformers.find((p) => String(p.id) === String(performerPopoutId))
        : null;
      return React.createElement(
        "div",
        { className: "power-tagger-performer-row-wrap" },
        // Header row: label on the left (with live count), Edit
        // button on the right. Combining them saves vertical space
        // compared to a separate footer.
        React.createElement(
          "div",
          { className: "power-tagger-performer-row-header" },
          React.createElement(
            "div",
            { className: "power-tagger-performer-row-label" },
            "Performers",
            React.createElement(
              "span",
              { className: "power-tagger-performer-row-count" },
              `(${scenePerformers.length})`
            )
          ),
          PS
            ? React.createElement(
                "button",
                {
                  type: "button",
                  className: "btn btn-sm btn-secondary power-tagger-performer-edit",
                  onClick: () => setPerformerEditOpen((v) => !v),
                  title: performerEditOpen
                    ? "Close performer editor"
                    : "Add or remove performers",
                },
                performerEditOpen ? "Done" : "Edit"
              )
            : null
        ),
        // Cards row: single row, horizontal scroll for overflow.
        // v0.11.12: wrapped in a flex shell with conditional arrows
        // (same pattern as the category strip). Arrows render only
        // when there's room to scroll that direction.
        React.createElement(
          "div",
          { className: "power-tagger-performer-row-shell" },
          perfCanScrollLeft
            ? React.createElement(
                "button",
                {
                  type: "button",
                  className:
                    "power-tagger-performer-row-arrow " +
                    "power-tagger-performer-row-arrow-left",
                  onClick: () => scrollPerformerRowBy(-1),
                  "aria-label": "Scroll performers left",
                  title: "Scroll left",
                },
                React.createElement(
                  "svg",
                  {
                    width: 12,
                    height: 12,
                    viewBox: "0 0 16 16",
                    fill: "none",
                    stroke: "currentColor",
                    strokeWidth: 2,
                    strokeLinecap: "round",
                    strokeLinejoin: "round",
                    "aria-hidden": "true",
                  },
                  React.createElement("polyline", { points: "10 4 6 8 10 12" })
                )
              )
            : null,
          React.createElement(
            "div",
            {
              className: "power-tagger-performer-row",
              ref: performerRowRef,
            },
            scenePerformers.map((p) => {
            const g = (p.gender || "").toUpperCase();
            // v0.11.12: bucket non-binary, intersex, and both transgender
            // variants into a single "-other" class for the purple
            // banner. MALE/FEMALE keep their existing blue/pink. Null /
            // unset gender falls through to no class (default grey),
            // which preserves the existing "not set" visual.
            const isOtherGender =
              g === "TRANSGENDER_MALE" ||
              g === "TRANSGENDER_FEMALE" ||
              g === "NON_BINARY" ||
              g === "INTERSEX";
            const cls =
              "power-tagger-performer-card" +
              (g === "MALE" ? " power-tagger-performer-card-male" : "") +
              (g === "FEMALE" ? " power-tagger-performer-card-female" : "") +
              (isOtherGender ? " power-tagger-performer-card-other" : "") +
              (String(performerPopoutId) === String(p.id)
                ? " power-tagger-performer-card-active"
                : "");
            return React.createElement(
              "div",
              {
                key: p.id,
                className: cls,
                role: "button",
                tabIndex: 0,
                onClick: () => {
                  setPerformerPopoutId((cur) =>
                    String(cur) === String(p.id) ? null : String(p.id)
                  );
                },
                onKeyDown: (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setPerformerPopoutId((cur) =>
                      String(cur) === String(p.id) ? null : String(p.id)
                    );
                  }
                },
                title: p.name,
              },
              // Photo block.
              React.createElement("div", {
                className: "power-tagger-performer-card-img",
                style: p.image_path
                  ? { backgroundImage: `url("${p.image_path}")` }
                  : null,
              }),
              // Small "open in new tab" icon. Click stops propagation
              // so the card's onClick (popout toggle) doesn't also
              // fire. target=_blank + rel for safety.
              // v0.11.13: FontAwesome arrow-up-right-from-square SVG
              // instead of the unicode ↗ glyph — renders consistently
              // across fonts and matches the icon Stash uses for
              // external links elsewhere.
              React.createElement(
                "a",
                {
                  className: "power-tagger-performer-card-link",
                  href: `/performers/${p.id}`,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  onClick: (e) => { e.stopPropagation(); },
                  title: "Open performer page in new tab",
                },
                React.createElement(
                  "svg",
                  {
                    width: 12,
                    height: 12,
                    viewBox: "0 0 448 512",
                    fill: "currentColor",
                    "aria-hidden": "true",
                  },
                  React.createElement("path", {
                    d: "M288 32c-17.7 0-32 14.3-32 32s14.3 32 32 32h50.7L169.4 265.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L384 141.3V192c0 17.7 14.3 32 32 32s32-14.3 32-32V64c0-17.7-14.3-32-32-32H288zM80 64C35.8 64 0 99.8 0 144V400c0 44.2 35.8 80 80 80H336c44.2 0 80-35.8 80-80V320c0-17.7-14.3-32-32-32s-32 14.3-32 32v80c0 8.8-7.2 16-16 16H80c-8.8 0-16-7.2-16-16V144c0-8.8 7.2-16 16-16h80c17.7 0 32-14.3 32-32s-14.3-32-32-32H80z",
                  })
                )
              ),
              // Name banner. flex: 1 in CSS lets it expand to fill
              // the card height when the name is short, matching the
              // card heights in a row with longer names.
              // v0.11.13: age-at-scene rendered as a second line
              // inside the banner. The banner CSS stacks the two
              // lines vertically and centers them as one unit, so the
              // age tucks neatly under the name without growing the
              // card. Only emitted when ageAtScene returns a real
              // number (silently skipped otherwise).
              (() => {
                const cardAge = ageAtScene(p);
                return React.createElement(
                  "div",
                  { className: "power-tagger-performer-card-name" },
                  React.createElement(
                    "div",
                    { className: "power-tagger-performer-card-name-text" },
                    p.name
                  ),
                  cardAge != null
                    ? React.createElement(
                        "div",
                        { className: "power-tagger-performer-card-age" },
                        `Age ${cardAge}`
                      )
                    : null
                );
              })()
            );
          })
        ),
          perfCanScrollRight
            ? React.createElement(
                "button",
                {
                  type: "button",
                  className:
                    "power-tagger-performer-row-arrow " +
                    "power-tagger-performer-row-arrow-right",
                  onClick: () => scrollPerformerRowBy(1),
                  "aria-label": "Scroll performers right",
                  title: "Scroll right",
                },
                React.createElement(
                  "svg",
                  {
                    width: 12,
                    height: 12,
                    viewBox: "0 0 16 16",
                    fill: "none",
                    stroke: "currentColor",
                    strokeWidth: 2,
                    strokeLinecap: "round",
                    strokeLinejoin: "round",
                    "aria-hidden": "true",
                  },
                  React.createElement("polyline", { points: "6 4 10 8 6 12" })
                )
              )
            : null
        ),
        // (Edit button was moved to the header row above to save vertical
        //  space; the editor itself still renders below when toggled open.)
        // Edit picker \u2014 only mounted when the user opens it. Writes
        // changes immediately to the scene via updateScenePerformers.
        performerEditOpen && PS
          ? React.createElement(
              "div",
              { className: "power-tagger-performer-editor" },
              React.createElement(PS, {
                values: scenePerformers,
                isMulti: true,
                onSelect: (items) => {
                  const next = items || [];
                  // Optimistic local update; server write happens in
                  // parallel and we don't block the UI on it.
                  setScenePerformers(next);
                  updateScenePerformers(sceneId, next.map((p) => p.id))
                    .catch((err) => {
                      alert("Failed to update performers: " + (err.message || err));
                    });
                  // v0.11.11: backfill missing detail fields for newly-
                  // added performers. PerformerSelect's option payload
                  // includes `id`, `name`, `image_path`, `__typename`,
                  // and a few others — but NOT the detail fields the
                  // popout displays (gender, ethnicity, hair_color,
                  // birthdate, etc.). Detector: `gender` strictly
                  // undefined means the field wasn't in react-select's
                  // payload — fetchSceneForPlayer always selects
                  // gender, so existing entries have it defined
                  // (string or null). Fetch full records for those
                  // IDs and merge into scenePerformers without
                  // disturbing the others.
                  //
                  // v0.11.11 first attempt used image_path as the
                  // detector — verified via fibre probe that doesn't
                  // work because PerformerSelect's internal options
                  // already carry image_path for the picker thumbnail.
                  const needFetch = next
                    .filter((p) => p && p.gender === undefined)
                    .map((p) => String(p.id));
                  if (needFetch.length) {
                    fetchPerformersByIds(needFetch)
                      .then((full) => {
                        if (!full.length) return;
                        const byId = new Map(
                          full.map((p) => [String(p.id), p])
                        );
                        setScenePerformers((prev) =>
                          prev.map((p) =>
                            byId.has(String(p.id)) ? byId.get(String(p.id)) : p
                          )
                        );
                      })
                      .catch(() => {});
                  }
                },
                menuPortalTarget: document.body,
                menuPlacement: "auto",
                styles: { menuPortal: (base) => ({ ...base, zIndex: 100000 }) },
                placeholder: "Add performers...",
              })
            )
          : null,
        // Popout card \u2014 absolutely positioned over the player area.
        openP ? renderPerformerPopout(openP) : null
      );
    }

    // Toggle a tag in selectedTags. Used by upper-panel cards: click to
    // stage if absent, click to unstage if present. Returns true if we
    // ADDED, false if we REMOVED — so the walkthrough can skip auto-
    // advance side-effects on an unstage.
    //
    // When ADDING, we also apply any cascade rules defined for this tag
    // in the active config's ruleset: every tag in the cascade's addTags
    // gets staged too (unless already staged). Cascades re-fire on every
    // staging (per spec), so removing+re-adding a trigger re-applies them.
    // Removing the trigger does NOT remove cascade-added tags.
    function toggleTag(tagId) {
      const t = allTags.find((x) => String(x.id) === String(tagId));
      if (!t) return false;
      const has = selectedTags.some((x) => String(x.id) === String(tagId));
      if (has) {
        setSelectedTags(selectedTags.filter((x) => String(x.id) !== String(tagId)));
        return false;
      }
      // Adding — compute the before/after staged sets and pass to
      // resolveCascades. The resolver returns IDs to also stage,
      // computed as "cascades that transitioned from not-firing to
      // firing as a result of this staging" (edge-triggered semantics).
      // This supports multi-trigger cascades with any/all logic: an
      // "all" cascade with two triggers fires when the second one is
      // staged. "Any" cascades fire on first trigger, never re-fire
      // while still met.
      const stagedBefore = new Set(selectedTags.map((x) => String(x.id)));
      const stagedAfter = new Set(stagedBefore);
      stagedAfter.add(String(tagId));
      const cascadeIds = resolveCascades(
        powerTaggerConfig.rulesets,
        configTagId,
        stagedBefore,
        stagedAfter
      );
      const existingIds = stagedBefore;
      const additions = [t];
      for (const cid of cascadeIds) {
        if (existingIds.has(String(cid)) || String(cid) === String(tagId)) continue;
        const ct = allTags.find((x) => String(x.id) === String(cid));
        if (ct) additions.push(ct);
      }
      setSelectedTags([...selectedTags, ...additions]);
      return true;
    }

    // Bulk remove. Used by warning "Remove offending tags" buttons. We
    // can't just loop toggleTag because it reads stale selectedTags within
    // a single render — this filters everything in one setState.
    function removeTags(tagIds) {
      const idSet = new Set(tagIds.map(String));
      setSelectedTags((prev) => prev.filter((x) => !idSet.has(String(x.id))));
    }

    // v0.11.2: Inverse of removeTags — re-stage tags by id. Used by
    // the save-confirm modal's Undo button to bring back tags that
    // were unstaged via Resolve. Deduplicates against currently
    // staged so a double-undo is a no-op.
    function addTags(tags) {
      if (!tags || !tags.length) return;
      setSelectedTags((prev) => {
        const existing = new Set(prev.map((x) => String(x.id)));
        const additions = tags.filter((t) => !existing.has(String(t.id)));
        if (!additions.length) return prev;
        return [...prev, ...additions];
      });
    }

    async function onSave() {
      setSaving(true);
      try {
        // Persist tag_ids in raw stage order. Stash always sorts tags
        // alphabetically on read (SQL: ORDER BY COALESCE(sort_name, name)),
        // so the array order we send is not used as display order. The
        // taxonomy-aware display ordering is handled at the rendering
        // layer (Tag Categories front-end reorder), not here.
        const ids = selectedTags.map((x) => x.id);
        if (launchSource === "toolbar") {
          // v0.11.8: Toolbar-launch path. Use the Apollo-aware
          // useSceneUpdateMutation so the scene's cached entry is
          // updated in place; any scenes-list card currently rendering
          // this scene re-renders with the new tags automatically.
          //
          // v0.11.9: call onSaveSuccess (host-provided) instead of
          // onClose. In queue mode the host advances to the next
          // scene; in single-scene mode (or back-compat where host
          // didn't pass onSaveSuccess) it closes the modal — identical
          // to v0.11.8 behaviour. The fallback to onClose ensures any
          // caller of this code path that doesn't know about queueing
          // still works.
          const input = {
            id: String(sceneId),
            tag_ids: ids.map((x) => String(x)),
          };
          if (organiseOnSave === true) input.organized = true;
          await sceneUpdateMutation({ variables: { input } });
          if (typeof onSaveSuccess === "function") {
            onSaveSuccess();
          } else {
            onClose();
          }
        } else {
          // Edit-page launch path — UNCHANGED from v0.11.7. Raw mutation
          // + hard navigation to the scene detail page. The user came
          // here from /scenes/:id/edit and expects to land at
          // /scenes/:id; that's a legitimate route change, not a
          // "refresh", so leaving it alone.
          await updateSceneTags(sceneId, ids, organiseOnSave);
          window.location.href = `/scenes/${sceneId}`;
        }
      } catch (err) {
        alert("Save failed: " + (err.message || String(err)));
        setSaving(false);
      }
    }

    // v0.11.5: requestSave — called by CategorySections' saveHandlerRef
    // when there are NO warnings. If the global plugin setting
    // `askForSaveConfirm` is ON, shows a simple confirm prompt before
    // calling onSave. If OFF, calls onSave immediately (current
    // behaviour). The warnings-review path is unaffected — it still
    // opens the existing complex modal directly.
    function requestSave() {
      if (powerTaggerConfig && powerTaggerConfig.askForSaveConfirm) {
        setConfirmSaveOpen(true);
      } else {
        onSave();
      }
    }

    // v0.14.0: the picker cards ARE the configurations list. Each entry
    // is a config object { id, name, tagId|null } — not a tag. `id` is
    // the ruleset key; `tagId` is the optional linked Stash tag (used
    // for the card thumbnail and autoStage). The legacy model derived
    // these from the Tag Categories "Configuration" category; gone now.
    const configTags = React.useMemo(() => {
      return Array.isArray(configurations) ? configurations : [];
    }, [configurations]);

    // v0.14.0: the set of Stash tag ids that back configurations.
    // These are excluded from the walkthrough's taggable tags so a
    // config tag never shows up as a normal tag (regardless of which
    // category it happens to be assigned to).
    const configLinkedTagIds = React.useMemo(() => {
      const s = new Set();
      for (const c of configTags) {
        if (c && c.tagId) s.add(String(c.tagId));
      }
      return s;
    }, [configTags]);

    // Track whether the current pendingConfigTagId was set by the
    // auto-select rule (so the preview box can show "AUTO-SUGGESTED"
    // instead of the plain "SELECTED" eyebrow). User manually clicking
    // a card clears this flag.
    const [autoSuggested, setAutoSuggested] = React.useState(false);
    // v0.11.6: once the user has explicitly unselected a card (by
    // clicking the selected one), the auto-suggest effect must NOT
    // re-fire on the resulting null state — otherwise we slam them
    // back to the auto-pick they just dismissed. This ref flips on
    // any user-initiated card click (select OR unselect) and stays
    // true for the rest of the picker session.
    const userTouchedConfigRef = React.useRef(false);

    // Pre-select effect. Single effect with explicit precedence so we
    // don't have a race between auto-select and default-config:
    //
    //   1. Auto-select rule match wins. Try each config's autoSelectRule
    //      against the scene; first match (by display order) is picked
    //      and flagged as "auto-suggested".
    //   2. Otherwise, fall back to defaultConfigId if the user set one
    //      and it still exists.
    //   3. Otherwise, leave unselected.
    //
    // Critical: this effect MUST wait for `scene` to be loaded before
    // running. Previously we had two separate effects \u2014 the default-
    // config one didn't depend on `scene`, so it ran first (as soon as
    // configTags + powerTaggerConfig were ready) and set the default,
    // which then blocked auto-select from ever running.
    React.useEffect(() => {
      if (phase !== "picker") return;
      if (pendingConfigTagId) return;
      if (userTouchedConfigRef.current) return; // v0.11.6: respect explicit unselect
      if (!liveScene || configTags.length === 0) return;
      const rulesets = (powerTaggerConfig && powerTaggerConfig.rulesets) || {};
      // Build allTagsById for the evaluator (used only for human-
      // readable summaries inside the trace, so a flat map is fine).
      const allTagsById = {};
      for (const t of allTags) allTagsById[String(t.id)] = t;
      const assignments = (tagCategoriesConfig && tagCategoriesConfig.assignments) || {};

      // Step 1: try auto-select. Evaluate against liveScene so the
      // pick reflects any performer / metadata edits the user has
      // made since the scene was first fetched.
      const pick = pickAutoSelectConfig(
        configTags,
        rulesets,
        liveScene,
        allTagsById,
        assignments
      );
      if (pick) {
        setPendingConfigTagId(String(pick.tag.id));
        setAutoSuggested(true);
        return;
      }

      // Step 2: fall back to default config if set.
      const defId = powerTaggerConfig && powerTaggerConfig.defaultConfigId;
      if (!defId) return;
      const exists = configTags.some((t) => String(t.id) === String(defId));
      if (!exists) return;
      setPendingConfigTagId(String(defId));
      // autoSuggested stays false \u2014 default-config is not an auto-pick,
      // just a preference.
    }, [configTags, powerTaggerConfig, phase, pendingConfigTagId, liveScene, allTags, tagCategoriesConfig]);

    // v0.13.0: plain-mode auto-skip. A library with no Configuration
    // tags (the Configuration category is empty, or the Tag Categories
    // plugin is not installed) has nothing to pick on the config
    // screen. Rather than dead-ending the user there, drop straight
    // into plain tagging. The ref makes this fire once, so a user who
    // later navigates back to the config screen is not bounced out.
    const plainModeSkipRef = React.useRef(false);
    React.useEffect(() => {
      if (plainModeSkipRef.current) return;
      if (phase !== "picker") return;
      if (loading || !scene) return;
      if (configTags.length > 0) return;
      plainModeSkipRef.current = true;
      enterPlainMode();
    }, [phase, loading, scene, configTags.length]);

    function getActiveConfigName() {
      if (!configTagId) return null;
      const t = configTags.find((x) => String(x.id) === String(configTagId));
      return t ? t.name : null;
    }

    function onConfirmConfig() {
      if (!pendingConfigTagId) return;
      // Reset staged tags to whatever the scene originally had on disk.
      // This drops anything the user added under the previous (possibly
      // wrong) config when they hit "Change" — they're starting fresh
      // for this new config.
      const originals = scene?.tags || [];

      // Auto-stage the config's linked tag if the ruleset opts in.
      // Useful for configs that ARE meaningful as tags on the scene
      // (Solo Female, Solo Male, Compilation, etc) — the user picks the
      // config, and the linked tag is staged immediately so they don't
      // have to add it manually. Default off; toggled per-config in the
      // rules editor. v0.14.0: only fires for tag-linked configs; a
      // tagless config has nothing to stage.
      const rs = (powerTaggerConfig.rulesets || {})[String(pendingConfigTagId)] || {};
      const pendingConfig = configTags.find(
        (c) => String(c.id) === String(pendingConfigTagId)
      );
      const linkedTagId = pendingConfig && pendingConfig.tagId;
      if (rs.autoStage && linkedTagId) {
        const linkedTag = allTags.find(
          (t) => String(t.id) === String(linkedTagId)
        );
        const alreadyHas = originals.some(
          (t) => String(t.id) === String(linkedTagId)
        );
        if (linkedTag && !alreadyHas) {
          setSelectedTags([...originals, linkedTag]);
        } else {
          setSelectedTags(originals);
        }
      } else {
        setSelectedTags(originals);
      }

      setConfigTagId(pendingConfigTagId);
      setPhase("walkthrough");
      // Per-slide click counters + completed-cat ticks live inside
      // CategorySections; they reset themselves via a useEffect keyed on
      // configTagId. (See the resetOnConfigChange effect there.)
    }

    // v0.13.0: enter the walkthrough with NO configuration ("plain
    // mode"). Used by the auto-skip effect (when the library has no
    // Configuration tags) and the "Tag without a configuration" button
    // on the config screen. The rules engine no-ops on a null
    // configTagId, so the walkthrough renders plain category-grouped
    // tagging. Staged tags reset to the scene's originals, matching
    // onConfirmConfig's non-autoStage path.
    function enterPlainMode() {
      setSelectedTags(scene?.tags || []);
      setConfigTagId(null);
      setPhase("walkthrough");
    }

    function onChangeConfig() {
      setPendingConfigTagId(configTagId);
      setPhase("picker");
    }

    // v0.11.5: dirty-check + requestClose gate. Hooks must live above
    // the loading/error/!scene early returns below (rules-of-hooks —
    // see lessons-learned).
    const isDirty = React.useMemo(() => {
      if (loading) return false;
      const saved = savedTagIdsRef.current;
      if (!saved) return false;
      const live = new Set(selectedTags.map((t) => String(t.id)));
      if (live.size !== saved.size) return true;
      for (const id of live) if (!saved.has(id)) return true;
      return false;
    }, [selectedTags, loading]);

    // Display order for the bottom-bar staged chips: always sorted by
    // taxonomy (Configuration first, then categories in taxonomy order,
    // sub-categories in taxonomy order, alphabetical within). Unassigned
    // tags go last. Pure cosmetic re-sort of the chip display; underlying
    // `selectedTags` state is untouched (chips still toggle/unstage
    // correctly).
    const displaySelectedTags = React.useMemo(() => {
      return sortTagsByTaxonomy(
        selectedTags,
        tagCategoriesConfig.taxonomy,
        tagCategoriesConfig.assignments || {}
      );
    }, [selectedTags, tagCategoriesConfig]);

    const requestClose = React.useCallback(() => {
      if (isDirty) setConfirmCloseOpen(true);
      else onClose();
    }, [isDirty, onClose]);

    // Publish requestClose onto the shared ref so PortalModal's header
    // Close button can route through it too.
    React.useEffect(() => {
      if (!requestCloseRef) return undefined;
      requestCloseRef.current = requestClose;
      return () => {
        if (requestCloseRef.current === requestClose) {
          requestCloseRef.current = null;
        }
      };
    }, [requestCloseRef, requestClose]);

    // v0.11.10: requestJump gate. Called by the host's queue sidebar
    // when the user clicks another scene's row. If the current scene
    // is dirty, stage the jump as pendingDirtyAction and open the
    // existing discard-confirm dialog — discarding will run the jump
    // instead of closing the whole modal. If clean, jump directly.
    const requestJump = React.useCallback((doJump) => {
      if (typeof doJump !== "function") return;
      if (isDirty) {
        setPendingDirtyAction(() => doJump);
        setConfirmCloseOpen(true);
      } else {
        doJump();
      }
    }, [isDirty]);

    React.useEffect(() => {
      if (!requestJumpRef) return undefined;
      requestJumpRef.current = requestJump;
      return () => {
        if (requestJumpRef.current === requestJump) {
          requestJumpRef.current = null;
        }
      };
    }, [requestJumpRef, requestJump]);

    // Loading / error states
    if (loading) {
      return React.createElement(
        "div",
        { style: { padding: 20, color: "#999" } },
        "Loading scene & taxonomy..."
      );
    }
    if (loadError) {
      return React.createElement(
        "div",
        { style: { padding: 20, color: "#f88" } },
        "Failed to load: " + loadError
      );
    }
    if (!scene) {
      return React.createElement(
        "div",
        { style: { padding: 20, color: "#f88" } },
        "Scene not found."
      );
    }

    // Header strip showing what we're tagging + active config + Change btn.
    function renderHeaderStrip() {
      if (phase !== "walkthrough") return null;
      // v0.14.0: tint the config-name pill with the active
      // configuration's own colour, carrying the visual identity from
      // the picker card into the walkthrough. Plain mode (no active
      // configuration) uses the fixed red so it reads unmistakably as
      // "tagging without a configuration".
      const activeConfig = configTagId
        ? configTags.find((c) => String(c.id) === String(configTagId))
        : null;
      const name = activeConfig ? activeConfig.name : null;
      const catColour = activeConfig
        ? activeConfig.colour || DEFAULT_CONFIG_COLOUR
        : PLAIN_MODE_COLOUR;
      const catTextColour = pickTextColour(catColour);
      return React.createElement(
        "div",
        { className: "power-tagger-config-bar" },
        React.createElement(
          "span",
          { className: "power-tagger-config-bar-label" },
          "Configuration:"
        ),
        React.createElement(
          "span",
          {
            className: "power-tagger-config-bar-name",
            style: {
              backgroundColor: catColour,
              color: catTextColour,
              borderColor: catColour,
            },
          },
          name || "None"
        ),
        // v0.13.0: with configurations available, offer to switch.
        // With none defined, the walkthrough is in plain mode by
        // necessity, so point the user at the Power Tagger rules
        // editor to create configurations instead of a dead button.
        configTags.length > 0
          ? React.createElement(
              "button",
              {
                type: "button",
                className: "btn btn-sm btn-primary power-tagger-config-bar-change",
                onClick: onChangeConfig,
                title: "Change configuration",
              },
              "Change Configuration"
            )
          : React.createElement(
              "button",
              {
                type: "button",
                className: "btn btn-sm btn-primary power-tagger-config-bar-change",
                onClick: () => {
                  // Close this modal, then open the rules editor — its
                  // host listens for OPEN_SETTINGS_EVENT.
                  onClose();
                  setTimeout(() => {
                    window.dispatchEvent(
                      new CustomEvent(OPEN_SETTINGS_EVENT)
                    );
                  }, 0);
                },
                title: "Open the Power Tagger rules editor to create configurations",
              },
              "Set up configurations"
            )
      );
    }

    // v0.11.5: confirm-discard prompt (portalled to body, same chrome
    // as the TC-jump prompt). Rendered as a sibling in both the picker
    // and walkthrough phase returns. Since it's a portal, where in the
    // tree it sits doesn't matter — it renders to body either way.
    const confirmCloseModal = confirmCloseOpen
      ? ReactDOM.createPortal(
          React.createElement(
            "div",
            { className: "power-tagger-save-confirm-overlay" },
            React.createElement(
              "div",
              { className: "power-tagger-save-confirm-modal" },
              React.createElement(
                "div",
                { className: "power-tagger-save-confirm-header" },
                React.createElement(
                  "div",
                  { className: "power-tagger-save-confirm-icon" },
                  "\u26A0\uFE0E"
                ),
                React.createElement(
                  "div",
                  null,
                  React.createElement(
                    "div",
                    { className: "power-tagger-save-confirm-title" },
                    "Discard staged changes?"
                  ),
                  React.createElement(
                    "div",
                    { className: "power-tagger-save-confirm-sub" },
                    "You have unsaved tag changes. If you close now, " +
                      "they will be lost."
                  )
                )
              ),
              React.createElement(
                "div",
                { className: "power-tagger-save-confirm-footer" },
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-secondary",
                    onClick: () => {
                      setConfirmCloseOpen(false);
                      setPendingDirtyAction(null);
                    },
                  },
                  "Keep editing"
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-danger",
                    onClick: () => {
                      setConfirmCloseOpen(false);
                      // v0.11.10: if a queue-jump action is pending,
                      // run it instead of onClose. Used by the queue
                      // sidebar so the user can discard stagings and
                      // jump rather than discarding and closing.
                      const action = pendingDirtyAction;
                      setPendingDirtyAction(null);
                      if (typeof action === "function") {
                        action();
                      } else {
                        onClose();
                      }
                    },
                  },
                  "Discard & close"
                )
              )
            )
          ),
          document.body
        )
      : null;

    // v0.11.5: confirm-save prompt. Driven by the global plugin setting
    // `askForSaveConfirm` (Settings → Plugins → Power Tagger). Fires
    // ONLY when there are no warnings (the warnings-review modal
    // already serves as a confirm step when there ARE warnings).
    const confirmSaveModal = confirmSaveOpen
      ? ReactDOM.createPortal(
          React.createElement(
            "div",
            { className: "power-tagger-save-confirm-overlay" },
            React.createElement(
              "div",
              { className: "power-tagger-save-confirm-modal power-tagger-save-confirm-modal-resolved" },
              React.createElement(
                "div",
                { className: "power-tagger-save-confirm-header" },
                React.createElement(
                  "div",
                  { className: "power-tagger-save-confirm-icon" },
                  "\u2713"
                ),
                React.createElement(
                  "div",
                  null,
                  React.createElement(
                    "div",
                    { className: "power-tagger-save-confirm-title" },
                    "Save changes?"
                  ),
                  React.createElement(
                    "div",
                    { className: "power-tagger-save-confirm-sub" },
                    `${selectedTags.length} tag${selectedTags.length === 1 ? "" : "s"} will be saved to the scene.`
                  )
                )
              ),
              React.createElement(
                "div",
                { className: "power-tagger-save-confirm-footer" },
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-secondary",
                    onClick: () => setConfirmSaveOpen(false),
                    disabled: saving,
                  },
                  "Cancel"
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-success",
                    onClick: () => {
                      setConfirmSaveOpen(false);
                      onSave();
                    },
                    disabled: saving,
                  },
                  saving ? "Saving..." : "Save"
                )
              )
            )
          ),
          document.body
        )
      : null;

    // ===== Picker phase render =====
    if (phase === "picker") {
      // Compute a static preview of what the SELECTED config will
      // include in the walkthrough: cat count + tag count + first
      // few cat names. Uses the base ruleset (no conditional logic
      // since nothing's staged yet). Returns null when no config
      // is selected, so the description box can hide.
      function previewForConfig(cfgId) {
        if (!cfgId) return null;
        const rulesets = (powerTaggerConfig && powerTaggerConfig.rulesets) || {};
        const r = rulesets[String(cfgId)] || {};
        const catRules = r.categories || {};
        const allCats = tagCategoriesConfig.taxonomy.categories || [];
        const visibleCats = allCats.filter((c) => {
          if (c.name === "Configuration") return false;
          // Tag Categories' per-category `hidden` flag is intentionally
          // not consulted here -- see the orderedCats memo upstairs for
          // the full reasoning. The only hide rule that matters is the
          // active configuration's own `cr.hidden`.
          const cr = catRules[c.name];
          if (cr && cr.hidden) return false;
          return true;
        });
        const visibleCatNames = new Set(visibleCats.map((c) => c.name));
        const hiddenTagsByCat = {};
        for (const c of visibleCats) {
          const cr = catRules[c.name] || {};
          hiddenTagsByCat[c.name] = new Set(
            (cr.hiddenTags || []).map(String)
          );
        }
        const assignments = tagCategoriesConfig.assignments || {};
        let tagCount = 0;
        for (const tid of Object.keys(assignments)) {
          const a = assignments[tid];
          if (!a) continue;
          // v0.14.0: config-backing tags aren't taggable, don't count them.
          if (configLinkedTagIds.has(String(tid))) continue;
          if (!visibleCatNames.has(a.category)) continue;
          if (hiddenTagsByCat[a.category].has(String(tid))) continue;
          tagCount++;
        }
        return {
          catCount: visibleCats.length,
          tagCount,
          catNames: visibleCats.map((c) => ({
            name: c.name,
            colour: c.colour || "#5a6e85",
          })),
        };
      }
      const selectedTag = configTags.find(
        (t) => String(t.id) === String(pendingConfigTagId)
      );
      const preview = previewForConfig(pendingConfigTagId);
      // v0.14.0: the picker no longer has a single colour \u2014 each
      // configuration carries its own. `selectedColour` drives the
      // hero accent stripe and the description box; it tracks the
      // currently-selected config (neutral default while nothing is
      // selected). Each card tints itself from its own `colour`.
      const selectedColour = selectedTag
        ? selectedTag.colour || DEFAULT_CONFIG_COLOUR
        : DEFAULT_CONFIG_COLOUR;

      // Per-config description + auto-select rule status. Description
      // displays as a single short line above the stats. Auto-select
      // status is one of:
      //   - hasNoRule: this config has no rule; no badge shown
      //   - matches: rule matched this scene; subtle green note
      //   - doesNotMatch: rule defined but didn't match; amber warning
      // The warning appears whether the user OR auto-pick picked
      // this config \u2014 it tells the user the rule disagrees.
      const selectedConfigRuleset = pendingConfigTagId
        ? ((powerTaggerConfig.rulesets || {})[String(pendingConfigTagId)] || {})
        : {};
      const selectedDescription = selectedConfigRuleset.description || "";
      const selectedDescriptionTruncated =
        selectedDescription.length > MAX_DESCRIPTION_CHARS
          ? selectedDescription.slice(0, MAX_DESCRIPTION_CHARS).trimEnd() + "\u2026"
          : selectedDescription;
      const allTagsById = {};
      for (const t of allTags) allTagsById[String(t.id)] = t;
      // Evaluate against liveScene (not raw scene) so the matched-rule
      // indicator reflects current performer / metadata edits when the
      // user comes back to the picker after editing in the tagging UI.
      const selectedRuleEval = evaluateAutoSelectRule(
        selectedConfigRuleset.autoSelectRule,
        liveScene,
        allTagsById,
        tagCategoriesConfig.assignments || {}
      );

      const __pickerEl = React.createElement(
        "div",
        { className: "power-tagger-grid power-tagger-grid-picker" },

        // Left: player (kept so user can preview the scene while choosing)
        React.createElement(
          "div",
          { className: "power-tagger-player" },
          playerEl
        ),

        // Right: picker UI \u2014 hero + grid + description box,
        // vertically centred so the gateway feels intentional and
        // not jammed to the top.
        React.createElement(
          "div",
          { className: "power-tagger-right power-tagger-picker" },
          React.createElement(
            "div",
            { className: "power-tagger-picker-inner" },
            // Hero: accent stripe + big title + descriptive subtitle.
            React.createElement(
              "div",
              {
                className: "power-tagger-picker-hero",
                style: { borderColor: selectedColour },
              },
              React.createElement(
                "h2",
                { className: "power-tagger-picker-hero-title" },
                "Configure walkthrough"
              ),
              React.createElement(
                "p",
                { className: "power-tagger-picker-hero-sub" },
                "Pick the option that best describes this scene. ",
                "Each configuration determines which categories and ",
                "tags appear during tagging."
              )
            ),

            React.createElement(
              "div",
              { className: "power-tagger-picker-scroll" },
              configTags.length === 0
                ? React.createElement(
                    "div",
                    { className: "power-tagger-picker-empty" },
                    "No configurations yet. Open the Power Tagger ",
                    React.createElement("strong", null, "rules editor"),
                    " from the plugin settings to create one."
                  )
                : React.createElement(
                    "div",
                    { className: "power-tagger-picker-grid" },
                    configTags.map((t) => {
                    const selected =
                      String(pendingConfigTagId) === String(t.id);
                    const anySelected = pendingConfigTagId != null;
                    // v0.14.0: each card tints from its own config colour.
                    const cardColour = t.colour || DEFAULT_CONFIG_COLOUR;
                    const cardTextColour = pickTextColour(cardColour);
                    return React.createElement(
                      "div",
                      {
                        key: t.id,
                        className:
                          "power-tagger-card power-tagger-picker-card" +
                          (selected
                            ? " power-tagger-picker-card-selected"
                            : "") +
                          (anySelected && !selected
                            ? " power-tagger-picker-card-dimmed"
                            : ""),
                        style: selected
                          ? {
                              outlineColor: cardColour,
                              boxShadow:
                                `0 0 0 3px ${cardColour}, 0 10px 30px rgba(0,0,0,0.55)`,
                            }
                          : null,
                        role: "button",
                        tabIndex: 0,
                        onClick: () => {
                          // v0.11.5: clicking the already-selected
                          // card unselects it. v0.11.6: also flip
                          // userTouchedConfigRef so the auto-suggest
                          // effect doesn't immediately re-fire and
                          // re-select the same card.
                          userTouchedConfigRef.current = true;
                          if (selected) {
                            setPendingConfigTagId(null);
                            setAutoSuggested(false);
                          } else {
                            setPendingConfigTagId(t.id);
                            setAutoSuggested(false);
                          }
                        },
                        onKeyDown: (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            userTouchedConfigRef.current = true;
                            if (selected) {
                              setPendingConfigTagId(null);
                              setAutoSuggested(false);
                            } else {
                              setPendingConfigTagId(t.id);
                              setAutoSuggested(false);
                            }
                          }
                        },
                        title: t.name,
                      },
                      React.createElement("div", {
                        className: "power-tagger-card-img",
                        // v0.14.0: config objects carry no image; pull
                        // the thumbnail from the linked tag (if any).
                        style: (() => {
                          const lt = t.tagId
                            ? allTagsById[String(t.tagId)]
                            : null;
                          return lt && lt.image_path
                            ? { backgroundImage: `url("${lt.image_path}")` }
                            : null;
                        })(),
                      }),
                      // v0.11.5: green check badge on selected card,
                      // matching the staged-tag visual in the walkthrough
                      // so "selected" reads consistently across phases.
                      selected
                        ? React.createElement(
                            "div",
                            { className: "power-tagger-card-check" },
                            "\u2713"
                          )
                        : null,
                      React.createElement(
                        "div",
                        {
                          className:
                            "power-tagger-card-name power-tagger-picker-card-name",
                          style: selected
                            ? {
                                backgroundColor: cardColour,
                                color: cardTextColour,
                              }
                            : null,
                        },
                        t.name
                      )
                    );
                  })
                )
            ),

            // Description box: appears once a config is selected.
            // Helps the user understand what they're committing to
            // before clicking Confirm. Empty hint while no selection.
            selectedTag && preview
              ? React.createElement(
                  "div",
                  {
                    className: "power-tagger-picker-preview",
                    style: { borderColor: selectedColour },
                  },
                  React.createElement(
                    "div",
                    { className: "power-tagger-picker-preview-header" },
                    React.createElement("span", {
                      className: "power-tagger-picker-preview-swatch",
                      style: { backgroundColor: selectedColour },
                    }),
                    React.createElement(
                      "div",
                      { className: "power-tagger-picker-preview-headtext" },
                      React.createElement(
                        "div",
                        { className: "power-tagger-picker-preview-eyebrow" },
                        autoSuggested ? "Auto-suggested" : "Selected"
                      ),
                      React.createElement(
                        "div",
                        { className: "power-tagger-picker-preview-title" },
                        selectedTag.name
                      )
                    ),
                    React.createElement(
                      "div",
                      { className: "power-tagger-picker-preview-stats" },
                      React.createElement(
                        "div",
                        { className: "power-tagger-picker-preview-stat" },
                        React.createElement(
                          "div",
                          {
                            className: "power-tagger-picker-preview-stat-num",
                          },
                          String(preview.catCount)
                        ),
                        React.createElement(
                          "div",
                          {
                            className: "power-tagger-picker-preview-stat-label",
                          },
                          preview.catCount === 1 ? "category" : "categories"
                        )
                      ),
                      React.createElement(
                        "div",
                        { className: "power-tagger-picker-preview-stat" },
                        React.createElement(
                          "div",
                          {
                            className: "power-tagger-picker-preview-stat-num",
                          },
                          String(preview.tagCount)
                        ),
                        React.createElement(
                          "div",
                          {
                            className: "power-tagger-picker-preview-stat-label",
                          },
                          preview.tagCount === 1 ? "tag" : "tags"
                        )
                      )
                    )
                  ),
                  // Description text (if author set one). Truncated to
                  // MAX_DESCRIPTION_CHARS so the box stays compact.
                  selectedDescriptionTruncated
                    ? React.createElement(
                        "div",
                        { className: "power-tagger-picker-preview-desc" },
                        selectedDescriptionTruncated
                      )
                    : null,
                  // Auto-select rule mismatch warning. Only renders
                  // when the config defines a rule AND it doesn't
                  // match this scene. Tells the user (politely) that
                  // they might be on the wrong config.
                  selectedRuleEval.evaluated && !selectedRuleEval.matches
                    ? React.createElement(
                        "div",
                        { className: "power-tagger-picker-preview-mismatch" },
                        React.createElement(
                          "span",
                          { className: "power-tagger-picker-preview-mismatch-icon" },
                          "\u26A0\uFE0E"
                        ),
                        React.createElement(
                          "div",
                          { className: "power-tagger-picker-preview-mismatch-text" },
                          React.createElement(
                            "strong",
                            null,
                            "This config doesn't match the scene."
                          ),
                          " ",
                          (() => {
                            const failed = summariseAutoSelectFailure(selectedRuleEval);
                            return failed
                              ? `Failing: ${failed}.`
                              : "You can still proceed if this is intentional.";
                          })()
                        )
                      )
                    : null,
                  // Positive trace: when this config WAS auto-suggested
                  // AND its rule matches, show which rule passed +
                  // its passing conditions. Green check icon, mirrors
                  // the mismatch layout. Only renders when the user
                  // got here via auto-pick (not a manual selection
                  // that happens to match) \u2014 manual matches don't
                  // need this affirmation; it's specifically the "why
                  // did you pick this" answer.
                  autoSuggested && selectedRuleEval.evaluated && selectedRuleEval.matches
                    ? (() => {
                        const matchedIdx = selectedRuleEval.rules.findIndex((r) => r.matches);
                        const matched = matchedIdx >= 0 ? selectedRuleEval.rules[matchedIdx] : null;
                        if (!matched) return null;
                        // Build short pass phrases for each passing
                        // condition. Drop empty results (some types
                        // don't have a useful brief form).
                        const tagByIdLocal = {};
                        for (const t of allTags) tagByIdLocal[String(t.id)] = t;
                        const phrases = matched.conditionResults
                          .filter((r) => r.pass)
                          .map((r) => briefPassPhrase(r.cond, scene, tagByIdLocal))
                          .filter((s) => s && s.length > 0);
                        // Cap at 2 visible + "+N more" suffix. Keeps
                        // the preview height bounded; we never let
                        // condition lists push the box off-screen.
                        const CAP = 2;
                        const shown = phrases.slice(0, CAP);
                        const extra = phrases.length - shown.length;
                        const passingText = shown.length > 0
                          ? `${shown.join(", ")}${extra > 0 ? `, +${extra} more` : ""}`
                          : "";
                        const totalRules = selectedRuleEval.rules.length;
                        const ruleLabel = totalRules > 1
                          ? `Matched Rule ${matchedIdx + 1}`
                          : "Matched rule";
                        return React.createElement(
                          "div",
                          { className: "power-tagger-picker-preview-match" },
                          React.createElement(
                            "span",
                            { className: "power-tagger-picker-preview-match-icon" },
                            "\u2713"
                          ),
                          React.createElement(
                            "div",
                            { className: "power-tagger-picker-preview-match-text" },
                            React.createElement("strong", null, `${ruleLabel}.`),
                            passingText ? " " + passingText + "." : ""
                          )
                        );
                      })()
                    : null,
                  React.createElement(
                    "div",
                    { className: "power-tagger-picker-preview-hint" },
                    "Click ",
                    React.createElement("strong", null, "Confirm"),
                    " to begin the walkthrough with these settings."
                  )
                )
              : React.createElement(
                  "div",
                  { className: "power-tagger-picker-preview-placeholder" },
                  "Choose a configuration above to see what it includes."
                )
          )
        ),

        // Bottom: Confirm / Cancel — replaces TagSelect during picker phase.
        React.createElement(
          "div",
          { className: "power-tagger-bottom" },
          React.createElement(
            "div",
            { className: "power-tagger-footer" },
            React.createElement(
              "button",
              {
                type: "button",
                className: "btn btn-secondary",
                onClick: requestClose,
              },
              "Cancel"
            ),
            // v0.13.0: plain-mode opt-out. Only shown when configs
            // exist (with zero configs the screen is auto-skipped).
            configTags.length > 0
              ? React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-secondary",
                    onClick: enterPlainMode,
                    title: "Skip configuration and tag this scene plainly",
                  },
                  "Tag without a configuration"
                )
              : null,
            // v0.14.0: btn-secondary so its enabled state matches the
            // Cancel / "Tag without a configuration" buttons. It still
            // stays disabled until a configuration is selected.
            React.createElement(
              "button",
              {
                type: "button",
                className: "btn btn-secondary",
                onClick: onConfirmConfig,
                disabled: !pendingConfigTagId,
              },
              "Confirm"
            )
          )
        )
      );
      return React.createElement(
        React.Fragment,
        null,
        __pickerEl,
        confirmCloseModal,
        confirmSaveModal
      );
    }

    // ===== Walkthrough phase render =====
    const __walkthroughEl = React.createElement(
      "div",
      { className: "power-tagger-grid" },

      // Left: player on top, info+performers below.
      React.createElement(
        "div",
        { className: "power-tagger-left" },
        React.createElement(
          "div",
          { className: "power-tagger-player" },
          playerEl
        ),
        // Below-player area: 2 sub-columns. Left = scene info, right
        // = performer row. The performer popout still positions over
        // the player area as before.
        // v0.12.0: when the metadata editor is open the grid collapses
        // to a single column and renders the full-width editor panel
        // in place of the scene-info card + performer row.
        React.createElement(
          "div",
          {
            className:
              "power-tagger-below-player" +
              (metaEditOpen ? " power-tagger-below-player-editing" : ""),
          },
          metaEditOpen
            ? renderSceneMetaEditor()
            : React.createElement(
                React.Fragment,
                null,
                renderSceneInfo(),
                renderPerformerRow()
              )
        )
      ),

      // Right: walkthrough (carousel + config bar above strip)
      React.createElement(
        "div",
        { className: "power-tagger-right" },
        renderHeaderStrip(),
        React.createElement(CategorySections, {
          taxonomy: tagCategoriesConfig.taxonomy,
          assignments: tagCategoriesConfig.assignments,
          allTags: allTags,
          selectedIds: selectedTags.map((t) => t.id),
          onToggleTag: toggleTag,
          onRemoveTags: removeTags,
          onAddTags: addTags,
          rulesets: powerTaggerConfig.rulesets,
          configTagId: configTagId,
          // v0.14.0: tag ids that back configurations — excluded from
          // the taggable tag list so config tags never appear as
          // normal tags.
          configTagIds: configLinkedTagIds,
          // v0.11.3: evaluate rules against the LIVE performer list,
          // not the scene.performers snapshot from the initial fetch.
          // When the user adds/removes performers via the inline
          // editor, rules re-evaluate immediately and any
          // performer-gender-conditioned constraints/cascades update.
          performerCounts: performerCountsFromScene({ performers: scenePerformers }),
          // v0.11.4: liveScene = original scene + currently staged
          // tags + live performers. Used by the auto-select rule
          // re-evaluator (drift detection) so config-mismatch
          // warnings stay accurate as the user edits.
          // v0.12.0: also overlay committed metadata edits from
          // sceneMeta so studio/date-conditioned rules re-evaluate the
          // moment a metadata save lands. sceneMeta.groups is flattened
          // to {id,name,scene_index}; the evaluator only reads studio
          // and date today, but we overlay the full set for forward
          // compatibility.
          liveScene: scene
            ? {
                ...scene,
                performers: scenePerformers,
                tags: selectedTags,
                ...(sceneMeta
                  ? {
                      title: sceneMeta.title,
                      date: sceneMeta.date,
                      code: sceneMeta.code,
                      details: sceneMeta.details,
                      rating100: sceneMeta.rating100,
                      urls: sceneMeta.urls,
                      studio: sceneMeta.studio,
                      groups: sceneMeta.groups,
                    }
                  : {}),
              }
            : null,
          saveHandlerRef: saveHandlerRef,
          onConfirmedSave: requestSave,
        })
      ),

      // Bottom: TagSelect + footer
      React.createElement(
        "div",
        { className: "power-tagger-bottom" },
        React.createElement(
          "div",
          { className: "power-tagger-tag-select-wrap" },
          // Stash TagSelect inlined here directly. Previously this was
          // wrapped in a `BottomTagSelect` function declared inside
          // PowerTaggerBody — but a function declared inside a render
          // body creates a NEW component type on every parent render,
          // which causes React to unmount + remount the entire
          // TagSelect on every state change (e.g. every staged tag).
          // The remount drops focus to <body> mid-flow and forces the
          // user to re-click the input. Inlining keeps the component
          // type stable (Components.TagSelect is the same reference
          // across renders) so React reconciles in-place.
          (() => {
            const TS = Components.TagSelect;
            if (!TS) {
              return React.createElement(
                "div",
                { style: { color: "#888" } },
                "(TagSelect component not yet loaded \u2014 try reopening)"
              );
            }
            return React.createElement(TS, {
              values: displaySelectedTags,
              isMulti: true,
              // v0.11.2: route changes through the cascade resolver so
              // that typing/selecting tags in this picker fires
              // cascades the same way clicking cards does. Previously
              // `setSelectedTags(items)` bypassed cascade resolution
              // because toggleTag (the card-click path) was the only
              // caller of resolveCascades. The bottom picker can add
              // *or* remove tags in a single onSelect; we diff
              // before/after, ask the resolver for newly-fired
              // cascades, and append their addTags to the new list.
              // Removals (or no change) yield no cascades, so the
              // resolver call is a no-op in those cases.
              onSelect: (items) => {
                const next = items || [];
                const stagedBefore = new Set(selectedTags.map((x) => String(x.id)));
                const stagedAfter = new Set(next.map((x) => String(x.id)));
                const cascadeIds = resolveCascades(
                  powerTaggerConfig.rulesets,
                  configTagId,
                  stagedBefore,
                  stagedAfter
                );
                if (cascadeIds.length === 0) {
                  setSelectedTags(next);
                  return;
                }
                const existingIds = new Set(next.map((x) => String(x.id)));
                const additions = [];
                for (const cid of cascadeIds) {
                  if (existingIds.has(String(cid))) continue;
                  const ct = allTags.find((x) => String(x.id) === String(cid));
                  if (ct) additions.push(ct);
                }
                setSelectedTags([...next, ...additions]);
              },
              menuPortalTarget: document.body,
              // Force "top": this picker lives at the bottom of the
              // modal by design, so the menu always wants to open
              // upward. "auto" is environment-dependent — its
              // available-space calc reads the nearest scroll
              // container, and that container varies across Stash
              // versions / themes / viewport heights, sometimes
              // deciding to open downward off the visible page.
              menuPlacement: "top",
              // Lift the menu portal far above any modal layer. Stash's
              // own modals use ~1050; our overlay sits there too.
              // 100000 leaves plenty of room.
              styles: { menuPortal: (base) => ({ ...base, zIndex: 100000 }) },
              placeholder: "Search tags or add manually...",
            });
          })()
        ),
        React.createElement(
          "div",
          { className: "power-tagger-footer" },
          React.createElement(
            "span",
            { className: "power-tagger-count" },
            `${selectedTags.length} tag${selectedTags.length === 1 ? "" : "s"}`
          ),
          // v0.11.5: per-scene "Organise on save" checkbox. Initial
          // state mirrors the global default setting (Settings →
          // Plugins → Power Tagger → "Organise on save (default)").
          // When checked, Save marks the scene as organised in the
          // same mutation that writes the tags. Unchecked = leave
          // organised flag alone (we don't unmark scenes).
          React.createElement(
            "label",
            { className: "power-tagger-organise-toggle" },
            React.createElement("input", {
              type: "checkbox",
              checked: organiseOnSave,
              onChange: (e) => setOrganiseOnSave(e.target.checked),
              disabled: saving,
            }),
            React.createElement("span", null, "Organise on save")
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: "btn btn-primary",
              onClick: () => {
                // Defer to CategorySections's registered handler, which
                // either opens the save-confirm modal or invokes onSave
                // directly depending on whether there are warnings. If
                // the ref hasn't been set yet (initial render before
                // CategorySections' effect runs) fall back to onSave so
                // the button still works.
                if (saveHandlerRef.current) {
                  saveHandlerRef.current();
                } else {
                  onSave();
                }
              },
              // v0.14.0: disabled until something actually changes —
              // matches the rules editor's Save. No point saving a
              // scene whose tags are identical to what's on disk.
              disabled: saving || !isDirty,
              title: isDirty
                ? "Save tag changes"
                : "No changes to save",
            },
            saving ? "Saving..." : "Save"
          )
        )
      )
    );
    return React.createElement(
      React.Fragment,
      null,
      __walkthroughEl,
      confirmCloseModal,
      confirmSaveModal
    );
  }

  // -------------------------------------------------------------------------
  // ModalHost — singleton React component that listens for the open event.
  // -------------------------------------------------------------------------
  let activeHostCount = 0;

  function ModalHost() {
    const [open, setOpen] = React.useState(false);
    const [sceneId, setSceneId] = React.useState(null);
    const [isActive, setIsActive] = React.useState(false);
    // v0.11.5: shared ref the body fills with its requestClose gate.
    // PortalModal calls into this ref when its header Close button is
    // clicked so that path also routes through the dirty-check confirm.
    const requestCloseRef = React.useRef(null);
    // v0.11.6: where the open event came from. "toolbar" means the
    // scenes-list toolbar button — on Save, navigate back to the
    // exact URL the user launched from so their filter state
    // survives. Anything else keeps the existing behaviour of
    // navigating to the scene page.
    const [launchSource, setLaunchSource] = React.useState(null);
    const [returnUrl, setReturnUrl] = React.useState(null);

    // v0.11.9: queue state for multi-scene toolbar launches.
    //   queueIds  — array of all scene IDs to process, in DOM order.
    //               Length 1 = single-scene mode (existing behaviour).
    //               Length > 1 = queue mode.
    //   queueIdx  — current position in the queue (0-based).
    //   pendingQ  — non-null = "Tag N scenes?" confirm is showing,
    //               pending user Confirm/Cancel before we open for real.
    const [queueIds, setQueueIds] = React.useState([]);
    const [queueIdx, setQueueIdx] = React.useState(0);
    const [pendingQ, setPendingQ] = React.useState(null);
    // v0.11.10: sidebar UI state. Only meaningful in queue mode
    // (queueIds.length > 1). Always starts closed each queue (per
    // session-preference decision — see chat thread).
    const [sidebarOpen, setSidebarOpen] = React.useState(false);
    // v0.11.10: metadata cache for queue rows. Populated eagerly when
    // a queue starts; keyed by scene ID. Each entry is the slim scene
    // payload from fetchQueueMetadata.
    const [queueMeta, setQueueMeta] = React.useState({});
    // v0.11.10: scenes that have been successfully saved during this
    // queue, marked green with a tick in the sidebar.
    const [completedIds, setCompletedIds] = React.useState(() => new Set());
    // v0.11.10: ref the body fills with its "request jump" gate, used
    // when the user clicks another row in the sidebar. The gate runs
    // the same dirty-check confirm as Cancel; on confirm it calls
    // performJump(idx) (which the host sets via the ref). If the body
    // hasn't registered the gate yet, fall back to jumping directly.
    const requestJumpRef = React.useRef(null);

    React.useEffect(() => {
      if (activeHostCount > 0) return undefined;
      activeHostCount += 1;
      setIsActive(true);

      function onOpen(e) {
        const id = e?.detail?.sceneId;
        const ids = Array.isArray(e?.detail?.sceneIds) && e.detail.sceneIds.length
          ? e.detail.sceneIds.map(String)
          : (id ? [String(id)] : []);
        const src = e?.detail?.source || null;
        const ret = e?.detail?.returnUrl || null;
        if (!ids.length) return;

        // v0.11.9: queue (>1 scenes) launched from the toolbar gets a
        // confirm prompt first. Single-scene launches (from anywhere,
        // including the edit page) skip the prompt — identical to
        // existing behaviour.
        if (ids.length > 1 && src === "toolbar") {
          setPendingQ({ ids, src, ret });
          return;
        }

        // Single-scene path — UNCHANGED from v0.11.8.
        setQueueIds(ids);
        setQueueIdx(0);
        setSceneId(ids[0]);
        setLaunchSource(src);
        setReturnUrl(ret);
        setOpen(true);
      }
      window.addEventListener(OPEN_EVENT_NAME, onOpen);
      return () => {
        window.removeEventListener(OPEN_EVENT_NAME, onOpen);
        activeHostCount -= 1;
      };
    }, []);

    if (!isActive) return null;

    function close() {
      setOpen(false);
      setSceneId(null);
      setLaunchSource(null);
      setReturnUrl(null);
      setQueueIds([]);
      setQueueIdx(0);
      // v0.11.10: reset queue sidebar state so the next queue starts fresh.
      setSidebarOpen(false);
      setQueueMeta({});
      setCompletedIds(new Set());
      requestJumpRef.current = null;
    }

    function onCloseRequest() {
      const gate = requestCloseRef.current;
      if (typeof gate === "function") gate();
      else close();
    }

    // v0.11.9: called by PowerTaggerBody after a successful save in
    // toolbar mode. If there's a next scene in the queue, advance to
    // it (the prop change triggers the body's [sceneId] effect to
    // re-fetch the new scene and re-seed selectedTags). If we just
    // saved the LAST scene in the queue, close the modal — equivalent
    // to the v0.11.8 single-scene behaviour.
    function onSaveSuccess() {
      // v0.11.10: mark this scene as completed for the sidebar's tick.
      const justSavedId = queueIds[queueIdx];
      if (justSavedId) {
        setCompletedIds((prev) => {
          if (prev.has(String(justSavedId))) return prev;
          const next = new Set(prev);
          next.add(String(justSavedId));
          return next;
        });
      }
      const next = queueIdx + 1;
      if (next < queueIds.length) {
        setQueueIdx(next);
        setSceneId(queueIds[next]);
      } else {
        close();
      }
    }

    // v0.11.9: queue confirm prompt. Same chrome as the rest of the
    // app's small dialogs; rendered as a separate PortalModal-ish
    // overlay above everything else when active. If the user
    // confirms, we transition to opening the modal for the first
    // scene in the queue.
    function startQueue() {
      if (!pendingQ) return;
      const { ids, src, ret } = pendingQ;
      setQueueIds(ids);
      setQueueIdx(0);
      setSceneId(ids[0]);
      setLaunchSource(src);
      setReturnUrl(ret);
      setPendingQ(null);
      setOpen(true);
      // v0.11.10: eager fetch of all queued scenes' display metadata
      // so the sidebar renders instantly when the user opens it. Each
      // findScene call is independent; failures of individual scenes
      // leave them out of the map (the row will show a fallback).
      fetchQueueMetadata(ids).then((meta) => setQueueMeta(meta)).catch(() => {});
    }
    function cancelQueue() {
      setPendingQ(null);
    }

    // v0.11.10: jump to a specific scene in the queue. Bypasses the
    // dirty-check — called by requestJump after the gate has cleared.
    function performJump(targetIdx) {
      if (targetIdx < 0 || targetIdx >= queueIds.length) return;
      if (targetIdx === queueIdx) return; // no-op
      setQueueIdx(targetIdx);
      setSceneId(queueIds[targetIdx]);
    }

    // v0.11.10: request a jump from the sidebar. Routes through the
    // body's dirty-check gate (same one Cancel uses) so the user gets
    // the "Discard staged changes?" prompt if they have unsaved work.
    // If the body hasn't registered a gate yet (race during first
    // render), jump directly.
    function requestJump(targetIdx) {
      const gate = requestJumpRef.current;
      if (typeof gate === "function") {
        gate(() => performJump(targetIdx));
      } else {
        performJump(targetIdx);
      }
    }

    const queueConfirmOverlay = pendingQ
      ? ReactDOM.createPortal(
          React.createElement(
            "div",
            { className: "power-tagger-overlay", style: { zIndex: 100002 } },
            React.createElement(
              "div",
              {
                className: "power-tagger-modal",
                style: {
                  width: "auto",
                  maxWidth: 480,
                  height: "auto",
                  minHeight: 0,
                },
              },
              React.createElement(
                "div",
                { className: "power-tagger-header" },
                React.createElement("h5", null, "Tag multiple scenes"),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-sm btn-secondary",
                    onClick: cancelQueue,
                  },
                  "Close"
                )
              ),
              React.createElement(
                "div",
                {
                  className: "power-tagger-body",
                  style: { padding: 20, gap: 16 },
                },
                React.createElement(
                  "p",
                  { style: { margin: 0, color: "#ddd" } },
                  `Tag ${pendingQ.ids.length} scenes as a queue?`
                ),
                React.createElement(
                  "p",
                  { style: { margin: 0, color: "#999", fontSize: 13 } },
                  "Save advances to the next scene. Cancel exits the whole queue (already-saved scenes stay saved)."
                ),
                React.createElement(
                  "div",
                  {
                    style: {
                      display: "flex",
                      gap: 8,
                      justifyContent: "flex-end",
                      marginTop: 8,
                    },
                  },
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      className: "btn btn-secondary",
                      onClick: cancelQueue,
                    },
                    "Cancel"
                  ),
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      className: "btn btn-primary",
                      onClick: startQueue,
                    },
                    `Start (${pendingQ.ids.length} scenes)`
                  )
                )
              )
            )
          ),
          document.body
        )
      : null;

    // v0.11.9: title shows queue progress in queue mode; plain in
    // single-scene mode (identical to v0.11.8).
    const modalTitle =
      queueIds.length > 1
        ? `Power Tagger — Scene ${queueIdx + 1} of ${queueIds.length}`
        : "Power Tagger";

    // v0.11.10: build the queue sidebar (rail + optional expanded
    // panel) ONLY in queue mode. Single-scene launches render no
    // sidebar at all (leftAdornment stays null), and PortalModal
    // renders exactly as it did pre-sidebar.
    function buildQueueItem(id, idx) {
      const meta = queueMeta[String(id)];
      const isCurrent = idx === queueIdx;
      const isDone = completedIds.has(String(id));
      const title =
        (meta && meta.title) ||
        (meta && meta.files && meta.files[0] && meta.files[0].basename) ||
        `Scene ${id}`;
      const studioName = meta && meta.studio && meta.studio.name;
      const performers = (meta && meta.performers) || [];
      const performerNames = performers.map((p) => p.name).join(", ");
      const date = meta && meta.date;
      const screenshot = meta && meta.paths && meta.paths.screenshot;
      const itemClass =
        "power-tagger-queue-item" +
        (isCurrent ? " power-tagger-queue-item--current" : "") +
        (isDone ? " power-tagger-queue-item--done" : "");
      return React.createElement(
        "div",
        {
          key: String(id),
          className: itemClass,
          onClick: () => {
            if (isCurrent) return;
            requestJump(idx);
          },
          title: title,
        },
        React.createElement(
          "div",
          { className: "power-tagger-queue-item-index" },
          idx + 1 + "."
        ),
        React.createElement(
          "div",
          { className: "power-tagger-queue-item-thumb" },
          screenshot
            ? React.createElement("img", {
                src: screenshot,
                alt: "",
                loading: "lazy",
              })
            : null,
          isDone
            ? React.createElement(
                "div",
                {
                  className: "power-tagger-queue-item-thumb-tick",
                  "aria-label": "Completed",
                },
                "✓"
              )
            : null
        ),
        React.createElement(
          "div",
          { className: "power-tagger-queue-item-meta" },
          React.createElement(
            "div",
            { className: "power-tagger-queue-item-title" },
            title
          ),
          studioName
            ? React.createElement(
                "div",
                { className: "power-tagger-queue-item-studio" },
                studioName
              )
            : null,
          performerNames
            ? React.createElement(
                "div",
                { className: "power-tagger-queue-item-performers" },
                performerNames
              )
            : null,
          date
            ? React.createElement(
                "div",
                { className: "power-tagger-queue-item-date" },
                date
              )
            : null
        )
      );
    }

    const inQueueMode = queueIds.length > 1;
    const queueSidebar = inQueueMode
      ? (() => {
          const railArrow = React.createElement(
            "svg",
            {
              className: "power-tagger-queue-rail-arrow",
              width: 12,
              height: 12,
              viewBox: "0 0 16 16",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: 2,
              strokeLinecap: "round",
              strokeLinejoin: "round",
              "aria-hidden": "true",
            },
            // Right chevron when closed (expand), left when open (collapse).
            React.createElement("polyline", {
              points: sidebarOpen ? "10 4 6 8 10 12" : "6 4 10 8 6 12",
            })
          );
          const rail = React.createElement(
            "div",
            {
              className: "power-tagger-queue-rail",
              onClick: () => setSidebarOpen((v) => !v),
              role: "button",
              "aria-label": sidebarOpen ? "Hide queue" : "Show queue",
              title: sidebarOpen ? "Hide queue" : "Show queue",
            },
            railArrow
          );
          const sidebar = sidebarOpen
            ? React.createElement(
                "div",
                { className: "power-tagger-queue-sidebar" },
                React.createElement(
                  "div",
                  { className: "power-tagger-queue-sidebar-header" },
                  `Queue (${queueIdx + 1} / ${queueIds.length})`
                ),
                React.createElement(
                  "div",
                  { className: "power-tagger-queue-sidebar-list" },
                  queueIds.map((id, idx) => buildQueueItem(id, idx))
                )
              )
            : null;
          // The order matters: rail on the outer left (always visible),
          // sidebar to its right when open, modal to the right of both.
          // CSS keeps the rail's left radii so the shell's leftmost
          // corners are rounded; sidebar has no radius (it abuts rail
          // on the left and modal on the right).
          return React.createElement(
            React.Fragment,
            null,
            rail,
            sidebar
          );
        })()
      : null;

    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        PortalModal,
        {
          show: open,
          onHide: close,
          onCloseRequest: onCloseRequest,
          title: modalTitle,
          leftAdornment: queueSidebar,
        },
        sceneId
          ? React.createElement(PowerTaggerBody, {
              // v0.11.9: key forces a full unmount/remount when sceneId
              // changes during queue advancement. Without a key, React
              // tries to diff the existing component, and stale internal
              // refs (savedTagIdsRef, saveHandlerRef, etc.) can linger
              // between scenes. With key=sceneId, each queue step is a
              // clean component instance — same UX as opening the modal
              // fresh per scene, just without closing/reopening the
              // portal. The Apollo cache update from the previous
              // scene's save still applies to its now-unmounted card.
              key: sceneId,
              sceneId,
              onClose: close,
              requestCloseRef: requestCloseRef,
              launchSource: launchSource,
              returnUrl: returnUrl,
              // v0.11.9: queue advancement callback. PowerTaggerBody
              // calls this after a successful toolbar-path save. Host
              // either advances to the next queued scene or closes.
              // For non-queue (single-scene) launches, queueIds.length
              // is 1, so onSaveSuccess just closes — identical to
              // v0.11.8 behaviour.
              onSaveSuccess: onSaveSuccess,
              // v0.11.10: body registers a "request jump" gate function
              // onto this ref. The host calls it when the user clicks
              // another row in the queue sidebar so that the same
              // dirty-check confirm Cancel uses also fires for jumps.
              requestJumpRef: requestJumpRef,
            })
          : null
      ),
      queueConfirmOverlay
    );
  }

  // -------------------------------------------------------------------------
  // RulesEditorBody — the visual editor mounted in the settings modal.
  //
  // Layout:
  //   Left rail (~220px): list of Configuration tags (rulesets) + add hint.
  //   Right pane: scrollable tree of categories → subs → tags, each with
  //              a checkbox. Per-category maxSelections input on the right.
  //
  // State is local until Save: we work on a `draft` copy of rulesets,
  // commit via savePowerTaggerConfig only when the user hits Save.
  // -------------------------------------------------------------------------
  function RulesEditorBody({ onClose, requestCloseRef }) {
    const [allTags, setAllTags] = React.useState([]);
    const [tcConfig, setTcConfig] = React.useState({
      assignments: {},
      taxonomy: { categories: [] },
    });
    const [originalRulesets, setOriginalRulesets] = React.useState({});
    const [draft, setDraft] = React.useState({});
    const [activeConfigId, setActiveConfigId] = React.useState(null);
    // v0.14.0: Power-Tagger-owned configurations list, each entry
    // { id, name, tagId|null }. Populated by ensureConfigurations on
    // mount; mutated by the Add/Edit/Remove rail actions.
    const [configurations, setConfigurations] = React.useState([]);
    // v0.14.0: config-editor modal state. null = closed. Otherwise
    // { mode: "add"|"edit"|"remove", configId?, name, tagMode, linkTag }.
    const [configEditor, setConfigEditor] = React.useState(null);
    const [loading, setLoading] = React.useState(true);
    const [loadError, setLoadError] = React.useState(null);
    const [saving, setSaving] = React.useState(false);
    // v0.11.5: confirm-discard prompt for close-with-unsaved-changes.
    const [confirmCloseOpen, setConfirmCloseOpen] = React.useState(false);
    // v0.11.5: import flow. `pendingImport` holds the parsed backup
    // payload waiting on user confirm. Parse / validation errors are
    // surfaced via alert() — they're rare and infrequent enough that
    // a dedicated inline error UI isn't worth it.
    const [pendingImport, setPendingImport] = React.useState(null);
    const fileInputRef = React.useRef(null);
    // Track which sub-headers are collapsed (UI-only, not persisted)
    const [collapsedKeys, setCollapsedKeys] = React.useState(new Set());
    // Whether the cascades panel is collapsed. Collapsed by default (most
    // rulesets won't define cascades; users opt in by expanding).
    const [cascadesCollapsed, setCascadesCollapsed] = React.useState(true);
    // Same for the conditionals panel.
    const [conditionalsCollapsed, setConditionalsCollapsed] = React.useState(true);
    // Per-row collapse state — set of row indices (as strings) that are
    // collapsed. UI-only; not persisted. Lets the user fold up finished
    // rules in long lists. Indices are strings so we don't trip up Sets'
    // identity rules across renders.
    const [collapsedCascadeRows, setCollapsedCascadeRows] = React.useState(new Set());
    const [collapsedConditionalRows, setCollapsedConditionalRows] = React.useState(new Set());
    // Performer rules panel collapse + per-row collapse (v0.11.0).
    const [performerRulesCollapsed, setPerformerRulesCollapsed] = React.useState(true);
    const [collapsedPerformerRuleRows, setCollapsedPerformerRuleRows] = React.useState(new Set());
    // v0.11.4: Auto-select rule panel collapse. Default collapsed
    // because most users won't have one configured yet.
    const [autoSelectCollapsed, setAutoSelectCollapsed] = React.useState(true);
    // Per-category collapse state in the editor's category tree.
    // Same UI-only Set pattern.
    const [collapsedCatRows, setCollapsedCatRows] = React.useState(new Set());

    // v0.11.2: Jump-to-Tag-Categories confirm modal. When the user
    // clicks "Edit Tag Categories" with unsaved changes, we show a
    // 3-button dialog: Save & continue / Discard & continue / Stay.
    // false when no prompt is showing.
    const [tcJumpPromptOpen, setTcJumpPromptOpen] = React.useState(false);

    // Persisted UI state — loaded once on mount, saved (debounced) on
    // every change. Distinct from rulesets: it doesn't go through the
    // Save/Cancel flow, just persists immediately so collapse state
    // survives reload + cross-browser via plugin config.
    // Shape:
    //   { perConfig: { [configId]: {
    //       cascadesCollapsed, conditionalsCollapsed,
    //       collapsedCascadeRows, collapsedConditionalRows, collapsedCatRows
    //   } } }
    const [uiState, setUiState] = React.useState({});
    // Default config id (picker pre-selects this when set). Saved
    // immediately on toggle, like uiState — not via Save/Cancel.
    const [defaultConfigId, setDefaultConfigIdState] = React.useState(null);
    // First-paint flag — set to true once we've hydrated state from the
    // loaded uiState. Prevents the debounced save from firing during
    // initial seed (which would otherwise write empty defaults over
    // whatever's already on disk).
    const uiStateHydratedRef = React.useRef(false);

    React.useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          const [tags, tc, ours] = await Promise.all([
            fetchAllTags(),
            readTagCategoriesConfig(),
            readPowerTaggerConfig(),
          ]);
          if (cancelled) return;
          setAllTags(tags);
          setTcConfig(tc);
          const rulesets = ours.rulesets || {};
          setOriginalRulesets(rulesets);
          setDraft(JSON.parse(JSON.stringify(rulesets)));
          setUiState(ours.uiState || {});
          setDefaultConfigIdState(ours.defaultConfigId || null);
          // v0.14.0: resolve the configurations list (one-time legacy
          // migration runs here on first use).
          const configs = await ensureConfigurations(ours, tc, tags);
          if (!cancelled) setConfigurations(configs);
        } catch (err) {
          if (!cancelled) setLoadError(err.message || String(err));
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      return () => { cancelled = true; };
    }, []);

    // v0.14.0: configs ARE the configurations list — each entry a
    // config object { id, name, tagId|null }, not a tag.
    const configTags = React.useMemo(() => {
      return Array.isArray(configurations) ? configurations : [];
    }, [configurations]);

    // v0.14.0: tag ids that back configurations — excluded from the
    // category tree so a config tag can't be managed as a normal tag.
    const configLinkedTagIds = React.useMemo(() => {
      const s = new Set();
      for (const c of configTags) {
        if (c && c.tagId) s.add(String(c.tagId));
      }
      return s;
    }, [configTags]);

    // Default to first config on first render
    React.useEffect(() => {
      if (!activeConfigId && configTags.length > 0) {
        setActiveConfigId(String(configTags[0].id));
      }
    }, [configTags, activeConfigId]);

    // Seed the per-row collapse states from persisted uiState whenever
    // the active config changes. Each config gets its own collapse view.
    // The hydration flag flips on first run so subsequent state changes
    // are written back to disk.
    React.useEffect(() => {
      if (!activeConfigId) return;
      const perConfig = (uiState && uiState.perConfig) || {};
      const my = perConfig[String(activeConfigId)] || {};
      setCascadesCollapsed(my.cascadesCollapsed !== false);          // default collapsed
      setConditionalsCollapsed(my.conditionalsCollapsed !== false);  // default collapsed
      setPerformerRulesCollapsed(my.performerRulesCollapsed !== false); // default collapsed
      setAutoSelectCollapsed(my.autoSelectCollapsed !== false);       // default collapsed
      setCollapsedCascadeRows(new Set((my.collapsedCascadeRows || []).map(String)));
      setCollapsedConditionalRows(new Set((my.collapsedConditionalRows || []).map(String)));
      setCollapsedPerformerRuleRows(new Set((my.collapsedPerformerRuleRows || []).map(String)));
      setCollapsedCatRows(new Set(my.collapsedCatRows || []));
      // Mark hydration done after a tick so any state changes queued by
      // the setters above don't trigger the save-on-change effect.
      uiStateHydratedRef.current = false;
      const t = setTimeout(() => { uiStateHydratedRef.current = true; }, 0);
      return () => clearTimeout(t);
    }, [activeConfigId, uiState]);

    // Persist collapse state — debounced, scoped per config. Fires
    // whenever any of the watched states change AND we're past initial
    // hydration. savePowerTaggerUiState merges only the uiState key, so
    // it won't disturb rulesets-in-flight (the user might have an
    // unsaved draft of rule edits — that's left alone).
    React.useEffect(() => {
      if (!uiStateHydratedRef.current) return;
      if (!activeConfigId) return;
      const t = setTimeout(() => {
        // Read current uiState through setter to avoid stale closure.
        setUiState((prev) => {
          const next = { ...(prev || {}) };
          const perConfig = { ...(next.perConfig || {}) };
          perConfig[String(activeConfigId)] = {
            cascadesCollapsed,
            conditionalsCollapsed,
            performerRulesCollapsed,
            autoSelectCollapsed,
            collapsedCascadeRows: [...collapsedCascadeRows],
            collapsedConditionalRows: [...collapsedConditionalRows],
            collapsedPerformerRuleRows: [...collapsedPerformerRuleRows],
            collapsedCatRows: [...collapsedCatRows],
          };
          next.perConfig = perConfig;
          // Fire-and-forget save. Errors are logged; collapse state isn't
          // critical enough to surface to the user.
          savePowerTaggerUiState(next).catch((err) => {
            console.error("[power-tagger] failed to persist uiState:", err);
          });
          return next;
        });
      }, 400);
      return () => clearTimeout(t);
    }, [
      activeConfigId,
      cascadesCollapsed,
      conditionalsCollapsed,
      performerRulesCollapsed,
      autoSelectCollapsed,
      collapsedCascadeRows,
      collapsedConditionalRows,
      collapsedPerformerRuleRows,
      collapsedCatRows,
    ]);

    // Categories shown in the rules editor tree. All taxonomy
    // categories appear (so the user can configure rules for any of
    // them) except the legacy "Configuration" category, which is
    // omitted because it's no longer a real tagging category in
    // Power Tagger's model. Tag Categories' per-category `hidden`
    // flag is intentionally not consulted -- the rules editor needs
    // to surface every category so the user can choose to hide or
    // show it from the walkthrough independently.
    const cats = React.useMemo(() => {
      return (tcConfig.taxonomy.categories || []).filter(
        (c) => c.name !== "Configuration"
      );
    }, [tcConfig]);

    // Map: catName -> subName -> [tagObj] (only tags actually present).
    const grouped = React.useMemo(() => {
      const byId = {};
      for (const t of allTags) byId[String(t.id)] = t;
      const out = {};
      const assignments = tcConfig.assignments || {};
      for (const tid of Object.keys(assignments)) {
        const a = assignments[tid];
        if (!a || !a.category) continue;
        if (a.category === "Configuration") continue;
        // v0.14.0: config-backing tags aren't ordinary tags.
        if (configLinkedTagIds.has(String(tid))) continue;
        const tag = byId[String(tid)];
        if (!tag) continue;
        if (!out[a.category]) out[a.category] = {};
        const sub = a.subcategory || "";
        if (!out[a.category][sub]) out[a.category][sub] = [];
        out[a.category][sub].push(tag);
      }
      return out;
    }, [allTags, tcConfig, configLinkedTagIds]);

    // Tag lookup by id. Used by the cascade row renderers below to
    // resolve stored tag-id strings back into full tag objects for the
    // TagSelect `values` prop. MUST live here (above the loading /
    // loadError / no-configs early returns) — putting it lower will
    // change the hook call count between renders and trip React error
    // #310 ("Rendered more hooks than during the previous render").
    const tagsById = React.useMemo(() => {
      const out = {};
      for (const t of allTags) out[String(t.id)] = t;
      return out;
    }, [allTags]);

    // Helpers operating on `draft`.
    function getCatRule(catName) {
      if (!activeConfigId) return { hidden: false, maxSelections: 0, hiddenTags: [], subMaxSelections: {} };
      const rs = draft[activeConfigId] || {};
      const cats = rs.categories || {};
      const c = cats[catName] || {};
      return {
        hidden: !!c.hidden,
        maxSelections: toInt(c.maxSelections, 0),
        hiddenTags: c.hiddenTags || [],
        subMaxSelections: c.subMaxSelections || {},
      };
    }

    function patchCatRule(catName, patch) {
      if (!activeConfigId) return;
      setDraft((prev) => {
        const next = { ...prev };
        const rs = { ...(next[activeConfigId] || {}) };
        const cats = { ...(rs.categories || {}) };
        const cur = cats[catName] || {};
        cats[catName] = { ...cur, ...patch };
        rs.categories = cats;
        next[activeConfigId] = rs;
        return next;
      });
    }

    // Sub-level max selections. Falls back to cat-level max in the
    // walkthrough (see resolveSubMax); 0 / unset means "use cat max".
    function getSubMax(catName, subName) {
      const r = getCatRule(catName);
      const v = toInt((r.subMaxSelections || {})[subName], 0);
      return v >= 0 ? v : 0;
    }

    function setSubMax(catName, subName, value) {
      const r = getCatRule(catName);
      const next = { ...(r.subMaxSelections || {}) };
      // Remove the key if value is 0 / falsy, so we don't bloat the
      // stored config with zeros — the resolver treats absence as "use
      // cat-level max" anyway.
      if (!Number.isFinite(value) || value <= 0) {
        delete next[subName];
      } else {
        next[subName] = value;
      }
      patchCatRule(catName, { subMaxSelections: next });
    }

    // autoStage is a ruleset-level (not per-category) flag. When true, the
    // chosen config tag is automatically added to staged tags when the
    // user hits Confirm in the picker — useful for configs that ARE
    // meaningful as tags (Solo Female, Solo Male, Compilation).
    function getAutoStage() {
      if (!activeConfigId) return false;
      return !!(draft[activeConfigId] && draft[activeConfigId].autoStage);
    }

    function setAutoStage(val) {
      if (!activeConfigId) return;
      setDraft((prev) => {
        const next = { ...prev };
        const rs = { ...(next[activeConfigId] || {}) };
        rs.autoStage = !!val;
        next[activeConfigId] = rs;
        return next;
      });
    }

    // Toggle the default Configuration. Saves immediately (preference,
    // not editable data — doesn't pass through Save/Cancel). Clicking
    // the star on the current default unsets it.
    function toggleDefaultConfig(tagId) {
      const id = String(tagId);
      const newVal = String(defaultConfigId) === id ? null : id;
      setDefaultConfigIdState(newVal);
      savePowerTaggerDefaultConfig(newVal).catch((err) => {
        console.error("[power-tagger] failed to save default config:", err);
      });
    }

    // v0.14.0: configuration management (Add / Edit / Remove). These
    // open the config-editor modal; commitConfigEditor() applies the
    // change. Structural changes persist immediately (like the default
    // star), separate from the rule-editing Save/Cancel flow.
    function openAddConfig() {
      setConfigEditor({
        mode: "add",
        name: "",
        tagMode: "none",       // "none" | "create" | "link"
        linkTag: null,
        // New configs default to blue; the user can recolour before
        // or after creating.
        colour: DEFAULT_CONFIG_COLOUR,
      });
    }
    function openEditConfig(cfg) {
      setConfigEditor({
        mode: "edit",
        configId: String(cfg.id),
        name: cfg.name || "",
        // "keep" the current tag when there is one; otherwise default
        // to "none". The user can switch to create / link / unlink.
        tagMode: cfg.tagId ? "keep" : "none",
        linkTag: null,
        colour: cfg.colour || DEFAULT_CONFIG_COLOUR,
      });
    }
    function openRemoveConfig(cfg) {
      setConfigEditor({
        mode: "remove",
        configId: String(cfg.id),
        name: cfg.name || "",
      });
    }
    function closeConfigEditor() {
      setConfigEditor(null);
    }

    async function commitConfigEditor() {
      const ed = configEditor;
      if (!ed) return;
      const name = String(ed.name || "").trim();
      if (ed.mode !== "remove" && !name) {
        alert("Please enter a name for the configuration.");
        return;
      }
      setSaving(true);
      try {
        if (ed.mode === "add") {
          let tagId = null;
          if (ed.tagMode === "create") {
            const tag = await createTag(name);
            if (!tag || !tag.id) throw new Error("Tag creation failed.");
            tagId = String(tag.id);
            // Keep allTags in sync so the linked tag resolves for
            // thumbnails / pickers without a reload.
            setAllTags((prev) => [...prev, { id: tagId, name: tag.name }]);
          } else if (ed.tagMode === "link") {
            if (!ed.linkTag) {
              throw new Error("Pick a tag to link, or choose 'No tag'.");
            }
            tagId = String(ed.linkTag.id);
          }
          const id = genConfigId();
          const next = [
            ...configurations,
            { id, name, tagId, colour: ed.colour || DEFAULT_CONFIG_COLOUR },
          ];
          await savePowerTaggerConfigurations(next);
          setConfigurations(next);
          setActiveConfigId(id);
        } else if (ed.mode === "edit") {
          const cfg = configurations.find(
            (c) => String(c.id) === String(ed.configId)
          );
          if (!cfg) throw new Error("Configuration no longer exists.");
          // Resolve the new linked tag from the chosen tag mode.
          // renameTargetId is the tag (if any) that should be renamed
          // to match the configuration's new name.
          let newTagId = cfg.tagId || null;
          let renameTargetId = null;
          if (ed.tagMode === "keep") {
            newTagId = cfg.tagId || null;
            if (cfg.tagId) renameTargetId = String(cfg.tagId);
          } else if (ed.tagMode === "none") {
            newTagId = null;
          } else if (ed.tagMode === "create") {
            const tag = await createTag(name);
            if (!tag || !tag.id) throw new Error("Tag creation failed.");
            newTagId = String(tag.id);
            setAllTags((prev) => [...prev, { id: newTagId, name: tag.name }]);
          } else if (ed.tagMode === "link") {
            if (!ed.linkTag) {
              throw new Error("Pick a tag to link, or choose 'No tag'.");
            }
            // Linking an existing tag does NOT rename it — same as Add.
            newTagId = String(ed.linkTag.id);
          }
          const next = configurations.map((c) =>
            String(c.id) === String(ed.configId)
              ? {
                  ...c,
                  name,
                  tagId: newTagId,
                  colour: ed.colour || DEFAULT_CONFIG_COLOUR,
                }
              : c
          );
          await savePowerTaggerConfigurations(next);
          setConfigurations(next);
          if (renameTargetId) {
            await renameTag(renameTargetId, name);
            setAllTags((prev) =>
              prev.map((t) =>
                String(t.id) === String(renameTargetId) ? { ...t, name } : t
              )
            );
          }
        } else if (ed.mode === "remove") {
          const id = String(ed.configId);
          const nextConfigs = configurations.filter(
            (c) => String(c.id) !== id
          );
          // Drop the ruleset from the on-disk set. We persist
          // originalRulesets (the saved state) minus this key, NOT the
          // draft — unsaved edits to OTHER configs stay unsaved.
          const nextOriginal = { ...originalRulesets };
          delete nextOriginal[id];
          const clearDefault = String(defaultConfigId) === id;
          const patch = {
            configurations: nextConfigs,
            rulesets: nextOriginal,
          };
          if (clearDefault) patch.defaultConfigId = null;
          await savePowerTaggerPartial(patch);
          setConfigurations(nextConfigs);
          setOriginalRulesets(nextOriginal);
          setDraft((prev) => {
            const n = { ...prev };
            delete n[id];
            return n;
          });
          if (clearDefault) setDefaultConfigIdState(null);
          if (String(activeConfigId) === id) {
            setActiveConfigId(
              nextConfigs.length ? String(nextConfigs[0].id) : null
            );
          }
          // The Stash tag (if any) is intentionally left alone — the
          // user may still want it as a normal tag.
        }
        setConfigEditor(null);
      } catch (err) {
        alert("Failed: " + (err.message || String(err)));
      } finally {
        setSaving(false);
      }
    }

    // Generic "toggle membership of a string key in a Set state". Used
    // by all the UI-only collapse states (cascade rows, conditional rows,
    // category rows).
    function toggleInSet(setter, key) {
      setter((prev) => {
        const next = new Set(prev);
        const k = String(key);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        return next;
      });
    }

    // Cascade rule helpers. Stored as a list on the ruleset:
    //   rulesets[<id>].cascades = [{ trigger: tagId, addTags: [tagId,...] }]
    // The list is what we render and edit in place; an empty trigger
    // (user hasn't picked one yet) is allowed but won't actually fire at
    // runtime.
    function getCascades() {
      if (!activeConfigId) return [];
      return (draft[activeConfigId] && draft[activeConfigId].cascades) || [];
    }

    function setCascades(arr) {
      if (!activeConfigId) return;
      setDraft((prev) => {
        const next = { ...prev };
        const rs = { ...(next[activeConfigId] || {}) };
        rs.cascades = arr;
        next[activeConfigId] = rs;
        return next;
      });
    }

    function addCascade() {
      // New cascade defaults to the new multi-trigger shape (empty
      // triggers array, "any" combinator). Migration in
      // normaliseRulesetsNumerics handles legacy single-trigger entries
      // on load.
      setCascades([...getCascades(), { triggers: [], triggerMode: "any", addTags: [] }]);
    }

    function removeCascade(idx) {
      const cur = getCascades();
      setCascades(cur.filter((_, i) => i !== idx));
    }

    function updateCascade(idx, patch) {
      const cur = getCascades();
      const next = cur.map((c, i) => (i === idx ? { ...c, ...patch } : c));
      setCascades(next);
    }

    // Conditional rule helpers. Each conditional lives on the ruleset:
    //   rulesets[<id>].conditionals = [{ triggers, triggerMode, direction, targets }]
    // where targets is { cats: [], subs: [{cat,sub}], tags: [] }.
    function getConditionals() {
      if (!activeConfigId) return [];
      return (draft[activeConfigId] && draft[activeConfigId].conditionals) || [];
    }

    // v0.11.4: Description + auto-select rule helpers.
    //
    // Description is a single short string (~150 chars displayed).
    // Auto-select rule is one rule per config:
    //   { mode: "all"|"any", conditions: [...] }
    // null means "no rule" (no auto-pick, no mismatch warning).
    function getDescription() {
      if (!activeConfigId) return "";
      return (draft[activeConfigId] && draft[activeConfigId].description) || "";
    }
    function setDescription(text) {
      if (!activeConfigId) return;
      setDraft((prev) => {
        const next = { ...prev };
        const rs = { ...(next[activeConfigId] || {}) };
        rs.description = text;
        next[activeConfigId] = rs;
        return next;
      });
    }
    // v0.11.4: Auto-select rule helpers. The rule is a list of "match
    // patterns" combined with top-level OR. Each pattern has its own
    // ALL/ANY mode + condition list.
    //
    // Stored shape:
    //   rs.autoSelectRule = { rules: [{ mode, conditions: [...] }, ...] }
    //
    // null/missing = no rule defined. An empty rules array (no
    // patterns at all) also reads as "no rule".
    function getAutoSelectRule() {
      if (!activeConfigId) return null;
      return (draft[activeConfigId] && draft[activeConfigId].autoSelectRule) || null;
    }
    function getAutoSelectRules() {
      // Returns the inner rules array (always an array). Handles both
      // new shape (autoSelectRule.rules) and the legacy single-rule
      // shape (autoSelectRule.conditions) by wrapping the latter.
      const ar = getAutoSelectRule();
      if (!ar || typeof ar !== "object") return [];
      if (Array.isArray(ar.rules)) return ar.rules;
      if (Array.isArray(ar.conditions)) {
        return [{ mode: ar.mode || "all", conditions: ar.conditions }];
      }
      return [];
    }
    function setAutoSelectRule(rule) {
      if (!activeConfigId) return;
      setDraft((prev) => {
        const next = { ...prev };
        const rs = { ...(next[activeConfigId] || {}) };
        if (rule == null) {
          delete rs.autoSelectRule;
        } else {
          rs.autoSelectRule = rule;
        }
        next[activeConfigId] = rs;
        return next;
      });
    }
    function setAutoSelectRules(rules) {
      setAutoSelectRule({ rules });
    }
    function addAutoSelectRule() {
      // Add a fresh empty rule pattern (ALL mode, no conditions). On
      // first call from "+ Add auto-select rule" this also creates
      // the autoSelectRule wrapper.
      const cur = getAutoSelectRules();
      setAutoSelectRules([...cur, { mode: "all", conditions: [] }]);
      setAutoSelectCollapsed(false);
    }
    function removeAutoSelectAll() {
      // Wipe the entire autoSelectRule entry.
      setAutoSelectRule(null);
    }
    function removeAutoSelectRuleAt(ruleIdx) {
      const cur = getAutoSelectRules();
      const next = cur.filter((_, i) => i !== ruleIdx);
      if (next.length === 0) {
        // Last rule removed \u2014 drop the autoSelectRule entirely.
        setAutoSelectRule(null);
      } else {
        setAutoSelectRules(next);
      }
    }
    function setAutoSelectRuleMode(ruleIdx, mode) {
      const cur = getAutoSelectRules();
      const next = cur.map((r, i) =>
        i === ruleIdx ? { ...r, mode: mode === "any" ? "any" : "all" } : r
      );
      setAutoSelectRules(next);
    }
    function addAutoSelectCondition(ruleIdx, type) {
      const cur = getAutoSelectRules();
      const defaults = autoSelectConditionDefaults(type);
      const next = cur.map((r, i) =>
        i === ruleIdx
          ? { ...r, conditions: [...(r.conditions || []), defaults] }
          : r
      );
      setAutoSelectRules(next);
    }
    function updateAutoSelectCondition(ruleIdx, condIdx, patch) {
      const cur = getAutoSelectRules();
      const next = cur.map((r, i) => {
        if (i !== ruleIdx) return r;
        const conds = (r.conditions || []).slice();
        conds[condIdx] = { ...conds[condIdx], ...patch };
        return { ...r, conditions: conds };
      });
      setAutoSelectRules(next);
    }
    function removeAutoSelectCondition(ruleIdx, condIdx) {
      const cur = getAutoSelectRules();
      const next = cur.map((r, i) => {
        if (i !== ruleIdx) return r;
        return {
          ...r,
          conditions: (r.conditions || []).filter((_, j) => j !== condIdx),
        };
      });
      setAutoSelectRules(next);
    }

    function setConditionals(arr) {
      if (!activeConfigId) return;
      setDraft((prev) => {
        const next = { ...prev };
        const rs = { ...(next[activeConfigId] || {}) };
        rs.conditionals = arr;
        next[activeConfigId] = rs;
        return next;
      });
    }

    function addConditional() {
      setConditionals([
        ...getConditionals(),
        {
          triggers: [],
          notTags: [],
          triggerMode: "any",
          direction: "reveal",
          targets: { cats: [], subs: [], tags: [] },
        },
      ]);
    }

    function removeConditional(idx) {
      const cur = getConditionals();
      setConditionals(cur.filter((_, i) => i !== idx));
    }

    function updateConditional(idx, patch) {
      const cur = getConditionals();
      const next = cur.map((c, i) => (i === idx ? { ...c, ...patch } : c));
      setConditionals(next);
    }

    function updateConditionalTargets(idx, targetPatch) {
      const cur = getConditionals();
      const next = cur.map((c, i) => {
        if (i !== idx) return c;
        return {
          ...c,
          targets: { ...(c.targets || {}), ...targetPatch },
        };
      });
      setConditionals(next);
    }

    // Performer-triggers helpers (v0.11.0 rev). Sister to the gender-block
    // helpers used by performer rules — same shape, but stored under
    // `performerTriggers` on a conditional.
    function togglePerformerTriggers(idx, enabled) {
      const cur = getConditionals();
      const next = cur.map((c, i) => {
        if (i !== idx) return c;
        if (enabled) {
          return {
            ...c,
            performerTriggers: c.performerTriggers || {
              mode: "all",
              male: null,
              female: null,
              other: null,
            },
          };
        }
        return { ...c, performerTriggers: null };
      });
      setConditionals(next);
    }

    function updateConditionalPerformerBlock(idx, patch) {
      const cur = getConditionals();
      const next = cur.map((c, i) => {
        if (i !== idx) return c;
        return {
          ...c,
          performerTriggers: { ...(c.performerTriggers || {}), ...patch },
        };
      });
      setConditionals(next);
    }

    function updateConditionalPerformerGenderBlock(idx, key, blockPatch) {
      const cur = getConditionals();
      const next = cur.map((c, i) => {
        if (i !== idx) return c;
        const pt = { ...(c.performerTriggers || { mode: "all" }) };
        if (blockPatch === null) {
          pt[key] = null;
        } else {
          pt[key] = { ...(pt[key] || { mode: "min", value: 0 }), ...blockPatch };
        }
        return { ...c, performerTriggers: pt };
      });
      setConditionals(next);
    }

    // -----------------------------------------------------------------
    // Performer rules CRUD (v0.11.0)
    // Mirrors the cascade / conditional helpers above. All writes go
    // through setDraft so the existing save-on-Save button picks them up
    // along with everything else.
    //
    // Note: reads run migratePerformerRules first to upgrade any
    // legacy-shape (scope/limit) rules to the new shape (groups[]). The
    // migration happens in memory only — disk isn't touched until the
    // user hits Save, at which point setDraft has captured the migrated
    // rules and they go out with the rest of the changes.
    // -----------------------------------------------------------------
    function getPerformerRules() {
      if (!activeConfigId) return [];
      const raw = (draft[activeConfigId] && draft[activeConfigId].performerRules) || [];
      return migratePerformerRules(raw, tcConfig.assignments || {});
    }

    function setPerformerRules(arr) {
      if (!activeConfigId) return;
      setDraft((prev) => {
        const next = { ...prev };
        const rs = { ...(next[activeConfigId] || {}) };
        rs.performerRules = arr;
        next[activeConfigId] = rs;
        return next;
      });
    }

    function newPerformerRuleId() {
      // RFC4122-ish ID. crypto.randomUUID is available in modern browsers
      // but we keep a fallback in case Stash runs somewhere older.
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
      return "pr-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    }

    function newGroupId() {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
      return "g-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    }

    function addPerformerRule() {
      setPerformerRules([
        ...getPerformerRules(),
        {
          id: newPerformerRuleId(),
          name: "",
          tagTriggers: [],
          notTags: [],
          performerTriggers: null,
          triggerMode: "all",
          direction: "at-most",
          groups: [
            {
              id: newGroupId(),
              label: "",
              tags: [],
              cap: {
                base: 0, perMale: 0, perFemale: 0, perOther: 0, hardCap: null,
              },
            },
          ],
        },
      ]);
    }

    function removePerformerRule(idx) {
      const cur = getPerformerRules();
      setPerformerRules(cur.filter((_, i) => i !== idx));
    }

    function updatePerformerRule(idx, patch) {
      const cur = getPerformerRules();
      const next = cur.map((r, i) => (i === idx ? { ...r, ...patch } : r));
      setPerformerRules(next);
    }

    // Trigger helpers — operate on performerTriggers (the new home of
    // what was previously called `condition`).
    function togglePerfTriggers(idx, enabled) {
      const cur = getPerformerRules();
      const next = cur.map((r, i) => {
        if (i !== idx) return r;
        if (enabled) {
          return {
            ...r,
            performerTriggers: r.performerTriggers || {
              mode: "all", male: null, female: null, other: null,
            },
          };
        }
        return { ...r, performerTriggers: null };
      });
      setPerformerRules(next);
    }

    function updatePerformerRuleCondition(idx, condPatch) {
      const cur = getPerformerRules();
      const next = cur.map((r, i) => {
        if (i !== idx) return r;
        return {
          ...r,
          performerTriggers: { ...(r.performerTriggers || { mode: "all" }), ...condPatch },
        };
      });
      setPerformerRules(next);
    }

    function updatePerformerRuleGenderBlock(idx, key, blockPatch) {
      const cur = getPerformerRules();
      const next = cur.map((r, i) => {
        if (i !== idx) return r;
        const pt = { ...(r.performerTriggers || { mode: "all" }) };
        if (blockPatch === null) {
          pt[key] = null;
        } else {
          pt[key] = { ...(pt[key] || { mode: "min", value: 0 }), ...blockPatch };
        }
        return { ...r, performerTriggers: pt };
      });
      setPerformerRules(next);
    }

    function movePerformerRule(idx, delta) {
      const cur = getPerformerRules();
      const targetIdx = idx + delta;
      if (targetIdx < 0 || targetIdx >= cur.length) return;
      const next = cur.slice();
      const [item] = next.splice(idx, 1);
      next.splice(targetIdx, 0, item);
      setPerformerRules(next);
    }

    // Group-level CRUD.
    function addPerformerRuleGroup(ruleIdx) {
      const cur = getPerformerRules();
      const next = cur.map((r, i) => {
        if (i !== ruleIdx) return r;
        const groups = Array.isArray(r.groups) ? r.groups.slice() : [];
        groups.push({
          id: newGroupId(),
          label: "",
          tags: [],
          cap: { base: 0, perMale: 0, perFemale: 0, perOther: 0, hardCap: null },
        });
        return { ...r, groups };
      });
      setPerformerRules(next);
    }

    function removePerformerRuleGroup(ruleIdx, groupIdx) {
      const cur = getPerformerRules();
      const next = cur.map((r, i) => {
        if (i !== ruleIdx) return r;
        const groups = (r.groups || []).filter((_, gi) => gi !== groupIdx);
        return { ...r, groups };
      });
      setPerformerRules(next);
    }

    function updatePerformerRuleGroup(ruleIdx, groupIdx, patch) {
      const cur = getPerformerRules();
      const next = cur.map((r, i) => {
        if (i !== ruleIdx) return r;
        const groups = (r.groups || []).map((g, gi) =>
          gi === groupIdx ? { ...g, ...patch } : g
        );
        return { ...r, groups };
      });
      setPerformerRules(next);
    }

    function updatePerformerRuleGroupCap(ruleIdx, groupIdx, capPatch) {
      const cur = getPerformerRules();
      const next = cur.map((r, i) => {
        if (i !== ruleIdx) return r;
        const groups = (r.groups || []).map((g, gi) => {
          if (gi !== groupIdx) return g;
          return { ...g, cap: { ...(g.cap || {}), ...capPatch } };
        });
        return { ...r, groups };
      });
      setPerformerRules(next);
    }

    // Tag-level visibility.
    function isTagHidden(catName, tagId) {
      const r = getCatRule(catName);
      return r.hiddenTags.map(String).includes(String(tagId));
    }

    function setTagsHidden(catName, tagIds, hidden) {
      const r = getCatRule(catName);
      const set = new Set(r.hiddenTags.map(String));
      for (const tid of tagIds) {
        if (hidden) set.add(String(tid));
        else set.delete(String(tid));
      }
      patchCatRule(catName, { hiddenTags: [...set] });
    }

    // Category-level checkbox.
    // CHECKED: hidden=false AND no tags hidden.
    // UNCHECKED: hidden=true (entire category skipped).
    // INDETERMINATE: hidden=false but some tags hidden.
    function getCatCheckState(catName) {
      const r = getCatRule(catName);
      if (r.hidden) return "unchecked";
      if (r.hiddenTags.length === 0) return "checked";
      return "indeterminate";
    }

    function toggleCategory(catName) {
      const state = getCatCheckState(catName);
      if (state === "checked") {
        // → uncheck everything: set hidden=true AND hiddenTags = all tags
        const allTagIdsInCat = [];
        const cat = (tcConfig.taxonomy.categories || []).find((c) => c.name === catName);
        const subsHere = cat?.subcategories?.length ? cat.subcategories : [""];
        for (const sub of subsHere) {
          const list = (grouped[catName] || {})[sub] || [];
          for (const t of list) allTagIdsInCat.push(String(t.id));
        }
        patchCatRule(catName, { hidden: true, hiddenTags: allTagIdsInCat });
      } else {
        // unchecked or indeterminate → check all: clear hidden + hiddenTags
        patchCatRule(catName, { hidden: false, hiddenTags: [] });
      }
    }

    // Sub-level checkbox (doesn't touch category.hidden).
    function getSubCheckState(catName, subName) {
      const list = (grouped[catName] || {})[subName] || [];
      if (list.length === 0) return "checked";
      const hiddenInSub = list.filter((t) => isTagHidden(catName, t.id)).length;
      if (hiddenInSub === 0) return "checked";
      if (hiddenInSub === list.length) return "unchecked";
      return "indeterminate";
    }

    function toggleSub(catName, subName) {
      const state = getSubCheckState(catName, subName);
      const list = (grouped[catName] || {})[subName] || [];
      const ids = list.map((t) => t.id);
      if (state === "checked") {
        setTagsHidden(catName, ids, true);
      } else {
        setTagsHidden(catName, ids, false);
      }
    }

    // Sub collapse state — UI-only.
    function subKey(catName, subName) { return `${catName}::${subName}`; }
    function isSubCollapsed(catName, subName) {
      return collapsedKeys.has(subKey(catName, subName));
    }
    function toggleSubCollapsed(catName, subName) {
      const key = subKey(catName, subName);
      setCollapsedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    }

    // Tri-state checkbox renderer.
    function checkbox(state, onClick, opts) {
      return React.createElement("input", {
        type: "checkbox",
        className: "power-tagger-rules-checkbox",
        checked: state === "checked",
        ref: (el) => {
          if (el) el.indeterminate = state === "indeterminate";
        },
        onChange: () => {},  // controlled component; React warns without
        onClick: (e) => {
          e.stopPropagation();
          onClick();
        },
        ...(opts || {}),
      });
    }

    const dirty = JSON.stringify(draft) !== JSON.stringify(originalRulesets);

    async function onSave() {
      setSaving(true);
      try {
        await savePowerTaggerRulesets(draft);
        setOriginalRulesets(JSON.parse(JSON.stringify(draft)));
        // Stay in the editor — user can keep editing or close manually.
      } catch (err) {
        alert("Save failed: " + (err.message || String(err)));
      } finally {
        setSaving(false);
      }
    }

    // v0.11.5: export current rules to a JSON file. Exports the
    // in-memory `draft` so unsaved edits ARE included — what you see
    // is what you back up. Includes a small wrapper { format, version,
    // exportedAt } around the actual payload so an importer can sanity-
    // check before applying.
    function onExportRules() {
      const payload = {
        format: "power-tagger-rules-backup",
        // v0.14.0: bumped to 2 — `data.configurations` was added.
        // Older importers ignore the new key and fall back to the
        // rulesets keys, so v2 backups stay safely importable.
        version: 2,
        exportedAt: new Date().toISOString(),
        data: {
          rulesets: draft,
          configurations: configurations,
          defaultConfigId: defaultConfigId || null,
        },
      };
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date()
        .toISOString()
        .replace(/[:T]/g, "-")
        .replace(/\..+$/, "");
      a.href = url;
      a.download = `power-tagger-rules-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    // v0.11.5: handle file selection for import. Reads + parses the
    // JSON, validates the wrapper, and stages it as `pendingImport`
    // — the actual replace doesn't happen until the user confirms via
    // the prompt below. Resets the file input so picking the same
    // file twice in a row works.
    function onImportFilePicked(e) {
      const file = e.target.files && e.target.files[0];
      if (e.target) e.target.value = "";
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          if (!parsed || typeof parsed !== "object") {
            throw new Error("File is not a JSON object.");
          }
          if (parsed.format !== "power-tagger-rules-backup") {
            throw new Error(
              "Not a Power Tagger rules backup file (missing or wrong `format` field)."
            );
          }
          if (!parsed.data || typeof parsed.data !== "object") {
            throw new Error("Backup file is missing the `data` payload.");
          }
          if (!parsed.data.rulesets || typeof parsed.data.rulesets !== "object") {
            throw new Error("Backup `data.rulesets` is missing or not an object.");
          }
          setPendingImport(parsed);
        } catch (err) {
          alert("Import failed: " + (err.message || String(err)));
        }
      };
      reader.onerror = () => {
        alert("Failed to read file.");
      };
      reader.readAsText(file);
    }

    function onImportClick() {
      if (fileInputRef.current) fileInputRef.current.click();
    }

    // Confirmed import — replace storage AND in-memory draft. Persists
    // through savePowerTaggerPartial so the new state survives reload
    // immediately (no separate Save step required).
    async function onImportConfirm() {
      const incoming = pendingImport;
      if (!incoming) return;
      setPendingImport(null);
      setSaving(true);
      try {
        const newRulesets = normaliseRulesetsNumerics(incoming.data.rulesets || {});
        // v0.14.0: a v2 backup carries the configurations list. A
        // pre-v2 backup has none — run the same legacy migration we
        // use on first load, building configs from the Configuration
        // category + ruleset keys.
        const newConfigurations = Array.isArray(incoming.data.configurations)
          ? incoming.data.configurations
          : buildMigratedConfigurations(newRulesets, tcConfig, allTags);
        const patch = {
          rulesets: newRulesets,
          configurations: newConfigurations,
        };
        if ("defaultConfigId" in incoming.data) {
          patch.defaultConfigId = incoming.data.defaultConfigId || null;
        }
        await savePowerTaggerPartial(patch);
        // Reset local editor state to match the new persisted state.
        setOriginalRulesets(JSON.parse(JSON.stringify(newRulesets)));
        setDraft(JSON.parse(JSON.stringify(newRulesets)));
        setConfigurations(newConfigurations);
        if ("defaultConfigId" in incoming.data) {
          setDefaultConfigIdState(incoming.data.defaultConfigId || null);
        }
        // If the previously-selected config no longer exists in the
        // imported set, switch to the first one (or none).
        if (
          activeConfigId &&
          !newConfigurations.some(
            (c) => String(c.id) === String(activeConfigId)
          )
        ) {
          setActiveConfigId(
            newConfigurations.length
              ? String(newConfigurations[0].id)
              : null
          );
        }
      } catch (err) {
        alert("Import failed: " + (err.message || String(err)));
      } finally {
        setSaving(false);
      }
    }

    function onImportCancel() {
      setPendingImport(null);
    }

    // v0.11.5: requestClose gate. Used by the Cancel button and (via
    // requestCloseRef) by PortalModal's header Close button. Opens the
    // in-modal confirm prompt if there are unsaved changes; closes
    // immediately otherwise.
    function requestClose() {
      if (dirty) setConfirmCloseOpen(true);
      else onClose();
    }

    // Publish onto the shared ref so PortalModal can route through it.
    React.useEffect(() => {
      if (!requestCloseRef) return undefined;
      requestCloseRef.current = requestClose;
      return () => {
        if (requestCloseRef.current === requestClose) {
          requestCloseRef.current = null;
        }
      };
      // requestClose is recreated each render; the effect re-publishes
      // on every render which is fine — the cost is a couple of pointer
      // writes per render and it guarantees the ref always reflects the
      // latest `dirty` snapshot.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    });

    function onCancel() {
      requestClose();
    }

    // v0.11.2: Jump to Tag Categories' editor. If there are unsaved
    // rule edits, show a 3-button confirm so the user can choose
    // whether to save, discard, or stay. Otherwise jump immediately.
    // The "jump" is: close this modal, dispatch the Tag Categories
    // open event \u2014 the Tag Categories plugin's hidden host listens
    // for it and opens its own editor.
    function fireTagCategoriesOpen() {
      onClose();
      // Small delay so this modal's close animation/cleanup runs
      // before the Tag Categories modal mounts. Both modals live as
      // portals to <body>; without the delay you can see a brief
      // overlap.
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent(TAG_CATEGORIES_OPEN_EVENT));
      }, 0);
    }
    function onOpenTagCategories() {
      if (dirty) {
        setTcJumpPromptOpen(true);
        return;
      }
      fireTagCategoriesOpen();
    }
    async function onJumpSaveAndContinue() {
      setTcJumpPromptOpen(false);
      // Save first; only jump if save succeeded.
      setSaving(true);
      try {
        await savePowerTaggerRulesets(draft);
        setOriginalRulesets(JSON.parse(JSON.stringify(draft)));
      } catch (err) {
        alert("Save failed: " + (err.message || String(err)));
        setSaving(false);
        return;
      }
      setSaving(false);
      fireTagCategoriesOpen();
    }
    function onJumpDiscardAndContinue() {
      setTcJumpPromptOpen(false);
      // No save call \u2014 just close + open Tag Categories. The unsaved
      // draft is discarded by virtue of the modal closing (state
      // resets next time the rules editor opens).
      fireTagCategoriesOpen();
    }
    function onJumpStay() {
      setTcJumpPromptOpen(false);
    }

    // ---- Render ----
    if (loading) {
      return React.createElement(
        "div",
        { style: { padding: 20, color: "#999" } },
        "Loading rules..."
      );
    }
    if (loadError) {
      return React.createElement(
        "div",
        { style: { padding: 20, color: "#f88" } },
        "Failed to load: " + loadError
      );
    }

    // IMPORTANT: read TagSelect fresh from PluginApi.components each
    // render rather than from the module-level Components capture.
    // PluginApi loads components lazily; if the user opens this editor
    // BEFORE Stash has mounted any scene-edit page, TagSelect may not
    // be in `components` yet at module load. Re-reading on every render
    // means the picker appears as soon as it becomes available (also:
    // defensive null check means we never feed `undefined` to
    // createElement and crash).
    const TS = (PluginApi.components && PluginApi.components.TagSelect) || null;

    // v0.14.0: config-editor modal (Add / Rename / Remove a
    // configuration). Built unconditionally so it renders in both the
    // no-configs empty state and the normal editor layout.
    const configEditorModal = configEditor
      ? (() => {
          const ed = configEditor;
          const isRemove = ed.mode === "remove";
          const cfg =
            ed.configId != null
              ? configurations.find(
                  (c) => String(c.id) === String(ed.configId)
                )
              : null;
          const setEd = (patch) =>
            setConfigEditor((prev) => (prev ? { ...prev, ...patch } : prev));
          const title =
            ed.mode === "add"
              ? "Add configuration"
              : ed.mode === "edit"
              ? "Edit configuration"
              : "Remove configuration";
          const sub = isRemove
            ? `Delete "${ed.name}" and its rules. ` +
              (cfg && cfg.tagId
                ? "The linked Stash tag is kept."
                : "This cannot be undone.")
            : ed.mode === "edit"
            ? "Rename the configuration or change its linked tag."
            : "A configuration is a named tagging profile. It can optionally be backed by a tag.";
          const labelStyle = {
            display: "block",
            fontSize: 12,
            fontWeight: 600,
            margin: "12px 0 4px",
            color: "#bbb",
          };
          const inputStyle = {
            width: "100%",
            padding: "6px 8px",
            background: "#1b1f26",
            border: "1px solid #3a4351",
            borderRadius: 4,
            color: "#eee",
          };
          const radio = (val, label, hint) =>
            React.createElement(
              "label",
              {
                key: val,
                style: {
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "5px 0",
                  cursor: "pointer",
                },
              },
              React.createElement("input", {
                type: "radio",
                name: "power-tagger-config-tagmode",
                checked: ed.tagMode === val,
                onChange: () => setEd({ tagMode: val }),
                style: { marginTop: 3 },
              }),
              React.createElement(
                "span",
                null,
                React.createElement("span", null, label),
                hint
                  ? React.createElement(
                      "span",
                      { style: { display: "block", fontSize: 11, color: "#888" } },
                      hint
                    )
                  : null
              )
            );
          // v0.14.0: linked-tag controls. Shown for both Add and Edit.
          // Edit of a tag-linked config gets an extra "Keep" option;
          // its other options replace or unlink the current tag.
          const hasCurrentTag = !!(cfg && cfg.tagId);
          const currentTagName = hasCurrentTag
            ? (tagsById[String(cfg.tagId)] || {}).name || String(cfg.tagId)
            : null;
          const tagRadios = [];
          if (ed.mode === "edit" && hasCurrentTag) {
            tagRadios.push(
              radio(
                "keep",
                `Keep linked tag: “${currentTagName}”`,
                "Renaming the configuration also renames this tag."
              )
            );
          }
          tagRadios.push(
            radio(
              "none",
              hasCurrentTag ? "Unlink the tag" : "No tag",
              hasCurrentTag
                ? "Becomes a rules-only profile. The tag itself stays in Stash."
                : "A rules-only profile. Auto-stage is unavailable."
            )
          );
          tagRadios.push(
            radio(
              "create",
              "Create a new tag",
              "Makes a Stash tag with the configuration's name."
            )
          );
          tagRadios.push(
            radio(
              "link",
              hasCurrentTag ? "Link a different tag" : "Link an existing tag",
              "Use a tag you already have."
            )
          );
          const tagSection = React.createElement(
            "div",
            null,
            React.createElement("label", { style: labelStyle }, "Linked tag"),
            tagRadios,
            ed.tagMode === "link"
              ? React.createElement(
                  "div",
                  { style: { marginTop: 6 } },
                  TS
                    ? React.createElement(TS, {
                        values: ed.linkTag ? [ed.linkTag] : [],
                        isMulti: false,
                        onSelect: (items) => {
                          const arr = Array.isArray(items)
                            ? items
                            : items
                            ? [items]
                            : [];
                          setEd({ linkTag: arr[0] || null });
                        },
                        menuPortalTarget: document.body,
                        menuPlacement: "auto",
                        // NB: Stash's TagSelect ignores a
                        // styles.menuPortal zIndex and pins the portal
                        // at z 1600 itself. The modal's z-index (not
                        // this) is what keeps the dropdown in front —
                        // see .power-tagger-config-editor-overlay.
                        styles: {
                          menuPortal: (base) => ({
                            ...base,
                            zIndex: 100000,
                          }),
                        },
                        placeholder: "Pick a tag to link...",
                      })
                    : React.createElement(
                        "div",
                        { style: { color: "#888" } },
                        "(TagSelect not loaded)"
                      )
                )
              : null
          );
          // v0.14.0: colour picker — preset swatches plus a native
          // custom-colour input. The chosen colour identifies the
          // configuration in the picker cards and walkthrough bar.
          const currentColour = ed.colour || DEFAULT_CONFIG_COLOUR;
          const colourSection = React.createElement(
            "div",
            null,
            React.createElement("label", { style: labelStyle }, "Colour"),
            React.createElement(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flexWrap: "wrap",
                },
              },
              CONFIG_COLOUR_PALETTE.map((hex) => {
                const picked =
                  currentColour.toLowerCase() === hex.toLowerCase();
                return React.createElement("button", {
                  key: hex,
                  type: "button",
                  title: hex,
                  onClick: () => setEd({ colour: hex }),
                  style: {
                    boxSizing: "border-box",
                    width: 24,
                    height: 24,
                    padding: 0,
                    borderRadius: 4,
                    cursor: "pointer",
                    background: hex,
                    border: picked
                      ? "2px solid #fff"
                      : "2px solid transparent",
                    boxShadow: "0 0 0 1px rgba(0,0,0,0.4)",
                  },
                });
              }),
              // Custom colour: a rainbow swatch that opens the native
              // colour picker. The conic-gradient is the universal
              // "pick any colour" affordance, so it reads as distinct
              // from the flat preset swatches rather than as just
              // another (blue) swatch. White ring when the current
              // colour is a custom one (not a preset).
              (() => {
                const isCustom = !CONFIG_COLOUR_PALETTE.some(
                  (h) => h.toLowerCase() === currentColour.toLowerCase()
                );
                return React.createElement(
                  "label",
                  {
                    title: "Custom colour…",
                    style: {
                      boxSizing: "border-box",
                      position: "relative",
                      width: 24,
                      height: 24,
                      margin: 0,
                      padding: 0,
                      borderRadius: 4,
                      cursor: "pointer",
                      background:
                        "conic-gradient(from 90deg, #ff4d4d, #ffe24d, #4dff4d, #4dffff, #4d4dff, #ff4dff, #ff4d4d)",
                      border: isCustom
                        ? "2px solid #fff"
                        : "2px solid transparent",
                      boxShadow: "0 0 0 1px rgba(0,0,0,0.4)",
                      display: "inline-block",
                      flexShrink: 0,
                    },
                  },
                  // The native input is the actual picker; kept
                  // visually hidden — clicking the label opens it.
                  React.createElement("input", {
                    type: "color",
                    value: currentColour,
                    onChange: (e) => setEd({ colour: e.target.value }),
                    style: {
                      position: "absolute",
                      width: 1,
                      height: 1,
                      opacity: 0,
                      pointerEvents: "none",
                    },
                  })
                );
              })()
            )
          );
          const body = isRemove
            ? null
            : React.createElement(
                "div",
                { style: { padding: "4px 20px 0" } },
                React.createElement(
                  "label",
                  { style: labelStyle },
                  "Configuration name"
                ),
                React.createElement("input", {
                  type: "text",
                  autoFocus: true,
                  value: ed.name,
                  placeholder: "e.g. Solo, Couple, Compilation",
                  style: inputStyle,
                  onChange: (e) => setEd({ name: e.target.value }),
                  onKeyDown: (e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitConfigEditor();
                    }
                  },
                }),
                colourSection,
                tagSection
              );
          const confirmLabel = isRemove
            ? saving
              ? "Removing..."
              : "Remove configuration"
            : ed.mode === "add"
            ? saving
              ? "Adding..."
              : "Add configuration"
            : saving
            ? "Saving..."
            : "Save";
          return ReactDOM.createPortal(
            React.createElement(
              "div",
              {
                // Reuses save-confirm chrome but at a LOWER z-index
                // (see .power-tagger-config-editor-overlay): Stash pins
                // the TagSelect menu portal at z 1600, so this modal
                // must sit below 1600 or the "link a tag" picker opens
                // behind it.
                className:
                  "power-tagger-save-confirm-overlay power-tagger-config-editor-overlay",
              },
              React.createElement(
                "div",
                { className: "power-tagger-save-confirm-modal" },
                React.createElement(
                  "div",
                  {
                    // Add / Edit are not destructive, so they get a
                    // neutral header. Remove keeps the red warning
                    // header (it deletes a configuration).
                    className:
                      "power-tagger-save-confirm-header" +
                      (isRemove
                        ? ""
                        : " power-tagger-config-editor-header"),
                  },
                  React.createElement(
                    "div",
                    null,
                    React.createElement(
                      "div",
                      { className: "power-tagger-save-confirm-title" },
                      title
                    ),
                    React.createElement(
                      "div",
                      { className: "power-tagger-save-confirm-sub" },
                      sub
                    )
                  )
                ),
                body,
                React.createElement(
                  "div",
                  { className: "power-tagger-save-confirm-footer" },
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      className: "btn btn-secondary",
                      onClick: closeConfigEditor,
                      disabled: saving,
                    },
                    "Cancel"
                  ),
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      className:
                        "btn " + (isRemove ? "btn-danger" : "btn-primary"),
                      onClick: commitConfigEditor,
                      disabled: saving,
                    },
                    confirmLabel
                  )
                )
              )
            ),
            document.body
          );
        })()
      : null;

    if (configTags.length === 0) {
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "div",
          { className: "power-tagger-rules-noconfigs" },
          React.createElement(
            "div",
            { className: "power-tagger-rules-noconfigs-title" },
            "No configurations yet"
          ),
          React.createElement(
            "p",
            { className: "power-tagger-rules-noconfigs-text" },
            "A configuration is a named tagging profile: it decides which ",
            "categories and tags appear during a walkthrough, and can carry ",
            "its own cascade, conditional and auto-select rules. Create one ",
            "to get started."
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: "btn btn-primary",
              onClick: openAddConfig,
            },
            "Add configuration"
          )
        ),
        configEditorModal
      );
    }

    // Left rail.
    const leftRail = React.createElement(
      "div",
      { className: "power-tagger-rules-rail" },
      React.createElement(
        "div",
        { className: "power-tagger-rules-rail-header" },
        "Configurations"
      ),
      configTags.map((t) => {
        const active = String(t.id) === String(activeConfigId);
        const isDefault = String(defaultConfigId) === String(t.id);
        // v0.14.0: tint the row with the configuration's colour — the
        // left strip, the name text, and the linked-tag icon.
        const rowColour = t.colour || DEFAULT_CONFIG_COLOUR;
        return React.createElement(
          "div",
          {
            key: t.id,
            className:
              "power-tagger-rules-rail-row" +
              (active ? " power-tagger-rules-rail-row-active" : ""),
            style: { borderLeftColor: rowColour },
          },
          React.createElement(
            "button",
            {
              type: "button",
              className: "power-tagger-rules-rail-item",
              onClick: () => setActiveConfigId(String(t.id)),
              title: t.name,
              style: { color: rowColour },
            },
            // Wrap the name in a span so it can ellipsis-truncate without
            // squeezing out the tag icon / no-tag badge to its right.
            // The CSS makes the name flex-shrinkable while the icon/badge
            // stay full-size, so a long name no longer hides the tag
            // indicator behind a "..." cut.
            React.createElement(
              "span",
              { className: "power-tagger-rules-rail-name" },
              t.name
            ),
            // v0.14.0: linked-tag marker. A tag-linked config shows a
            // compact tag icon (hover reveals the tag name); a tagless
            // one shows a "no tag" badge.
            t.tagId
              ? React.createElement(
                  "span",
                  {
                    className: "power-tagger-rules-rail-tagicon",
                    title:
                      "Linked tag: " +
                      ((tagsById[String(t.tagId)] || {}).name ||
                        String(t.tagId)),
                  },
                  // Font Awesome "tag" icon — the same glyph Stash
                  // uses for tags — rendered as an inline SVG so it
                  // matches the rest of the UI without a webfont dep.
                  React.createElement(
                    "svg",
                    {
                      viewBox: "0 0 512 512",
                      xmlns: "http://www.w3.org/2000/svg",
                      "aria-hidden": "true",
                      focusable: "false",
                    },
                    React.createElement("path", {
                      d: "M32.5 96l0 149.5c0 17 6.7 33.3 18.7 45.3l192 192c25 25 65.5 25 90.5 0L483.2 333.3c25-25 25-65.5 0-90.5l-192-192C279.2 38.7 263 32 246 32L96.5 32c-35.3 0-64 28.7-64 64zm112 16a32 32 0 1 1 0 64 32 32 0 1 1 0-64z",
                      // Theme-proof fill: some Stash themes (notably
                      // the "glassy" variant) define `svg path { fill:
                      // ... !important }` which beats both the
                      // inline-style cascade AND CSS rules without
                      // !important. Use the ref callback to set fill
                      // via setProperty(..., "important") so we
                      // unconditionally win regardless of theme.
                      ref: (el) => {
                        if (el) el.style.setProperty("fill", rowColour, "important");
                      },
                    })
                  )
                )
              : React.createElement(
                  "span",
                  { className: "power-tagger-rules-rail-notag" },
                  "no tag"
                )
          ),
          // Star toggle. Always visible; filled for the current default,
          // outline otherwise. Clicking it doesn't change the active
          // selection — the surrounding row click handler isn't bound on
          // the wrapper itself, so this is a clean independent action.
          React.createElement(
            "button",
            {
              type: "button",
              className:
                "power-tagger-rules-rail-star" +
                (isDefault ? " power-tagger-rules-rail-star-active" : ""),
              onClick: (e) => {
                e.stopPropagation();
                toggleDefaultConfig(t.id);
              },
              title: isDefault
                ? "This is the default. Click to clear."
                : "Set as default — pre-selects this config when opening Power Tagger.",
            },
            isDefault ? "\u2605" : "\u2606"   // ★ vs ☆
          ),
          // v0.14.0: per-config Rename + Remove actions.
          React.createElement(
            "button",
            {
              type: "button",
              className: "power-tagger-rules-rail-iconbtn",
              onClick: (e) => {
                e.stopPropagation();
                openEditConfig(t);
              },
              title: "Edit this configuration (name and linked tag)",
            },
            "✎"
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className:
                "power-tagger-rules-rail-iconbtn power-tagger-rules-rail-iconbtn-danger",
              onClick: (e) => {
                e.stopPropagation();
                openRemoveConfig(t);
              },
              title: "Remove this configuration",
            },
            "✕"
          )
        );
      }),
      // v0.14.0: add-configuration button, directly below the list.
      React.createElement(
        "button",
        {
          type: "button",
          className: "power-tagger-rules-rail-add",
          onClick: openAddConfig,
          title: "Add a new configuration",
        },
        "+ Add configuration"
      ),
      // v0.11.2+: rail-bottom action group. Sits at the bottom of the
      // rail (pushed there by `margin-top: auto` on the group). Holds
      // utility actions that aren't tied to a specific config:
      // Edit Tag Categories (jump to TC editor), Export Config,
      // Import Config. The hidden file input is the import trigger.
      React.createElement(
        "div",
        { className: "power-tagger-rules-rail-actions" },
        React.createElement(
          "button",
          {
            type: "button",
            className: "btn btn-sm btn-secondary",
            onClick: onOpenTagCategories,
            disabled: saving,
            title: "Open the Tag Categories editor (closes this dialog).",
          },
          "Edit Tag Categories"
        ),
        React.createElement("input", {
          ref: fileInputRef,
          type: "file",
          accept: "application/json,.json",
          style: { display: "none" },
          onChange: onImportFilePicked,
        }),
        React.createElement(
          "button",
          {
            type: "button",
            className: "btn btn-sm btn-secondary",
            onClick: onExportRules,
            disabled: saving,
            title: "Download a JSON backup of all rules (includes unsaved edits).",
          },
          "Export Config"
        ),
        React.createElement(
          "button",
          {
            type: "button",
            className: "btn btn-sm btn-secondary",
            onClick: onImportClick,
            disabled: saving,
            title: "Import a JSON backup. Replaces all current rules.",
          },
          "Import Config"
        )
      )
    );

    // Per-config options panel — sits above the category tree. Currently
    // just the auto-stage toggle, but the panel can grow as we add more
    // ruleset-level settings (e.g. cascades / conditionals later).
    const activeConfigTag = configTags.find(
      (t) => String(t.id) === String(activeConfigId)
    );
    // v0.14.0: auto-stage only makes sense for a tag-linked config
    // — there is nothing to stage for a tagless (rules-only)
    // profile. For those we replace the checkbox with a note.
    const activeConfigLinkedTag =
      activeConfigTag && activeConfigTag.tagId
        ? tagsById[String(activeConfigTag.tagId)]
        : null;
    const activeConfigHasTag = !!(activeConfigTag && activeConfigTag.tagId);
    const optionsPanel = React.createElement(
      "div",
      { className: "power-tagger-rules-options" },
      activeConfigHasTag
        ? React.createElement(
            "label",
            { className: "power-tagger-rules-option" },
            React.createElement("input", {
              type: "checkbox",
              className: "power-tagger-rules-checkbox",
              checked: getAutoStage(),
              onChange: (e) => setAutoStage(e.target.checked),
            }),
            React.createElement(
              "span",
              null,
              "Auto-stage this configuration's tag",
              React.createElement(
                "span",
                { className: "power-tagger-rules-option-hint" },
                ` (\u201C${
                  (activeConfigLinkedTag && activeConfigLinkedTag.name) ||
                  (activeConfigTag && activeConfigTag.name) ||
                  "the linked tag"
                }\u201D will be added to the scene when this config is chosen)`
              )
            )
          )
        : React.createElement(
            "div",
            { className: "power-tagger-rules-option-note" },
            "This configuration has no linked tag, so it is a "
              + "rules-only profile — auto-stage is unavailable. "
              + "Use the ✎ button on the rail to link a tag."
          )
    );

    function tagObjsFromIds(ids) {
      return (ids || [])
        .map((id) => tagsById[String(id)])
        .filter(Boolean);
    }

    const cascades = getCascades();
    const cascadeRows = cascades.map((c, idx) => {
      const triggerIds = Array.isArray(c.triggers) ? c.triggers : [];
      const triggerObjs = tagObjsFromIds(triggerIds);
      const addObjs = tagObjsFromIds(c.addTags);
      const cRowCollapsed = collapsedCascadeRows.has(String(idx));
      const cMode = c.triggerMode === "all" ? "all" : "any";

      // Summary for collapsed state — list trigger names with the mode
      // combinator. "A or B \u2192 N tags" / "A and B \u2192 N tags".
      // Falls back to "(no trigger)" when no triggers are set.
      const triggerNames = triggerObjs.map((t) => t.name);
      let triggerSummary;
      if (triggerNames.length === 0) {
        triggerSummary = "(no trigger)";
      } else if (triggerNames.length === 1) {
        triggerSummary = triggerNames[0];
      } else {
        const joiner = cMode === "all" ? " and " : " or ";
        triggerSummary = triggerNames.join(joiner);
      }
      const addCount = (c.addTags || []).length;
      const cSummary = `${triggerSummary} \u2192 ${addCount} tag${addCount === 1 ? "" : "s"}`;

      return React.createElement(
        "div",
        { key: idx, className: "power-tagger-cond-row" },
        // Row-level collapse strip — same structure as conditionals
        // and constraint rules for visual parity. Uses the shared
        // cond-rowhead styling.
        React.createElement(
          "div",
          {
            className: "power-tagger-cond-rowhead",
            onClick: () => toggleInSet(setCollapsedCascadeRows, idx),
            role: "button",
            tabIndex: 0,
          },
          React.createElement(
            "span",
            { className: "power-tagger-cond-rowhead-toggle" },
            cRowCollapsed ? "▶\uFE0E" : "▼\uFE0E"
          ),
          React.createElement(
            "span",
            { className: "power-tagger-cond-rowhead-summary" },
            cSummary
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: "btn btn-sm btn-secondary power-tagger-cond-rowhead-remove",
              onClick: (e) => {
                e.stopPropagation();
                removeCascade(idx);
              },
              title: "Remove this cascade",
            },
            "Remove"
          )
        ),
        // Body — only when expanded. Reuses cond-body padding; the
        // internal cascade-grid handles the 2-column trigger→targets
        // layout unique to cascades.
        cRowCollapsed
          ? null
          : React.createElement(
              "div",
              { className: "power-tagger-cond-body" },
              React.createElement(
                "div",
                { className: "power-tagger-cascade-grid" },
                React.createElement(
                  "div",
                  { className: "power-tagger-cascade-field" },
                  React.createElement(
                    "div",
                    { className: "power-tagger-cascade-label" },
                    "When these are staged:"
                  ),
                  TS
                    ? React.createElement(TS, {
                        values: triggerObjs,
                        isMulti: true,
                        onSelect: (items) => {
                          const ids = (items || []).map((x) => String(x.id));
                          updateCascade(idx, { triggers: ids });
                        },
                        menuPortalTarget: document.body,
                        menuPlacement: "auto",
                        styles: { menuPortal: (base) => ({ ...base, zIndex: 100000 }) },
                        placeholder: "Pick one or more trigger tags...",
                      })
                    : React.createElement(
                        "div",
                        { style: { color: "#888" } },
                        "(TagSelect not loaded)"
                      ),
                  // Any/All combinator \u2014 sits below the trigger picker,
                  // inside the same field column so it reads as "part of"
                  // the left side. Reuses cond-segmented styling for
                  // consistency with conditionals + constraint rules.
                  React.createElement(
                    "div",
                    { className: "power-tagger-cascade-mode-row" },
                    React.createElement(
                      "div",
                      { className: "power-tagger-cascade-mode-label" },
                      "Match:"
                    ),
                    React.createElement(
                      "div",
                      { className: "power-tagger-cond-segmented" },
                      ["any", "all"].map((m) =>
                        React.createElement(
                          "button",
                          {
                            key: m,
                            type: "button",
                            className:
                              "power-tagger-cond-seg" +
                              (cMode === m ? " power-tagger-cond-seg-active" : ""),
                            disabled: triggerIds.length < 2,
                            onClick: () => updateCascade(idx, { triggerMode: m }),
                            title:
                              m === "any"
                                ? "Fires when ANY trigger is staged"
                                : "Fires only when ALL triggers are staged",
                          },
                          m === "any" ? "Any" : "All"
                        )
                      )
                    )
                  )
                ),
                React.createElement(
                  "div",
                  { className: "power-tagger-cascade-arrow" },
                  "\u2192"
                ),
                React.createElement(
                  "div",
                  { className: "power-tagger-cascade-field" },
                  React.createElement(
                    "div",
                    { className: "power-tagger-cascade-label" },
                    "Also stage these:"
                  ),
                  TS
                    ? React.createElement(TS, {
                        values: addObjs,
                        isMulti: true,
                        onSelect: (items) => {
                          const ids = (items || []).map((x) => String(x.id));
                          updateCascade(idx, { addTags: ids });
                        },
                        menuPortalTarget: document.body,
                        menuPlacement: "auto",
                        styles: { menuPortal: (base) => ({ ...base, zIndex: 100000 }) },
                        placeholder: "Pick one or more tags...",
                      })
                    : null
                )
              )
            )
      );
    });

    // ---- Auto-select rule panel (v0.11.4) ----
    //
    // Progressive disclosure: shows an "+ Add auto-select rule" button
    // when no rule is defined; once added, surfaces a mode toggle +
    // condition rows + add/remove controls. Description textarea sits
    // above the rule (it's lighter UX and most users will set it even
    // if they skip the rule).
    //
    // The condition catalogue (AUTO_SELECT_CONDITION_CATALOGUE) drives
    // both the type dropdown and the per-row operator/value rendering.
    // Adding a new condition type only requires updating that catalogue
    // + the resolveCondition() switch \u2014 the UI auto-extends.
    const StudioSelect = (PluginApi.components && PluginApi.components.StudioSelect) || null;
    const PerformerSelect = (PluginApi.components && PluginApi.components.PerformerSelect) || null;

    function renderAutoSelectConditionValue(cond, ruleIdx, idx) {
      const entry = AUTO_SELECT_CONDITION_CATALOGUE.find((e) => e.key === cond.type);
      if (!entry) return null;
      const kind = entry.valueKind;
      const op = cond.op || "eq";

      // Helpers
      const numberInput = (val, key, placeholder) =>
        React.createElement("input", {
          type: "number",
          className: "power-tagger-as-num",
          value: val == null ? "" : val,
          placeholder: placeholder || "",
          onChange: (e) => {
            const v = e.target.value === "" ? 0 : parseInt(e.target.value, 10);
            updateAutoSelectCondition(ruleIdx, idx, { [key]: Number.isFinite(v) ? v : 0 });
          },
        });

      switch (kind) {
        case "numberRange": {
          if (op === "between") {
            return React.createElement(
              "div",
              { className: "power-tagger-as-row-values" },
              numberInput(cond.value, "value", "min"),
              React.createElement("span", { className: "power-tagger-as-and" }, "to"),
              numberInput(cond.max, "max", "max")
            );
          }
          return React.createElement(
            "div",
            { className: "power-tagger-as-row-values" },
            numberInput(cond.value, "value", "")
          );
        }
        case "gender": {
          const genderSelect = React.createElement(
            "select",
            {
              className: "power-tagger-as-select",
              value: cond.gender || "female",
              onChange: (e) => updateAutoSelectCondition(ruleIdx, idx, { gender: e.target.value }),
            },
            React.createElement("option", { value: "female" }, "Female"),
            React.createElement("option", { value: "male" }, "Male"),
            React.createElement("option", { value: "other" }, "Other"),
          );
          if (op === "between") {
            return React.createElement(
              "div",
              { className: "power-tagger-as-row-values" },
              genderSelect,
              numberInput(cond.value, "value", "min"),
              React.createElement("span", { className: "power-tagger-as-and" }, "to"),
              numberInput(cond.max, "max", "max")
            );
          }
          return React.createElement(
            "div",
            { className: "power-tagger-as-row-values" },
            genderSelect,
            numberInput(cond.value, "value", "")
          );
        }
        case "tagId": {
          const selObj = cond.tagId ? [tagsById[String(cond.tagId)]].filter(Boolean) : [];
          return TS
            ? React.createElement(TS, {
                values: selObj,
                isMulti: false,
                onSelect: (items) => {
                  const arr = Array.isArray(items) ? items : (items ? [items] : []);
                  const t = arr[0];
                  updateAutoSelectCondition(ruleIdx, idx, { tagId: t ? String(t.id) : "" });
                },
                menuPortalTarget: document.body,
                menuPlacement: "auto",
                styles: { menuPortal: (base) => ({ ...base, zIndex: 100000 }) },
                placeholder: "Pick a tag...",
              })
            : React.createElement("span", { style: { color: "#888" } }, "(TagSelect not loaded)");
        }
        case "tagIds": {
          const selObjs = (cond.tagIds || []).map((id) => tagsById[String(id)]).filter(Boolean);
          return TS
            ? React.createElement(TS, {
                values: selObjs,
                isMulti: true,
                onSelect: (items) => {
                  const ids = (items || []).map((x) => String(x.id));
                  updateAutoSelectCondition(ruleIdx, idx, { tagIds: ids });
                },
                menuPortalTarget: document.body,
                menuPlacement: "auto",
                styles: { menuPortal: (base) => ({ ...base, zIndex: 100000 }) },
                placeholder: "Pick one or more tags...",
              })
            : React.createElement("span", { style: { color: "#888" } }, "(TagSelect not loaded)");
        }
        case "studioId": {
          // StudioSelect props mirror TagSelect. Defensive null check
          // because lazy load may not have populated PluginApi.components
          // for users whose Stash session hasn't visited a scene edit
          // page yet. Fall back to a free-text id input so the rule is
          // still editable.
          if (StudioSelect) {
            const sel = cond.studioId
              ? [{ id: String(cond.studioId), name: cond.studioName || "" }]
              : [];
            return React.createElement(StudioSelect, {
              values: sel,
              isMulti: false,
              onSelect: (items) => {
                const arr = Array.isArray(items) ? items : (items ? [items] : []);
                const s = arr[0];
                updateAutoSelectCondition(ruleIdx, idx, {
                  studioId: s ? String(s.id) : "",
                  studioName: s ? s.name : "",
                });
              },
              menuPortalTarget: document.body,
              menuPlacement: "auto",
              styles: { menuPortal: (base) => ({ ...base, zIndex: 100000 }) },
              placeholder: "Pick a studio...",
            });
          }
          return React.createElement("input", {
            type: "text",
            className: "power-tagger-as-text",
            value: cond.studioId || "",
            placeholder: "Studio ID",
            onChange: (e) => updateAutoSelectCondition(ruleIdx, idx, { studioId: e.target.value }),
          });
        }
        case "studioIds": {
          if (StudioSelect) {
            const sel = (cond.studioIds || []).map((id, i) => ({
              id: String(id),
              name: (cond.studioNames && cond.studioNames[i]) || "",
            }));
            return React.createElement(StudioSelect, {
              values: sel,
              isMulti: true,
              onSelect: (items) => {
                const arr = items || [];
                updateAutoSelectCondition(ruleIdx, idx, {
                  studioIds: arr.map((x) => String(x.id)),
                  studioNames: arr.map((x) => x.name || ""),
                });
              },
              menuPortalTarget: document.body,
              menuPlacement: "auto",
              styles: { menuPortal: (base) => ({ ...base, zIndex: 100000 }) },
              placeholder: "Pick one or more studios...",
            });
          }
          return React.createElement("span", { style: { color: "#888" } }, "(StudioSelect not loaded)");
        }
        case "performerIds": {
          if (PerformerSelect) {
            // Store names alongside ids so the chips display correctly
            // after reload. Same pattern as studios above. PerformerSelect
            // expects values with id+name; without name the chip label
            // renders blank.
            const sel = (cond.performerIds || []).map((id, i) => ({
              id: String(id),
              name: (cond.performerNames && cond.performerNames[i]) || "",
            }));
            return React.createElement(PerformerSelect, {
              values: sel,
              isMulti: true,
              onSelect: (items) => {
                const arr = items || [];
                updateAutoSelectCondition(ruleIdx, idx, {
                  performerIds: arr.map((x) => String(x.id)),
                  performerNames: arr.map((x) => x.name || ""),
                });
              },
              menuPortalTarget: document.body,
              menuPlacement: "auto",
              styles: { menuPortal: (base) => ({ ...base, zIndex: 100000 }) },
              placeholder: "Pick one or more performers...",
            });
          }
          return React.createElement("span", { style: { color: "#888" } }, "(PerformerSelect not loaded)");
        }
        case "text": {
          return React.createElement("input", {
            type: "text",
            className: "power-tagger-as-text",
            value: cond.text || "",
            placeholder: "Text...",
            onChange: (e) => updateAutoSelectCondition(ruleIdx, idx, { text: e.target.value }),
          });
        }
        case "category": {
          const visibleCats = (tcConfig.taxonomy.categories || []).filter(
            (c) => c.name !== "Configuration"
          );
          return React.createElement(
            "select",
            {
              className: "power-tagger-as-select power-tagger-as-cat",
              value: cond.category || "",
              onChange: (e) => updateAutoSelectCondition(ruleIdx, idx, { category: e.target.value }),
            },
            React.createElement("option", { value: "" }, "Pick a category..."),
            ...visibleCats.map((c) =>
              React.createElement("option", { key: c.name, value: c.name }, c.name)
            )
          );
        }
        case "categoryAndNumber": {
          const visibleCats = (tcConfig.taxonomy.categories || []).filter(
            (c) => c.name !== "Configuration"
          );
          const catSel = React.createElement(
            "select",
            {
              className: "power-tagger-as-select power-tagger-as-cat",
              value: cond.category || "",
              onChange: (e) => updateAutoSelectCondition(ruleIdx, idx, { category: e.target.value }),
            },
            React.createElement("option", { value: "" }, "Pick a category..."),
            ...visibleCats.map((c) =>
              React.createElement("option", { key: c.name, value: c.name }, c.name)
            )
          );
          if (op === "between") {
            return React.createElement(
              "div",
              { className: "power-tagger-as-row-values" },
              catSel,
              numberInput(cond.value, "value", "min"),
              React.createElement("span", { className: "power-tagger-as-and" }, "to"),
              numberInput(cond.max, "max", "max")
            );
          }
          return React.createElement(
            "div",
            { className: "power-tagger-as-row-values" },
            catSel,
            numberInput(cond.value, "value", "")
          );
        }
        default:
          return null;
      }
    }

    function renderAutoSelectConditionRow(cond, ruleIdx, idx) {
      const entry = AUTO_SELECT_CONDITION_CATALOGUE.find((e) => e.key === cond.type);
      if (!entry) {
        return React.createElement(
          "div",
          { key: idx, className: "power-tagger-as-row" },
          React.createElement(
            "span",
            { style: { color: "#888" } },
            `(Unknown condition type: ${cond.type})`
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: "btn btn-sm btn-secondary power-tagger-as-remove",
              onClick: () => removeAutoSelectCondition(ruleIdx, idx),
            },
            "Remove"
          )
        );
      }
      return React.createElement(
        "div",
        { key: idx, className: "power-tagger-as-row" },
        React.createElement(
          "div",
          { className: "power-tagger-as-row-label" },
          entry.label
        ),
        React.createElement(
          "select",
          {
            className: "power-tagger-as-select power-tagger-as-op",
            value: cond.op || (entry.operators[0] && entry.operators[0].value) || "",
            onChange: (e) => updateAutoSelectCondition(ruleIdx, idx, { op: e.target.value }),
          },
          ...entry.operators.map((o) =>
            React.createElement("option", { key: o.value, value: o.value }, o.label)
          )
        ),
        renderAutoSelectConditionValue(cond, ruleIdx, idx),
        React.createElement(
          "button",
          {
            type: "button",
            className: "btn btn-sm btn-danger power-tagger-as-remove",
            onClick: () => removeAutoSelectCondition(ruleIdx, idx),
            title: "Remove this condition",
          },
          "\u00d7"
        )
      );
    }

    // Group conditions by their `group` field for the Add-Condition
    // dropdown. Optgroup makes the dropdown easier to scan.
    function buildAddConditionGroups() {
      const groups = {};
      for (const entry of AUTO_SELECT_CONDITION_CATALOGUE) {
        if (!groups[entry.group]) groups[entry.group] = [];
        groups[entry.group].push(entry);
      }
      return groups;
    }

    // v0.11.4: Multi-rule shape. Each "rule" in the list is a discrete
    // match pattern; rules are OR'd together at the top. The user
    // builds patterns like "(1F + 1M)" as one rule, "(2F + 0M)" as
    // another, "(0F + 2M)" as a third, etc.
    const currentAutoSelectRule = getAutoSelectRule();
    const currentDescription = getDescription();
    const descCount = currentDescription.length;
    const descOverLimit = descCount > MAX_DESCRIPTION_CHARS;
    const ruleList = getAutoSelectRules();
    const hasRules = ruleList.length > 0;
    const totalConditions = ruleList.reduce(
      (n, r) => n + ((r && r.conditions) ? r.conditions.length : 0),
      0
    );

    // Render a single rule "card". Each rule has its own ALL/ANY mode
    // toggle, its own list of conditions, its own +Add condition row,
    // and an × button to remove the whole rule.
    function renderAutoSelectRuleCard(rule, ruleIdx) {
      const ruleConditions = (rule && rule.conditions) || [];
      const ruleMode = (rule && rule.mode) || "all";
      const isMulti = ruleList.length > 1;
      return React.createElement(
        "div",
        { key: ruleIdx, className: "power-tagger-as-rule" },
        React.createElement(
          "div",
          { className: "power-tagger-as-rule-header" },
          React.createElement(
            "div",
            { className: "power-tagger-as-mode" },
            // Show "Rule N" badge only when there are multiple rules.
            // Otherwise it's clutter.
            isMulti
              ? React.createElement(
                  "span",
                  { className: "power-tagger-as-rule-num" },
                  `Rule ${ruleIdx + 1}`
                )
              : null,
            React.createElement(
              "span",
              { className: "power-tagger-as-mode-label" },
              "Match:"
            ),
            React.createElement(
              "div",
              { className: "power-tagger-cond-segmented" },
              ["all", "any"].map((m) =>
                React.createElement(
                  "button",
                  {
                    key: m,
                    type: "button",
                    className:
                      "power-tagger-cond-seg" +
                      (ruleMode === m ? " power-tagger-cond-seg-active" : ""),
                    onClick: () => setAutoSelectRuleMode(ruleIdx, m),
                    title:
                      m === "all"
                        ? "ALL conditions must pass (AND)"
                        : "ANY condition must pass (OR)",
                  },
                  m === "all" ? "All (AND)" : "Any (OR)"
                )
              )
            )
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: "btn btn-sm btn-secondary power-tagger-as-remove-rule",
              onClick: () => {
                if (
                  ruleConditions.length === 0 ||
                  window.confirm(
                    `Remove ${isMulti ? `Rule ${ruleIdx + 1}` : "the auto-select rule"}? Any conditions will be lost.`
                  )
                ) {
                  removeAutoSelectRuleAt(ruleIdx);
                }
              },
              title: "Remove this rule",
            },
            isMulti ? "Remove" : "Remove rule"
          )
        ),
        ruleConditions.length === 0
          ? React.createElement(
              "div",
              { className: "power-tagger-as-empty" },
              "No conditions yet. Use \u201C+ Add condition\u201D below to define when this rule matches."
            )
          : React.createElement(
              "div",
              { className: "power-tagger-as-rows" },
              ruleConditions.map((c, i) =>
                renderAutoSelectConditionRow(c, ruleIdx, i)
              )
            ),
        React.createElement(
          "div",
          { className: "power-tagger-as-add-row" },
          React.createElement(
            "select",
            {
              className: "power-tagger-as-select power-tagger-as-add-select",
              value: "",
              onChange: (e) => {
                const v = e.target.value;
                if (!v) return;
                addAutoSelectCondition(ruleIdx, v);
                e.target.value = "";
              },
            },
            React.createElement("option", { value: "" }, "+ Add condition\u2026"),
            ...Object.keys(buildAddConditionGroups()).map((group) =>
              React.createElement(
                "optgroup",
                { key: group, label: group },
                ...buildAddConditionGroups()[group].map((e) =>
                  React.createElement("option", { key: e.key, value: e.key }, e.label)
                )
              )
            )
          )
        )
      );
    }

    const autoSelectPanel = React.createElement(
      "div",
      { className: "power-tagger-rules-cascades power-tagger-rules-cascades-panel power-tagger-rules-autoselect-panel" },
      React.createElement(
        "div",
        {
          className: "power-tagger-rules-cascades-header",
          onClick: () => setAutoSelectCollapsed((v) => !v),
          role: "button",
          tabIndex: 0,
          onKeyDown: (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setAutoSelectCollapsed((v) => !v);
            }
          },
          title: autoSelectCollapsed ? "Expand auto-select & description" : "Collapse auto-select & description",
        },
        React.createElement(
          "span",
          { className: "power-tagger-rules-cascades-toggle" },
          autoSelectCollapsed ? "\u25B6\uFE0E" : "\u25BC\uFE0E"
        ),
        React.createElement(
          "span",
          { className: "power-tagger-rules-cascades-title" },
          "Auto-select & description"
        ),
        React.createElement(
          "span",
          { className: "power-tagger-rules-cascades-count" },
          hasRules
            ? `(${ruleList.length} rule${ruleList.length === 1 ? "" : "s"}, ${totalConditions} condition${totalConditions === 1 ? "" : "s"})`
            : "(no rule)"
        )
      ),
      !autoSelectCollapsed
        ? React.createElement(
            "div",
            { className: "power-tagger-rules-cascades-body" },
            // Description ----------------------------------------------------
            React.createElement(
              "div",
              { className: "power-tagger-as-section" },
              React.createElement(
                "div",
                { className: "power-tagger-as-section-label" },
                "Description"
              ),
              React.createElement(
                "div",
                { className: "power-tagger-as-section-hint" },
                "Shown in the picker preview when this config is selected. Keep it short \u2014 one or two sentences."
              ),
              React.createElement("textarea", {
                className: "power-tagger-as-desc" + (descOverLimit ? " power-tagger-as-desc-over" : ""),
                rows: 2,
                value: currentDescription,
                onChange: (e) => setDescription(e.target.value),
                placeholder: "e.g. Solo female scene with no visible partner.",
              }),
              React.createElement(
                "div",
                {
                  className:
                    "power-tagger-as-desc-counter" +
                    (descOverLimit ? " power-tagger-as-desc-counter-over" : ""),
                },
                `${descCount} / ${MAX_DESCRIPTION_CHARS}`,
                descOverLimit
                  ? React.createElement(
                      "span",
                      { className: "power-tagger-as-desc-counter-note" },
                      " \u2014 will be truncated in the picker preview."
                    )
                  : null
              )
            ),

            // Auto-select rules ----------------------------------------------
            React.createElement(
              "div",
              { className: "power-tagger-as-section" },
              React.createElement(
                "div",
                { className: "power-tagger-as-section-label" },
                "Auto-select rule"
              ),
              React.createElement(
                "div",
                { className: "power-tagger-as-section-hint" },
                "Optional. When ANY of these rules match the scene, this configuration is auto-suggested in the picker. ",
                "Rules combine with OR \u2014 add multiple rules to cover different scene shapes (e.g. ",
                React.createElement("em", null, "1F+1M"),
                " in one rule, ",
                React.createElement("em", null, "2F+0M"),
                " in another). Each rule's conditions combine with AND or OR via its Match toggle."
              ),
              !hasRules
                ? React.createElement(
                    "button",
                    {
                      type: "button",
                      className: "btn btn-secondary power-tagger-as-add-rule",
                      onClick: addAutoSelectRule,
                    },
                    "+ Add auto-select rule"
                  )
                : React.createElement(
                    React.Fragment,
                    null,
                    // Rules combinator hint when there's more than one.
                    ruleList.length > 1
                      ? React.createElement(
                          "div",
                          { className: "power-tagger-as-rules-combinator" },
                          "Config matches if ",
                          React.createElement("strong", null, "ANY"),
                          " of these rules pass:"
                        )
                      : null,
                    React.createElement(
                      "div",
                      { className: "power-tagger-as-rules" },
                      ruleList.map((r, i) => renderAutoSelectRuleCard(r, i))
                    ),
                    React.createElement(
                      "div",
                      { className: "power-tagger-as-add-rule-row" },
                      React.createElement(
                        "button",
                        {
                          type: "button",
                          className: "btn btn-secondary power-tagger-as-add-another-rule",
                          onClick: addAutoSelectRule,
                          title: "Add another match pattern \u2014 rules combine with OR",
                        },
                        "+ Add another rule"
                      )
                    )
                  )
            )
          )
        : null
    );

    const cascadesPanel = React.createElement(
      "div",
      { className: "power-tagger-rules-cascades power-tagger-rules-cascades-panel" },
      React.createElement(
        "div",
        {
          className: "power-tagger-rules-cascades-header",
          onClick: () => setCascadesCollapsed((v) => !v),
          role: "button",
          tabIndex: 0,
        },
        React.createElement(
          "span",
          { className: "power-tagger-rules-cascades-toggle" },
          cascadesCollapsed ? "▶\uFE0E" : "▼\uFE0E"
        ),
        React.createElement(
          "span",
          { className: "power-tagger-rules-cascades-title" },
          "Cascades"
        ),
        React.createElement(
          "span",
          { className: "power-tagger-rules-cascades-count" },
          cascades.length > 0 ? ` (${cascades.length})` : ""
        ),
        React.createElement(
          "span",
          { className: "power-tagger-rules-cascades-hint" },
          " — when a tag is staged, also stage other tags"
        )
      ),
      !cascadesCollapsed
        ? React.createElement(
            "div",
            { className: "power-tagger-rules-cascades-body" },
            cascades.length === 0
              ? React.createElement(
                  "div",
                  { className: "power-tagger-rules-cascades-empty" },
                  "No cascades defined for this configuration."
                )
              : cascadeRows,
            React.createElement(
              "button",
              {
                type: "button",
                className: "btn btn-sm btn-secondary power-tagger-rules-cascades-add",
                onClick: addCascade,
              },
              "+ Add cascade"
            )
          )
        : null
    );

    // ----- Conditionals panel -----

    // Build the option lists for the cat / sub / tag pickers.
    //
    // Earlier these were filtered to base-visible items, but that made it
    // impossible to author a REVEAL conditional: by definition a reveal
    // targets something currently hidden, so hiding it from the picker
    // defeated the feature. Now we show ALL items in the active config's
    // taxonomy — users can target whatever they want, including base-
    // hidden items (the conditional simply has no effect if it targets
    // something that's already in the desired visibility state).
    const allTargetCats = cats;           // already excludes Configuration
    const allTargetSubs = [];             // [{ cat, sub }]
    for (const c of allTargetCats) {
      const subsHere =
        c.subcategories && c.subcategories.length > 0 ? c.subcategories : [];
      for (const sub of subsHere) {
        // Only include subs that actually have at least one tag assigned
        // — empty subs would be a no-op target.
        const list = (grouped[c.name] || {})[sub] || [];
        if (list.length > 0) {
          allTargetSubs.push({ cat: c.name, sub });
        }
      }
    }

    const conditionals = getConditionals();
    const conditionalRows = conditionals.map((c, idx) => {
      const triggerObjs = tagObjsFromIds(c.triggers || []);
      const targetTagObjs = tagObjsFromIds((c.targets && c.targets.tags) || []);
      const direction = c.direction === "hide" ? "hide" : "reveal";
      const mode = c.triggerMode === "all" ? "all" : "any";

      // Cat picker — a checkbox grid of ALL cats in the active config's
      // taxonomy (not filtered by base visibility — see allTargetCats).
      const catChecks = allTargetCats.map((vc) =>
        React.createElement(
          "label",
          { key: vc.name, className: "power-tagger-cond-checkbox" },
          React.createElement("input", {
            type: "checkbox",
            checked: ((c.targets && c.targets.cats) || []).includes(vc.name),
            onChange: (e) => {
              const curList = ((c.targets && c.targets.cats) || []).slice();
              if (e.target.checked && !curList.includes(vc.name)) {
                curList.push(vc.name);
              } else if (!e.target.checked) {
                const k = curList.indexOf(vc.name);
                if (k >= 0) curList.splice(k, 1);
              }
              updateConditionalTargets(idx, { cats: curList });
            },
          }),
          React.createElement("span", null, vc.name)
        )
      );

      // Sub picker — checkbox grid, only currently-visible subs.
      const curSubList = ((c.targets && c.targets.subs) || []);
      function subChecked(catName, subName) {
        return curSubList.some(
          (s) => s.cat === catName && s.sub === subName
        );
      }
      const subChecks = allTargetSubs.map(({ cat: catName, sub: subName }) =>
        React.createElement(
          "label",
          {
            key: `${catName}::${subName}`,
            className: "power-tagger-cond-checkbox",
          },
          React.createElement("input", {
            type: "checkbox",
            checked: subChecked(catName, subName),
            onChange: (e) => {
              let nextList;
              if (e.target.checked) {
                nextList = subChecked(catName, subName)
                  ? curSubList
                  : [...curSubList, { cat: catName, sub: subName }];
              } else {
                nextList = curSubList.filter(
                  (s) => !(s.cat === catName && s.sub === subName)
                );
              }
              updateConditionalTargets(idx, { subs: nextList });
            },
          }),
          React.createElement(
            "span",
            null,
            React.createElement(
              "span",
              { className: "power-tagger-cond-cat-hint" },
              `${catName} › `
            ),
            subName
          )
        )
      );

      const rowCollapsed = collapsedConditionalRows.has(String(idx));

      // Build a short summary line for the collapsed state. If the
      // conditional has a name, lead with it; otherwise fall back to the
      // trigger-shape summary (same auto-description style as warnings).
      const triggerNames = (c.triggers || [])
        .map((tid) => tagsById[String(tid)] && tagsById[String(tid)].name)
        .filter(Boolean);
      const triggerSummary =
        triggerNames.length === 0
          ? "(no triggers)"
          : triggerNames.length === 1
            ? triggerNames[0]
            : `${triggerNames.join(", ")} (${mode})`;
      const tCount =
        ((c.targets && c.targets.cats) || []).length +
        ((c.targets && c.targets.subs) || []).length +
        ((c.targets && c.targets.tags) || []).length;
      const hasName = typeof c.name === "string" && c.name.trim();
      const summary = hasName
        ? `${c.name.trim()} \u00B7 ${direction === "reveal" ? "Reveal" : "Hide"} \u00B7 ${tCount} target${tCount === 1 ? "" : "s"}`
        : `${direction === "reveal" ? "Reveal" : "Hide"} \u00B7 when ${triggerSummary} \u00B7 ${tCount} target${tCount === 1 ? "" : "s"}`;

      return React.createElement(
        "div",
        { key: idx, className: "power-tagger-cond-row" },
        // Row-level collapse strip — always visible. Click to toggle.
        React.createElement(
          "div",
          {
            className: "power-tagger-cond-rowhead",
            onClick: () => toggleInSet(setCollapsedConditionalRows, idx),
            role: "button",
            tabIndex: 0,
          },
          React.createElement(
            "span",
            { className: "power-tagger-cond-rowhead-toggle" },
            rowCollapsed ? "▶\uFE0E" : "▼\uFE0E"
          ),
          React.createElement(
            "span",
            { className: "power-tagger-cond-rowhead-summary" },
            summary
          ),
          // Remove always available so collapsed rows can still be cleared.
          React.createElement(
            "button",
            {
              type: "button",
              className: "btn btn-sm btn-secondary power-tagger-cond-rowhead-remove",
              onClick: (e) => {
                e.stopPropagation();
                removeConditional(idx);
              },
              title: "Remove this conditional",
            },
            "Remove"
          )
        ),
        // The full row body — only rendered when expanded.
        rowCollapsed
          ? null
          : React.createElement(
              "div",
              { className: "power-tagger-cond-body" },
              // v0.11.2: Optional name. If non-empty, used as the
              // warning label and the collapsed-row summary; otherwise
              // the trigger shape is auto-described.
              React.createElement(
                "div",
                { className: "power-tagger-cond-field power-tagger-cond-field-wide" },
                React.createElement(
                  "div",
                  { className: "power-tagger-cond-label" },
                  "Name (optional \u2014 shown in warnings):"
                ),
                React.createElement("input", {
                  type: "text",
                  className: "form-control",
                  value: c.name || "",
                  placeholder: "e.g. \"BBG needs 2 males\"",
                  onChange: (e) => updateConditional(idx, { name: e.target.value }),
                })
              ),
              // Header: trigger picker + mode toggle + direction toggle
              React.createElement(
                "div",
                { className: "power-tagger-cond-head" },
          React.createElement(
            "div",
            { className: "power-tagger-cond-field power-tagger-cond-field-wide" },
            React.createElement(
              "div",
              { className: "power-tagger-cond-label" },
              "When these are staged:"
            ),
            TS
              ? React.createElement(TS, {
                  values: triggerObjs,
                  isMulti: true,
                  onSelect: (items) => {
                    const ids = (items || []).map((x) => String(x.id));
                    updateConditional(idx, { triggers: ids });
                  },
                  menuPortalTarget: document.body,
                  menuPlacement: "auto",
                  styles: { menuPortal: (base) => ({ ...base, zIndex: 100000 }) },
                  placeholder: "Pick one or more trigger tags...",
                })
              : React.createElement(
                  "div",
                  { style: { color: "#888" } },
                  "(TagSelect not loaded)"
                )
          ),
          // Not-staged picker (negation gate) — sister to Triggers.
          React.createElement(
            "div",
            { className: "power-tagger-cond-field power-tagger-cond-field-wide" },
            React.createElement(
              "div",
              { className: "power-tagger-cond-label" },
              "Skip when ANY of these are staged:"
            ),
            TS
              ? React.createElement(TS, {
                  values: (c.notTags || [])
                    .map((id) => tagsById[String(id)])
                    .filter(Boolean),
                  isMulti: true,
                  onSelect: (items) => {
                    const ids = (items || []).map((x) => String(x.id));
                    updateConditional(idx, { notTags: ids });
                  },
                  menuPortalTarget: document.body,
                  menuPlacement: "auto",
                  styles: { menuPortal: (base) => ({ ...base, zIndex: 100000 }) },
                  placeholder: "Optional \u2014 tags whose presence cancels this rule...",
                })
              : null
          ),
          // Mode toggle. Only meaningful when 2+ triggers.
          React.createElement(
            "div",
            { className: "power-tagger-cond-field" },
            React.createElement(
              "div",
              { className: "power-tagger-cond-label" },
              "Match:"
            ),
            React.createElement(
              "div",
              { className: "power-tagger-cond-segmented" },
              ["any", "all"].map((m) =>
                React.createElement(
                  "button",
                  {
                    key: m,
                    type: "button",
                    className:
                      "power-tagger-cond-seg" +
                      (mode === m ? " power-tagger-cond-seg-active" : ""),
                    disabled: ((c.triggers || []).length + (c.performerTriggers ? 1 : 0)) < 2,
                    onClick: () => updateConditional(idx, { triggerMode: m }),
                    title:
                      m === "any"
                        ? "Fires if ANY trigger is staged"
                        : "Fires only if ALL triggers are staged",
                  },
                  m === "any" ? "Any" : "All"
                )
              )
            )
          ),
          // Direction toggle.
          React.createElement(
            "div",
            { className: "power-tagger-cond-field" },
            React.createElement(
              "div",
              { className: "power-tagger-cond-label" },
              "Then:"
            ),
            React.createElement(
              "div",
              { className: "power-tagger-cond-segmented" },
              ["reveal", "hide"].map((d) =>
                React.createElement(
                  "button",
                  {
                    key: d,
                    type: "button",
                    className:
                      "power-tagger-cond-seg" +
                      (direction === d ? " power-tagger-cond-seg-active" : ""),
                    onClick: () => updateConditional(idx, { direction: d }),
                  },
                  d === "reveal" ? "Reveal" : "Hide"
                )
              )
            )
          )
        ),
        // Performer triggers (v0.11.0 rev). Optional block; toggle on to
        // gate the conditional on scene performer counts. Same UI shape
        // as performer rules.
        React.createElement(
          "div",
          { className: "power-tagger-cond-perf" },
          React.createElement(
            "label",
            { className: "power-tagger-cond-perf-toggle" },
            React.createElement("input", {
              type: "checkbox",
              checked: !!c.performerTriggers,
              onChange: (e) => togglePerformerTriggers(idx, e.target.checked),
            }),
            React.createElement(
              "span",
              null,
              "Also gate on performer counts"
            )
          ),
          c.performerTriggers
            ? React.createElement(
                "div",
                { className: "power-tagger-cond-perf-body" },
                React.createElement(
                  "div",
                  { className: "power-tagger-rules-pr-mode-row" },
                  React.createElement(
                    "span",
                    { className: "power-tagger-rules-pr-mode-label" },
                    "Gender match"
                  ),
                  React.createElement(
                    "select",
                    {
                      className: "form-control power-tagger-rules-pr-mode-select",
                      value: (c.performerTriggers && c.performerTriggers.mode) || "all",
                      onChange: (e) =>
                        updateConditionalPerformerBlock(idx, { mode: e.target.value }),
                    },
                    React.createElement("option", { value: "all" }, "all of"),
                    React.createElement("option", { value: "any" }, "any of")
                  )
                ),
                React.createElement(
                  "div",
                  { className: "power-tagger-rules-pr-gender-list" },
                  renderCondGenderBlockRow(idx, c, "male",   "Male"),
                  renderCondGenderBlockRow(idx, c, "female", "Female"),
                  renderCondGenderBlockRow(idx, c, "other",  "Other (Any Trans)")
                ),
                React.createElement(
                  "div",
                  { className: "power-tagger-rules-pr-condition-hint" },
                  "Tick a gender to add it. Unticked means \u201Cdon\u2019t care\u201D. Combined with the tag triggers above via the Match toggle."
                )
              )
            : null
        ),
        // Targets — three sections.
        React.createElement(
          "div",
          { className: "power-tagger-cond-targets" },
          React.createElement(
            "div",
            { className: "power-tagger-cond-target-block" },
            React.createElement(
              "div",
              { className: "power-tagger-cond-target-title" },
              "Categories"
            ),
            allTargetCats.length === 0
              ? React.createElement(
                  "div",
                  { className: "power-tagger-cond-empty" },
                  "(no categories)"
                )
              : React.createElement(
                  "div",
                  { className: "power-tagger-cond-checkbox-grid" },
                  catChecks
                )
          ),
          React.createElement(
            "div",
            { className: "power-tagger-cond-target-block" },
            React.createElement(
              "div",
              { className: "power-tagger-cond-target-title" },
              "Sub-categories"
            ),
            allTargetSubs.length === 0
              ? React.createElement(
                  "div",
                  { className: "power-tagger-cond-empty" },
                  "(no sub-categories)"
                )
              : React.createElement(
                  "div",
                  { className: "power-tagger-cond-checkbox-grid" },
                  subChecks
                )
          ),
          React.createElement(
            "div",
            { className: "power-tagger-cond-target-block" },
            React.createElement(
              "div",
              { className: "power-tagger-cond-target-title" },
              "Individual tags"
            ),
            TS
              ? React.createElement(TS, {
                  values: targetTagObjs,
                  isMulti: true,
                  onSelect: (items) => {
                    const ids = (items || []).map((x) => String(x.id));
                    updateConditionalTargets(idx, { tags: ids });
                  },
                  menuPortalTarget: document.body,
                  menuPlacement: "auto",
                  styles: { menuPortal: (base) => ({ ...base, zIndex: 100000 }) },
                  placeholder: "Pick target tags...",
                })
              : null
          )
        )
      )
      );
    });

    const conditionalsPanel = React.createElement(
      "div",
      { className: "power-tagger-rules-cascades power-tagger-rules-conditionals-panel" },
      React.createElement(
        "div",
        {
          className: "power-tagger-rules-cascades-header",
          onClick: () => setConditionalsCollapsed((v) => !v),
          role: "button",
          tabIndex: 0,
        },
        React.createElement(
          "span",
          { className: "power-tagger-rules-cascades-toggle" },
          conditionalsCollapsed ? "▶\uFE0E" : "▼\uFE0E"
        ),
        React.createElement(
          "span",
          { className: "power-tagger-rules-cascades-title" },
          "Conditionals"
        ),
        React.createElement(
          "span",
          { className: "power-tagger-rules-cascades-count" },
          conditionals.length > 0 ? ` (${conditionals.length})` : ""
        ),
        React.createElement(
          "span",
          { className: "power-tagger-rules-cascades-hint" },
          " — reveal or hide cats/subs/tags based on what's staged"
        )
      ),
      !conditionalsCollapsed
        ? React.createElement(
            "div",
            { className: "power-tagger-rules-cascades-body" },
            conditionals.length === 0
              ? React.createElement(
                  "div",
                  { className: "power-tagger-rules-cascades-empty" },
                  "No conditionals defined for this configuration."
                )
              : conditionalRows,
            React.createElement(
              "button",
              {
                type: "button",
                className: "btn btn-sm btn-secondary power-tagger-rules-cascades-add",
                onClick: addConditional,
              },
              "+ Add conditional"
            )
          )
        : null
    );

    // -----------------------------------------------------------------
    // Performer Rules panel (v0.11.0)
    //
    // Each rule row collapses to a one-liner; expanded shows scope +
    // condition + limit editors. The shape matches the data model:
    //   { id, name, scope: { kind, cat, sub }, condition, limit }
    // -----------------------------------------------------------------

    const performerRules = getPerformerRules();

    function togglePerformerRuleCollapse(idx) {
      setCollapsedPerformerRuleRows((prev) => {
        const next = new Set(prev);
        const k = String(idx);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        return next;
      });
    }

    // Helper for a single gender block row inside a rule editor.
    // key = "male" | "female" | "other"; label is the display label.
    // Sister of renderGenderBlockRow, targeting a conditional's
    // performerTriggers block instead of a performer rule's condition.
    function renderCondGenderBlockRow(condIdx, cond, key, label) {
      const block = (cond.performerTriggers || {})[key];
      const enabled = !!block;
      const mode = (block && block.mode) || "min";
      const value = block ? toInt(block.value, 0) : 0;
      const max   = block ? toInt(block.max, value) : value;
      return React.createElement(
        "div",
        { key, className: "power-tagger-rules-pr-gender-row" },
        React.createElement(
          "label",
          { className: "power-tagger-rules-pr-gender-toggle" },
          React.createElement("input", {
            type: "checkbox",
            checked: enabled,
            onChange: (e) => {
              if (e.target.checked) {
                updateConditionalPerformerGenderBlock(condIdx, key, { mode: "min", value: 1 });
              } else {
                updateConditionalPerformerGenderBlock(condIdx, key, null);
              }
            },
          }),
          React.createElement("span", null, label)
        ),
        enabled
          ? React.createElement(
              "select",
              {
                className: "power-tagger-rules-pr-mode-select",
                value: mode,
                onChange: (e) =>
                  updateConditionalPerformerGenderBlock(condIdx, key, { mode: e.target.value }),
              },
              React.createElement("option", { value: "exact" }, "exactly"),
              React.createElement("option", { value: "min" }, "\u2265"),
              React.createElement("option", { value: "max" }, "\u2264"),
              React.createElement("option", { value: "range" }, "between"),
              React.createElement("option", { value: "any" }, "any")
            )
          : null,
        enabled && mode !== "any"
          ? React.createElement("input", {
              type: "number",
              className: "power-tagger-rules-pr-num-input",
              value: value,
              min: 0,
              step: 1,
              onChange: (e) => {
                const v = parseInt(e.target.value, 10);
                updateConditionalPerformerGenderBlock(condIdx, key, {
                  value: Number.isFinite(v) ? v : 0,
                });
              },
            })
          : null,
        enabled && mode === "range"
          ? React.createElement(
              "span",
              { className: "power-tagger-rules-pr-range-sep" },
              "\u2026"
            )
          : null,
        enabled && mode === "range"
          ? React.createElement("input", {
              type: "number",
              className: "power-tagger-rules-pr-num-input",
              value: max,
              min: 0,
              step: 1,
              onChange: (e) => {
                const v = parseInt(e.target.value, 10);
                updateConditionalPerformerGenderBlock(condIdx, key, {
                  max: Number.isFinite(v) ? v : 0,
                });
              },
            })
          : null
      );
    }

    function renderGenderBlockRow(ruleIdx, rule, key, label) {
      const block = (rule.performerTriggers || {})[key];
      const enabled = !!block;
      const mode = (block && block.mode) || "min";
      const value = block ? toInt(block.value, 0) : 0;
      const max   = block ? toInt(block.max, value) : value;
      return React.createElement(
        "div",
        { key, className: "power-tagger-rules-pr-gender-row" },
        React.createElement(
          "label",
          { className: "power-tagger-rules-pr-gender-toggle" },
          React.createElement("input", {
            type: "checkbox",
            checked: enabled,
            onChange: (e) => {
              if (e.target.checked) {
                updatePerformerRuleGenderBlock(ruleIdx, key, { mode: "min", value: 1 });
              } else {
                updatePerformerRuleGenderBlock(ruleIdx, key, null);
              }
            },
          }),
          React.createElement("span", null, label)
        ),
        enabled
          ? React.createElement(
              "select",
              {
                className: "power-tagger-rules-pr-mode-select",
                value: mode,
                onChange: (e) =>
                  updatePerformerRuleGenderBlock(ruleIdx, key, { mode: e.target.value }),
              },
              React.createElement("option", { value: "exact" }, "exactly"),
              React.createElement("option", { value: "min" }, "≥"),
              React.createElement("option", { value: "max" }, "≤"),
              React.createElement("option", { value: "range" }, "between"),
              React.createElement("option", { value: "any" }, "any")
            )
          : null,
        enabled && mode !== "any"
          ? React.createElement("input", {
              type: "number",
              className: "power-tagger-rules-pr-num-input",
              value: value,
              min: 0,
              step: 1,
              onChange: (e) => {
                const v = parseInt(e.target.value, 10);
                updatePerformerRuleGenderBlock(ruleIdx, key, {
                  value: Number.isFinite(v) ? v : 0,
                });
              },
            })
          : null,
        enabled && mode === "range"
          ? React.createElement(
              "span",
              { className: "power-tagger-rules-pr-range-sep" },
              "…"
            )
          : null,
        enabled && mode === "range"
          ? React.createElement("input", {
              type: "number",
              className: "power-tagger-rules-pr-num-input",
              value: max,
              min: 0,
              step: 1,
              onChange: (e) => {
                const v = parseInt(e.target.value, 10);
                updatePerformerRuleGenderBlock(ruleIdx, key, {
                  max: Number.isFinite(v) ? v : 0,
                });
              },
            })
          : null
      );
    }

    // Render a single group inside a performer rule. Includes label
    // input, TagSelect multi for tags, cap inputs, and a remove button.
    function renderPerformerRuleGroup(ruleIdx, group, gIdx, direction) {
      const isAtLeast = direction === "at-least";
      const tagObjs = (group.tags || [])
        .map((id) => tagsById[String(id)])
        .filter(Boolean);
      const cap = group.cap || {};
      return React.createElement(
        "div",
        {
          key: group.id || gIdx,
          className: "power-tagger-rules-pr-group",
        },
        React.createElement(
          "div",
          { className: "power-tagger-rules-pr-group-head" },
          React.createElement("input", {
            type: "text",
            className: "form-control power-tagger-rules-pr-group-label",
            value: group.label || "",
            placeholder: `Group ${gIdx + 1} label (optional, e.g. "Physical size")`,
            onChange: (e) =>
              updatePerformerRuleGroup(ruleIdx, gIdx, { label: e.target.value }),
          }),
          React.createElement(
            "button",
            {
              type: "button",
              className: "btn btn-sm btn-danger",
              onClick: () => {
                if (window.confirm(`Delete this group?`)) {
                  removePerformerRuleGroup(ruleIdx, gIdx);
                }
              },
              title: "Delete group",
            },
            "×"
          )
        ),
        React.createElement(
          "div",
          { className: "power-tagger-rules-pr-group-tags" },
          TS
            ? React.createElement(TS, {
                values: tagObjs,
                isMulti: true,
                onSelect: (items) => {
                  const ids = (items || []).map((x) => String(x.id));
                  updatePerformerRuleGroup(ruleIdx, gIdx, { tags: ids });
                },
                menuPortalTarget: document.body,
                menuPlacement: "auto",
                styles: { menuPortal: (base) => ({ ...base, zIndex: 100000 }) },
                placeholder: "Pick tags for this group...",
              })
            : React.createElement(
                "div",
                { style: { color: "#888", fontSize: 11 } },
                "Tag picker loading..."
              )
        ),
        React.createElement(
          "div",
          { className: "power-tagger-rules-pr-group-cap" },
          React.createElement(
            "label",
            { className: "power-tagger-rules-pr-limit-cell" },
            React.createElement("span", null, "Base"),
            React.createElement("input", {
              type: "number",
              className: "power-tagger-rules-pr-num-input",
              value: toInt(cap.base, 0),
              min: 0,
              step: 1,
              onChange: (e) => {
                const v = parseInt(e.target.value, 10);
                updatePerformerRuleGroupCap(ruleIdx, gIdx, {
                  base: Number.isFinite(v) ? v : 0,
                });
              },
            })
          ),
          React.createElement(
            "label",
            { className: "power-tagger-rules-pr-limit-cell" },
            React.createElement("span", null, "per Male"),
            React.createElement("input", {
              type: "number",
              className: "power-tagger-rules-pr-num-input",
              value: toInt(cap.perMale, 0),
              min: 0,
              step: 1,
              onChange: (e) => {
                const v = parseInt(e.target.value, 10);
                updatePerformerRuleGroupCap(ruleIdx, gIdx, {
                  perMale: Number.isFinite(v) ? v : 0,
                });
              },
            })
          ),
          React.createElement(
            "label",
            { className: "power-tagger-rules-pr-limit-cell" },
            React.createElement("span", null, "per Female"),
            React.createElement("input", {
              type: "number",
              className: "power-tagger-rules-pr-num-input",
              value: toInt(cap.perFemale, 0),
              min: 0,
              step: 1,
              onChange: (e) => {
                const v = parseInt(e.target.value, 10);
                updatePerformerRuleGroupCap(ruleIdx, gIdx, {
                  perFemale: Number.isFinite(v) ? v : 0,
                });
              },
            })
          ),
          React.createElement(
            "label",
            { className: "power-tagger-rules-pr-limit-cell" },
            React.createElement("span", null, "per Other"),
            React.createElement("input", {
              type: "number",
              className: "power-tagger-rules-pr-num-input",
              value: toInt(cap.perOther, 0),
              min: 0,
              step: 1,
              onChange: (e) => {
                const v = parseInt(e.target.value, 10);
                updatePerformerRuleGroupCap(ruleIdx, gIdx, {
                  perOther: Number.isFinite(v) ? v : 0,
                });
              },
            })
          ),
          isAtLeast
            ? null
            : React.createElement(
                "label",
                { className: "power-tagger-rules-pr-limit-cell" },
                React.createElement("span", null, "Hard cap"),
                React.createElement("input", {
                  type: "number",
                  className: "power-tagger-rules-pr-num-input",
                  value: (() => {
                    const hc = toInt(cap.hardCap, null);
                    return (hc !== null && hc > 0) ? hc : "";
                  })(),
                  min: 0,
                  step: 1,
                  placeholder: "\u2014",
                  onChange: (e) => {
                    const raw = e.target.value;
                    if (raw === "") {
                      updatePerformerRuleGroupCap(ruleIdx, gIdx, { hardCap: null });
                      return;
                    }
                    const v = parseInt(raw, 10);
                    updatePerformerRuleGroupCap(ruleIdx, gIdx, {
                      hardCap: Number.isFinite(v) && v > 0 ? v : null,
                    });
                  },
                })
              )
        ),
        React.createElement(
          "div",
          { className: "power-tagger-rules-pr-condition-hint" },
          isAtLeast
            ? "Required count = Base + (per-M \u00D7 males) + (per-F \u00D7 females) + (per-O \u00D7 others). At-least 0 is a no-op."
            : "Cap = Base + (per-M \u00D7 males) + (per-F \u00D7 females) + (per-O \u00D7 others). Hard cap is an absolute ceiling; leave blank for none."
        )
      );
    }

    function renderPerformerRuleRow(rule, idx) {
      const collapsed = collapsedPerformerRuleRows.has(String(idx));
      const summary = summarisePerformerRule(rule);
      const displayName = rule.name && rule.name.trim() ? rule.name : "(unnamed)";

      // Header — name + summary + Remove. Matches the shared cond-rowhead
      // pattern used by cascades and conditionals for visual parity.
      // Up/Down arrows were dropped because rule order has no semantic
      // effect (evaluatePerformerRules iterates each rule independently;
      // there's no first-match-wins or override). Name appears in the
      // summary span to keep the layout consistent.
      const header = React.createElement(
        "div",
        {
          className: "power-tagger-cond-rowhead",
          onClick: () => togglePerformerRuleCollapse(idx),
          role: "button",
          tabIndex: 0,
        },
        React.createElement(
          "span",
          { className: "power-tagger-cond-rowhead-toggle" },
          collapsed ? "▶\uFE0E" : "▼\uFE0E"
        ),
        React.createElement(
          "span",
          { className: "power-tagger-cond-rowhead-summary" },
          React.createElement(
            "strong",
            { className: "power-tagger-rules-pr-row-name" },
            displayName
          ),
          ` \u00B7 when ${summary.condStr} \u00B7 ${summary.directionLabel} \u00B7 ${summary.groupStr}`
        ),
        React.createElement(
          "button",
          {
            type: "button",
            className: "btn btn-sm btn-secondary power-tagger-cond-rowhead-remove",
            onClick: (e) => {
              e.stopPropagation();
              if (window.confirm(`Delete constraint rule "${displayName}"?`)) {
                removePerformerRule(idx);
              }
            },
            title: "Delete rule",
          },
          "Remove"
        )
      );

      if (collapsed) {
        return React.createElement(
          "div",
          { key: rule.id || idx, className: "power-tagger-cond-row" },
          header
        );
      }

      const groups = Array.isArray(rule.groups) ? rule.groups : [];

      const tagTriggerObjs = (rule.tagTriggers || [])
        .map((id) => tagsById[String(id)])
        .filter(Boolean);
      const hasTagTriggers = (rule.tagTriggers || []).length > 0;
      const hasPerfTriggers = !!rule.performerTriggers;
      const showMatchToggle = hasTagTriggers && hasPerfTriggers;
      const direction = rule.direction === "at-least" ? "at-least" : "at-most";

      const body = React.createElement(
        "div",
        { className: "power-tagger-cond-body" },
        // Name input
        React.createElement(
          "div",
          { className: "power-tagger-rules-pr-field" },
          React.createElement(
            "label",
            { className: "power-tagger-rules-pr-label" },
            "Name"
          ),
          React.createElement("input", {
            type: "text",
            className: "form-control power-tagger-rules-pr-name-input",
            value: rule.name || "",
            placeholder: "e.g. Tit Size constraints",
            onChange: (e) => updatePerformerRule(idx, { name: e.target.value }),
          })
        ),
        // Triggers — tag triggers (optional) + performer triggers (optional)
        React.createElement(
          "div",
          { className: "power-tagger-rules-pr-field" },
          React.createElement(
            "label",
            { className: "power-tagger-rules-pr-label" },
            "When (triggers)"
          ),
          // Tag triggers picker.
          React.createElement(
            "div",
            { className: "power-tagger-rules-pr-trigger-block" },
            React.createElement(
              "div",
              { className: "power-tagger-rules-pr-mode-label" },
              "Tag triggers (optional)"
            ),
            TS
              ? React.createElement(TS, {
                  values: tagTriggerObjs,
                  isMulti: true,
                  onSelect: (items) => {
                    const ids = (items || []).map((x) => String(x.id));
                    updatePerformerRule(idx, { tagTriggers: ids });
                  },
                  menuPortalTarget: document.body,
                  menuPlacement: "auto",
                  styles: { menuPortal: (base) => ({ ...base, zIndex: 100000 }) },
                  placeholder: "Pick one or more tags to gate this rule on...",
                })
              : React.createElement(
                  "div",
                  { style: { color: "#888", fontSize: 11 } },
                  "Tag picker loading..."
                )
          ),
          // Not-staged picker (negation gate). Dormant if any listed tag
          // is currently staged.
          React.createElement(
            "div",
            {
              className: "power-tagger-rules-pr-trigger-block",
              style: { marginTop: 8 },
            },
            React.createElement(
              "div",
              { className: "power-tagger-rules-pr-mode-label" },
              "Skip rule when ANY of these are staged (optional)"
            ),
            TS
              ? React.createElement(TS, {
                  values: (rule.notTags || [])
                    .map((id) => tagsById[String(id)])
                    .filter(Boolean),
                  isMulti: true,
                  onSelect: (items) => {
                    const ids = (items || []).map((x) => String(x.id));
                    updatePerformerRule(idx, { notTags: ids });
                  },
                  menuPortalTarget: document.body,
                  menuPlacement: "auto",
                  styles: { menuPortal: (base) => ({ ...base, zIndex: 100000 }) },
                  placeholder: "Pick tags whose presence cancels this rule...",
                })
              : null
          ),
          // Performer-trigger toggle.
          React.createElement(
            "label",
            {
              className: "power-tagger-cond-perf-toggle",
              style: { marginTop: 8 },
            },
            React.createElement("input", {
              type: "checkbox",
              checked: hasPerfTriggers,
              onChange: (e) => togglePerfTriggers(idx, e.target.checked),
            }),
            React.createElement(
              "span",
              null,
              "Also gate on performer counts"
            )
          ),
          hasPerfTriggers
            ? React.createElement(
                "div",
                {
                  className: "power-tagger-rules-pr-trigger-block",
                  style: { marginTop: 4 },
                },
                React.createElement(
                  "div",
                  { className: "power-tagger-rules-pr-mode-row" },
                  React.createElement(
                    "span",
                    { className: "power-tagger-rules-pr-mode-label" },
                    "Gender match"
                  ),
                  React.createElement(
                    "select",
                    {
                      className: "form-control power-tagger-rules-pr-mode-select",
                      value: (rule.performerTriggers && rule.performerTriggers.mode) || "all",
                      onChange: (e) =>
                        updatePerformerRuleCondition(idx, { mode: e.target.value }),
                    },
                    React.createElement("option", { value: "all" }, "all of"),
                    React.createElement("option", { value: "any" }, "any of")
                  )
                ),
                React.createElement(
                  "div",
                  { className: "power-tagger-rules-pr-gender-list" },
                  renderGenderBlockRow(idx, rule, "male",   "Male"),
                  renderGenderBlockRow(idx, rule, "female", "Female"),
                  renderGenderBlockRow(idx, rule, "other",  "Other (Any Trans)")
                ),
                React.createElement(
                  "div",
                  { className: "power-tagger-rules-pr-condition-hint" },
                  "Tick a gender to add it. Unticked means \u201Cdon\u2019t care\u201D. Performers with no gender set are excluded."
                )
              )
            : null,
          // Match (any/all) — only meaningful when both trigger sides exist.
          showMatchToggle
            ? React.createElement(
                "div",
                {
                  className: "power-tagger-rules-pr-mode-row",
                  style: { marginTop: 6 },
                },
                React.createElement(
                  "span",
                  { className: "power-tagger-rules-pr-mode-label" },
                  "Combine"
                ),
                React.createElement(
                  "select",
                  {
                    className: "form-control power-tagger-rules-pr-mode-select",
                    value: rule.triggerMode === "any" ? "any" : "all",
                    onChange: (e) =>
                      updatePerformerRule(idx, { triggerMode: e.target.value }),
                  },
                  React.createElement(
                    "option",
                    { value: "all" },
                    "all sides must match (AND)"
                  ),
                  React.createElement(
                    "option",
                    { value: "any" },
                    "any side may match (OR)"
                  )
                )
              )
            : null,
          React.createElement(
            "div",
            { className: "power-tagger-rules-pr-condition-hint" },
            "If both tag triggers and performer counts are set, choose how to combine them. Leave both empty to make the rule fire on every scene."
          )
        ),
        // Direction — at-most vs at-least
        React.createElement(
          "div",
          { className: "power-tagger-rules-pr-field" },
          React.createElement(
            "label",
            { className: "power-tagger-rules-pr-label" },
            "Direction"
          ),
          React.createElement(
            "select",
            {
              className: "form-control power-tagger-rules-pr-mode-select",
              value: direction,
              onChange: (e) =>
                updatePerformerRule(idx, { direction: e.target.value }),
            },
            React.createElement(
              "option",
              { value: "at-most" },
              "At most (cap is a ceiling \u2014 violates if too many staged)"
            ),
            React.createElement(
              "option",
              { value: "at-least" },
              "At least (cap is a floor \u2014 violates if too few staged)"
            )
          )
        ),
        // Groups
        React.createElement(
          "div",
          { className: "power-tagger-rules-pr-field" },
          React.createElement(
            "label",
            { className: "power-tagger-rules-pr-label" },
            "Tag groups"
          ),
          React.createElement(
            "div",
            { className: "power-tagger-rules-pr-condition-hint" },
            direction === "at-least"
              ? "Each group is a hand-picked list of tags. A group violates when FEWER of its tags are staged than the cap requires. Add multiple groups to enforce several independent requirements."
              : "Each group is a hand-picked list of tags. A group violates when more of its tags are staged than the cap allows. Add multiple groups to enforce several independent constraints inside one rule."
          ),
          ...groups.map((g, gi) => renderPerformerRuleGroup(idx, g, gi, direction)),
          React.createElement(
            "div",
            { style: { marginTop: 6 } },
            React.createElement(
              "button",
              {
                type: "button",
                className: "btn btn-sm btn-secondary",
                onClick: () => addPerformerRuleGroup(idx),
              },
              "+ Add group"
            )
          )
        )
      );

      return React.createElement(
        "div",
        { key: rule.id || idx, className: "power-tagger-cond-row" },
        header,
        body
      );
    }

    const performerRulesPanel = React.createElement(
      "div",
      { className: "power-tagger-rules-cascades power-tagger-rules-pr" },
      React.createElement(
        "div",
        {
          className: "power-tagger-rules-cascades-header",
          onClick: () => setPerformerRulesCollapsed((v) => !v),
          role: "button",
          tabIndex: 0,
        },
        React.createElement(
          "span",
          { className: "power-tagger-rules-cascades-toggle" },
          performerRulesCollapsed ? "▶\uFE0E" : "▼\uFE0E"
        ),
        React.createElement(
          "span",
          { className: "power-tagger-rules-cascades-title" },
          "Constraint Rules"
        ),
        React.createElement(
          "span",
          { className: "power-tagger-rules-cascades-count" },
          performerRules.length > 0 ? ` (${performerRules.length})` : ""
        ),
        React.createElement(
          "span",
          { className: "power-tagger-rules-cascades-hint" },
          " \u2014 flag scenes when the staged tags don't match per-scene constraints"
        )
      ),
      !performerRulesCollapsed
        ? React.createElement(
            "div",
            { className: "power-tagger-rules-cascades-body" },
            performerRules.length === 0
              ? React.createElement(
                  "div",
                  { className: "power-tagger-rules-cascades-empty" },
                  "No constraint rules defined for this configuration."
                )
              : performerRules.map((r, i) => renderPerformerRuleRow(r, i)),
            React.createElement(
              "button",
              {
                type: "button",
                className: "btn btn-sm btn-secondary power-tagger-rules-cascades-add",
                onClick: addPerformerRule,
              },
              "+ Add constraint rule"
            )
          )
        : null
    );

    // Right pane: the tree of cats/subs/tags for the active config.
    const tree = React.createElement(
      "div",
      { className: "power-tagger-rules-tree" },
      cats.map((cat) => {
        const catState = getCatCheckState(cat.name);
        const rule = getCatRule(cat.name);
        const subsHere = cat.subcategories && cat.subcategories.length > 0
          ? cat.subcategories
          : [""];
        const catRowCollapsed = collapsedCatRows.has(cat.name);
        return React.createElement(
          "div",
          {
            key: cat.name,
            className: "power-tagger-rules-cat",
            style: { borderLeftColor: cat.colour || "#5a6e85" },
          },
          // Category header — click anywhere on it (except interactive
          // bits) toggles collapse. We stopPropagation on the checkbox
          // and Max input so editing them doesn't also collapse.
          React.createElement(
            "div",
            {
              className: "power-tagger-rules-cat-header",
              onClick: () => toggleInSet(setCollapsedCatRows, cat.name),
              role: "button",
              tabIndex: 0,
            },
            React.createElement(
              "span",
              { className: "power-tagger-rules-cat-toggle" },
              catRowCollapsed ? "▶\uFE0E" : "▼\uFE0E"
            ),
            // checkbox click handler already stopPropagation's (see
            // `checkbox` builder above) — collapse won't fire.
            checkbox(catState, () => toggleCategory(cat.name)),
            React.createElement(
              "span",
              { className: "power-tagger-rules-cat-name" },
              cat.name
            ),
            React.createElement(
              "label",
              {
                className: "power-tagger-rules-max",
                onClick: (e) => e.stopPropagation(),
              },
              "Max selections: ",
              React.createElement("input", {
                type: "number",
                min: "0",
                step: "1",
                value: rule.maxSelections,
                className: "power-tagger-rules-max-input",
                onChange: (e) => {
                  const v = parseInt(e.target.value, 10);
                  patchCatRule(cat.name, { maxSelections: Number.isFinite(v) && v >= 0 ? v : 0 });
                },
                onClick: (e) => e.stopPropagation(),
              }),
              React.createElement(
                "span",
                { className: "power-tagger-rules-max-hint" },
                " (0 = unlimited)"
              )
            )
          ),
          // Subs — only rendered when the cat row is expanded.
          catRowCollapsed
            ? null
            : subsHere.map((sub) => {
            const list = (grouped[cat.name] || {})[sub] || [];
            if (list.length === 0) return null;
            const subState = getSubCheckState(cat.name, sub);
            const collapsed = isSubCollapsed(cat.name, sub);
            const isUnnamed = !sub;
            return React.createElement(
              "div",
              { key: sub || "_nosub", className: "power-tagger-rules-sub" },
              !isUnnamed
                ? React.createElement(
                    "div",
                    {
                      className: "power-tagger-rules-sub-header",
                      onClick: () => toggleSubCollapsed(cat.name, sub),
                    },
                    React.createElement(
                      "span",
                      { className: "power-tagger-rules-sub-toggle" },
                      // U+FE0E forces text presentation on the right-
                      // pointing triangle (otherwise rendered as colour
                      // emoji on Firefox/Windows).
                      collapsed ? "▶\uFE0E" : "▼\uFE0E"
                    ),
                    checkbox(subState, () => toggleSub(cat.name, sub)),
                    React.createElement(
                      "span",
                      { className: "power-tagger-rules-sub-name" },
                      sub
                    ),
                    React.createElement(
                      "span",
                      { className: "power-tagger-rules-sub-count" },
                      ` (${list.length})`
                    ),
                    // Per-sub max. When 0 / unset, falls back to the
                    // category-level max at runtime. We stopPropagation
                    // on the input + label so editing this value doesn't
                    // also toggle the collapse state.
                    React.createElement(
                      "label",
                      {
                        className: "power-tagger-rules-submax",
                        onClick: (e) => e.stopPropagation(),
                      },
                      "Max:",
                      React.createElement("input", {
                        type: "number",
                        min: "0",
                        step: "1",
                        value: getSubMax(cat.name, sub),
                        className: "power-tagger-rules-max-input",
                        onChange: (e) => {
                          const v = parseInt(e.target.value, 10);
                          setSubMax(cat.name, sub, Number.isFinite(v) && v >= 0 ? v : 0);
                        },
                        onClick: (e) => e.stopPropagation(),
                      })
                    )
                  )
                : null,
              !collapsed
                ? React.createElement(
                    "div",
                    { className: "power-tagger-rules-tags" },
                    list.map((t) => {
                      const hidden = isTagHidden(cat.name, t.id);
                      return React.createElement(
                        "label",
                        {
                          key: t.id,
                          className: "power-tagger-rules-tag",
                        },
                        React.createElement("input", {
                          type: "checkbox",
                          className: "power-tagger-rules-checkbox",
                          checked: !hidden,
                          onChange: () => setTagsHidden(cat.name, [t.id], !hidden),
                        }),
                        React.createElement(
                          "span",
                          { className: "power-tagger-rules-tag-name" },
                          t.name
                        )
                      );
                    })
                  )
                : null
            );
          })
        );
      })
    );

    // Footer.
    const footer = React.createElement(
      "div",
      { className: "power-tagger-rules-footer" },
      React.createElement(
        "span",
        { className: "power-tagger-rules-status" },
        dirty ? "Unsaved changes" : "All changes saved"
      ),
      React.createElement(
        "button",
        {
          type: "button",
          className: "btn btn-secondary",
          onClick: onCancel,
        },
        "Cancel"
      ),
      React.createElement(
        "button",
        {
          type: "button",
          className: "btn btn-primary",
          onClick: onSave,
          disabled: !dirty || saving,
        },
        saving ? "Saving..." : "Save"
      )
    );

    // v0.11.5: confirm-discard prompt for closing the rules editor
    // with unsaved rule edits. Same chrome as tcJumpModal but two
    // buttons.
    const confirmCloseModal = confirmCloseOpen
      ? ReactDOM.createPortal(
          React.createElement(
            "div",
            { className: "power-tagger-save-confirm-overlay" },
            React.createElement(
              "div",
              { className: "power-tagger-save-confirm-modal" },
              React.createElement(
                "div",
                { className: "power-tagger-save-confirm-header" },
                React.createElement(
                  "div",
                  { className: "power-tagger-save-confirm-icon" },
                  "\u26A0\uFE0E"
                ),
                React.createElement(
                  "div",
                  null,
                  React.createElement(
                    "div",
                    { className: "power-tagger-save-confirm-title" },
                    "Discard unsaved changes?"
                  ),
                  React.createElement(
                    "div",
                    { className: "power-tagger-save-confirm-sub" },
                    "You have unsaved rule edits. If you close now, " +
                      "they will be lost."
                  )
                )
              ),
              React.createElement(
                "div",
                { className: "power-tagger-save-confirm-footer" },
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-secondary",
                    onClick: () => setConfirmCloseOpen(false),
                  },
                  "Keep editing"
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-danger",
                    onClick: () => {
                      setConfirmCloseOpen(false);
                      onClose();
                    },
                  },
                  "Discard & close"
                )
              )
            )
          ),
          document.body
        )
      : null;

    // v0.11.5: import-confirm modal. Fires after the user picks a
    // backup file and it's successfully parsed. Replacing all rules
    // is destructive so we use the default red/warning variant of
    // the confirm chrome (no -resolved class).
    const importConfirmModal = pendingImport
      ? ReactDOM.createPortal(
          React.createElement(
            "div",
            { className: "power-tagger-save-confirm-overlay" },
            React.createElement(
              "div",
              { className: "power-tagger-save-confirm-modal" },
              React.createElement(
                "div",
                { className: "power-tagger-save-confirm-header" },
                React.createElement(
                  "div",
                  { className: "power-tagger-save-confirm-icon" },
                  "\u26A0\uFE0E"
                ),
                React.createElement(
                  "div",
                  null,
                  React.createElement(
                    "div",
                    { className: "power-tagger-save-confirm-title" },
                    "Replace all rules?"
                  ),
                  React.createElement(
                    "div",
                    { className: "power-tagger-save-confirm-sub" },
                    (() => {
                      // v0.14.0: prefer the configurations list count;
                      // fall back to ruleset keys for a pre-v2 backup.
                      const cfgCount = Array.isArray(
                        pendingImport.data.configurations
                      )
                        ? pendingImport.data.configurations.length
                        : Object.keys(
                            pendingImport.data.rulesets || {}
                          ).length;
                      const when = pendingImport.exportedAt
                        ? new Date(pendingImport.exportedAt).toLocaleString()
                        : "an unknown time";
                      return (
                        `This backup contains ${cfgCount} configuration${cfgCount === 1 ? "" : "s"} ` +
                        `(exported ${when}). Importing will REPLACE all your current rules. ` +
                        `Any unsaved edits will be lost.`
                      );
                    })()
                  )
                )
              ),
              React.createElement(
                "div",
                { className: "power-tagger-save-confirm-footer" },
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-secondary",
                    onClick: onImportCancel,
                    disabled: saving,
                  },
                  "Cancel"
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-danger",
                    onClick: onImportConfirm,
                    disabled: saving,
                  },
                  saving ? "Importing..." : "Replace all rules"
                )
              )
            )
          ),
          document.body
        )
      : null;

    // v0.11.2: Unsaved-changes confirm modal when clicking Edit Tag
    // Categories with unsaved rule edits. Three buttons:
    //   - Save & continue: save now, then jump.
    //   - Discard & continue: jump without saving (user's draft is lost).
    //   - Stay here: dismiss the prompt, no jump.
    // Rendered as a portal to <body> so it floats above the rules
    // editor modal (same pattern as the save-confirm modal in the
    // walkthrough).
    const tcJumpModal = tcJumpPromptOpen
      ? ReactDOM.createPortal(
          React.createElement(
            "div",
            { className: "power-tagger-save-confirm-overlay" },
            React.createElement(
              "div",
              { className: "power-tagger-save-confirm-modal" },
              React.createElement(
                "div",
                { className: "power-tagger-save-confirm-header" },
                React.createElement(
                  "div",
                  { className: "power-tagger-save-confirm-icon" },
                  "\u26A0\uFE0E"
                ),
                React.createElement(
                  "div",
                  null,
                  React.createElement(
                    "div",
                    { className: "power-tagger-save-confirm-title" },
                    "Unsaved changes"
                  ),
                  React.createElement(
                    "div",
                    { className: "power-tagger-save-confirm-sub" },
                    "You have unsaved rule edits. Save them before opening the Tag Categories editor?"
                  )
                )
              ),
              React.createElement(
                "div",
                { className: "power-tagger-save-confirm-footer" },
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-secondary",
                    onClick: onJumpStay,
                  },
                  "Stay here"
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-danger",
                    onClick: onJumpDiscardAndContinue,
                  },
                  "Discard & continue"
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-primary",
                    onClick: onJumpSaveAndContinue,
                    disabled: saving,
                  },
                  saving ? "Saving..." : "Save & continue"
                )
              )
            )
          ),
          document.body
        )
      : null;

    return React.createElement(
      "div",
      { className: "power-tagger-rules-layout" },
      React.createElement(
        "div",
        { className: "power-tagger-rules-main" },
        leftRail,
        React.createElement(
          "div",
          { className: "power-tagger-rules-pane" },
          // Active configuration header. Shows which config the right
          // pane is currently editing, in the config's own colour, so
          // the rail selection is mirrored on the main side. Especially
          // useful when a config name is long enough to ellipsis-
          // truncate in the rail -- here it gets full width.
          activeConfigTag
            ? React.createElement(
                "div",
                {
                  className: "power-tagger-rules-pane-header",
                  style: {
                    borderLeftColor:
                      activeConfigTag.colour || DEFAULT_CONFIG_COLOUR,
                  },
                },
                React.createElement(
                  "h2",
                  {
                    className: "power-tagger-rules-pane-title",
                    style: {
                      color:
                        activeConfigTag.colour || DEFAULT_CONFIG_COLOUR,
                    },
                  },
                  activeConfigTag.name
                ),
                activeConfigHasTag
                  ? React.createElement(
                      "span",
                      {
                        className: "power-tagger-rules-pane-tagicon",
                        title:
                          "Linked tag: " +
                          ((activeConfigLinkedTag && activeConfigLinkedTag.name) ||
                            String(activeConfigTag.tagId)),
                      },
                      React.createElement(
                        "svg",
                        {
                          viewBox: "0 0 512 512",
                          xmlns: "http://www.w3.org/2000/svg",
                          "aria-hidden": "true",
                          focusable: "false",
                        },
                        React.createElement("path", {
                          d: "M32.5 96l0 149.5c0 17 6.7 33.3 18.7 45.3l192 192c25 25 65.5 25 90.5 0L483.2 333.3c25-25 25-65.5 0-90.5l-192-192C279.2 38.7 263 32 246 32L96.5 32c-35.3 0-64 28.7-64 64zm112 16a32 32 0 1 1 0 64 32 32 0 1 1 0-64z",
                          ref: (el) => {
                            if (el)
                              el.style.setProperty(
                                "fill",
                                activeConfigTag.colour || DEFAULT_CONFIG_COLOUR,
                                "important"
                              );
                          },
                        })
                      )
                    )
                  : React.createElement(
                      "span",
                      { className: "power-tagger-rules-pane-notag" },
                      "no tag"
                    )
              )
            : null,
          optionsPanel,
          // Rules group — wraps the three meta-rule sections (cascades,
          // conditionals, constraint rules) in a labeled container so
          // they read as distinct from the tag-category list below.
          // The label + grouped container give a clear "these are
          // different concepts" signal at-a-glance.
          React.createElement(
            "div",
            { className: "power-tagger-rules-section" },
            React.createElement(
              "div",
              { className: "power-tagger-rules-section-label" },
              "Rules"
            ),
            React.createElement(
              "div",
              { className: "power-tagger-rules-section-body" },
              autoSelectPanel,
              cascadesPanel,
              conditionalsPanel,
              performerRulesPanel
            )
          ),
          // Categories group — same labeling treatment for symmetry.
          React.createElement(
            "div",
            { className: "power-tagger-rules-section" },
            React.createElement(
              "div",
              { className: "power-tagger-rules-section-label" },
              "Categories"
            ),
            React.createElement(
              "div",
              { className: "power-tagger-rules-section-body" },
              tree
            )
          )
        )
      ),
      footer,
      tcJumpModal,
      confirmCloseModal,
      importConfirmModal,
      configEditorModal
    );
  }

  // RulesEditorModalHost — a second hidden React mount that listens for the
  // settings event and opens the editor inside a portal modal.
  let activeRulesHostCount = 0;
  function RulesEditorModalHost() {
    const [open, setOpen] = React.useState(false);
    const [isActive, setIsActive] = React.useState(false);
    // v0.11.5: shared ref the body fills with its requestClose gate.
    const requestCloseRef = React.useRef(null);

    React.useEffect(() => {
      if (activeRulesHostCount > 0) return undefined;
      activeRulesHostCount += 1;
      setIsActive(true);
      function onOpen() { setOpen(true); }
      window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
      return () => {
        window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
        activeRulesHostCount -= 1;
      };
    }, []);

    if (!isActive) return null;

    function close() { setOpen(false); }

    function onCloseRequest() {
      const gate = requestCloseRef.current;
      if (typeof gate === "function") gate();
      else close();
    }

    return React.createElement(
      PortalModal,
      {
        show: open,
        onHide: close,
        onCloseRequest: onCloseRequest,
        title: "Edit Power Tagger Rules",
      },
      open
        ? React.createElement(
            CrashBoundary,
            { label: "Rules Editor" },
            React.createElement(RulesEditorBody, {
              onClose: close,
              requestCloseRef: requestCloseRef,
            })
          )
        : null
    );
  }

  // Mount the host inside the navbar (same pattern as our other plugins).
  if (PluginApi.patch && PluginApi.patch.before) {
    PluginApi.patch.before("MainNavBar.UtilityItems", function (props) {
      return [
        Object.assign({}, props, {
          children: React.createElement(
            React.Fragment,
            null,
            React.createElement(ModalHost, null),
            React.createElement(RulesEditorModalHost, null),
            props.children
          ),
        }),
      ];
    });
  }

  // -------------------------------------------------------------------------
  // Observer + bootstrap
  // -------------------------------------------------------------------------
  let injectionPending = false;
  function scheduleInjection() {
    if (injectionPending) return;
    injectionPending = true;
    requestAnimationFrame(() => {
      injectionPending = false;
      try {
        injectLaunchButtonIfNeeded();
      } catch (err) {
        console.error("[power-tagger] launch button injection error:", err);
      }
      try {
        injectScenesToolbarButtonIfNeeded();
      } catch (err) {
        console.error("[power-tagger] toolbar button injection error:", err);
      }
      try {
        injectSettingsButtonHandlerIfNeeded();
      } catch (err) {
        console.error("[power-tagger] settings button injection error:", err);
      }
    });
  }

  function startObserver() {
    if (!document.body) {
      setTimeout(startObserver, 50);
      return;
    }
    scheduleInjection();
    const observer = new MutationObserver(() => scheduleInjection());
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver);
  } else {
    startObserver();
  }

  console.log("[power-tagger] 0.14.0 loaded");
})();
