"use strict";

// =============================================================================
// Tag Categories plugin — 0.3.0
//
// What 0.3.0 adds on top of 0.2.x:
//   - Tag picker pill colouring: every TagSelect picker (the react-select
//     multi-value widget used on edit forms across Stash + inside our other
//     plugins) gets its staged-tag pills tinted with the tag's category
//     colour. Tags with no assignment OR with an orphaned assignment are
//     left untouched, falling back to whatever Stash/theme default is.
//   - Text colour inside the pill auto-picks black or white based on the
//     pill background's perceived luminance (reuses pickTextColour).
//   - Tinting is opt-out via CSS only — the JS sets two CSS custom
//     properties (--tc-bg / --tc-fg) and a marker attribute; CSS in
//     tag-categories.css gates the override behind that marker.
//   - Config-changed event dispatched on every write so the cached
//     assignments/taxonomy refresh when the user edits in another tab
//     (or in the same tab via the rules editor).
//
// What 0.2.0 added on top of Phase 1:
//   - YAML declares a STRING setting "taxonomyEditor" which causes Stash to
//     render an "Edit" button in our row on Settings → Plugins.
//   - We intercept the Edit button's click via DOM and open our own custom
//     modal instead of Stash's built-in tiny text-input modal.
//   - The modal contains a two-column editor: categories on the left,
//     subcategories of the selected category on the right.
//     Per category: rename, delete, reorder, toggle hidden-in-picker.
//     Per subcategory: rename, delete, reorder.
//   - Add new category / subcategory buttons.
//   - JSON import/export for power users and sharing.
//   - On rename/delete, count existing tag assignments and confirm before
//     applying. Cascading update: renames update assignments; deletes orphan
//     the assignment (which then resolves to no-category at read time).
//   - The plugin's taxonomy comes from plugin config if present, else the
//     hard-coded DEFAULT_TAXONOMY. First save through the modal promotes
//     it to user-controlled.
//
// Inherited from Phase 1:
//   - Tag edit form gets two new fields (Tag Category + Sub-Category) above
//     Parent Tags. Save hook reads dropdowns and writes plugin config.
//
// Storage model:
//   configuration.plugins["tag-categories"] = {
//     assignments: { "<tagId>": { category, subcategory } },
//     taxonomy:    { categories: [ { name, hidden, subcategories: [str] } ] },
//   }
// =============================================================================

(() => {
  const PluginApi = window.PluginApi;
  if (!PluginApi) {
    console.error("[tag-categories] window.PluginApi not found");
    return;
  }

  const GQL = PluginApi.GQL || {};
  const React = PluginApi.React;
  const ReactDOM = PluginApi.ReactDOM;
  const PLUGIN_ID = "tag-categories";
  const OPEN_EVENT_NAME = "tag-categories:open-settings";
  // Fired whenever assignments OR taxonomy are written. Listeners (notably
  // the picker-pill colourer) invalidate caches on this.
  const CONFIG_CHANGED_EVENT_NAME = "tag-categories:config-changed";

  // ---------------------------------------------------------------------------
  // Default taxonomy — used until the user saves something via the modal.
  // After that, plugin config's taxonomy takes precedence.
  //
  // Each category has a colour (hex). These defaults are chosen to be:
  //   - Visually distinct (cycle through hues without adjacent collisions)
  //   - Dark enough that light text reads cleanly on top
  //   - Muted, not neon — matches Stash's overall dark theme
  // Hidden categories get neutral greys (they don't appear in the picker
  // so colour matters less but we still default sensibly).
  // ---------------------------------------------------------------------------
  // A deliberately small, generic starter. It is meant to be edited:
  // the first save through the modal promotes it to user-controlled
  // config, after which this default is no longer consulted. A few
  // categories carry example subcategories to show how nesting works.
  const DEFAULT_TAXONOMY = {
    categories: [
      { name: "Scene Type",                hidden: false, colour: "#c8362a", subcategories: [] },
      { name: "Female Performer Traits",   hidden: false, colour: "#ee7090", subcategories: [
        "Body Type", "Hair Colour", "Features", "Age"
      ]},
      { name: "Male Performer Traits",     hidden: false, colour: "#3d95d3", subcategories: [
        "Body Type", "Hair Colour", "Features"
      ]},
      { name: "Acts",                      hidden: false, colour: "#55a864", subcategories: [
        "Penetration", "Oral", "Other"
      ]},
      { name: "Finish",                    hidden: false, colour: "#ffffff", subcategories: [] },
      { name: "Outfit & Wardrobe",         hidden: false, colour: "#f3c42a", subcategories: [] },
      { name: "Location",                  hidden: false, colour: "#a8efea", subcategories: [] },
      { name: "Other",                     hidden: true,  colour: "#586b89", subcategories: [] },
    ],
  };

  // Fallback colour used when a category was added without one specified,
  // or for the "uncategorised" virtual badge state.
  const DEFAULT_CATEGORY_COLOUR = "#5a6e85";
  const UNCATEGORISED_COLOUR = "#555555";

  // Marker class / IDs for our injected tag-edit form rows
  const INJECTED_CLASS = "tag-categories-row";
  const ROW_CAT_ID = "tag-categories-cat-row";
  const ROW_SUB_ID = "tag-categories-sub-row";
  const SELECT_CAT_ID = "tag-categories-cat-select";
  const SELECT_SUB_ID = "tag-categories-sub-select";
  const SAVE_HOOK_MARKER = "data-tag-categories-hooked";

  // Synchronous in-flight guard for injectTagEditFieldsIfNeeded. The function
  // has an `await readPluginConfig()` between the ROW_CAT_ID idempotency check
  // and the actual DOM insertion, so two concurrent observer ticks could both
  // pass the check and both insert, producing duplicate rows. The flag is set
  // synchronously before the await and cleared in a finally; a second tick
  // sees it and bails. See injectTagEditFieldsIfNeeded.
  let editFieldInjectionInFlight = false;

  // Used to ferry a category/sub-category selection from the Add Tag page
  // (/tags/new) across the create-and-navigate transition to the new tag's
  // detail page, where we finally know the tag ID and can write the
  // assignment. See attachAddTagSaveHook + applyPendingAssignmentIfNeeded.
  //
  // TTL is deliberately tight: a successful Stash create-and-redirect
  // completes in well under a second. If the create fails and the user
  // manually clicks through to a different existing tag instead, we'd
  // rather drop the pending entry than apply it to the wrong tag.
  const PENDING_ASSIGNMENT_KEY = "tag-categories-pending-assignment";
  const PENDING_ASSIGNMENT_TTL_MS = 5 * 1000;

  // ---------------------------------------------------------------------------
  // GraphQL helpers — raw fetch for reads outside React, hooks for writes
  // inside React components.
  // ---------------------------------------------------------------------------
  async function gqlFetch(query, variables) {
    const r = await fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const json = await r.json();
    if (json.errors && json.errors.length) {
      throw new Error("GraphQL: " + json.errors.map((e) => e.message).join("; "));
    }
    return json.data;
  }

  // Read full plugin config slice (assignments + taxonomy). Falls back to
  // defaults if absent.
  async function readPluginConfig() {
    const data = await gqlFetch(`query { configuration { plugins } }`, {});
    const allPlugins = data?.configuration?.plugins || {};
    const ours = allPlugins[PLUGIN_ID] || {};
    return {
      assignments: ours.assignments || {},
      taxonomy: ours.taxonomy || DEFAULT_TAXONOMY,
      // v0.3.3: BOOLEAN setting controlling whether tryReorderTagBadges()
      // runs. Stash may return booleans as strings ("true"/"false") depending
      // on version; coerce defensively. Defaults to false so first-install
      // behaviour matches pre-0.3.3.
      reorderTagBadges:
        ours.reorderTagBadges === true || ours.reorderTagBadges === "true",
      // v1.4.0: BOOLEAN gating whether category/sub-category pills get
      // their click handlers and link styling. Default false so a fresh
      // install matches the pre-v1.3.0 "static colour pill" behaviour
      // (rendering the pills is cheap; the click-target machinery is
      // what the user wanted to be able to disable).
      clickableCategoryPills:
        ours.clickableCategoryPills === true ||
        ours.clickableCategoryPills === "true",
    };
  }

  // v1.4.3: cached wrapper around readPluginConfig with a short TTL.
  //
  // The per-tick injection functions (tryInjectTagCardBadges,
  // injectTagDetailDisplayIfNeeded) ran readPluginConfig on every observer
  // animation frame, which is ~60 GraphQL queries per second per function.
  // On a tag detail page or /tags listing that was ~120 queries/second,
  // enough to saturate Stash's GraphQL endpoint and starve other fetches
  // (tag detail data, hover-popover content) so the page appeared to
  // "infinitely load". This cache collapses concurrent callers onto one
  // in-flight promise and reuses the result for TTL milliseconds.
  //
  // Write paths (writeAssignment, writeTaxonomy, etc.) keep using the
  // uncached readPluginConfig - they need a fresh read-modify-write.
  // CONFIG_CHANGED_EVENT_NAME invalidates the cache so plugin-config
  // changes propagate immediately to subsequent reads.
  const CONFIG_CACHE_TTL_MS = 500;
  let configCacheValue = null;
  let configCacheExpiry = 0;
  let configCachePromise = null;

  async function readPluginConfigCached() {
    const now = (typeof performance !== "undefined" && performance.now)
      ? performance.now()
      : Date.now();
    if (configCacheValue && now < configCacheExpiry) {
      return configCacheValue;
    }
    if (configCachePromise) {
      return configCachePromise;
    }
    configCachePromise = (async () => {
      try {
        const result = await readPluginConfig();
        configCacheValue = result;
        configCacheExpiry =
          ((typeof performance !== "undefined" && performance.now)
            ? performance.now()
            : Date.now()) + CONFIG_CACHE_TTL_MS;
        return result;
      } finally {
        configCachePromise = null;
      }
    })();
    return configCachePromise;
  }

  function invalidatePluginConfigCache() {
    configCacheValue = null;
    configCacheExpiry = 0;
  }

  // v1.4.4: orphan-assignment cleanup. When a tag is deleted in Stash, our
  // assignments map and the per-category tagOrder arrays still reference
  // its now-dead ID. The taxonomy editor then renders an entry as
  // "(tag 313)" because tagNameFor can't resolve the ID to a name. Self-
  // heal on editor open: drop any assignment/tagOrder ID that isn't in
  // the live tag list. Returns the cleaned config plus a flag indicating
  // whether anything was actually removed (so the caller can decide
  // whether to persist).
  function pruneOrphanAssignments(cfg, allTags) {
    const validIds = new Set(
      (allTags || []).map((t) => String(t.id))
    );

    let changed = false;

    const cleanAssignments = {};
    for (const tid of Object.keys(cfg.assignments || {})) {
      if (validIds.has(String(tid))) {
        cleanAssignments[tid] = cfg.assignments[tid];
      } else {
        changed = true;
      }
    }

    const cleanCategories = ((cfg.taxonomy && cfg.taxonomy.categories) || []).map(
      (c) => {
        if (!c.tagOrder) return c;
        const cleanedOrder = {};
        for (const sub of Object.keys(c.tagOrder)) {
          const ids = c.tagOrder[sub];
          if (!Array.isArray(ids)) {
            cleanedOrder[sub] = ids;
            continue;
          }
          const filtered = ids.filter((id) => validIds.has(String(id)));
          if (filtered.length !== ids.length) changed = true;
          cleanedOrder[sub] = filtered;
        }
        return { ...c, tagOrder: cleanedOrder };
      }
    );

    return {
      cleaned: {
        ...cfg,
        assignments: cleanAssignments,
        taxonomy: { ...cfg.taxonomy, categories: cleanCategories },
      },
      changed,
    };
  }

  // Write the entire plugin config slice. Caller must read+merge first.
  async function writePluginConfig(slice) {
    await gqlFetch(
      `mutation($plugin_id: ID!, $input: Map!) {
        configurePlugin(plugin_id: $plugin_id, input: $input)
      }`,
      { plugin_id: PLUGIN_ID, input: slice }
    );
  }

  // Write assignment for a single tag, preserving the rest of plugin config.
  async function writeAssignment(tagId, category, subcategory) {
    const current = await readPluginConfig();
    if (!category) {
      delete current.assignments[String(tagId)];
    } else {
      current.assignments[String(tagId)] = {
        category,
        subcategory: subcategory || "",
      };
    }
    // v0.3.3: configurePlugin REPLACES the per-plugin object — write ALL
    // top-level keys back to avoid wiping reorderTagBadges (or any future
    // BOOLEAN setting Stash's settings UI may have toggled separately).
    await writePluginConfig({
      assignments: current.assignments,
      taxonomy: current.taxonomy,
      reorderTagBadges: current.reorderTagBadges,
      clickableCategoryPills: current.clickableCategoryPills,
    });
    window.dispatchEvent(new CustomEvent(CONFIG_CHANGED_EVENT_NAME));
  }

  // Write taxonomy, preserving assignments. Optionally pass an "updates"
  // function that runs against assignments before saving (e.g. for renames).
  async function writeTaxonomy(newTaxonomy, assignmentUpdater) {
    const current = await readPluginConfig();
    current.taxonomy = newTaxonomy;
    if (typeof assignmentUpdater === "function") {
      current.assignments = assignmentUpdater(current.assignments);
    }
    // v0.3.3: see writeAssignment — include reorderTagBadges so it survives.
    await writePluginConfig({
      assignments: current.assignments,
      taxonomy: current.taxonomy,
      reorderTagBadges: current.reorderTagBadges,
      clickableCategoryPills: current.clickableCategoryPills,
    });
  }

  // Write both taxonomy and assignments in one shot (used by the settings
  // modal's Save).
  async function writeTaxonomyAndAssignments(newTaxonomy, newAssignments) {
    // v0.3.3: read current first so we can preserve reorderTagBadges
    // through this write. configurePlugin REPLACES the per-plugin object;
    // without round-tripping the BOOLEAN, saving the taxonomy editor would
    // wipe whatever the user set in Stash → Settings → Plugins.
    const current = await readPluginConfig();
    await writePluginConfig({
      taxonomy: newTaxonomy,
      assignments: newAssignments,
      reorderTagBadges: current.reorderTagBadges,
      clickableCategoryPills: current.clickableCategoryPills,
    });
    window.dispatchEvent(new CustomEvent(CONFIG_CHANGED_EVENT_NAME));
  }

  // Fetch all tags from Stash. Returns [{ id, name }], sorted by name.
  // Used by the col-3 tag picker so the user can pick from uncategorised
  // tags. Raw fetch over the lazy-query hook because we want a known
  // selection set and to keep this outside React.
  async function fetchAllTags() {
    const data = await gqlFetch(
      `query { findTags(filter: { per_page: -1, sort: "name" }) { tags { id name } } }`,
      {}
    );
    return data?.findTags?.tags || [];
  }

  // ---------------------------------------------------------------------------
  // Tag-edit form injection (carried over from Phase 1, refactored to read
  // taxonomy from plugin config instead of hard-coded const).
  // ---------------------------------------------------------------------------

  // Tag ID from URL (/tags/<id>/edit). Returns null if not on edit page.
  function getCurrentTagId() {
    const m = window.location.pathname.match(/^\/tags\/(\d+)/);
    return m ? m[1] : null;
  }

  // True on the "create new tag" page (/tags/new). The form layout matches
  // /tags/<id>/edit closely enough that we can inject the same two rows;
  // see injectTagEditFieldsIfNeeded.
  function isAddTagPage() {
    return window.location.pathname === "/tags/new";
  }

  function hasSubcategories(taxonomy, catName) {
    const cat = taxonomy.categories.find((c) => c.name === catName);
    return !!(cat && cat.subcategories.length > 0);
  }

  function getSubcategories(taxonomy, catName) {
    const cat = taxonomy.categories.find((c) => c.name === catName);
    return cat ? cat.subcategories : [];
  }

  // Lookup a category's colour. Returns DEFAULT_CATEGORY_COLOUR if the
  // category exists but has no colour set (e.g. older taxonomy data without
  // the colour field). Returns UNCATEGORISED_COLOUR for unknown / empty cat.
  function getCategoryColour(taxonomy, catName) {
    if (!catName) return UNCATEGORISED_COLOUR;
    const cat = taxonomy.categories.find((c) => c.name === catName);
    if (!cat) return UNCATEGORISED_COLOUR;
    return cat.colour || DEFAULT_CATEGORY_COLOUR;
  }

  // Pick black or white text depending on the background colour's perceived
  // brightness. Uses WCAG's relative-luminance formula: a weighted sum of
  // sRGB channels approximating how the eye perceives lightness. Threshold
  // 0.55 chosen empirically — pure yellow #ffff00 (L≈0.93) goes black;
  // pure white #ffffff goes black; mid-grey #808080 (L≈0.22) stays white;
  // neon greens go black, dark teals stay white.
  function pickTextColour(bgHex) {
    if (!bgHex || typeof bgHex !== "string") return "#ffffff";
    const m = bgHex.match(/^#([0-9a-fA-F]{6})$/);
    if (!m) return "#ffffff";
    const hex = m[1];
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    // sRGB -> linear
    const toLin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const L = 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
    return L > 0.55 ? "#1a1a1a" : "#ffffff";
  }

  // ---------------------------------------------------------------------------
  // Pill picker — a custom dropdown that wraps a hidden <select>.
  //
  // The hidden <select> stays the canonical state holder. Reads (save hook,
  // validation, change-event listeners) all keep working against it as
  // before. The visible picker is a thin DOM layer over it: clicking an
  // option assigns .value on the select and dispatches a change event, so
  // every downstream listener fires the same way as a native select pick.
  //
  // Only one picker can be open at a time across the plugin. The shared
  // currentlyOpenPicker pointer + a document-level click listener handle
  // outside-clicks and cross-picker dismissal.
  // ---------------------------------------------------------------------------

  let currentlyOpenPicker = null;

  // v1.4.3: lastSeenClickablePills + the polling task that previously lived
  // here are gone. The config cache (readPluginConfigCached) now makes per-
  // tick reads cheap, so the idempotency checks in both injection functions
  // use the LIVE cached value instead of a stale module-level mirror, and
  // setting toggles propagate within the cache TTL (500ms) automatically.

  // Theme-adaptive picker styling: read live computed styles from a Stash
  // form control on the page and propagate them as CSS variables on :root,
  // so our picker tracks whichever theme is active (default vs glassy etc).
  // The .react-select__control on the same form is the closest analog to
  // our picker shape; a plain form-control input is a fallback when no
  // TagSelect is mounted.
  //
  // Runs every observer tick; the cheap guard short-circuits if the bg
  // hasn't changed since the last apply, so steady-state cost is one
  // querySelector + one getComputedStyle + one string compare.
  let lastAppliedStashBg = null;

  function applyStashFormStylingIfNeeded() {
    const ref =
      document.querySelector(".react-select__control") ||
      document.querySelector("input.form-control") ||
      null;
    if (!ref) return;
    const cs = getComputedStyle(ref);
    const bg = cs.backgroundColor;
    if (!bg || bg === "rgba(0, 0, 0, 0)") return; // skip transparent / unset
    if (bg === lastAppliedStashBg) return;
    lastAppliedStashBg = bg;

    const root = document.documentElement;
    root.style.setProperty("--tc-picker-bg", bg);
    root.style.setProperty("--tc-picker-text", cs.color);
    // Border deliberately NOT inherited - the reference is often the empty
    // Parent Tags react-select, which in glassy gets a red validation
    // border. Picker CSS forces border: transparent and uses the focus
    // ring for visible state.
  }

  function closeCurrentPicker() {
    if (!currentlyOpenPicker) return;
    currentlyOpenPicker.menu.hidden = true;
    currentlyOpenPicker.control.classList.remove("tag-categories-picker-open");
    currentlyOpenPicker = null;
  }

  function refreshPickerControl(controlEl, value, getColour, placeholderText) {
    while (controlEl.firstChild) controlEl.removeChild(controlEl.firstChild);

    if (!value) {
      const placeholder = document.createElement("span");
      placeholder.className = "tag-categories-picker-placeholder";
      placeholder.textContent = placeholderText;
      controlEl.appendChild(placeholder);
    } else {
      // Re-use the same pill class the detail page uses, so the picker
      // and the read-only display read identically.
      const pill = document.createElement("span");
      pill.className =
        "tag-categories-detail-pill tag-categories-picker-pill";
      const colour = getColour(value);
      pill.style.backgroundColor = colour;
      pill.style.color = pickTextColour(colour);
      pill.textContent = value;

      const x = document.createElement("span");
      x.className = "tag-categories-picker-pill-x";
      x.setAttribute("data-pill-x", "1");
      x.textContent = "×";
      pill.appendChild(x);

      controlEl.appendChild(pill);
    }

    const chevron = document.createElement("span");
    chevron.className = "tag-categories-picker-chevron";
    chevron.textContent = "▾";
    controlEl.appendChild(chevron);
  }

  // Menu lists only real options. Clearing is done by clicking the × on
  // the pill inside the control, matching Stash's TagSelect behaviour.
  // (The blankText parameter is unused; kept on the signature so existing
  // call sites stay compatible without a wider refactor.)
  function refreshPickerMenu(menuEl, selectEl, getColour /*, blankText */) {
    while (menuEl.firstChild) menuEl.removeChild(menuEl.firstChild);

    for (const opt of selectEl.options) {
      if (opt.value === "") continue;
      const row = document.createElement("div");
      row.className = "tag-categories-picker-option";
      row.setAttribute("data-value", opt.value);

      const pill = document.createElement("span");
      pill.className = "tag-categories-detail-pill";
      const colour = getColour(opt.value);
      pill.style.backgroundColor = colour;
      pill.style.color = pickTextColour(colour);
      pill.textContent = opt.textContent;

      row.appendChild(pill);
      menuEl.appendChild(row);
    }
  }

  function wirePicker({ wrapperEl, controlEl, menuEl, selectEl, getColour, placeholderText }) {
    const handle = { control: controlEl, menu: menuEl, wrapper: wrapperEl };

    controlEl.setAttribute("tabindex", "0");

    controlEl.addEventListener("click", (e) => {
      if (e.target.hasAttribute("data-pill-x")) return;
      if (menuEl.hidden) openMenu(); else closeCurrentPicker();
    });

    controlEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (menuEl.hidden) openMenu(); else closeCurrentPicker();
      } else if (e.key === "Escape") {
        closeCurrentPicker();
      }
    });

    wrapperEl.addEventListener("click", (e) => {
      if (e.target.hasAttribute("data-pill-x")) {
        e.stopPropagation();
        setValue("");
      }
    });

    menuEl.addEventListener("click", (e) => {
      const opt = e.target.closest(".tag-categories-picker-option");
      if (!opt) return;
      setValue(opt.getAttribute("data-value") || "");
    });

    // Mirror the hidden select's value into the picker control on every
    // change, regardless of source (user click, programmatic assignment +
    // dispatchEvent, or a parent-category change that cleared a stale sub).
    selectEl.addEventListener("change", () => {
      refreshPickerControl(controlEl, selectEl.value, getColour, placeholderText);
    });

    function openMenu() {
      if (currentlyOpenPicker && currentlyOpenPicker !== handle) {
        closeCurrentPicker();
      }
      menuEl.hidden = false;
      controlEl.classList.add("tag-categories-picker-open");
      currentlyOpenPicker = handle;
    }

    function setValue(newValue) {
      selectEl.value = newValue;
      selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      closeCurrentPicker();
    }
  }

  // Document-level dismiss: outside-click closes any open picker. Capture
  // phase so a click on (say) the modal backdrop closes before its own
  // handler runs.
  document.addEventListener(
    "click",
    (e) => {
      if (!currentlyOpenPicker) return;
      if (!currentlyOpenPicker.wrapper.contains(e.target)) {
        closeCurrentPicker();
      }
    },
    true
  );

  function buildCategoryRow(currentCat, taxonomy) {
    const row = document.createElement("div");
    row.id = ROW_CAT_ID;
    row.className = "form-group row " + INJECTED_CLASS;
    row.setAttribute("data-field", "tag-category");

    const label = document.createElement("label");
    label.className = "form-label col-form-label col-xl-2 col-sm-3";
    label.htmlFor = SELECT_CAT_ID;
    label.textContent = "Tag Category";

    const inputCol = document.createElement("div");
    inputCol.className = "col-xl-7 col-sm-9";

    // Hidden <select> - canonical state. The visible picker (below) mirrors
    // it; reads from the save hook etc. still go through this element.
    const select = document.createElement("select");
    select.id = SELECT_CAT_ID;
    select.className = "form-control input-control";
    select.style.display = "none";

    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "— Select Tag Category —";
    select.appendChild(blank);

    for (const cat of taxonomy.categories) {
      const opt = document.createElement("option");
      opt.value = cat.name;
      opt.textContent = cat.name + (cat.hidden ? "  (hidden in picker)" : "");
      if (cat.hidden) opt.setAttribute("data-hidden", "1");
      select.appendChild(opt);
    }
    select.value = currentCat || "";

    // Visible picker UI.
    const picker = document.createElement("div");
    picker.className = "tag-categories-picker";

    const control = document.createElement("div");
    control.className = "tag-categories-picker-control";

    const menu = document.createElement("div");
    menu.className = "tag-categories-picker-menu";
    menu.hidden = true;

    picker.appendChild(control);
    picker.appendChild(menu);

    const colourFor = (val) => getCategoryColour(taxonomy, val);
    const placeholder = "— Select Tag Category —";

    refreshPickerControl(control, currentCat || "", colourFor, placeholder);
    refreshPickerMenu(menu, select, colourFor, placeholder);
    wirePicker({
      wrapperEl: picker,
      controlEl: control,
      menuEl: menu,
      selectEl: select,
      getColour: colourFor,
      placeholderText: placeholder,
    });

    inputCol.appendChild(select);
    inputCol.appendChild(picker);
    row.appendChild(label);
    row.appendChild(inputCol);
    return row;
  }

  function buildSubCategoryRow(currentCat, currentSub, taxonomy) {
    const row = document.createElement("div");
    row.id = ROW_SUB_ID;
    row.className = "form-group row " + INJECTED_CLASS;
    row.setAttribute("data-field", "tag-sub-category");

    const label = document.createElement("label");
    label.className = "form-label col-form-label col-xl-2 col-sm-3";
    label.htmlFor = SELECT_SUB_ID;
    label.textContent = "Tag Sub-Category";

    const inputCol = document.createElement("div");
    inputCol.className = "col-xl-7 col-sm-9";

    // Hidden <select> - canonical state.
    const select = document.createElement("select");
    select.id = SELECT_SUB_ID;
    select.className = "form-control input-control";
    select.style.display = "none";

    populateSubOptions(select, currentCat, currentSub, taxonomy);

    // Visible picker UI.
    const picker = document.createElement("div");
    picker.className = "tag-categories-picker";

    const control = document.createElement("div");
    control.className = "tag-categories-picker-control";

    const menu = document.createElement("div");
    menu.className = "tag-categories-picker-menu";
    menu.hidden = true;

    picker.appendChild(control);
    picker.appendChild(menu);

    // Sub-categories inherit the parent category's colour. Read the live
    // cat select from the DOM each call so the colour updates when the user
    // switches categories without rebuilding the picker. Fall back to the
    // currentCat parameter when the lookup misses - the cat row is built
    // BEFORE it's inserted into the DOM, and buildSubCategoryRow runs the
    // first refreshPickerControl during the cat row's pre-insert phase, so
    // a naive DOM lookup returns null and we render the pill with the
    // uncategorised grey colour instead of the parent category's.
    const colourFor = () => {
      const catEl = document.getElementById(SELECT_CAT_ID);
      const activeCat = catEl ? catEl.value || "" : currentCat;
      return getCategoryColour(taxonomy, activeCat);
    };
    const placeholder = "— Select Sub-Category —";

    refreshPickerControl(control, select.value || "", colourFor, placeholder);
    refreshPickerMenu(menu, select, colourFor, placeholder);
    wirePicker({
      wrapperEl: picker,
      controlEl: control,
      menuEl: menu,
      selectEl: select,
      getColour: colourFor,
      placeholderText: placeholder,
    });

    inputCol.appendChild(select);
    inputCol.appendChild(picker);

    // Validation error slot (populated by validateSubcategory on Save).
    const error = document.createElement("div");
    error.className = "tag-categories-error";
    error.id = "tag-categories-sub-error";
    error.style.display = "none";
    inputCol.appendChild(error);

    row.appendChild(label);
    row.appendChild(inputCol);

    // The row is only shown when the selected category actually has
    // sub-categories defined. See updateSubRowVisibility.
    updateSubRowVisibility(row, currentCat, taxonomy);

    return row;
  }

  // Show or hide the sub-category row based on the current category state:
  //   - no category selected            -> hide
  //   - category has no sub-categories  -> hide
  //   - category has sub-categories     -> show
  function updateSubRowVisibility(row, catName, taxonomy) {
    if (!row) return;
    const shouldShow = !!catName && hasSubcategories(taxonomy, catName);
    row.style.display = shouldShow ? "" : "none";
  }

  function showSubError(message) {
    const err = document.getElementById("tag-categories-sub-error");
    if (!err) return;
    err.textContent = message;
    err.style.display = "block";
  }

  function clearSubError() {
    const err = document.getElementById("tag-categories-sub-error");
    if (!err) return;
    err.textContent = "";
    err.style.display = "none";
  }

  // Synchronous validation used by both Save hooks. Returns {valid, message}.
  // The check piggy-backs on the sub row's visibility: if the row is hidden,
  // no sub-cat is required (no category, or the category has no subs). If
  // it's visible, a non-empty selection is required.
  function validateSubcategory() {
    const subRow = document.getElementById(ROW_SUB_ID);
    const subSelect = document.getElementById(SELECT_SUB_ID);
    if (!subRow || !subSelect) return { valid: true };
    if (subRow.style.display === "none") return { valid: true };

    const sub = (subSelect.value || "").trim();
    if (!sub) {
      return {
        valid: false,
        message: "Sub-category is required for this category.",
      };
    }
    return { valid: true };
  }

  function populateSubOptions(selectEl, catName, currentSub, taxonomy) {
    while (selectEl.firstChild) selectEl.removeChild(selectEl.firstChild);
    const subs = getSubcategories(taxonomy, catName);

    if (!catName) {
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "(select a Tag Category first)";
      selectEl.appendChild(blank);
      selectEl.disabled = true;
      return;
    }

    if (subs.length === 0) {
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "(no sub-categories for this category)";
      selectEl.appendChild(blank);
      selectEl.disabled = true;
      return;
    }

    selectEl.disabled = false;

    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "— Select Sub-Category —";
    selectEl.appendChild(blank);

    for (const s of subs) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      selectEl.appendChild(opt);
    }

    if (currentSub && subs.indexOf(currentSub) !== -1) {
      selectEl.value = currentSub;
    } else {
      selectEl.value = "";
    }
  }

  function findParentTagsRow() {
    const rows = document.querySelectorAll("form .form-group.row");
    for (const r of rows) {
      const lbl = r.querySelector("label.form-label");
      if (lbl && (lbl.textContent || "").trim() === "Parent Tags") {
        return r;
      }
    }
    return null;
  }

  async function injectTagEditFieldsIfNeeded() {
    const tagId = getCurrentTagId();
    const isAdd = isAddTagPage();
    if (!tagId && !isAdd) return;

    const form = document.querySelector("form .form-group.row");
    if (!form) return;

    if (document.getElementById(ROW_CAT_ID)) return;

    // Synchronous guard against double-injection: if another tick has already
    // passed the ROW_CAT_ID check and is awaiting readPluginConfig, bail.
    // Without this, two concurrent ticks both pass the check, both await,
    // both insert -> duplicate rows. See editFieldInjectionInFlight comment.
    if (editFieldInjectionInFlight) return;
    editFieldInjectionInFlight = true;

    try {
      const parentRow = findParentTagsRow();
      if (!parentRow) return;

      let current = { category: "", subcategory: "" };
      let taxonomy = DEFAULT_TAXONOMY;
      try {
        const cfg = await readPluginConfig();
        taxonomy = cfg.taxonomy;
        // On /tags/new there's no existing assignment to load. Defaults stand.
        if (tagId) {
          const entry = cfg.assignments[String(tagId)];
          if (entry) {
            current = {
              category: entry.category || "",
              subcategory: entry.subcategory || "",
            };
          }
        }
      } catch (err) {
        console.warn("[tag-categories] failed to read plugin config:", err);
      }

      // Recheck after the await: DOM may have changed (form remount, another
      // tick that snuck past the guard somehow, etc).
      if (document.getElementById(ROW_CAT_ID)) return;
      if (!parentRow.isConnected || !parentRow.parentNode) return;

      const catRow = buildCategoryRow(current.category, taxonomy);
      const subRow = buildSubCategoryRow(current.category, current.subcategory, taxonomy);
      parentRow.parentNode.insertBefore(catRow, parentRow);
      parentRow.parentNode.insertBefore(subRow, parentRow);

      const catSelect = document.getElementById(SELECT_CAT_ID);
      const subSelect = document.getElementById(SELECT_SUB_ID);

      function enableSaveButton() {
        const saveBtns = document.querySelectorAll("button.save.btn.btn-success");
        for (const btn of saveBtns) {
          if ((btn.textContent || "").trim() !== "Save") continue;
          btn.disabled = false;
          btn.removeAttribute("disabled");
        }
      }

      catSelect.addEventListener("change", () => {
        const newCat = catSelect.value;
        populateSubOptions(subSelect, newCat, "", taxonomy);
        // Visibility follows the category: only show the sub-cat row when
        // the selected category actually has sub-categories defined.
        updateSubRowVisibility(subRow, newCat, taxonomy);
        // Changing the category clears any prior error - the user will
        // either pick a sub now or not need one for the new category.
        clearSubError();

        // Sub-picker maintenance: populateSubOptions rebuilt the hidden
        // sub-select's options (and cleared its value), but the picker is
        // a separate DOM layer that needs to be told. Refresh its menu
        // from the new options, then dispatch a change on the sub-select
        // so the picker's own change listener refreshes the control's
        // displayed pill/placeholder.
        const subPicker = subRow.querySelector(".tag-categories-picker");
        if (subPicker) {
          const subMenu = subPicker.querySelector(".tag-categories-picker-menu");
          const subColourFor = () => getCategoryColour(taxonomy, newCat);
          refreshPickerMenu(subMenu, subSelect, subColourFor, "— Select Sub-Category —");
        }
        subSelect.dispatchEvent(new Event("change", { bubbles: true }));

        enableSaveButton();
      });
      catSelect.addEventListener("focus", enableSaveButton);
      subSelect.addEventListener("change", () => {
        // A non-empty pick clears the validation error inline.
        if ((subSelect.value || "").trim()) clearSubError();
        enableSaveButton();
      });
      subSelect.addEventListener("focus", enableSaveButton);

      // Save-hook attachment is deliberately NOT done here. The Save button
      // can be mounted after our rows on /tags/new, and this function runs
      // only once per page (gated by ROW_CAT_ID). attachSaveHookIfNeeded runs
      // on every observer tick instead and uses SAVE_HOOK_MARKER for
      // idempotency.
    } finally {
      editFieldInjectionInFlight = false;
    }
  }

  // Locate the Save button(s) for the current tag form.
  //
  // On Stash's tag pages the Save button sits in a footer that's a SIBLING of
  // the <form>, not a child of it. Scoping the search to `closest("form")`
  // misses it entirely. So we walk up the DOM from our injected row,
  // checking each ancestor for a descendant Save button. First match wins.
  //
  // The classes are just "btn btn-success" - no "save" class on the actual
  // Save button, despite what the old selector assumed. We match by class +
  // exact text "Save" (not startsWith) to avoid grabbing a "Save and..."
  // split-button dropdown if Stash ever adds one.
  function findSaveButtonsForTagForm() {
    const rowCat = document.getElementById(ROW_CAT_ID);
    if (!rowCat) return [];

    const matchesSave = (b) =>
      b.classList.contains("btn-success") &&
      (b.textContent || "").trim() === "Save";

    let node = rowCat.parentElement;
    let steps = 0;
    while (node && node !== document.body && steps < 8) {
      const candidates = Array.from(node.querySelectorAll("button")).filter(matchesSave);
      if (candidates.length > 0) return candidates;
      node = node.parentElement;
      steps++;
    }

    // Last-ditch fallback: scan the whole document. Cheap and only fires if
    // the page layout has moved the Save button into a totally detached
    // surface (overlay, portal, etc.). The hook marker still prevents
    // double-attach if a stale Save button matches.
    return Array.from(document.querySelectorAll("button")).filter(matchesSave);
  }

  // Run every observer tick. Idempotent via SAVE_HOOK_MARKER on each button:
  // a button that's already been hooked is skipped. New buttons that appear
  // later in Stash's render cycle (the /tags/new case) get picked up on the
  // tick after they mount.
  function attachSaveHookIfNeeded() {
    if (!document.getElementById(ROW_CAT_ID)) return;
    const tagId = getCurrentTagId();
    const isAdd = isAddTagPage();
    if (!tagId && !isAdd) return;

    if (tagId) {
      attachSaveHook(tagId);
    } else {
      attachAddTagSaveHook();
    }
  }

  function attachSaveHook(tagId) {
    const saveBtns = findSaveButtonsForTagForm();
    for (const btn of saveBtns) {
      if (btn.getAttribute(SAVE_HOOK_MARKER)) continue;
      btn.setAttribute(SAVE_HOOK_MARKER, "1");

      btn.addEventListener("click", async (event) => {
        // Block save synchronously if the picked category requires a
        // sub-category and none is selected. React 17 (Stash) delegates click
        // events at the document root, so stopImmediatePropagation here
        // prevents the event from ever reaching React's handler.
        const validation = validateSubcategory();
        if (!validation.valid) {
          if (event && typeof event.preventDefault === "function") {
            event.preventDefault();
          }
          if (event && typeof event.stopImmediatePropagation === "function") {
            event.stopImmediatePropagation();
          }
          showSubError(validation.message);
          return;
        }
        clearSubError();

        const catSelect = document.getElementById(SELECT_CAT_ID);
        const subSelect = document.getElementById(SELECT_SUB_ID);
        if (!catSelect) return;

        const category = catSelect.value || "";
        const subcategory = (subSelect && !subSelect.disabled)
          ? (subSelect.value || "")
          : "";

        try {
          await writeAssignment(tagId, category, subcategory);
          console.log(
            `[tag-categories] saved tag ${tagId}: category="${category}" subcategory="${subcategory}"`
          );
        } catch (err) {
          console.error("[tag-categories] save failed:", err);
          return;
        }

        // Navigate back to tag detail page if Stash didn't navigate on its
        // own (no Stash-managed field changed). Uses hard nav for reliability.
        setTimeout(() => {
          const path = window.location.pathname;
          const stillOnEditPage = /^\/tags\/\d+\/edit/.test(path);
          if (stillOnEditPage) {
            window.location.href = path.replace(/\/edit$/, "");
          } else if (/^\/tags\/\d+/.test(path) &&
                     document.querySelector("form .form-group.row label.form-label")) {
            // URL changed but edit form is still rendered — force reload.
            window.location.href = path;
          }
        }, 100);
      });
    }
  }

  // Save hook for the Add Tag page (/tags/new). There's no tag ID yet, so we
  // can't write the assignment immediately. Instead we snapshot the form's
  // selected category/sub-category into sessionStorage; once Stash creates the
  // tag and navigates to /tags/<newId>, applyPendingAssignmentIfNeeded picks
  // the entry up and writes the assignment against the real ID.
  //
  // Skipping the snapshot entirely when both fields are empty is intentional:
  // unassigned tags should have NO entry in cfg.assignments, not an empty one.
  function attachAddTagSaveHook() {
    const saveBtns = findSaveButtonsForTagForm();
    for (const btn of saveBtns) {
      if (btn.getAttribute(SAVE_HOOK_MARKER)) continue;
      btn.setAttribute(SAVE_HOOK_MARKER, "1");

      btn.addEventListener("click", (event) => {
        // Same validation as the edit-page hook: block save if the picked
        // category requires a sub-category and none is selected.
        const validation = validateSubcategory();
        if (!validation.valid) {
          if (event && typeof event.preventDefault === "function") {
            event.preventDefault();
          }
          if (event && typeof event.stopImmediatePropagation === "function") {
            event.stopImmediatePropagation();
          }
          showSubError(validation.message);
          return;
        }
        clearSubError();

        const catSelect = document.getElementById(SELECT_CAT_ID);
        const subSelect = document.getElementById(SELECT_SUB_ID);
        if (!catSelect) return;

        const category = catSelect.value || "";
        const subcategory = (subSelect && !subSelect.disabled)
          ? (subSelect.value || "")
          : "";

        if (!category && !subcategory) return;

        try {
          sessionStorage.setItem(PENDING_ASSIGNMENT_KEY, JSON.stringify({
            category,
            subcategory,
            timestamp: Date.now(),
          }));
        } catch (err) {
          console.warn("[tag-categories] could not store pending assignment:", err);
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Pending-assignment applier: completes the Add Tag flow.
  //
  // Runs every observer tick. Whenever we're on /tags/<id> AND a pending
  // entry exists within its TTL window, apply and clear. The TTL is tight
  // (PENDING_ASSIGNMENT_TTL_MS, set near the top of the file) so a stale
  // entry left over from a failed create cannot survive long enough to
  // attach to the next tag the user happens to visit.
  //
  // Also clears pending if the user drifts off /tags/new to a non-tag page
  // without a successful create (e.g. clicks /scenes from the sidebar).
  // ---------------------------------------------------------------------------

  async function applyPendingAssignmentIfNeeded() {
    const tagId = getCurrentTagId();
    const currentPath = window.location.pathname;

    if (!tagId) {
      if (currentPath !== "/tags/new") {
        try { sessionStorage.removeItem(PENDING_ASSIGNMENT_KEY); } catch (e) {}
      }
      return;
    }

    let pending = null;
    try {
      const raw = sessionStorage.getItem(PENDING_ASSIGNMENT_KEY);
      if (!raw) return;
      pending = JSON.parse(raw);
    } catch (err) {
      try { sessionStorage.removeItem(PENDING_ASSIGNMENT_KEY); } catch (e) {}
      return;
    }

    if (!pending) return;

    if ((Date.now() - (pending.timestamp || 0)) > PENDING_ASSIGNMENT_TTL_MS) {
      try { sessionStorage.removeItem(PENDING_ASSIGNMENT_KEY); } catch (e) {}
      return;
    }

    // Clear FIRST, then write. If the write fails we'd rather lose the
    // assignment than risk a retry loop that fires every observer tick.
    try { sessionStorage.removeItem(PENDING_ASSIGNMENT_KEY); } catch (e) {}

    try {
      await writeAssignment(
        tagId,
        pending.category || "",
        pending.subcategory || ""
      );
      console.log(
        `[tag-categories] applied pending assignment to new tag ${tagId}: ` +
        `category="${pending.category || ""}" subcategory="${pending.subcategory || ""}"`
      );
    } catch (err) {
      console.error("[tag-categories] failed to apply pending assignment:", err);
    }
  }

  // ---------------------------------------------------------------------------
  // Tag detail page display: show the tag's category + subcategory at the
  // top of .detail-group, mirroring the existing .detail-item rows ("Sub-Tags",
  // "Stash IDs"). Read-only display only.
  //
  // Display rules:
  //   - If tag has no category assigned: show "Tag Category: uncategorised".
  //     Hide sub-category row entirely (no category = no sub-category context).
  //   - If category has no subcategories defined: show category row only,
  //     hide sub-category row.
  //   - If category has subcategories but tag's sub-category is empty: show
  //     sub-category row with value "uncategorised".
  //   - If both set: show both rows with their values.
  //
  // Insertion happens only on the tag DETAIL page (/tags/<id>), not on the
  // EDIT page (/tags/<id>/edit) — the edit page already has its own
  // dropdowns from Phase 1.
  // ---------------------------------------------------------------------------

  const DETAIL_CAT_CLASS = "tag-categories-detail-cat";
  const DETAIL_SUB_CLASS = "tag-categories-detail-sub";

  function isTagDetailPage() {
    // Detail page is /tags/<id>, NOT /tags/<id>/edit. The edit page has
    // a longer pathname matched first to exclude it.
    if (/^\/tags\/\d+\/edit/.test(window.location.pathname)) return null;
    const m = window.location.pathname.match(/^\/tags\/(\d+)(?:\/.*)?$/);
    return m ? m[1] : null;
  }

  function buildDetailRow(extraClass, titleText, valueText, colour, href) {
    // Mirror the exact structure Stash uses for .detail-item rows:
    //   <div class="detail-item <kind>">
    //     <span class="detail-item-title <kind>">Label:</span>
    //     <span class="detail-item-value <kind>">Value</span>
    //   </div>
    // The plugin-specific class on the outer <div> is just a marker for
    // idempotency / removal.
    //
    // If a colour is provided, the value is wrapped in a small pill with
    // the category colour applied as background. When href is also
    // provided, the pill becomes an anchor that navigates to the filtered
    // /tags listing (see buildCategoryTagsUrl). Otherwise plain text.
    const row = document.createElement("div");
    row.className = `detail-item ${extraClass}`;

    const title = document.createElement("span");
    title.className = `detail-item-title ${extraClass}`;
    title.textContent = titleText;

    const value = document.createElement("span");
    value.className = `detail-item-value ${extraClass}`;

    if (colour) {
      const pill = href
        ? document.createElement("a")
        : document.createElement("span");
      pill.className = "tag-categories-detail-pill";
      if (href) pill.href = href;
      pill.textContent = valueText;
      pill.style.backgroundColor = colour;
      pill.style.borderColor = colour;
      pill.style.color = pickTextColour(colour);
      value.appendChild(pill);
    } else {
      value.textContent = valueText;
    }

    row.appendChild(title);
    row.appendChild(value);
    return row;
  }

  function removeDetailRows() {
    document
      .querySelectorAll(`.${DETAIL_CAT_CLASS}, .${DETAIL_SUB_CLASS}`)
      .forEach((el) => el.remove());
  }

  async function injectTagDetailDisplayIfNeeded() {
    const tagId = isTagDetailPage();
    if (!tagId) {
      // Not on detail page — clean up any of our rows that might be left
      // over from a previous tag detail view.
      removeDetailRows();
      return;
    }

    const detailGroup = document.querySelector(".detail-group");
    if (!detailGroup) return;

    // v1.4.3: read config FIRST, then check idempotency. Pre-1.4.3 the
    // order was reversed and the idempotency check used a module-level
    // lastSeen cache, which never updated when the function returned
    // early on a match - so toggling the clickable-pills setting was
    // undetectable on a stable detail page. With readPluginConfigCached
    // collapsing concurrent reads onto one in-flight promise (TTL 500ms),
    // doing the read first is cheap and the idempotency check can compare
    // against the live value.
    let category = "";
    let subcategory = "";
    let taxonomy = DEFAULT_TAXONOMY;
    let assignments = {};
    let clickablePills = false;
    try {
      const cfg = await readPluginConfigCached();
      taxonomy = cfg.taxonomy;
      assignments = cfg.assignments || {};
      clickablePills = !!cfg.clickableCategoryPills;
      const entry = assignments[String(tagId)];
      if (entry) {
        category = entry.category || "";
        subcategory = entry.subcategory || "";
      }
    } catch (err) {
      console.warn("[tag-categories] failed to read plugin config for detail display:", err);
    }

    // Idempotency check using the LIVE clickablePills value we just read.
    const existing = detailGroup.querySelector(`.${DETAIL_CAT_CLASS}`);
    if (
      existing &&
      existing.getAttribute("data-tag-id") === tagId &&
      existing.getAttribute("data-clickable") === String(clickablePills)
    ) {
      return;
    }

    // Past the idempotency check means we will re-render. Sweep any
    // existing rows (stale tag, stale state, or unreplaced placeholder
    // from an earlier failed render).
    if (existing) removeDetailRows();

    // Insert placeholder synchronously. Now that we know clickablePills,
    // set data-clickable on the placeholder so re-entrant ticks during
    // any later awaits see a state-matching placeholder and skip.
    const placeholder = document.createElement("div");
    placeholder.className = `detail-item ${DETAIL_CAT_CLASS}`;
    placeholder.setAttribute("data-tag-id", tagId);
    placeholder.setAttribute("data-clickable", String(clickablePills));
    placeholder.setAttribute("data-placeholder", "1");
    detailGroup.insertBefore(placeholder, detailGroup.firstChild);

    // Tag name map only needed when pills are clickable (Stash's native
    // /tags filter matches by name, so we need names of every tag in the
    // category/sub-category to build the URL). Skipped when off.
    let nameMap = {};
    if (clickablePills) {
      try {
        nameMap = await getTagNameMap();
      } catch (err) {
        nameMap = {};
      }
    }

    // Verify we're still on the same tag's detail page — async work may
    // have taken long enough for the user to navigate elsewhere.
    if (isTagDetailPage() !== tagId) {
      // Remove the placeholder we put down
      placeholder.remove();
      return;
    }

    // Verify the placeholder is still present in the DOM (React might
    // have torn down the .detail-group and rebuilt it).
    if (!placeholder.isConnected) return;

    // Resolve display state per the rules
    const catValue = category || "uncategorised";
    const showSubRow = !!category && hasSubcategories(taxonomy, category);
    const subValue = subcategory || "uncategorised";
    const catColour = getCategoryColour(taxonomy, category);
    // Subcategory inherits parent category colour. When subcategory is
    // missing ("uncategorised"), use a muted colour instead of the parent's.
    const subColour = subcategory ? catColour : UNCATEGORISED_COLOUR;

    // Build the filter links for each pill, if the user has opted in
    // via the clickable-pills setting. Category pill widens the /tags
    // listing to every tag in this category; sub-category pill narrows
    // further to just this sub-category. Uncategorised pills get no
    // link (nothing useful to filter to). When the setting is off, both
    // pills render as static colour with no click target.
    let catHref = null;
    let subHref = null;
    if (clickablePills) {
      const catItems = category
        ? collectCategoryTagItems(assignments, nameMap, category, null)
        : [];
      const subItems =
        category && subcategory
          ? collectCategoryTagItems(assignments, nameMap, category, subcategory)
          : [];
      catHref = catItems.length > 0 ? buildCategoryTagsUrl(catItems) : null;
      subHref = subItems.length > 0 ? buildCategoryTagsUrl(subItems) : null;
    }

    // Replace the placeholder with the real category row
    const catRow = buildDetailRow(
      DETAIL_CAT_CLASS, "Tag Category:", catValue,
      category ? catColour : UNCATEGORISED_COLOUR,
      catHref
    );
    catRow.setAttribute("data-tag-id", tagId);
    catRow.setAttribute("data-clickable", String(clickablePills));
    if (!category) {
      catRow.classList.add("tag-categories-empty-value");
    }
    placeholder.replaceWith(catRow);

    if (showSubRow) {
      const subRow = buildDetailRow(
        DETAIL_SUB_CLASS, "Tag Sub-Category:", subValue, subColour, subHref
      );
      subRow.setAttribute("data-tag-id", tagId);
      subRow.setAttribute("data-clickable", String(clickablePills));
      if (!subcategory) {
        subRow.classList.add("tag-categories-empty-value");
      }
      // Insert directly after the category row
      catRow.insertAdjacentElement("afterend", subRow);
    }
  }

  // ---------------------------------------------------------------------------
  // Tag card badge injection: on tag list/grid pages, decorate each tag card
  // with a pill showing its category (and subcategory if set). Compact,
  // single-line, colourable later.
  //
  // Layout target (verified via DOM probe):
  //   <div class="tag-card grid-card card">
  //     <div class="thumbnail-section">...</div>
  //     <div class="card-section">
  //       <h5 class="card-section-title">Anal</h5>
  //       <div class="tag-sub-tags">Parent of 27 Tags</div>
  //       ...
  //     </div>
  //   </div>
  //
  // We inject the badge between <h5> and the next element, so it sits
  // above Stash's "Parent of X" / "Sub-tag of Y" lines.
  //
  // Idempotency: a `data-tag-categories-badge-tagid` attribute on the
  // injected element. If a card's tag ID changes (list pagination/refresh),
  // the stale badge is removed and a fresh one inserted.
  //
  // Performance: plugin config is fetched ONCE per scheduler tick and
  // reused across all cards. Without this, hundreds of cards = hundreds of
  // GraphQL calls.
  // ---------------------------------------------------------------------------

  const CARD_BADGE_CLASS = "tag-categories-card-badge";
  const CARD_BADGE_MARKER_ATTR = "data-tag-categories-badge-tagid";

  function getTagIdFromCard(card) {
    const link = card.querySelector("a[href*='/tags/']");
    if (!link) return null;
    const m = (link.getAttribute("href") || "").match(/\/tags\/(\d+)/);
    return m ? m[1] : null;
  }

  // Build one pill in the card badge. Returns a div (not an <a>) because
  // the surrounding tag card is itself an <a>, and nested anchors are
  // invalid HTML; stopPropagation on click keeps the parent link from
  // also firing. Used for both the category and the sub-category pills,
  // each with its own href (or null in the OFF state, in which case the
  // pill is fully inert).
  function buildCardBadgePill(text, colour, href) {
    const pill = document.createElement("div");
    pill.className = "tag-categories-card-badge-pill";
    pill.textContent = text;

    if (colour) {
      pill.style.backgroundColor = colour;
      pill.style.borderColor = colour;
      pill.style.color = pickTextColour(colour);
    }

    if (href) {
      pill.classList.add("tag-categories-card-badge-link");
      pill.setAttribute("role", "link");
      pill.setAttribute("tabindex", "0");
      pill.title = text;
      const go = (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.location.href = href;
      };
      pill.addEventListener("click", go);
      pill.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") go(e);
      });
    } else {
      // OFF state: still swallow the click so it doesn't bubble up to
      // the surrounding tag card's <a> link. Without this, clicking the
      // pill would silently navigate to the tag's detail page, which
      // looks like "the pill is clickable" - the opposite of what the
      // toggle being off should do.
      pill.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    }
    return pill;
  }

  function buildCardBadge(category, subcategory, colour, catHref, subHref) {
    const wrap = document.createElement("div");
    wrap.className = CARD_BADGE_CLASS;

    const isUncategorised = !category;
    if (isUncategorised) {
      // Keep the single-pill "uncategorised" form for tags with no
      // category assigned; styled muted/italic via the existing class.
      const pill = document.createElement("div");
      pill.className =
        "tag-categories-card-badge-pill tag-categories-card-badge-uncategorised";
      pill.textContent = "uncategorised";
      wrap.appendChild(pill);
      return wrap;
    }

    wrap.setAttribute("data-category", category);

    // v1.3.0: split into two pills (category + sub-category) so each is
    // independently clickable, mirroring the tag DETAIL page layout. The
    // sub-category pill only shows when one is actually assigned; the
    // category pill always shows when a category is assigned.
    wrap.appendChild(buildCardBadgePill(category, colour, catHref));
    if (subcategory) {
      wrap.appendChild(buildCardBadgePill(subcategory, colour, subHref));
    }

    return wrap;
  }

  // v0.5.0: session cache of tag id -> name, for the filter chip labels
  // on the clickable category badges. Tag names rarely change within a
  // session; a stale label is cosmetic (the filter matches by id).
  let tagNameCacheMap = null;
  let tagNameCachePromise = null;
  async function getTagNameMap() {
    if (tagNameCacheMap) return tagNameCacheMap;
    if (!tagNameCachePromise) {
      tagNameCachePromise = fetchAllTags()
        .then((tags) => {
          const m = {};
          for (const t of tags) m[String(t.id)] = t.name;
          tagNameCacheMap = m;
          return m;
        })
        .catch((err) => {
          tagNameCachePromise = null;
          throw err;
        });
    }
    return tagNameCachePromise;
  }

  // Collect the [{id, name}] of every tag in a category — or, when
  // `subcategory` is non-null, only the tags in that subcategory.
  function collectCategoryTagItems(assignments, nameMap, category, subcategory) {
    const items = [];
    for (const tid of Object.keys(assignments || {})) {
      const a = assignments[tid];
      if (!a || a.category !== category) continue;
      if (subcategory != null && (a.subcategory || "") !== subcategory) continue;
      items.push({ id: String(tid), name: nameMap[String(tid)] || String(tid) });
    }
    return items;
  }

  // Build a root-relative Scenes-list URL filtered to "has any of these
  // tags" (Stash v0.31 filter encoding). Root-relative so it works on
  // localhost or a LAN IP alike. Returns null for an empty tag set.
  function buildCategoryScenesUrl(tagItems) {
    if (!tagItems || tagItems.length === 0) return null;
    const itemsStr = tagItems
      .map((t) => {
        // The label is cosmetic (filter-chip text); the id does the
        // filtering. Strip the two characters that would break the
        // (...) mini-language's quoted string.
        const label = String(t.name).replace(/[\\"]/g, "'");
        return '("id":"' + t.id + '","label":"' + label + '")';
      })
      .join(",");
    const criterion =
      '("type":"tags","modifier":"INCLUDES","value":' +
      '("items":[' + itemsStr + '],"excluded":[],"depth":0))';
    // Match Stash's own URL style: ( ) : , stay literal (all valid in a
    // query string), everything else percent-encoded. encodeURIComponent
    // already leaves ( ) alone; restore : and , afterwards.
    const enc = encodeURIComponent(criterion)
      .replace(/%3A/g, ":")
      .replace(/%2C/g, ",");
    return "/scenes?c=" + enc;
  }

  // Pick the right "show me everything matching this category" target
  // based on what page the badge is being rendered from:
  //   - On any /tags pathname (listing or a specific tag's detail), the
  //     target is the /tags listing filtered by name.
  //   - Anywhere else (scenes, galleries, performers, images, groups,
  //     markers, studios, individual scene/etc. pages), it stays as the
  //     /scenes listing filtered by tag IDs - the original behaviour.
  // Returns null if items is empty.
  function chooseTagFilterUrl(items) {
    if (!items || items.length === 0) return null;
    const path = location.pathname;
    const onTagsSurface =
      path === "/tags" ||
      path === "/tags/" ||
      /^\/tags\/\d+/.test(path);
    return onTagsSurface
      ? buildCategoryTagsUrl(items)
      : buildCategoryScenesUrl(items);
  }

  // Escape a string so it can be embedded in a regex as a literal AND
  // survive Stash's URL filter mini-language parser.
  //
  // Standard regex escape uses backslash for every meta char, e.g.
  // "Rimming (Female)" becomes "Rimming \(Female\)". But Stash's URL
  // filter language uses ( ) for structural grouping, and its parser is
  // naive about parens inside quoted string values - any ( ) we emit
  // inside the "value":"..." string trips it and the entire c= parameter
  // is silently discarded, leaving the page unfiltered.
  //
  // Workaround: encode ( ) and " using regex character classes - [(] and
  // [)] and ["] - which match a single literal of that character but
  // contain no naked paren or quote that the URL filter parser could
  // misread. Bracket-class syntax is universal across regex engines.
  function escapeForRegex(str) {
    return String(str)
      .replace(/[\\^$.*?[\]{}]/g, "\\$&")
      .replace(/\(/g, "[(]")
      .replace(/\)/g, "[)]")
      .replace(/\+/g, "[+]")
      .replace(/\|/g, "[|]")
      .replace(/"/g, '["]');
  }

  // Build a root-relative /tags URL filtered (via Stash's native filter
  // system) to "name matches one of these tag names". This is the tags-
  // page equivalent of buildCategoryScenesUrl: Stash applies the filter
  // server-side at query time, so non-matching tag cards never render in
  // the first place. No flash-then-hide.
  //
  // Stash's tag-name filter has no "name in list" criterion, so we use
  // MATCHES_REGEX with an alternation: ^name1$|^name2$|...  No outer
  // grouping parens — keeps the criterion mini-language parser happy
  // (it uses ( ) for tuples, and a paren inside a quoted string value
  // can confuse some parsers; alternation works fine without grouping).
  //
  // Names are regex-escaped for meta chars, and " is also escaped so
  // it doesn't prematurely terminate the criterion value string.
  function buildCategoryTagsUrl(tagItems) {
    if (!tagItems || tagItems.length === 0) return null;
    const regex = tagItems
      .map((t) => "^" + escapeForRegex(t.name) + "$")
      .join("|");
    const criterion =
      '("type":"name","modifier":"MATCHES_REGEX","value":"' + regex + '")';
    const enc = encodeURIComponent(criterion)
      .replace(/%3A/g, ":")
      .replace(/%2C/g, ",");
    return "/tags?c=" + enc;
  }

  // True when a tag card is rendered inside an editing surface (the
  // Speed Tagger modal) — there the badge must not be a filter link.
  function isEditingContext(card) {
    return !!(
      card &&
      card.closest &&
      card.closest(".speed-tagger-overlay, .speed-tagger-modal")
    );
  }

  async function tryInjectTagCardBadges() {
    const cards = document.querySelectorAll(".tag-card.grid-card.card");
    if (cards.length === 0) return;

    // Read plugin config ONCE for this entire injection pass.
    let assignments = {};
    let taxonomy = DEFAULT_TAXONOMY;
    let clickablePills = false;
    try {
      const cfg = await readPluginConfigCached();
      assignments = cfg.assignments || {};
      taxonomy = cfg.taxonomy || DEFAULT_TAXONOMY;
      clickablePills = !!cfg.clickableCategoryPills;
    } catch (err) {
      console.warn("[tag-categories] failed to read config for card badges:", err);
      return;
    }

    // v0.5.0: tag id -> name map for the clickable badges' filter labels.
    // Cached, so this fetch only happens on the first pass. Skipped when
    // pills are non-clickable (the names are only needed for the filter
    // URL).
    let nameMap = {};
    if (clickablePills) {
      try {
        nameMap = await getTagNameMap();
      } catch (err) {
        nameMap = {};
      }
    }

    // v0.6.0: hide tag cards whose category is marked hidden, but only
    // on the /tags listing — hover popovers and other contexts still
    // show the card (you can still see and use those tags everywhere
    // they actually appear; they just vanish from the browse listing).
    const onTagsListing =
      location.pathname === "/tags" || location.pathname === "/tags/";
    const hiddenCategorySet = new Set();
    for (const c of taxonomy.categories || []) {
      if (c.hidden) hiddenCategorySet.add(c.name);
    }

    for (const card of cards) {
      const tagId = getTagIdFromCard(card);
      if (!tagId) continue;

      const entry = assignments[tagId];
      const category = entry?.category || "";
      const subcategory = entry?.subcategory || "";

      // v0.6.0: toggle the hidden-card class every pass, OUTSIDE the
      // badge idempotency check below — so unhiding a category (or
      // moving a tag out of one) updates the listing live, even though
      // the existing badge is reused.
      if (onTagsListing && category && hiddenCategorySet.has(category)) {
        card.classList.add("tag-categories-hidden-card");
      } else {
        card.classList.remove("tag-categories-hidden-card");
      }

      // Idempotency: if a badge for this tag ID is already present AND
      // its clickable state matches the current setting, skip. The
      // clickable check matters because toggling the setting at runtime
      // needs to force a re-render so existing static badges become
      // clickable (or vice versa).
      const existing = card.querySelector("." + CARD_BADGE_CLASS);
      const wantClickable = String(clickablePills);
      if (
        existing &&
        existing.getAttribute(CARD_BADGE_MARKER_ATTR) === tagId &&
        existing.getAttribute("data-clickable") === wantClickable
      ) {
        continue;
      }
      // Stale badge (different tag ID, or state mismatch) — remove.
      if (existing) existing.remove();

      // Resolve subcategory display: only show subcategory text when the
      // category has subcategories defined AND the tag has one assigned.
      const showSub = category && hasSubcategories(taxonomy, category) && subcategory;
      const colour = getCategoryColour(taxonomy, category);

      // v1.3.0 + v1.4.0: build both pills' filter links separately, but
      // only if the user has opted in via the clickable-pills setting.
      // The category pill widens to the whole category; the
      // sub-category pill (when shown) narrows to that one sub-category.
      // Target page (tags vs scenes) is chosen by chooseTagFilterUrl
      // based on the current pathname. Skipped for uncategorised tags
      // and inside editing surfaces (Power Tagger).
      let catHref = null;
      let subHref = null;
      if (clickablePills && category && !isEditingContext(card)) {
        const catItems = collectCategoryTagItems(
          assignments,
          nameMap,
          category,
          null
        );
        catHref = chooseTagFilterUrl(catItems);
        if (showSub) {
          const subItems = collectCategoryTagItems(
            assignments,
            nameMap,
            category,
            subcategory
          );
          subHref = chooseTagFilterUrl(subItems);
        }
      }

      const badge = buildCardBadge(
        category,
        showSub ? subcategory : "",
        colour,
        catHref,
        subHref
      );
      badge.setAttribute(CARD_BADGE_MARKER_ATTR, tagId);
      badge.setAttribute("data-clickable", wantClickable);

      // Insert between the <h5> title and the next sibling (parent/sub info).
      const cardSection = card.querySelector(".card-section");
      const titleEl = cardSection?.querySelector("h5.card-section-title");
      if (!cardSection || !titleEl) continue;

      titleEl.insertAdjacentElement("afterend", badge);
    }
  }

  // ---------------------------------------------------------------------------
  // Toolbar button: inject a button into the tags-page (and other list-pages)
  // toolbar so the settings modal can be opened without navigating to
  // Stash → Settings → Plugins. Same trigger pattern as Tag Sets:
  // dispatch the OPEN_EVENT_NAME CustomEvent, the modal host listens.
  //
  // We inject into the same button group as the Tag Sets button (the group
  // containing fa-table-cells-large / fa-list / fa-tags / fa-layer-group),
  // so it sits naturally next to other view-controlling buttons.
  // ---------------------------------------------------------------------------

  const TOOLBAR_BUTTON_MARKER_CLASS = "tag-categories-toolbar-button";

  // v0.3.2: render the toolbar button via React + Stash's own
  // react-bootstrap OverlayTrigger + Tooltip so the hover tooltip
  // matches the native Grid/List/Wall/Tagger styling exactly.
  // React-Bootstrap is exposed at PluginApi.libraries.Bootstrap.
  function renderToolbarButton(host) {
    const Bootstrap = (PluginApi.libraries && PluginApi.libraries.Bootstrap) || null;
    if (!Bootstrap || !Bootstrap.OverlayTrigger || !Bootstrap.Tooltip) {
      throw new Error("react-bootstrap Tooltip not available");
    }
    const { OverlayTrigger, Tooltip } = Bootstrap;

    const iconSvg = React.createElement(
      "svg",
      {
        className: "svg-inline--fa fa-folder-tree fa-icon",
        "aria-hidden": "true",
        focusable: "false",
        "data-prefix": "fas",
        "data-icon": "folder-tree",
        role: "img",
        xmlns: "http://www.w3.org/2000/svg",
        viewBox: "0 0 576 512",
      },
      React.createElement("path", {
        fill: "currentColor",
        // FontAwesome 6 Free Solid 'folder-tree' (verified from official source).
        // Earlier versions of this file shipped a corrupted/hallucinated path
        // string that rendered as two overlapping blobs — replaced 0.3.4.
        d:
          "M544 32h-112l-32-32H320c-17.62 0-32 14.38-32 32v160c0 17.62 14.38 " +
          "32 32 32h224c17.62 0 32-14.38 32-32V64C576 46.38 561.6 32 544 32zM544 " +
          "320h-112l-32-32H320c-17.62 0-32 14.38-32 32v160c0 17.62 14.38 32 32 " +
          "32h224c17.62 0 32-14.38 32-32v-128C576 334.4 561.6 320 544 320zM64 " +
          "16C64 7.125 56.88 0 48 0h-32C7.125 0 0 7.125 0 16V416c0 17.62 14.38 " +
          "32 32 32h224v-64H64V160h192V96H64V16z",
      })
    );

    const tooltip = React.createElement(
      Tooltip,
      { id: "tag-categories-toolbar-tooltip" },
      "Tag Categories"
    );

    const btn = React.createElement(
      "button",
      {
        type: "button",
        className: "btn btn-secondary",
        "aria-label": "Tag Categories",
        onClick: () => window.dispatchEvent(new CustomEvent(OPEN_EVENT_NAME)),
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

  // Fallback: plain DOM button without the react-bootstrap tooltip.
  // Used only if the OverlayTrigger render fails.
  function buildToolbarButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-secondary " + TOOLBAR_BUTTON_MARKER_CLASS;
    btn.title = "Tag Categories";
    btn.setAttribute("aria-label", "Tag Categories");

    // FontAwesome 'fa-folder-tree' icon — hierarchy with subfolders, fits
    // categories-with-subcategories semantics. Path data is the official
    // FA6 Free Solid 'folder-tree' (verified 0.3.4 — earlier versions had
    // a corrupted path that rendered as two overlapping blobs).
    btn.innerHTML =
      '<svg class="svg-inline--fa fa-folder-tree fa-icon" ' +
      'aria-hidden="true" focusable="false" data-prefix="fas" ' +
      'data-icon="folder-tree" role="img" xmlns="http://www.w3.org/2000/svg" ' +
      'viewBox="0 0 576 512">' +
      '<path fill="currentColor" d="M544 32h-112l-32-32H320c-17.62 0-32 ' +
      '14.38-32 32v160c0 17.62 14.38 32 32 32h224c17.62 0 32-14.38 32-32V64C576 ' +
      '46.38 561.6 32 544 32zM544 320h-112l-32-32H320c-17.62 0-32 14.38-32 ' +
      '32v160c0 17.62 14.38 32 32 32h224c17.62 0 32-14.38 32-32v-128C576 ' +
      '334.4 561.6 320 544 320zM64 16C64 7.125 56.88 0 48 0h-32C7.125 0 0 ' +
      '7.125 0 16V416c0 17.62 14.38 32 32 32h224v-64H64V160h192V96H64V16z"' +
      '></path></svg>';

    btn.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent(OPEN_EVENT_NAME));
    });

    return btn;
  }

  // Find the toolbar group that holds the list-page view-mode buttons
  // (grid / list / etc.) and inject ours into it as the last child.
  // Idempotent.
  function tryInjectToolbarButton() {
    // v0.3.5: anchor on the native grid-view icon (fa-table-cells-large).
    // This previously anchored on fa-layer-group, which is only reliably
    // present when the Tag Sets plugin is installed. On a stock Stash that
    // anchor was missing and the button silently never appeared. The
    // grid-view toggle is native to every Stash list page.
    const gridIcons = document.querySelectorAll("svg.fa-table-cells-large");
    for (const icon of gridIcons) {
      const button = icon.closest("button");
      if (!button) continue;
      const group = button.closest('div[role="group"].btn-group');
      if (!group) continue;
      if (group.querySelector("." + TOOLBAR_BUTTON_MARKER_CLASS)) {
        return true;  // already injected
      }
      // The view-mode group always has at least grid + list. Guard against
      // a stray grid icon sitting alone in some other btn-group.
      const buttonCount = group.querySelectorAll("button").length;
      if (buttonCount < 2) continue;
      // v0.3.2: prefer React-Bootstrap tooltip; fall back to plain
      // DOM button if the render fails.
      const host = document.createElement("span");
      host.className = TOOLBAR_BUTTON_MARKER_CLASS;
      host.style.display = "contents";
      group.appendChild(host);
      try {
        renderToolbarButton(host);
      } catch (err) {
        console.error("[tag-categories] toolbar button render error:", err);
        host.remove();
        group.appendChild(buildToolbarButton());
      }
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------

  const SETTINGS_BTN_MARKER = "data-tag-categories-settings-hooked";

  function injectSettingsButtonHandlerIfNeeded() {
    // Stash renders our setting as a row containing the label
    // "Edit Tag Categories" (from YAML displayName) and an Edit button.
    // We find that row and rebind the button.
    if (!window.location.pathname.startsWith("/settings")) return;

    // Find buttons whose text is "Edit" and that sit in a row containing
    // our displayName. We can't rely on a tag-categories specific class —
    // walk up from each "Edit" button and check the surrounding text.
    const editButtons = [...document.querySelectorAll("button")].filter(
      (b) => ((b.textContent || "").trim() === "Edit")
    );
    for (const btn of editButtons) {
      if (btn.getAttribute(SETTINGS_BTN_MARKER)) continue;

      // Find the IMMEDIATE setting-row container for this button — not
      // just any ancestor whose text contains our displayName, or we'll
      // match the entire settings page (which contains every plugin's
      // displayName) and end up hooking every Edit button on screen.
      //
      // The row text in Stash starts with the displayName, so requiring
      // a startsWith match on a close-by ancestor pins this to our row.
      const TARGET = "edit tag categories";
      let p = btn.parentElement;
      let foundOurRow = false;
      for (let i = 0; i < 5 && p; i++) {
        const txt = (p.textContent || "").trim().toLowerCase();
        if (txt.startsWith(TARGET)) {
          foundOurRow = true;
          break;
        }
        p = p.parentElement;
      }
      if (!foundOurRow) continue;

      btn.setAttribute(SETTINGS_BTN_MARKER, "1");

      // Capture-phase listener so we run before Stash's own onClick. We
      // prevent the default + Stash's modal by stopping propagation.
      btn.addEventListener(
        "click",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          window.dispatchEvent(new CustomEvent(OPEN_EVENT_NAME));
        },
        true
      );
    }
  }

  // ---------------------------------------------------------------------------
  // React modal — mounted via patch.before("MainNavBar.UtilityItems") and
  // listens for the open event from the settings button. Same pattern as
  // tag-sets and other plugins in this collection.
  // ---------------------------------------------------------------------------

  function ErrorBoundary({ children }) {
    const [err, setErr] = React.useState(null);
    React.useEffect(() => {
      // Hacky catch via global error: nothing perfect here. The boundary
      // pattern with class component is more robust but uses createClass.
    }, []);
    if (err) {
      return React.createElement(
        "div",
        { style: { color: "#f88", padding: 12, fontFamily: "monospace" } },
        "Tag Categories modal error: " + String(err)
      );
    }
    try {
      return children;
    } catch (e) {
      setErr(e.message || String(e));
      return null;
    }
  }

  // v0.3.1: PortalModal supports an optional `onCloseRequest` prop. If
  // supplied, the header Close button calls it instead of `onHide`.
  // Lets the body intercept the click to show a confirm-discard
  // prompt when there are unsaved changes. Outside-click dismissal
  // removed: the modal is "modal" — only explicit Close / Cancel /
  // Save buttons should close it. A stray click on the dim overlay
  // previously closed the modal, easy to do accidentally and lose
  // in-progress edits.
  function PortalModal({ show, onHide, onCloseRequest, title, width, height, children }) {
    if (!show) return null;
    const closeHandler = onCloseRequest || onHide;
    const overlay = React.createElement(
      "div",
      {
        className: "tag-categories-overlay",
      },
      React.createElement(
        "div",
        {
          className: "tag-categories-modal",
          style: {
            width: width || "min(1500px, 95vw)",
            height: height || undefined,
          },
        },
        React.createElement(
          "div",
          { className: "tag-categories-modal-header" },
          React.createElement("h5", null, title || "Tag Categories"),
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
          { className: "tag-categories-modal-body" },
          children
        )
      )
    );
    return ReactDOM.createPortal(overlay, document.body);
  }

  // Count how many tags are assigned to a given category (and optionally
  // subcategory). Used in rename/delete confirmation dialogs.
  function countAssignments(assignments, catName, subName) {
    let n = 0;
    for (const key of Object.keys(assignments || {})) {
      const a = assignments[key];
      if (!a) continue;
      if (a.category === catName) {
        if (subName === undefined || a.subcategory === subName) n++;
      }
    }
    return n;
  }

  // v0.4.0: create a new Stash tag. Used by the tag picker's "Create
  // tag" option. The tag is created immediately (same as Stash's own
  // tag pickers); the editor's Save only persists category assignments.
  async function createTag(name) {
    const data = await gqlFetch(
      `mutation($input: TagCreateInput!) {
        tagCreate(input: $input) { id name }
      }`,
      { input: { name: String(name || "").trim() } }
    );
    return (data && data.tagCreate) || null;
  }

  // v0.4.0: the tag picker for the editor's third column.
  //
  // It is a bespoke combobox rather than Stash's bundled TagSelect: the
  // editor needs each option to show the tag's CURRENT category, so the
  // user can see, before picking, whether a tag is uncategorised or is
  // about to be moved out of another category. Stash's TagSelect gives
  // no hook to annotate its options. The styling deliberately mirrors a
  // native dark combobox so it still blends into Stash.
  //
  // Props: allTags, assignments (current draft — for the category
  // annotation), taxonomy (for category colours), currentCategory (the
  // category being edited — its tags are excluded from the list),
  // busy, onAdd(tagId), onCreate(name).
  function TagPickerCombo({
    allTags,
    assignments,
    taxonomy,
    currentCategory,
    busy,
    onAdd,
    onCreate,
  }) {
    const [query, setQuery] = React.useState("");
    const [open, setOpen] = React.useState(false);
    const [highlight, setHighlight] = React.useState(0);
    const wrapRef = React.useRef(null);
    const inputRef = React.useRef(null);

    function catColourOf(name) {
      const c = (taxonomy.categories || []).find((x) => x.name === name);
      return (c && c.colour) || DEFAULT_CATEGORY_COLOUR;
    }

    const q = query.trim().toLowerCase();
    // Only offer tags NOT already in the category being edited — they
    // are uncategorised or live in another category. A tag already in
    // this category has nothing to add.
    const matches = (allTags || [])
      .filter((t) => {
        const a = assignments[String(t.id)];
        if (a && a.category === currentCategory) return false;
        return !q || t.name.toLowerCase().includes(q);
      })
      .slice(0, 50);
    const exact = (allTags || []).some(
      (t) => t.name.toLowerCase() === q
    );
    const canCreate = q.length > 0 && !exact;
    const options = matches.map((t) => ({ type: "tag", tag: t }));
    if (canCreate) options.push({ type: "create" });

    // Close the menu when clicking outside the combo.
    React.useEffect(() => {
      function onDocDown(e) {
        if (wrapRef.current && !wrapRef.current.contains(e.target)) {
          setOpen(false);
        }
      }
      document.addEventListener("mousedown", onDocDown);
      return () => document.removeEventListener("mousedown", onDocDown);
    }, []);

    function choose(opt) {
      if (!opt) return;
      if (opt.type === "create") {
        if (query.trim()) onCreate(query.trim());
      } else {
        onAdd(opt.tag.id);
      }
      // The picked tag is now in this category, so it drops out of the
      // list. Reset and close — re-open by clicking the field again.
      setQuery("");
      setHighlight(0);
      setOpen(false);
    }

    function onKeyDown(e) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
        setHighlight((h) => Math.min(h + 1, Math.max(0, options.length - 1)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
      } else if (e.key === "Enter") {
        if (open && options.length) {
          e.preventDefault();
          choose(options[Math.min(highlight, options.length - 1)]);
        }
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }

    return React.createElement(
      "div",
      { className: "tag-categories-combo", ref: wrapRef },
      React.createElement("input", {
        ref: inputRef,
        type: "text",
        className: "tag-categories-combo-input",
        value: query,
        placeholder: "Add a tag to this category…",
        disabled: busy,
        onChange: (e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
        },
        onFocus: () => setOpen(true),
        onKeyDown: onKeyDown,
      }),
      open
        ? React.createElement(
            "div",
            { className: "tag-categories-combo-menu" },
            options.length === 0
              ? React.createElement(
                  "div",
                  { className: "tag-categories-combo-empty" },
                  "No tags found."
                )
              : options.map((opt, i) => {
                  const hl = i === highlight;
                  if (opt.type === "create") {
                    return React.createElement(
                      "div",
                      {
                        key: "__create",
                        className:
                          "tag-categories-combo-option" +
                          (hl ? " highlighted" : ""),
                        onMouseEnter: () => setHighlight(i),
                        onMouseDown: (e) => {
                          e.preventDefault();
                          choose(opt);
                        },
                      },
                      React.createElement(
                        "span",
                        { className: "tag-categories-combo-create" },
                        `Create tag “${query.trim()}”`
                      )
                    );
                  }
                  const t = opt.tag;
                  const a = assignments[String(t.id)];
                  const cat = a && a.category;
                  return React.createElement(
                    "div",
                    {
                      key: t.id,
                      className:
                        "tag-categories-combo-option" +
                        (hl ? " highlighted" : ""),
                      onMouseEnter: () => setHighlight(i),
                      onMouseDown: (e) => {
                        e.preventDefault();
                        choose(opt);
                      },
                    },
                    React.createElement(
                      "span",
                      { className: "tag-categories-combo-name" },
                      t.name
                    ),
                    cat
                      ? React.createElement(
                          "span",
                          {
                            className: "tag-categories-combo-cat",
                            style: {
                              backgroundColor: catColourOf(cat),
                              color: pickTextColour(catColourOf(cat)),
                            },
                            title: "Currently in this category — picking it moves it here",
                          },
                          a.subcategory ? cat + " / " + a.subcategory : cat
                        )
                      : React.createElement(
                          "span",
                          { className: "tag-categories-combo-uncat" },
                          "uncategorised"
                        )
                  );
                })
          )
        : null
    );
  }

  // The main settings modal body. Two-column editor with cascade-aware edits.
  function SettingsModalBody({ initialConfig, onSaved, onClose, requestCloseRef }) {
    // Seed taxonomy with tagOrder populated from existing assignments. On
    // first open, any tag assigned to (cat, sub) but not in that
    // tagOrder array gets appended to the array. This handles the legacy
    // case where assignments existed before tagOrder did.
    // v0.5.x: which categories currently have sub-categories — drives
    // the orphan-tag heal below. A tag assigned to category X with no
    // sub is "orphaned" if X has subs, because the editor has no slot
    // for "tags directly in a sub-categorised category".
    const subbedCategoriesAtLoad = React.useMemo(() => {
      const s = new Set();
      for (const c of (initialConfig.taxonomy.categories || [])) {
        if ((c.subcategories || []).length > 0) s.add(c.name);
      }
      return s;
    }, [initialConfig]);

    const seededTaxonomy = React.useMemo(() => {
      const t = JSON.parse(JSON.stringify(initialConfig.taxonomy));
      // Build map: catName -> subName -> [tagId]. Skip orphans (tags in
      // a sub-categorised category with no sub) — they get healed into
      // the `assignments` initial state below, and shouldn't be re-
      // appended into a stray `tagOrder[""]` here.
      const byCatSub = {};
      for (const tagId of Object.keys(initialConfig.assignments || {})) {
        const a = initialConfig.assignments[tagId];
        if (!a || !a.category) continue;
        const sub = a.subcategory || "";
        if (sub === "" && subbedCategoriesAtLoad.has(a.category)) continue;
        if (!byCatSub[a.category]) byCatSub[a.category] = {};
        if (!byCatSub[a.category][sub]) byCatSub[a.category][sub] = [];
        byCatSub[a.category][sub].push(String(tagId));
      }
      // Walk taxonomy, ensure tagOrder exists for each (cat, sub)
      for (const cat of t.categories) {
        if (!cat.tagOrder || typeof cat.tagOrder !== "object") {
          cat.tagOrder = {};
        }
        const subsHere = cat.subcategories.length > 0
          ? cat.subcategories
          : [""];
        for (const sub of subsHere) {
          if (!Array.isArray(cat.tagOrder[sub])) cat.tagOrder[sub] = [];
          // Append any assigned tags missing from the order list
          const have = new Set(cat.tagOrder[sub]);
          const assigned = (byCatSub[cat.name] && byCatSub[cat.name][sub]) || [];
          for (const tid of assigned) {
            if (!have.has(tid)) cat.tagOrder[sub].push(tid);
          }
        }
        // v0.5.x: a sub-categorised category should never carry a
        // tagOrder[""] entry — anything there is an orphan from before
        // the sub was added. Drop it to match the healed assignments.
        if (cat.subcategories.length > 0 && cat.tagOrder[""]) {
          delete cat.tagOrder[""];
        }
      }
      return t;
    }, [initialConfig, subbedCategoriesAtLoad]);

    const [taxonomy, setTaxonomy] = React.useState(seededTaxonomy);
    // Assignments are now mutable — col-3 adds/removes touch them.
    // v0.5.x: heal orphaned tags on load — a tag assigned to a
    // category that has subs but no sub of its own becomes
    // uncategorised. The cleanup is silent (no dirty flag) since
    // it's a normalisation, not a user edit; it gets persisted the
    // next time the user saves anything.
    const [assignments, setAssignments] = React.useState(() => {
      const a = JSON.parse(JSON.stringify(initialConfig.assignments || {}));
      for (const tid of Object.keys(a)) {
        const entry = a[tid];
        if (!entry || !entry.category) continue;
        if (
          subbedCategoriesAtLoad.has(entry.category) &&
          (entry.subcategory || "") === ""
        ) {
          delete a[tid];
        }
      }
      return a;
    });
    // Mutable: newly created tags (via the tag picker) are appended so
    // they resolve to their real name immediately, without a reload.
    const [allTags, setAllTags] = React.useState(initialConfig.allTags || []);
    const [selectedCatIdx, setSelectedCatIdx] = React.useState(0);
    // Selected subcategory NAME ("" = none / category-with-no-subs).
    // Resets when category changes.
    const [selectedSub, setSelectedSub] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [showJsonView, setShowJsonView] = React.useState(false);
    const [jsonText, setJsonText] = React.useState("");
    const [jsonError, setJsonError] = React.useState("");
    const [unsavedDirty, setUnsavedDirty] = React.useState(false);
    // v0.3.1: file-based import flow. `pendingImport` holds the parsed
    // backup payload waiting on user confirm; parse / validation
    // errors surface via alert(). `fileInputRef` is the hidden
    // <input type=file> the Import button triggers.
    const [pendingImport, setPendingImport] = React.useState(null);
    const fileInputRef = React.useRef(null);
    // v0.3.1: confirm-discard prompt for closing with unsaved edits.
    const [confirmCloseOpen, setConfirmCloseOpen] = React.useState(false);
    // v0.4.0: in-modal dialog replacing browser prompt()/confirm() for
    // category / sub-category add / rename / delete. `dialog` is null
    // when closed, otherwise a descriptor (see askText / askConfirm).
    const [dialog, setDialog] = React.useState(null);

    const selectedCat = taxonomy.categories[selectedCatIdx] || null;
    // When category has no subcategories, the "subcategory" is "" — col 3
    // shows tags assigned to (cat, "") directly without requiring a sub
    // selection.
    const categoryHasSubs = selectedCat && selectedCat.subcategories.length > 0;
    const effectiveSub = categoryHasSubs ? selectedSub : "";
    const col3Active = selectedCat && (
      !categoryHasSubs || selectedSub !== null
    );

    function markDirty() {
      setUnsavedDirty(true);
    }

    // v0.4.0: Promise-based in-modal dialogs. `askText` resolves to the
    // trimmed string (or null if cancelled); `askConfirm` resolves to
    // true / false. They replace the browser prompt() / confirm()
    // dialogs so add / rename / delete stay inside Stash's look. The
    // dialog overlay is modal, so no other state changes while it is
    // open — callers can safely use closure values after the await.
    function askText(opts) {
      return new Promise((resolve) => {
        setDialog({
          mode: "prompt",
          title: opts.title || "",
          message: opts.message || "",
          value: opts.defaultValue || "",
          placeholder: opts.placeholder || "",
          confirmLabel: opts.confirmLabel || "OK",
          validate: opts.validate || null,
          error: "",
          resolve,
        });
      });
    }
    function askConfirm(opts) {
      return new Promise((resolve) => {
        setDialog({
          mode: "confirm",
          title: opts.title || "",
          message: opts.message || "",
          confirmLabel: opts.confirmLabel || "Confirm",
          danger: !!opts.danger,
          resolve,
        });
      });
    }
    function dialogCancel() {
      if (dialog) dialog.resolve(dialog.mode === "confirm" ? false : null);
      setDialog(null);
    }
    function dialogConfirm() {
      if (!dialog) return;
      if (dialog.mode === "prompt") {
        const v = String(dialog.value || "").trim();
        if (dialog.validate) {
          const err = dialog.validate(v);
          if (err) {
            // Keep the dialog open and surface the validation error.
            setDialog({ ...dialog, error: err });
            return;
          }
        }
        dialog.resolve(v);
      } else {
        dialog.resolve(true);
      }
      setDialog(null);
    }

    function syncJson() {
      setJsonText(JSON.stringify(taxonomy, null, 2));
      setJsonError("");
    }

    // --------- category-level ops ---------
    async function addCategory() {
      const trimmed = await askText({
        title: "Add category",
        message: "Name for the new category:",
        placeholder: "e.g. Themes",
        confirmLabel: "Add category",
        validate: (v) =>
          taxonomy.categories.some((c) => c.name === v)
            ? "A category with this name already exists."
            : null,
      });
      if (!trimmed) return;
      const next = { ...taxonomy };
      next.categories = [
        ...taxonomy.categories,
        {
          name: trimmed,
          hidden: false,
          colour: DEFAULT_CATEGORY_COLOUR,
          subcategories: [],
        },
      ];
      setTaxonomy(next);
      setSelectedCatIdx(next.categories.length - 1);
      markDirty();
    }

    async function renameCategory(idx) {
      const cur = taxonomy.categories[idx];
      const trimmed = await askText({
        title: "Rename category",
        message: `Rename "${cur.name}" to:`,
        defaultValue: cur.name,
        confirmLabel: "Rename",
        validate: (v) =>
          taxonomy.categories.some((c, i) => i !== idx && c.name === v)
            ? "A category with this name already exists."
            : null,
      });
      if (!trimmed || trimmed === cur.name) return;
      const affected = countAssignments(assignments, cur.name);
      if (affected > 0) {
        const ok = await askConfirm({
          title: "Rename category",
          message:
            `${affected} tag${affected === 1 ? "" : "s"} ${affected === 1 ? "is" : "are"} ` +
            `assigned to "${cur.name}". They will be updated to "${trimmed}" when you save. Continue?`,
          confirmLabel: "Rename",
        });
        if (!ok) return;
      }
      const next = { ...taxonomy };
      next.categories = taxonomy.categories.map((c, i) =>
        i === idx ? { ...c, name: trimmed, _renamedFrom: cur.name } : c
      );
      setTaxonomy(next);
      markDirty();
    }

    async function deleteCategory(idx) {
      const cur = taxonomy.categories[idx];
      const affected = countAssignments(assignments, cur.name);
      let msg = `Delete category "${cur.name}"?`;
      if (cur.subcategories.length > 0) {
        msg += `\nIts ${cur.subcategories.length} sub-categories will also be deleted.`;
      }
      if (affected > 0) {
        msg += `\n\n${affected} tag${affected === 1 ? "" : "s"} ${affected === 1 ? "is" : "are"} ` +
               `currently assigned to this category. Their assignment will be cleared.`;
      }
      const ok = await askConfirm({
        title: "Delete category",
        message: msg,
        confirmLabel: "Delete category",
        danger: true,
      });
      if (!ok) return;
      const next = { ...taxonomy };
      next.categories = taxonomy.categories.filter((_, i) => i !== idx);
      setTaxonomy(next);
      if (selectedCatIdx >= next.categories.length) {
        setSelectedCatIdx(Math.max(0, next.categories.length - 1));
      }
      markDirty();
    }

    // ---- Drag-and-drop state & helpers ----
    //
    // dragState is a ref (not React state) so updating it during the rapid
    // dragover events doesn't trigger re-renders. Only the final drop
    // commits via setTaxonomy/setAssignments which IS a re-render.
    //
    // listKey identifies which list is being dragged: "cat" | "sub" | "tag".
    // Drops are only allowed within the same listKey — you can't drag a
    // category into the subcategories list and have it make sense.
    const dragState = React.useRef({ listKey: null, fromIdx: null });

    function reorderCategories(fromIdx, toIdx) {
      if (fromIdx === toIdx) return;
      const arr = [...taxonomy.categories];
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      const next = { ...taxonomy, categories: arr };
      setTaxonomy(next);
      // Track selection through the move so the highlighted row stays
      // highlighted.
      if (selectedCatIdx === fromIdx) {
        setSelectedCatIdx(toIdx);
      } else if (fromIdx < selectedCatIdx && toIdx >= selectedCatIdx) {
        setSelectedCatIdx(selectedCatIdx - 1);
      } else if (fromIdx > selectedCatIdx && toIdx <= selectedCatIdx) {
        setSelectedCatIdx(selectedCatIdx + 1);
      }
      markDirty();
    }

    function reorderSubs(fromIdx, toIdx) {
      if (fromIdx === toIdx || !selectedCat) return;
      const subs = [...selectedCat.subcategories];
      const [moved] = subs.splice(fromIdx, 1);
      subs.splice(toIdx, 0, moved);
      const next = { ...taxonomy };
      next.categories = taxonomy.categories.map((c, i) =>
        i === selectedCatIdx ? { ...c, subcategories: subs } : c
      );
      setTaxonomy(next);
      // Keep the same sub highlighted across the move
      if (selectedSub) {
        // selectedSub is a name not an index, so it's stable across reorder
      }
      markDirty();
    }

    function reorderTagsAt(fromIdx, toIdx) {
      if (fromIdx === toIdx) return;
      updateCurrentTagOrder((arr) => {
        const next = [...arr];
        const [moved] = next.splice(fromIdx, 1);
        next.splice(toIdx, 0, moved);
        return next;
      });
      markDirty();
    }

    // Build dnd props for a draggable row. listKey: "cat" | "sub" | "tag".
    // index: zero-based position in the list.
    // onReorder: function(fromIdx, toIdx) -> void.
    function dragProps(listKey, index, onReorder) {
      return {
        onDragOver: (e) => {
          // Only accept drops from the same list (cross-list drops are
          // semantically nonsensical).
          if (dragState.current.listKey !== listKey) return;
          e.preventDefault();  // required to allow drop
          // Visual: highlight which side of the row would receive the drop.
          // We don't store this in state (would re-render too aggressively);
          // instead, toggle a CSS class on the row directly via DOM.
          const rect = e.currentTarget.getBoundingClientRect();
          const aboveHalf = (e.clientY - rect.top) < rect.height / 2;
          e.currentTarget.classList.toggle("drag-over-above", aboveHalf);
          e.currentTarget.classList.toggle("drag-over-below", !aboveHalf);
        },
        onDragLeave: (e) => {
          e.currentTarget.classList.remove("drag-over-above", "drag-over-below");
        },
        onDrop: (e) => {
          if (dragState.current.listKey !== listKey) return;
          e.preventDefault();
          e.currentTarget.classList.remove("drag-over-above", "drag-over-below");
          const rect = e.currentTarget.getBoundingClientRect();
          const aboveHalf = (e.clientY - rect.top) < rect.height / 2;
          const from = dragState.current.fromIdx;
          // When dropping below an item, the target insertion index is
          // one past the hovered index. When the source is *before* the
          // target, splicing removes 1 element first, so the effective
          // destination shifts down by 1 — handled inside the reorder
          // helpers which all use splice semantics consistently.
          let to = aboveHalf ? index : index + 1;
          if (from < to) to -= 1;  // adjust for the removed source slot
          onReorder(from, to);
          dragState.current = { listKey: null, fromIdx: null };
        },
      };
    }

    // Build dnd props for the drag handle (the bit you grab). The handle
    // is responsible for setting `draggable=true` and firing dragStart.
    function handleProps(listKey, index) {
      return {
        draggable: true,
        onDragStart: (e) => {
          dragState.current = { listKey, fromIdx: index };
          // Some browsers require setData for drag to actually fire
          try {
            e.dataTransfer.setData("text/plain", String(index));
            e.dataTransfer.effectAllowed = "move";
          } catch (_) {}
        },
        onDragEnd: (e) => {
          // Clean up any stray highlight classes that didn't get cleared
          // by drop (e.g. user dragged outside the list).
          document
            .querySelectorAll(".drag-over-above, .drag-over-below")
            .forEach((el) =>
              el.classList.remove("drag-over-above", "drag-over-below")
            );
          dragState.current = { listKey: null, fromIdx: null };
        },
      };
    }

    function DragHandle({ listKey, index }) {
      return React.createElement(
        "span",
        Object.assign(
          {
            className: "tag-categories-drag-handle",
            title: "Drag to reorder",
            "aria-label": "Drag to reorder",
          },
          handleProps(listKey, index)
        ),
        // Six-dot grip glyph (Unicode "Braille pattern dots-12345678")
        "⠿"
      );
    }

    function toggleHidden(idx) {
      const next = { ...taxonomy };
      next.categories = taxonomy.categories.map((c, i) =>
        i === idx ? { ...c, hidden: !c.hidden } : c
      );
      setTaxonomy(next);
      markDirty();
    }

    function setColour(idx, newColour) {
      const next = { ...taxonomy };
      next.categories = taxonomy.categories.map((c, i) =>
        i === idx ? { ...c, colour: newColour } : c
      );
      setTaxonomy(next);
      markDirty();
    }

    // -------- tag-level ops (col 3) --------

    function getCurrentTagIds() {
      // Get the ordered list of tag IDs for the currently selected
      // (cat, sub). Returns the array reference from taxonomy.tagOrder.
      // If undefined for any reason, return []. Caller should not mutate.
      if (!selectedCat) return [];
      const order = selectedCat.tagOrder || {};
      return order[effectiveSub] || [];
    }

    function tagNameFor(tagId) {
      const t = allTags.find((x) => String(x.id) === String(tagId));
      return t ? t.name : `(tag ${tagId})`;
    }

    function updateCurrentTagOrder(updater) {
      // Update taxonomy.categories[selectedCatIdx].tagOrder[effectiveSub]
      // immutably via updater(currentArray) -> nextArray.
      const next = { ...taxonomy };
      next.categories = taxonomy.categories.map((c, i) => {
        if (i !== selectedCatIdx) return c;
        const order = { ...(c.tagOrder || {}) };
        const nextArr = updater(order[effectiveSub] || []);
        order[effectiveSub] = nextArr;
        return { ...c, tagOrder: order };
      });
      setTaxonomy(next);
    }

    function addTagToCurrent(tagId) {
      const idStr = String(tagId);
      // v0.4.0: the native picker offers every tag, not just
      // uncategorised ones, so a pick can be a re-assignment from
      // another (cat, sub). Append to the current category's tagOrder
      // AND, if the tag was assigned elsewhere, drop it from that old
      // category's tagOrder so it doesn't linger there as a ghost row.
      const prev = assignments[idStr] || null;
      setTaxonomy((tax) => {
        const next = { ...tax };
        next.categories = tax.categories.map((c, i) => {
          let cat = c;
          if (prev && prev.category === c.name) {
            const order = { ...(cat.tagOrder || {}) };
            const oldSub = prev.subcategory || "";
            if (Array.isArray(order[oldSub])) {
              order[oldSub] = order[oldSub].filter((x) => x !== idStr);
              cat = { ...cat, tagOrder: order };
            }
          }
          if (i === selectedCatIdx) {
            const order = { ...(cat.tagOrder || {}) };
            const arr = order[effectiveSub] || [];
            if (!arr.includes(idStr)) {
              order[effectiveSub] = [...arr, idStr];
              cat = { ...cat, tagOrder: order };
            }
          }
          return cat;
        });
        return next;
      });
      setAssignments((a) => ({
        ...a,
        [idStr]: { category: selectedCat.name, subcategory: effectiveSub },
      }));
      markDirty();
    }

    // v0.4.0: create a brand-new tag, then assign it to the current
    // (cat, sub). The tag is added to `allTags` immediately so it
    // resolves to its real name without waiting for a save + reload.
    async function createAndAddTag(name) {
      const nm = String(name || "").trim();
      if (!nm) return;
      // If a tag with this name already exists, just assign it rather
      // than creating a duplicate.
      const existing = allTags.find(
        (t) => t.name.toLowerCase() === nm.toLowerCase()
      );
      if (existing) {
        addTagToCurrent(existing.id);
        return;
      }
      setBusy(true);
      try {
        const tag = await createTag(nm);
        if (!tag || !tag.id) throw new Error("Tag creation failed.");
        setAllTags((prev) => [...prev, { id: String(tag.id), name: tag.name }]);
        addTagToCurrent(tag.id);
      } catch (err) {
        alert("Could not create tag: " + (err.message || String(err)));
      } finally {
        setBusy(false);
      }
    }

    function removeTagFromCurrent(tagId) {
      const idStr = String(tagId);
      updateCurrentTagOrder((arr) => arr.filter((x) => x !== idStr));
      // Clear the assignment entirely (tag goes back to uncategorised)
      const nextAss = { ...assignments };
      delete nextAss[idStr];
      setAssignments(nextAss);
      markDirty();
    }

    // --------- subcategory-level ops ---------
    async function addSub() {
      if (!selectedCat) return;
      const trimmed = await askText({
        title: "Add sub-category",
        message: `Name for the new sub-category in "${selectedCat.name}":`,
        placeholder: "e.g. Appearance",
        confirmLabel: "Add sub-category",
        validate: (v) =>
          selectedCat.subcategories.includes(v)
            ? "A sub-category with this name already exists in this category."
            : null,
      });
      if (!trimmed) return;
      // v0.5.x: if the category is currently flat and has tags
      // assigned to it directly, those tags become orphans the moment
      // a sub is added (the editor only displays tags inside a sub).
      // Confirm before applying, then uncategorise them — the user
      // can re-assign into the new sub afterwards.
      const wasFlat = selectedCat.subcategories.length === 0;
      let directTagIds = [];
      if (wasFlat) {
        directTagIds = Object.keys(assignments).filter((tid) => {
          const a = assignments[tid];
          return (
            a &&
            a.category === selectedCat.name &&
            (a.subcategory || "") === ""
          );
        });
      }
      if (directTagIds.length > 0) {
        const n = directTagIds.length;
        const ok = await askConfirm({
          title: "Add sub-category",
          message:
            `"${selectedCat.name}" has ${n} tag${n === 1 ? "" : "s"} ` +
            `assigned directly. Adding a sub-category will mark ` +
            `${n === 1 ? "it" : "them"} as uncategorised so you can ` +
            `move ${n === 1 ? "it" : "them"} into a sub.`,
          confirmLabel: "Add sub-category",
        });
        if (!ok) return;
        // Uncategorise — drop the assignments. The picker will show
        // them as uncategorised options immediately.
        setAssignments((prev) => {
          const next = { ...prev };
          for (const tid of directTagIds) delete next[tid];
          return next;
        });
      }
      const next = { ...taxonomy };
      next.categories = taxonomy.categories.map((c, i) => {
        if (i !== selectedCatIdx) return c;
        // Drop any stale tagOrder[""] for this category — the direct
        // slot no longer makes sense once it has subs.
        const tagOrder = { ...(c.tagOrder || {}) };
        if (tagOrder[""]) delete tagOrder[""];
        return {
          ...c,
          subcategories: [...c.subcategories, trimmed],
          tagOrder,
        };
      });
      setTaxonomy(next);
      markDirty();
    }

    async function renameSub(subIdx) {
      if (!selectedCat) return;
      const cur = selectedCat.subcategories[subIdx];
      const trimmed = await askText({
        title: "Rename sub-category",
        message: `Rename sub-category "${cur}" to:`,
        defaultValue: cur,
        confirmLabel: "Rename",
        validate: (v) =>
          selectedCat.subcategories.some((s, i) => i !== subIdx && s === v)
            ? "A sub-category with this name already exists."
            : null,
      });
      if (!trimmed || trimmed === cur) return;
      const affected = countAssignments(assignments, selectedCat.name, cur);
      if (affected > 0) {
        const ok = await askConfirm({
          title: "Rename sub-category",
          message:
            `${affected} tag${affected === 1 ? "" : "s"} ${affected === 1 ? "is" : "are"} assigned to ` +
            `"${selectedCat.name} / ${cur}". They will be updated when you save. Continue?`,
          confirmLabel: "Rename",
        });
        if (!ok) return;
      }
      const next = { ...taxonomy };
      next.categories = taxonomy.categories.map((c, i) => {
        if (i !== selectedCatIdx) return c;
        const subs = c.subcategories.map((s, si) => (si === subIdx ? trimmed : s));
        const renames = [...(c._subRenames || []), { from: cur, to: trimmed }];
        return { ...c, subcategories: subs, _subRenames: renames };
      });
      setTaxonomy(next);
      markDirty();
    }

    async function deleteSub(subIdx) {
      if (!selectedCat) return;
      const cur = selectedCat.subcategories[subIdx];
      const affected = countAssignments(assignments, selectedCat.name, cur);
      let msg = `Delete sub-category "${cur}" from "${selectedCat.name}"?`;
      if (affected > 0) {
        msg += `\n\n${affected} tag${affected === 1 ? "" : "s"} ${affected === 1 ? "is" : "are"} ` +
               "currently assigned. Their sub-category will be cleared (category preserved).";
      }
      const ok = await askConfirm({
        title: "Delete sub-category",
        message: msg,
        confirmLabel: "Delete sub-category",
        danger: true,
      });
      if (!ok) return;
      const next = { ...taxonomy };
      next.categories = taxonomy.categories.map((c, i) => {
        if (i !== selectedCatIdx) return c;
        const subs = c.subcategories.filter((_, si) => si !== subIdx);
        const deletions = [...(c._subDeletes || []), cur];
        return { ...c, subcategories: subs, _subDeletes: deletions };
      });
      setTaxonomy(next);
      markDirty();
    }

    // --------- JSON import/export ---------
    function importFromJson() {
      try {
        const parsed = JSON.parse(jsonText);
        if (!parsed || !Array.isArray(parsed.categories)) {
          throw new Error("Expected object with 'categories' array.");
        }
        for (const c of parsed.categories) {
          if (typeof c.name !== "string") throw new Error("Each category needs a 'name'.");
          if (!Array.isArray(c.subcategories)) c.subcategories = [];
          if (typeof c.hidden !== "boolean") c.hidden = false;
          if (typeof c.colour !== "string" || !/^#[0-9a-fA-F]{6}$/.test(c.colour)) {
            c.colour = DEFAULT_CATEGORY_COLOUR;
          }
        }
        setTaxonomy(parsed);
        setSelectedCatIdx(0);
        markDirty();
        setJsonError("");
        setShowJsonView(false);
      } catch (e) {
        setJsonError(e.message || String(e));
      }
    }

    // v0.3.1: file-based export/import. Independent of the JSON view
    // above — that lets you copy/paste taxonomy text; this lets you
    // download a full JSON file (taxonomy + assignments) and restore
    // it later. Import is destructive (replaces everything in
    // storage) so it routes through a confirm prompt.
    function onExportConfig() {
      const payload = {
        format: "tag-categories-backup",
        version: 1,
        exportedAt: new Date().toISOString(),
        data: {
          taxonomy: taxonomy,
          assignments: assignments,
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
      a.download = `tag-categories-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

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
          if (parsed.format !== "tag-categories-backup") {
            throw new Error(
              "Not a Tag Categories backup file (missing or wrong `format` field)."
            );
          }
          if (!parsed.data || typeof parsed.data !== "object") {
            throw new Error("Backup file is missing the `data` payload.");
          }
          if (!parsed.data.taxonomy || !Array.isArray(parsed.data.taxonomy.categories)) {
            throw new Error("Backup `data.taxonomy.categories` is missing or not an array.");
          }
          if (!parsed.data.assignments || typeof parsed.data.assignments !== "object") {
            throw new Error("Backup `data.assignments` is missing or not an object.");
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

    // Confirmed import — replace storage AND in-memory editor state.
    // Persists immediately via writeTaxonomyAndAssignments so the
    // restored config survives reload without a separate Save step.
    async function onImportConfirm() {
      const incoming = pendingImport;
      if (!incoming) return;
      setPendingImport(null);
      setBusy(true);
      try {
        const newTax = incoming.data.taxonomy;
        const newAssn = incoming.data.assignments;
        await writeTaxonomyAndAssignments(newTax, newAssn);
        // Resync local editor state so the UI reflects the new data.
        setTaxonomy(JSON.parse(JSON.stringify(newTax)));
        setAssignments(JSON.parse(JSON.stringify(newAssn)));
        setSelectedCatIdx(0);
        setSelectedSub(null);
        // Dirty state cleared — we just persisted to storage.
        setUnsavedDirty(false);
      } catch (err) {
        alert("Import failed: " + (err.message || String(err)));
      } finally {
        setBusy(false);
      }
    }

    function onImportCancel() {
      setPendingImport(null);
    }

    // --------- Save ---------
    async function save() {
      setBusy(true);
      try {
        // Build rename/delete maps from taxonomy transient markers
        const catRenames = {};        // oldName -> newName
        const subRenamesByCat = {};   // newCatName -> { oldSub -> newSub }
        const subDeletesByCat = {};   // catName -> Set(deletedSubs)
        for (const c of taxonomy.categories) {
          if (c._renamedFrom && c._renamedFrom !== c.name) {
            catRenames[c._renamedFrom] = c.name;
          }
          if (Array.isArray(c._subRenames)) {
            const map = subRenamesByCat[c.name] = {};
            for (const r of c._subRenames) map[r.from] = r.to;
          }
          if (Array.isArray(c._subDeletes)) {
            subDeletesByCat[c.name] = new Set(c._subDeletes);
          }
        }
        const aliveCats = new Set();
        for (const c of taxonomy.categories) aliveCats.add(c.name);

        // Apply cat-rename / sub-rename / cat-delete / sub-delete cascade
        // to the local assignments state (already includes col-3 changes).
        const cleanAssignments = { ...assignments };
        for (const tagId of Object.keys(cleanAssignments)) {
          const a = cleanAssignments[tagId];
          if (!a) continue;
          let cat = a.category;
          let sub = a.subcategory;
          if (catRenames[cat]) cat = catRenames[cat];
          if (!aliveCats.has(cat)) {
            delete cleanAssignments[tagId];
            continue;
          }
          const renames = subRenamesByCat[cat];
          if (renames && sub && renames[sub]) sub = renames[sub];
          const dels = subDeletesByCat[cat];
          if (dels && sub && dels.has(sub)) sub = "";
          cleanAssignments[tagId] = { category: cat, subcategory: sub };
        }

        // Strip transient markers from taxonomy before writing. Preserve
        // colour, hidden, and tagOrder. tagOrder keys also need to be
        // renamed/cleaned in the same way as subcategories.
        const clean = {
          categories: taxonomy.categories.map((c) => {
            const cleanOrder = {};
            const validSubs = new Set([...c.subcategories, ""]);
            for (const k of Object.keys(c.tagOrder || {})) {
              if (!validSubs.has(k)) continue;  // skip deleted sub keys
              // Filter tagOrder to only tags still assigned to this (cat, k)
              const want = (c.tagOrder[k] || []).filter((tid) => {
                const a = cleanAssignments[tid];
                return a && a.category === c.name && a.subcategory === k;
              });
              cleanOrder[k] = want;
            }
            return {
              name: c.name,
              hidden: !!c.hidden,
              colour: c.colour || DEFAULT_CATEGORY_COLOUR,
              subcategories: [...c.subcategories],
              tagOrder: cleanOrder,
            };
          }),
        };

        await writeTaxonomyAndAssignments(clean, cleanAssignments);
        setUnsavedDirty(false);
        onSaved();
      } catch (err) {
        alert("Save failed: " + (err.message || String(err)));
      } finally {
        setBusy(false);
      }
    }

    // v0.3.1: confirm-replace prompt for file-based import. Rendered
    // as a portal to <body> so it floats above the settings modal.
    // Destructive action — default chrome (no special "resolved"
    // variant). Two buttons: Cancel and Replace.
    const importConfirmModal = pendingImport
      ? ReactDOM.createPortal(
          React.createElement(
            "div",
            {
              className: "tag-categories-overlay",
              style: { zIndex: 2100 },
            },
            React.createElement(
              "div",
              {
                className: "tag-categories-modal",
                style: { width: 480, maxWidth: "90vw" },
              },
              React.createElement(
                "div",
                { className: "tag-categories-modal-header" },
                React.createElement("h5", null, "Replace all categories?")
              ),
              React.createElement(
                "div",
                { className: "tag-categories-modal-body" },
                React.createElement(
                  "div",
                  { style: { color: "#ccc", marginBottom: 16, lineHeight: 1.5 } },
                  (() => {
                    const catCount = (pendingImport.data.taxonomy.categories || []).length;
                    const assnCount = Object.keys(pendingImport.data.assignments || {}).length;
                    const when = pendingImport.exportedAt
                      ? new Date(pendingImport.exportedAt).toLocaleString()
                      : "an unknown time";
                    return (
                      `This backup contains ${catCount} categor${catCount === 1 ? "y" : "ies"} ` +
                      `and ${assnCount} tag assignment${assnCount === 1 ? "" : "s"} ` +
                      `(exported ${when}). Importing will REPLACE everything currently stored. ` +
                      `Any unsaved edits will be lost.`
                    );
                  })()
                ),
                React.createElement(
                  "div",
                  { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      className: "btn btn-secondary",
                      onClick: onImportCancel,
                      disabled: busy,
                    },
                    "Cancel"
                  ),
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      className: "btn btn-danger",
                      onClick: onImportConfirm,
                      disabled: busy,
                    },
                    busy ? "Importing..." : "Replace all"
                  )
                )
              )
            )
          ),
          document.body
        )
      : null;

    // v0.3.1: requestClose — gate function called by Cancel button,
    // header Close button, and (via requestCloseRef) PortalModal.
    // Opens the confirm-discard prompt if there are unsaved edits;
    // otherwise closes immediately.
    function requestClose() {
      if (unsavedDirty) setConfirmCloseOpen(true);
      else onClose();
    }

    // Publish requestClose onto the shared ref so PortalModal's header
    // Close button routes through it too.
    React.useEffect(() => {
      if (!requestCloseRef) return undefined;
      requestCloseRef.current = requestClose;
      return () => {
        if (requestCloseRef.current === requestClose) {
          requestCloseRef.current = null;
        }
      };
      // requestClose closes over unsavedDirty + onClose; re-publish
      // each render so the ref reflects the latest dirty state.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    });

    // v0.3.1: confirm-discard prompt for closing with unsaved edits.
    // Same chrome as the import-confirm prompt below (uses local
    // .tag-categories-overlay/modal classes). Two buttons: Keep
    // editing (dismiss) and Discard & close (proceed).
    const confirmCloseModal = confirmCloseOpen
      ? ReactDOM.createPortal(
          React.createElement(
            "div",
            {
              className: "tag-categories-overlay",
              style: { zIndex: 2100 },
            },
            React.createElement(
              "div",
              {
                className: "tag-categories-modal",
                style: { width: 480, maxWidth: "90vw" },
              },
              React.createElement(
                "div",
                { className: "tag-categories-modal-header" },
                React.createElement("h5", null, "Discard unsaved changes?")
              ),
              React.createElement(
                "div",
                { className: "tag-categories-modal-body" },
                React.createElement(
                  "div",
                  { style: { color: "#ccc", marginBottom: 16, lineHeight: 1.5 } },
                  "You have unsaved edits. If you close now, they will be lost."
                ),
                React.createElement(
                  "div",
                  { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
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
            )
          ),
          document.body
        )
      : null;

    // v0.4.0: in-modal prompt / confirm dialog (replaces browser
    // prompt() / confirm()). Portalled above the editor at z 2100.
    const dialogModal = dialog
      ? ReactDOM.createPortal(
          React.createElement(
            "div",
            { className: "tag-categories-overlay", style: { zIndex: 2100 } },
            React.createElement(
              "div",
              {
                className: "tag-categories-modal",
                style: { width: 460, maxWidth: "90vw" },
              },
              React.createElement(
                "div",
                { className: "tag-categories-modal-header" },
                React.createElement("h5", null, dialog.title)
              ),
              React.createElement(
                "div",
                { className: "tag-categories-modal-body" },
                dialog.message
                  ? React.createElement(
                      "div",
                      {
                        style: {
                          color: "#ccc",
                          marginBottom: 12,
                          lineHeight: 1.5,
                          whiteSpace: "pre-line",
                        },
                      },
                      dialog.message
                    )
                  : null,
                dialog.mode === "prompt"
                  ? React.createElement("input", {
                      type: "text",
                      autoFocus: true,
                      value: dialog.value,
                      placeholder: dialog.placeholder,
                      onChange: (e) =>
                        setDialog({
                          ...dialog,
                          value: e.target.value,
                          error: "",
                        }),
                      onKeyDown: (e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          dialogConfirm();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          dialogCancel();
                        }
                      },
                      style: {
                        width: "100%",
                        boxSizing: "border-box",
                        padding: "7px 9px",
                        background: "#15171b",
                        border: "1px solid #3a3a3a",
                        borderRadius: 4,
                        color: "#eee",
                        fontSize: 14,
                      },
                    })
                  : null,
                dialog.error
                  ? React.createElement(
                      "div",
                      {
                        style: {
                          color: "#ff6b6b",
                          fontSize: 12,
                          marginTop: 6,
                        },
                      },
                      dialog.error
                    )
                  : null,
                React.createElement(
                  "div",
                  {
                    style: {
                      display: "flex",
                      justifyContent: "flex-end",
                      gap: 8,
                      marginTop: 16,
                    },
                  },
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      className: "btn btn-secondary",
                      onClick: dialogCancel,
                    },
                    "Cancel"
                  ),
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      className:
                        "btn " + (dialog.danger ? "btn-danger" : "btn-primary"),
                      onClick: dialogConfirm,
                      disabled:
                        dialog.mode === "prompt" &&
                        !String(dialog.value || "").trim(),
                    },
                    dialog.confirmLabel
                  )
                )
              )
            )
          ),
          document.body
        )
      : null;

    // --------- Render ---------
    return React.createElement(
      "div",
      { className: "tag-categories-editor" },

      // JSON toggle row
      React.createElement(
        "div",
        { className: "tag-categories-toolbar" },
        React.createElement(
          "button",
          {
            type: "button",
            className: "btn btn-sm btn-secondary",
            onClick: () => {
              if (!showJsonView) syncJson();
              setShowJsonView(!showJsonView);
            },
          },
          showJsonView ? "Hide JSON" : "View / Edit as JSON"
        ),
        // v0.3.1: file-based export/import. Sits next to the JSON
        // view toggle since both are taxonomy I/O actions. Hidden
        // file input is triggered by the Import Config button.
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
            onClick: onExportConfig,
            disabled: busy,
            title: "Download a JSON backup of all categories + assignments.",
          },
          "Export Config"
        ),
        React.createElement(
          "button",
          {
            type: "button",
            className: "btn btn-sm btn-secondary",
            onClick: onImportClick,
            disabled: busy,
            title: "Import a JSON backup. Replaces all categories and assignments.",
          },
          "Import Config"
        ),
        React.createElement(
          "span",
          { className: "tag-categories-toolbar-spacer" },
          unsavedDirty ? "Unsaved changes" : ""
        )
      ),

      showJsonView
        ? React.createElement(
            "div",
            { className: "tag-categories-json-view" },
            React.createElement("textarea", {
              value: jsonText,
              onChange: (e) => setJsonText(e.target.value),
              rows: 20,
            }),
            jsonError
              ? React.createElement(
                  "div",
                  { className: "tag-categories-json-error" },
                  jsonError
                )
              : null,
            React.createElement(
              "div",
              { className: "tag-categories-json-actions" },
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "btn btn-sm btn-secondary",
                  onClick: () => navigator.clipboard.writeText(jsonText),
                },
                "Copy"
              ),
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "btn btn-sm btn-primary",
                  onClick: importFromJson,
                },
                "Apply JSON"
              )
            )
          )
        : React.createElement(
            "div",
            { className: "tag-categories-two-col" },

            // ----- Left column: categories -----
            React.createElement(
              "div",
              { className: "tag-categories-col" },
              React.createElement(
                "div",
                { className: "tag-categories-col-header" },
                React.createElement("h6", null, "Categories"),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-sm btn-primary",
                    onClick: addCategory,
                  },
                  "+ Add"
                )
              ),
              React.createElement(
                "ul",
                { className: "tag-categories-list" },
                taxonomy.categories.map((c, idx) =>
                  React.createElement(
                    "li",
                    Object.assign(
                      {
                        key: idx,
                        className:
                          "tag-categories-list-item" +
                          (idx === selectedCatIdx ? " selected" : "") +
                          (c.hidden ? " hidden-cat" : ""),
                        onClick: () => {
                          setSelectedCatIdx(idx);
                          setSelectedSub(null);
                        },
                      },
                      dragProps("cat", idx, reorderCategories)
                    ),
                    React.createElement(DragHandle, { listKey: "cat", index: idx }),
                    // Native HTML5 colour picker as inline swatch. Clicking
                    // opens the OS colour picker. Stopping propagation so
                    // clicking the swatch doesn't also re-trigger row
                    // selection (which is harmless but visually noisy).
                    React.createElement("input", {
                      type: "color",
                      value: c.colour || DEFAULT_CATEGORY_COLOUR,
                      className: "tag-categories-swatch-input",
                      title: "Change colour",
                      onClick: (e) => e.stopPropagation(),
                      onChange: (e) => setColour(idx, e.target.value),
                    }),
                    React.createElement(
                      "span",
                      { className: "tag-categories-list-name" },
                      c.name,
                      c.hidden
                        ? React.createElement(
                            "span",
                            { className: "tag-categories-hidden-flag" },
                            " (hidden)"
                          )
                        : null,
                      c.subcategories.length > 0
                        ? React.createElement(
                            "span",
                            { className: "tag-categories-subcount" },
                            ` · ${c.subcategories.length} subcat${c.subcategories.length === 1 ? "" : "s"}`
                          )
                        : null
                    ),
                    React.createElement(
                      "span",
                      { className: "tag-categories-list-actions" },
                      React.createElement(
                        "button",
                        {
                          type: "button",
                          title: "Rename",
                          className: "btn btn-xs btn-secondary",
                          onClick: (e) => {
                            e.stopPropagation();
                            renameCategory(idx);
                          },
                        },
                        "Rename"
                      ),
                      React.createElement(
                        "button",
                        {
                          type: "button",
                          title: c.hidden
                            ? "Show tags in this category on the Tags listing"
                            : "Hide tags in this category from the Tags listing",
                          className: "btn btn-xs btn-secondary",
                          onClick: (e) => {
                            e.stopPropagation();
                            toggleHidden(idx);
                          },
                        },
                        c.hidden ? "Show" : "Hide"
                      ),
                      React.createElement(
                        "button",
                        {
                          type: "button",
                          title: "Delete",
                          className: "btn btn-xs btn-danger",
                          onClick: (e) => {
                            e.stopPropagation();
                            deleteCategory(idx);
                          },
                        },
                        "✕"
                      )
                    )
                  )
                )
              )
            ),

            // ----- Right column: subcategories of selected category -----
            React.createElement(
              "div",
              { className: "tag-categories-col" },
              React.createElement(
                "div",
                { className: "tag-categories-col-header" },
                React.createElement(
                  "h6",
                  null,
                  selectedCat
                    ? `Sub-categories of "${selectedCat.name}"`
                    : "Sub-categories"
                ),
                selectedCat
                  ? React.createElement(
                      "button",
                      {
                        type: "button",
                        className: "btn btn-sm btn-primary",
                        onClick: addSub,
                      },
                      "+ Add"
                    )
                  : null
              ),
              !selectedCat
                ? React.createElement(
                    "div",
                    { className: "tag-categories-empty" },
                    "Select a category on the left."
                  )
                : selectedCat.subcategories.length === 0
                ? React.createElement(
                    "div",
                    { className: "tag-categories-empty" },
                    "This category has no sub-categories. Click + Add to create one."
                  )
                : React.createElement(
                    "ul",
                    { className: "tag-categories-list" },
                    selectedCat.subcategories.map((s, subIdx) =>
                      React.createElement(
                        "li",
                        Object.assign(
                          {
                            key: subIdx,
                            className:
                              "tag-categories-list-item" +
                              (selectedSub === s ? " selected" : ""),
                            onClick: () => {
                              setSelectedSub(s);
                            },
                          },
                          dragProps("sub", subIdx, reorderSubs)
                        ),
                        React.createElement(DragHandle, { listKey: "sub", index: subIdx }),
                        React.createElement(
                          "span",
                          { className: "tag-categories-list-name" },
                          s
                        ),
                        React.createElement(
                          "span",
                          { className: "tag-categories-list-actions" },
                          React.createElement(
                            "button",
                            {
                              type: "button",
                              title: "Rename",
                              className: "btn btn-xs btn-secondary",
                              onClick: (e) => {
                                e.stopPropagation();
                                renameSub(subIdx);
                              },
                            },
                            "Rename"
                          ),
                          React.createElement(
                            "button",
                            {
                              type: "button",
                              title: "Delete",
                              className: "btn btn-xs btn-danger",
                              onClick: (e) => {
                                e.stopPropagation();
                                deleteSub(subIdx);
                              },
                            },
                            "✕"
                          )
                        )
                      )
                    )
                  )
            ),

            // ----- Column 3: tags in the selected (cat, sub) -----
            React.createElement(
              "div",
              { className: "tag-categories-col" },
              React.createElement(
                "div",
                { className: "tag-categories-col-header" },
                React.createElement(
                  "h6",
                  null,
                  col3Active
                    ? (categoryHasSubs
                        ? `Tags in "${selectedCat.name} / ${selectedSub}"`
                        : `Tags in "${selectedCat.name}"`)
                    : "Tags"
                )
              ),
              !col3Active
                ? React.createElement(
                    "div",
                    { className: "tag-categories-empty" },
                    !selectedCat
                      ? "Select a category on the left."
                      : "Select a sub-category to see its tags."
                  )
                : React.createElement(
                    React.Fragment,
                    null,
                    // v0.4.0: bespoke tag picker. Looks like a native
                    // Stash combobox but annotates each option with the
                    // tag's current category, so the user can see — at
                    // pick time — whether a tag is uncategorised or is
                    // about to be moved out of another category.
                    React.createElement(
                      "div",
                      { className: "tag-categories-tag-picker" },
                      React.createElement(TagPickerCombo, {
                        allTags: allTags,
                        assignments: assignments,
                        taxonomy: taxonomy,
                        currentCategory: selectedCat.name,
                        busy: busy,
                        onAdd: addTagToCurrent,
                        onCreate: createAndAddTag,
                      })
                    ),
                    // Tag list
                    (() => {
                      const ids = getCurrentTagIds();
                      if (ids.length === 0) {
                        return React.createElement(
                          "div",
                          { className: "tag-categories-empty" },
                          "No tags assigned yet. Use the search above to add some."
                        );
                      }
                      return React.createElement(
                        "ul",
                        { className: "tag-categories-list" },
                        ids.map((tid, tIdx) =>
                          React.createElement(
                            "li",
                            Object.assign(
                              {
                                key: tid,
                                className: "tag-categories-list-item tag-categories-tag-list-item",
                              },
                              dragProps("tag", tIdx, reorderTagsAt)
                            ),
                            React.createElement(DragHandle, { listKey: "tag", index: tIdx }),
                            React.createElement(
                              "span",
                              { className: "tag-categories-list-name" },
                              React.createElement(
                                "a",
                                {
                                  href: `/tags/${tid}`,
                                  target: "_blank",
                                  rel: "noreferrer",
                                  title: "Open tag in new tab",
                                },
                                tagNameFor(tid)
                              )
                            ),
                            // v0.4.0: flag a tag that the pending save
                            // will move out of another category.
                            (() => {
                              const orig =
                                initialConfig.assignments &&
                                initialConfig.assignments[String(tid)];
                              if (
                                orig &&
                                orig.category &&
                                orig.category !== selectedCat.name
                              ) {
                                return React.createElement(
                                  "span",
                                  {
                                    className: "tag-categories-list-moved",
                                    title:
                                      "Saving will move this tag out of \"" +
                                      orig.category +
                                      "\".",
                                  },
                                  "moved from " + orig.category
                                );
                              }
                              return null;
                            })(),
                            React.createElement(
                              "span",
                              { className: "tag-categories-list-actions" },
                              React.createElement(
                                "button",
                                {
                                  type: "button",
                                  title: "Remove from this category/sub",
                                  className: "btn btn-xs btn-danger",
                                  onClick: () => removeTagFromCurrent(tid),
                                },
                                "✕"
                              )
                            )
                          )
                        )
                      );
                    })()
                  )
            )
          ),

      // Footer: Save / Cancel
      React.createElement(
        "div",
        { className: "tag-categories-footer" },
        React.createElement(
          "button",
          {
            type: "button",
            className: "btn btn-secondary",
            onClick: requestClose,
            disabled: busy,
          },
          "Cancel"
        ),
        React.createElement(
          "button",
          {
            type: "button",
            className: "btn btn-primary",
            onClick: save,
            disabled: busy || !unsavedDirty,
          },
          busy ? "Saving..." : "Save"
        )
      ),
      importConfirmModal,
      confirmCloseModal,
      dialogModal
    );
  }

  // Module-level counter to guard against the patch.before being applied
  // multiple times (the navbar re-renders, mounting a new ModalHost each
  // time). Only the first host to mount becomes active; the rest are no-ops.
  let activeHostCount = 0;

  function ModalHost() {
    const [open, setOpen] = React.useState(false);
    const [config, setConfig] = React.useState(null);
    const [loading, setLoading] = React.useState(false);
    const [isActive, setIsActive] = React.useState(false);
    // v0.3.1: shared ref the body fills with its requestClose gate.
    // PortalModal's header Close button routes through this so all
    // close paths consult the dirty-check confirm.
    const requestCloseRef = React.useRef(null);

    React.useEffect(() => {
      // Only the first host to mount becomes active. Subsequent hosts
      // (created by repeated patch applications) render null and ignore
      // events — otherwise the modal opens twice and you have to close
      // it twice.
      if (activeHostCount > 0) return undefined;
      activeHostCount += 1;
      setIsActive(true);

      function onOpen() {
        setOpen(true);
        setLoading(true);
        Promise.all([readPluginConfig(), fetchAllTags()])
          .then(([cfg, tags]) => {
            // v1.4.4: drop assignments / tagOrder entries whose tag ID
            // no longer exists in Stash (e.g. the user deleted the tag
            // after assigning it). The editor would otherwise show them
            // as "(tag 313)" rows. If anything was cleaned, persist the
            // cleaned config so the orphan is gone for good.
            const { cleaned, changed } = pruneOrphanAssignments(cfg, tags);
            if (changed) {
              writePluginConfig({
                assignments: cleaned.assignments,
                taxonomy: cleaned.taxonomy,
                reorderTagBadges: cfg.reorderTagBadges,
                clickableCategoryPills: cfg.clickableCategoryPills,
              })
                .then(() => {
                  window.dispatchEvent(
                    new CustomEvent(CONFIG_CHANGED_EVENT_NAME)
                  );
                })
                .catch((err) => {
                  console.warn(
                    "[tag-categories] failed to persist orphan cleanup:",
                    err
                  );
                });
            }
            setConfig({ ...cleaned, allTags: tags });
          })
          .catch((err) => {
            console.error("[tag-categories] failed to read config:", err);
            setConfig({ assignments: {}, taxonomy: DEFAULT_TAXONOMY, allTags: [] });
          })
          .finally(() => setLoading(false));
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
      setConfig(null);
    }
    function onSaved() {
      // Closed after save — refresh next time it opens.
      close();
    }
    // v0.3.1: route the header Close button through the body's
    // requestClose gate when it's available. If the body hasn't
    // mounted (loading state) it falls back to close() directly.
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
        title: "Edit Tag Categories",
        // Fixed height: the editor's columns scroll internally rather
        // than the whole modal growing with content.
        height: "85vh",
      },
      loading || !config
        ? React.createElement(
            "div",
            { style: { padding: 20, color: "#999" } },
            "Loading taxonomy..."
          )
        : React.createElement(SettingsModalBody, {
            initialConfig: config,
            onSaved: onSaved,
            onClose: close,
            requestCloseRef: requestCloseRef,
          })
    );
  }

  // ---------------------------------------------------------------------------
  // Picker pill colouring (0.3.0)
  //
  // Tints every staged-tag pill inside any react-select multi-value picker
  // (TagSelect) with the tag's category colour. Implementation:
  //
  //   1. Cache the plugin config in module-level state. Reload on first miss
  //      or on the CONFIG_CHANGED_EVENT_NAME event.
  //   2. On every injection pass, query for un-coloured pills:
  //        .react-select__multi-value:not([data-tc-coloured])
  //      For each, walk its React fibre upwards looking for memoizedProps
  //      with a string `value` field (verified via probe — that's the tag
  //      ID). Look up the category colour; set --tc-bg / --tc-fg inline.
  //      Mark with data-tc-coloured = "<tagId>" so we don't reprocess.
  //   3. When config changes, strip the marker off all pills so they get
  //      re-evaluated against the new colours/assignments on the next pass.
  //   4. If the pill's fibre value doesn't match its current marker, treat
  //      as un-coloured (handles the case where react-select reuses DOM
  //      nodes for different tags).
  //
  // We deliberately do NOT colour pills whose tag has no assignment, or
  // whose category was deleted from the taxonomy — those fall through to
  // whatever Stash/theme paints them. Marker still gets set (to "none") so
  // we don't keep re-walking the fibre on every pass.
  // ---------------------------------------------------------------------------

  const PILL_COLOUR_MARKER_ATTR = "data-tc-coloured";

  let pillColourerCachedConfig = null;
  let pillColourerLoadInFlight = null;

  async function ensurePillColourerConfig() {
    if (pillColourerCachedConfig) return pillColourerCachedConfig;
    if (pillColourerLoadInFlight) return pillColourerLoadInFlight;
    pillColourerLoadInFlight = (async () => {
      try {
        const cfg = await readPluginConfig();
        pillColourerCachedConfig = {
          assignments: cfg.assignments || {},
          taxonomy: cfg.taxonomy || DEFAULT_TAXONOMY,
          // v0.3.3: cached alongside taxonomy/assignments so the reorder
          // pass can decide whether to run without re-reading config.
          reorderTagBadges: !!cfg.reorderTagBadges,
        };
        return pillColourerCachedConfig;
      } catch (err) {
        console.warn(
          "[tag-categories] pill colourer: failed to load config:",
          err
        );
        return null;
      } finally {
        pillColourerLoadInFlight = null;
      }
    })();
    return pillColourerLoadInFlight;
  }

  function invalidatePillColourerCache() {
    pillColourerCachedConfig = null;
    // Strip markers AND inline paint so the next injection pass re-evaluates
    // every pill against the now-fresh config. We only touch the outer pill
    // element; the inner label/remove get their styling from a CSS rule
    // that's gated on the data-tc-coloured marker, so removing the marker
    // is enough to reset the inner elements too.
    document
      .querySelectorAll("[" + PILL_COLOUR_MARKER_ATTR + "]")
      .forEach((el) => {
        el.removeAttribute(PILL_COLOUR_MARKER_ATTR);
        el.style.removeProperty("background-color");
        el.style.removeProperty("color");
        el.style.removeProperty("--tc-bg");
        el.style.removeProperty("--tc-fg");
      });
    // v0.3.3: also strip the reorder marker so the next pass re-sorts
    // against fresh taxonomy/assignments. We can't restore Stash's
    // original badge order (the DOM has already been mutated) but the
    // re-sort gives the user the correct new order immediately.
    document
      .querySelectorAll("[" + BADGE_REORDER_MARKER_ATTR + "]")
      .forEach((el) => {
        el.removeAttribute(BADGE_REORDER_MARKER_ATTR);
      });
  }

  // Walk the React fibre attached to `el` upwards looking for the
  // react-select multi-value's data. The fibre stack from a pill DOM node
  // looks roughly like:
  //   hop 0-1: emotion-styled div wrappers
  //   hop 2-3: MultiValue components with props { data, selectProps, ... }
  //            where data = { value: "<tagId>", object: <full tag> }
  //
  // We require selectProps.className to contain "tag-select" so we don't
  // tint pills in non-tag pickers (gallery-select, performer-select, etc.)
  // which share the exact same react-select DOM/fibre shape.
  //
  // Returns the tag ID string, or null if not a tag picker / not found.
  function getTagIdFromPillFibre(el) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
    if (!key) return null;
    let fiber = el[key];
    let hops = 0;
    let foundId = null;
    let isTagSelect = false;
    while (fiber && hops < 20) {
      const props = fiber.memoizedProps;
      if (props) {
        // The MultiValue fibre carries both `data` and `selectProps`.
        if (
          !foundId &&
          props.data &&
          typeof props.data.value === "string" &&
          props.data.value.length > 0
        ) {
          foundId = props.data.value;
        }
        if (
          !isTagSelect &&
          props.selectProps &&
          typeof props.selectProps.className === "string" &&
          props.selectProps.className.split(/\s+/).includes("tag-select")
        ) {
          isTagSelect = true;
        }
        if (foundId && isTagSelect) return foundId;
      }
      fiber = fiber.return;
      hops += 1;
    }
    return null;
  }

  // Resolve a tag ID to a category colour using the cached config.
  // Returns null if no override should be applied (no assignment, orphan
  // assignment, or category has no colour set).
  function resolveTagPillColour(tagId) {
    if (!pillColourerCachedConfig) return null;
    const { assignments, taxonomy } = pillColourerCachedConfig;
    const entry = assignments && assignments[String(tagId)];
    if (!entry || !entry.category) return null;
    const cat = taxonomy.categories.find((c) => c.name === entry.category);
    if (!cat) return null; // orphan — leave untouched
    const bg = cat.colour;
    if (!bg || typeof bg !== "string") return null;
    return { bg, fg: pickTextColour(bg) };
  }

  async function tryColourPickerPills() {
    const pills = document.querySelectorAll(".react-select__multi-value");
    if (pills.length === 0) return;

    // Load config lazily on the first pill we see.
    if (!pillColourerCachedConfig) {
      await ensurePillColourerConfig();
      if (!pillColourerCachedConfig) return;
    }

    for (const pill of pills) {
      const tagId = getTagIdFromPillFibre(pill);

      // No tag ID resolvable — mark as "none" so we don't re-walk every pass.
      // Could happen for non-tag react-select usages (performers, studios,
      // etc.) where memoizedProps.value isn't a tag-shaped numeric string.
      if (!tagId) {
        if (pill.getAttribute(PILL_COLOUR_MARKER_ATTR) !== "none") {
          pill.setAttribute(PILL_COLOUR_MARKER_ATTR, "none");
          pill.style.removeProperty("--tc-bg");
          pill.style.removeProperty("--tc-fg");
        }
        continue;
      }

      const existing = pill.getAttribute(PILL_COLOUR_MARKER_ATTR);
      // Already processed for this exact tag ID — skip.
      if (existing === tagId) continue;
      // Stale marker (different tag) — clear inline paint before reapplying.
      // Inner label/remove are CSS-driven off the marker, so no per-child
      // cleanup needed.
      if (existing) {
        pill.style.removeProperty("background-color");
        pill.style.removeProperty("color");
        pill.style.removeProperty("--tc-bg");
        pill.style.removeProperty("--tc-fg");
      }

      const colour = resolveTagPillColour(tagId);
      if (!colour) {
        // No category / orphan / no colour. Leave the pill untouched.
        // Marker prevents re-walking the fibre every observer fire.
        pill.setAttribute(PILL_COLOUR_MARKER_ATTR, "none");
        continue;
      }

      // Paint the outer pill inline with !important. Inline !important is
      // the highest-priority declaration in CSS — it beats any stylesheet
      // rule including those with !important, regardless of selector
      // specificity or load order. This is what lets us win against themes
      // (Glassy) and Stash's own defaults without a specificity arms race.
      //
      // Inner label + remove elements are NOT painted from JS. They're
      // handled by a high-specificity descendant CSS rule in
      // tag-categories.css that fires off our data-tc-coloured marker.
      // Reason: react-select frequently re-renders the inner elements (on
      // any value change), and the new DOM nodes arrive without our inline
      // styles — there's a visible "flash to theme default" between the
      // re-render and our MutationObserver's next pass. Letting CSS paint
      // them via descendant selector means the new nodes are styled the
      // instant they mount, no race.
      pill.style.setProperty("background-color", colour.bg, "important");
      pill.style.setProperty("color", colour.fg, "important");

      // Keep the CSS custom properties too — they're useful for any future
      // CSS tweaks the user might author, and they're harmless if nothing
      // reads them. They're NOT what's painting the pill; the direct
      // background-color above is.
      pill.style.setProperty("--tc-bg", colour.bg);
      pill.style.setProperty("--tc-fg", colour.fg);

      pill.setAttribute(PILL_COLOUR_MARKER_ATTR, tagId);
    }
  }

  // -------------------------------------------------------------------------
  // Picker chip reorder (v1.0.1)
  //
  // Sorts the staged tag chips inside Stash's native react-select picker
  // by taxonomy order, mirroring tryReorderTagBadges' behaviour on the
  // read-only-badge side. Gated on the same `reorderTagBadges` BOOLEAN
  // setting as the badges, so one toggle drives all reordered surfaces.
  //
  // The tag ID for each chip is read from the colourer's per-chip marker
  // (PILL_COLOUR_MARKER_ATTR) rather than walking the React fibre, so
  // this is a cheap attribute read per chip. Both functions run in the
  // same scheduleInjection Promise.all, so on the rare frame where the
  // colourer hasn't tagged a chip yet, the reorder skips this pass and
  // catches up on the next.
  //
  // Non-tag pickers (performer, studio, group, etc.) use the same
  // .react-select__multi-value markup. The colourer marks those chips
  // "none". When we see ANY chip in a parent with a "none" or absent
  // marker, we skip the whole parent — that picker isn't a tag picker.
  //
  // No content-signature marker like the badge side: react-select can
  // re-render chips on any value change and may reset our DOM ordering.
  // Instead we recompute the expected order every pass and only mutate
  // when the current DOM order differs. After the user adds or removes
  // a tag, the next observer tick re-sorts; in between, the cheap
  // "already sorted" comparison no-ops.
  // -------------------------------------------------------------------------

  async function tryReorderPickerChips() {
    if (!pillColourerCachedConfig) {
      await ensurePillColourerConfig();
      if (!pillColourerCachedConfig) return;
    }
    if (!pillColourerCachedConfig.reorderTagBadges) return;

    const chips = document.querySelectorAll(".react-select__multi-value");
    if (chips.length === 0) return;

    // Group chips by parent — each react-select multi-value container is
    // a separate picker that may need independent ordering.
    const byParent = new Map();
    for (const chip of chips) {
      const p = chip.parentElement;
      if (!p) continue;
      let arr = byParent.get(p);
      if (!arr) {
        arr = [];
        byParent.set(p, arr);
      }
      arr.push(chip);
    }

    for (const [parent, parentChips] of byParent) {
      if (parentChips.length < 2) continue;

      // Resolve each chip's tag ID from the colourer's per-chip marker.
      // If ANY chip lacks a tag-shaped marker, this is either a non-tag
      // picker (performer / studio / etc.) or the colourer hasn't
      // processed yet — skip the entire parent and catch on a later pass.
      const chipIds = [];
      let skip = false;
      for (const c of parentChips) {
        const m = c.getAttribute(PILL_COLOUR_MARKER_ATTR);
        if (!m || m === "none") { skip = true; break; }
        chipIds.push(m);
      }
      if (skip) continue;

      // Compute the expected sorted order. Each entry keeps its original
      // index so we can detect "already sorted" by checking idx === position.
      const keyed = parentChips.map((c, i) => {
        const labelEl = c.querySelector(".react-select__multi-value__label");
        const name = labelEl ? (labelEl.textContent || "").trim() : "";
        return { c, idx: i, k: computeSortKeyFromTagId(chipIds[i], name) };
      });
      keyed.sort((x, y) => compareBadgeSortKeys(x.k, y.k));

      // Already in expected order — no DOM mutation needed.
      let needSort = false;
      for (let i = 0; i < keyed.length; i++) {
        if (keyed[i].idx !== i) { needSort = true; break; }
      }
      if (!needSort) continue;

      try {
        // Same insertBefore-anchor pattern as the badge reorder to
        // preserve the chip block's position within its parent (the
        // react-select input element typically follows the chips).
        const lastChip = parentChips[parentChips.length - 1];
        const referenceNode = lastChip.nextSibling;
        for (const { c } of keyed) {
          if (referenceNode) {
            parent.insertBefore(c, referenceNode);
          } else {
            parent.appendChild(c);
          }
        }
      } catch (err) {
        console.warn(
          "[tag-categories] picker chip reorder failed:",
          err
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Tag badge colouring (0.3.0)
  //
  // Stash renders read-only tag references as <span class="tag-item tag-link
  // badge badge-secondary"> across many surfaces — scene/gallery/image
  // detail panels, scene card hover popovers, and similar. These share
  // identical markup, so a single selector handles all of them:
  //
  //   <span class="tag-item tag-link badge badge-secondary"
  //         data-sort-name="<tag name>">
  //     <a href="/scenes?c=(...,%22id%22:%22<tagId>%22,%22label%22:...)">
  //       <div><tag name></div>
  //     </a>
  //   </span>
  //
  // The tag ID lives in the inner anchor's href as a URL-encoded JSON
  // fragment: "id":"NNN" (URL-encoded as %22id%22:%22NNN%22). Parsing
  // out the digit run is fast — no React fibre walk required.
  //
  // We share the cached config with tryColourPickerPills via
  // pillColourerCachedConfig, and the same data-tc-coloured marker
  // attribute. invalidatePillColourerCache strips markers from BOTH
  // surfaces because the selector `[data-tc-coloured]` matches anything
  // we've marked, regardless of element type.
  //
  // Performance: the DOM query already excludes processed badges via
  // :not([data-tc-coloured]), so an injection pass over a settled page
  // does effectively zero work — it just matches the empty set.
  // -------------------------------------------------------------------------

  const BADGE_SELECTOR =
    "span.tag-item.tag-link:not([" + PILL_COLOUR_MARKER_ATTR + "])";

  // Regex matches the URL-encoded tag ID fragment in the badge anchor's
  // href: "id":"NNN" (encoded as %22id%22:%22NNN%22).
  const BADGE_HREF_ID_RE = /%22id%22:%22(\d+)%22/;

  function getTagIdFromBadgeHref(badge) {
    const a = badge.querySelector("a");
    if (!a) return null;
    const href = a.getAttribute("href") || "";
    const m = href.match(BADGE_HREF_ID_RE);
    return m ? m[1] : null;
  }

  async function tryColourTagBadges() {
    const badges = document.querySelectorAll(BADGE_SELECTOR);
    if (badges.length === 0) return;

    // Load config lazily on first unmarked badge seen.
    if (!pillColourerCachedConfig) {
      await ensurePillColourerConfig();
      if (!pillColourerCachedConfig) return;
    }

    for (const badge of badges) {
      const tagId = getTagIdFromBadgeHref(badge);
      if (!tagId) {
        // No tag ID extractable — mark as "none" to skip on future passes.
        badge.setAttribute(PILL_COLOUR_MARKER_ATTR, "none");
        continue;
      }

      const colour = resolveTagPillColour(tagId);
      if (!colour) {
        badge.setAttribute(PILL_COLOUR_MARKER_ATTR, "none");
        continue;
      }

      // Inline !important paint on the outer span — beats any theme rule
      // unconditionally. Inner <a>/<div> styling handled by descendant CSS.
      badge.style.setProperty("background-color", colour.bg, "important");
      badge.style.setProperty("color", colour.fg, "important");
      badge.style.setProperty("--tc-bg", colour.bg);
      badge.style.setProperty("--tc-fg", colour.fg);
      badge.setAttribute(PILL_COLOUR_MARKER_ATTR, tagId);
    }
  }

  // ---------------------------------------------------------------------------
  // Tag badge reorder (0.3.3)
  //
  // Re-orders read-only tag badges in place so they display in taxonomy
  // hierarchy order rather than Stash's default alphabetical-by-name.
  // Pure DOM reshuffle — no DB writes, no Stash state mutation.
  //
  // Stash's `findScene { tags }` (and equivalents for performers/galleries
  // /images/etc.) is sorted by SQL `ORDER BY COALESCE(sort_name, name)`,
  // which we can't change from a JS plugin. The data arrives alphabetical;
  // we sort it on the client.
  //
  // Sort key per tag: [catIdx, subIdx, lowercaseName, id].
  //   - catIdx: index in `taxonomy.categories`. Missing assignment OR
  //     assigned to a category that no longer exists → Infinity (end).
  //   - subIdx: index in that category's `subcategories`. Missing sub OR
  //     sub no longer exists → Infinity within its cat.
  //   - lowercaseName: from badge data-sort-name (Stash already populates
  //     this) falling back to inner text.
  //   - id: tiebreaker for total order determinism.
  //
  // We mark each PROCESSED CONTAINER (the parent of the badges) with
  // `data-tc-reordered="1"`. Badges themselves keep the colour marker
  // (`data-tc-coloured`) untouched — separate concerns.
  //
  // Containers we touch are identified bottom-up: scan unmarked badges,
  // group by parent, dedupe, process each parent once. If a parent has
  // only one badge (or zero), skip — nothing to sort.
  //
  // Failure isolation: each container's reorder is wrapped in try/catch.
  // Failure on one container leaves it in natural Stash order; other
  // containers continue to sort normally.
  // ---------------------------------------------------------------------------

  const BADGE_REORDER_MARKER_ATTR = "data-tc-reordered";

  // Core sort key from (tagId, name): looks up the tag's category and
  // sub-category indices in the cached taxonomy and returns
  // [catIdx, subIdx, lowercaseName, id]. Shared by both the read-only
  // badge reorder and the picker-chip reorder (v1.0.1) so taxonomy order
  // is identical across all reordered surfaces. Returns null when no
  // tag ID is provided.
  function computeSortKeyFromTagId(tagId, name) {
    if (!tagId) return null;
    const cfg = pillColourerCachedConfig;
    const a = (cfg.assignments || {})[String(tagId)];
    const cats = (cfg.taxonomy && cfg.taxonomy.categories) || [];

    let catIdx = Infinity;
    let subIdx = Infinity;
    if (a && a.category) {
      const i = cats.findIndex((c) => c && c.name === a.category);
      if (i >= 0) {
        catIdx = i;
        if (a.subcategory) {
          const subs = (cats[i].subcategories || []);
          const j = subs.indexOf(a.subcategory);
          if (j >= 0) subIdx = j;
          // else: sub no longer exists → Infinity (end within its cat)
        } else {
          // No sub assigned → sort to top of its cat before any subbed tags.
          subIdx = -1;
        }
      }
      // else: cat no longer exists → Infinity (treat as unassigned)
    }
    return [catIdx, subIdx, (name || "").toLowerCase(), tagId];
  }

  // Compute the sort key for a read-only badge. Thin wrapper that
  // extracts the tag ID + display name from the badge element and
  // delegates to computeSortKeyFromTagId. Returns null if no tag ID
  // extractable (caller leaves such badges in place).
  function computeBadgeSortKey(badge) {
    const tagId = getTagIdFromBadgeHref(badge);
    if (!tagId) return null;
    // Prefer data-sort-name (Stash sets this to the tag name) over text;
    // fall back to inner anchor's div text. Lowercased for case-insensitive
    // alphabetical within the same sub (handled inside the helper).
    const rawName =
      badge.getAttribute("data-sort-name") ||
      (badge.textContent || "").trim();
    return computeSortKeyFromTagId(tagId, rawName);
  }

  // Compare two sort keys; returns -ve / 0 / +ve.
  function compareBadgeSortKeys(a, b) {
    if (a[0] !== b[0]) return a[0] - b[0];
    if (a[1] !== b[1]) return a[1] - b[1];
    if (a[2] < b[2]) return -1;
    if (a[2] > b[2]) return 1;
    // id tiebreaker — numeric compare for stable ordering.
    const ai = Number(a[3]);
    const bi = Number(b[3]);
    if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi;
    return String(a[3]).localeCompare(String(b[3]));
  }

  // Stable signature of the tag-id set inside a badge container. Used as
  // the BADGE_REORDER_MARKER_ATTR value so it acts as a content-aware
  // dedupe key, not a one-time flag. Order-independent (sorted) so a
  // container already holding the same set we sorted last time signs to
  // the same value regardless of current badge order; signs differently
  // when React reuses the same parent element for a different scene's
  // badges (e.g. clicking "next" on the scene player, which reconciles
  // the metadata panel in-place rather than full page navigation).
  // Pre-1.0.1 the marker was a literal "1", which made the dedupe blind
  // to badge-content changes and left "next"-navigated scenes alphabetical.
  function computeBadgeSetSignature(badges) {
    const ids = [];
    for (const b of badges) {
      const id = getTagIdFromBadgeHref(b);
      if (id) ids.push(String(id));
    }
    return ids.sort().join("|");
  }

  async function tryReorderTagBadges() {
    // Lazy-load config; bail if anything goes wrong.
    if (!pillColourerCachedConfig) {
      await ensurePillColourerConfig();
      if (!pillColourerCachedConfig) return;
    }
    // Gate: only run when the user has opted in.
    if (!pillColourerCachedConfig.reorderTagBadges) return;

    const allBadges = document.querySelectorAll("span.tag-item.tag-link");
    if (allBadges.length === 0) return;

    // Group ALL badges by parent. We no longer bail on marker presence
    // here — instead we compare the parent's stored signature against
    // the current badge set below, so a parent whose children have
    // changed gets re-sorted.
    const byParent = new Map();
    for (const b of allBadges) {
      const p = b.parentElement;
      if (!p) continue;
      let arr = byParent.get(p);
      if (!arr) {
        arr = [];
        byParent.set(p, arr);
      }
      arr.push(b);
    }

    for (const [parent, badges] of byParent) {
      // Compute the current badge set signature. If it matches the
      // marker, this exact set has already been sorted by us (both
      // pre- and post-sort produce the same sorted-set signature) and
      // we can skip. Different signature means the children changed.
      const sig = computeBadgeSetSignature(badges);
      const prevSig = parent.getAttribute(BADGE_REORDER_MARKER_ATTR);
      if (prevSig === sig) continue;

      // Single-badge containers: nothing to sort. Stamp with the
      // current signature so future passes skip cheaply, and re-process
      // if the badge set ever changes.
      if (badges.length < 2) {
        try {
          parent.setAttribute(BADGE_REORDER_MARKER_ATTR, sig);
        } catch (_) { /* read-only attr or detached node — ignore */ }
        continue;
      }
      try {
        // Build keyed list. Badges without a decodable ID get pushed to
        // the very end (alphabetical among themselves via name fallback).
        const keyed = badges.map((b) => {
          const k = computeBadgeSortKey(b);
          if (k) return { b, k };
          const rawName =
            b.getAttribute("data-sort-name") ||
            (b.textContent || "").trim();
          return { b, k: [Infinity, Infinity, rawName.toLowerCase(), ""] };
        });
        keyed.sort((x, y) => compareBadgeSortKeys(x.k, y.k));

        // v0.3.3: preserve the badge BLOCK position within its parent.
        // We can't `appendChild` because some Stash surfaces (e.g. the
        // scene detail page) interleave badges with non-badge siblings
        // — the "Performers" heading + performer cards sit AFTER the
        // tag badges in the same parent container. appendChild would
        // push badges past those siblings to the very end. Instead:
        // capture the next-sibling of the LAST original badge as the
        // insertion anchor, then insertBefore that anchor for each
        // sorted badge. If the last badge has no next sibling (i.e.
        // badges are at the end of the parent — typical for hover
        // popover containers), referenceNode is null and we fall back
        // to appendChild. Both paths leave the badge block in its
        // original position.
        const lastBadge = badges[badges.length - 1];
        const referenceNode = lastBadge.nextSibling;
        for (const { b } of keyed) {
          if (referenceNode) {
            parent.insertBefore(b, referenceNode);
          } else {
            parent.appendChild(b);
          }
        }

        parent.setAttribute(BADGE_REORDER_MARKER_ATTR, sig);
      } catch (err) {
        // Don't mark — give the next pass a chance to retry. Log once.
        console.warn(
          "[tag-categories] reorder failed for a badge container:",
          err
        );
      }
    }
  }

  // Listen for config changes so colours stay in sync when the user edits
  // the taxonomy or reassigns a tag while pickers are visible.
  window.addEventListener(CONFIG_CHANGED_EVENT_NAME, invalidatePillColourerCache);
  // v1.4.3: our own writes (writeAssignment, writeTaxonomy, etc.) need to
  // bust the read cache so the next read returns fresh data, not the
  // pre-write snapshot.
  window.addEventListener(CONFIG_CHANGED_EVENT_NAME, invalidatePluginConfigCache);

  // Detail display rows are gated by an idempotency check that bails when a
  // row already exists for the current tag ID, regardless of what data the
  // row was rendered with. That's fine for normal navigation, but it means
  // a row rendered with stale data (e.g. "uncategorised" right after a tag
  // is created, before our pending-assignment apply lands) sticks around
  // until a hard refresh. Clear them on config change so the next observer
  // tick redraws with current data.
  window.addEventListener(CONFIG_CHANGED_EVENT_NAME, removeDetailRows);

  // ---------------------------------------------------------------------------
  // Observer + bootstrap
  // ---------------------------------------------------------------------------
  let injectionPending = false;
  function scheduleInjection() {
    if (injectionPending) return;
    injectionPending = true;
    requestAnimationFrame(() => {
      injectionPending = false;
      Promise.all([
        injectTagEditFieldsIfNeeded(),
        Promise.resolve().then(attachSaveHookIfNeeded),
        Promise.resolve().then(applyStashFormStylingIfNeeded),
        injectTagDetailDisplayIfNeeded(),
        applyPendingAssignmentIfNeeded(),
        tryInjectTagCardBadges(),
        Promise.resolve().then(injectSettingsButtonHandlerIfNeeded),
        Promise.resolve().then(tryInjectToolbarButton),
        tryColourPickerPills(),
        tryColourTagBadges(),
        // v0.3.3: re-sort badge containers by taxonomy order. Gated on
        // the reorderTagBadges BOOLEAN setting inside the function — runs
        // every frame but no-ops when the setting is off or when no
        // unprocessed containers exist.
        tryReorderTagBadges(),
        // v1.0.1: re-sort staged tag chips inside Stash's native picker
        // by taxonomy order. Gated on the same reorderTagBadges setting
        // so one toggle drives every reordered surface. No-op when the
        // DOM order already matches the expected sorted order.
        tryReorderPickerChips(),
      ]).catch((err) =>
        console.error("[tag-categories] injection error:", err)
      );
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

  // Mount the React modal host inside the navbar.
  if (PluginApi.patch && PluginApi.patch.before) {
    PluginApi.patch.before("MainNavBar.UtilityItems", function (props) {
      return [
        Object.assign({}, props, {
          children: React.createElement(
            React.Fragment,
            null,
            React.createElement(ModalHost, null),
            props.children
          ),
        }),
      ];
    });
  } else {
    console.error(
      "[tag-categories] PluginApi.patch.before is not available; modal will not function"
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver);
  } else {
    startObserver();
  }

  console.log("[tag-categories] 1.4.7 loaded");
})();
