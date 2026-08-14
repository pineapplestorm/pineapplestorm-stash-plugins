(function () {
  "use strict";

  // ===========================================================================
  // Tag Sets plugin (v0.2)
  //
  // Lets the user define named bundles of tags ("tag sets") and apply all the
  // tags in a bundle to selected scenes in one click. Tag sets are pure
  // references: they do not create new tags, only point to existing tags by ID.
  //
  // Implementation notes
  // --------------------
  // - Storage uses GraphQL directly (useConfigurationQuery to read,
  //   useConfigurePluginMutation to write). The PluginApi.hooks.useSettings
  //   helper only works inside Stash's settings page (it requires a
  //   SettingsContext provider that doesn't exist elsewhere), so we can't use
  //   it from a modal opened from the navbar.
  // - The modal is rendered via React Portal to document.body to escape any
  //   parent context constraints (IntlProvider, Settings, etc.).
  // - Modal chrome is plain HTML/CSS (no react-bootstrap Modal) so it doesn't
  //   trip on missing IntlProvider context.
  // - Top-level patch is wrapped in an ErrorBoundary so if anything inside
  //   throws, only our injected button breaks - not the whole Stash UI.
  //
  // Self-healing: every time the modal opens, dangling tag IDs (tags that
  // were deleted in Stash since being added to a tag set) are silently dropped
  // and the cleaned config is saved back. The cleanup happens once per
  // deletion, not on every use.
  //
  // Apply: uses Stash's BulkSceneUpdate mutation in ADD mode. Idempotent;
  // tags already on a scene are silently skipped.
  // ===========================================================================

  const PluginApi = window.PluginApi;
  if (!PluginApi) {
    console.error("[tag-sets] window.PluginApi not found; plugin cannot load");
    return;
  }

  const React = PluginApi.React;
  const ReactDOM = PluginApi.ReactDOM || window.ReactDOM;
  const GQL = PluginApi.GQL || {};
  const Components = PluginApi.components || {};

  const PLUGIN_ID = "tag-sets";

  // ---------------------------------------------------------------------------
  // Selection capture: read selected scene IDs from the DOM
  // ---------------------------------------------------------------------------
  function getSelectedSceneIds() {
    const ids = [];
    const checkedBoxes = document.querySelectorAll(".card-check:checked");
    checkedBoxes.forEach((cb) => {
      const card = cb.closest(".scene-card");
      if (!card) return;
      const link = card.querySelector('a[href^="/scenes/"]');
      if (!link) return;
      const match = link.getAttribute("href").match(/^\/scenes\/(\d+)/);
      if (match) ids.push(match[1]);
    });
    return Array.from(new Set(ids));
  }

  function newTagSetId() {
    return (
      "ts_" +
      Math.random().toString(36).slice(2, 10) +
      Date.now().toString(36).slice(-4)
    );
  }

  function cleanTagSets(tagSets, existingTagIdSet) {
    let changed = false;
    const cleaned = tagSets.map((ts) => {
      const filteredIds = (ts.tagIds || []).filter((id) =>
        existingTagIdSet.has(String(id))
      );
      if (filteredIds.length !== (ts.tagIds || []).length) {
        changed = true;
      }
      return Object.assign({}, ts, { tagIds: filteredIds });
    });
    return { cleaned, changed };
  }

  function unionTagIds(selectedTagSetIds, allTagSets) {
    const ids = new Set();
    allTagSets.forEach((ts) => {
      if (!selectedTagSetIds.includes(ts.id)) return;
      (ts.tagIds || []).forEach((id) => ids.add(String(id)));
    });
    return Array.from(ids);
  }

  // ---------------------------------------------------------------------------
  // Error boundary: contain any crashes inside our component tree
  // ---------------------------------------------------------------------------
  class ErrorBoundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { hasError: false, errorMsg: null };
    }
    static getDerivedStateFromError(err) {
      return {
        hasError: true,
        errorMsg: String(err && err.message ? err.message : err),
      };
    }
    componentDidCatch(err, info) {
      console.error("[tag-sets] component error:", err, info);
    }
    render() {
      if (this.state.hasError) {
        return React.createElement(
          "div",
          {
            style: {
              padding: "8px",
              color: "#f88",
              fontSize: "12px",
              border: "1px solid #f88",
              borderRadius: "4px",
              margin: "4px",
            },
          },
          "Tag Sets plugin error: " + this.state.errorMsg
        );
      }
      return this.props.children;
    }
  }

  // ---------------------------------------------------------------------------
  // GraphQL plugin-config helpers
  // ---------------------------------------------------------------------------
  function usePluginConfig() {
    const useConfigurationQuery = GQL.useConfigurationQuery;
    const useConfigurePluginMutation = GQL.useConfigurePluginMutation;
    if (!useConfigurationQuery || !useConfigurePluginMutation) {
      return {
        loading: false,
        config: { tagSets: [] },
        save: () =>
          Promise.reject(new Error("plugin config GQL not available")),
        refetch: () => {},
      };
    }
    const { data, loading, refetch } = useConfigurationQuery({
      fetchPolicy: "cache-and-network",
    });
    const [configurePlugin] = useConfigurePluginMutation();

    const pluginsBlob = data && data.configuration && data.configuration.plugins;
    const ourSlice = (pluginsBlob && pluginsBlob[PLUGIN_ID]) || { tagSets: [] };
    if (!Array.isArray(ourSlice.tagSets)) ourSlice.tagSets = [];

    function save(nextSlice) {
      return configurePlugin({
        variables: {
          plugin_id: PLUGIN_ID,
          input: nextSlice,
        },
      }).then(() => refetch && refetch());
    }

    return { loading, config: ourSlice, save, refetch };
  }

  // ---------------------------------------------------------------------------
  // Plain HTML modal
  // ---------------------------------------------------------------------------
  function PortalModal({ show, onHide, title, children }) {
    // Lock background scroll while the modal is open. Save and restore the
    // previous body overflow value so we don't fight other code that may
    // have set it. Effect runs on `show` change so we restore on close.
    React.useEffect(() => {
      if (!show) return undefined;
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }, [show]);

    if (!show) return null;

    function onOverlayClick(e) {
      if (e.target === e.currentTarget) onHide();
    }

    const dialog = React.createElement(
      "div",
      {
        style: {
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(0, 0, 0, 0.5)",
          zIndex: 1050,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          padding: "60px 20px 20px 20px",
          overflowY: "auto",
        },
        onClick: onOverlayClick,
      },
      React.createElement(
        "div",
        {
          role: "dialog",
          className: "tag-sets-modal-root",
          style: {
            backgroundColor: "#2d2d2d",
            color: "#eee",
            borderRadius: "6px",
            width: "100%",
            maxWidth: "1100px",
            boxShadow: "0 4px 24px rgba(0,0,0,0.6)",
            maxHeight: "calc(100vh - 80px)",
            display: "flex",
            flexDirection: "column",
          },
        },
        React.createElement(
          "div",
          {
            style: {
              padding: "12px 16px",
              borderBottom: "1px solid #444",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexShrink: 0,
            },
          },
          React.createElement(
            "h5",
            { style: { margin: 0, fontSize: "18px" } },
            title
          ),
          React.createElement(
            "button",
            {
              type: "button",
              onClick: onHide,
              "aria-label": "Close",
              style: {
                background: "transparent",
                border: "none",
                color: "#ccc",
                fontSize: "20px",
                cursor: "pointer",
                padding: "0 4px",
                lineHeight: 1,
              },
            },
            "\u00d7"
          )
        ),
        React.createElement(
          "div",
          {
            style: {
              padding: "16px",
              overflowY: "auto",
              flexGrow: 1,
            },
          },
          children
        )
      )
    );

    if (ReactDOM && ReactDOM.createPortal) {
      return ReactDOM.createPortal(dialog, document.body);
    }
    return dialog;
  }

  function PlainButton({ onClick, disabled, variant, size, children, style }) {
    const baseStyle = {
      padding: size === "sm" ? "4px 10px" : "6px 14px",
      fontSize: size === "sm" ? "13px" : "14px",
      borderRadius: "4px",
      border: "1px solid transparent",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
      backgroundColor:
        variant === "danger"
          ? "#a33"
          : variant === "primary"
          ? "#137cbd"
          : "#555",
      color: "#fff",
      lineHeight: 1.2,
    };
    return React.createElement(
      "button",
      {
        type: "button",
        onClick: disabled ? undefined : onClick,
        disabled: !!disabled,
        style: Object.assign({}, baseStyle, style || {}),
      },
      children
    );
  }

  // ---------------------------------------------------------------------------
  // ConfirmDialog -- themed replacement for window.confirm
  //
  // window.confirm is functional but jarring against Stash's dark theme;
  // it pops a native OS dialog that breaks the visual continuity of the
  // plugin UI. This is a small modal that matches the manager modal's
  // chrome (#2d2d2d / 1px #444 / 6px radius) with a title, message, and
  // Cancel + action button pair. Caller supplies the labels and the
  // confirm callback; the dialog handles Escape / overlay click / Cancel
  // as the dismiss path.
  //
  // Stacking: rendered via portal to <body> at z-index 1400. That sits
  // above the manager modal (z 1050) and below TagSelect's hard-pinned
  // dropdown portal (z 1600), so confirm overlays the manager cleanly
  // and any picker dropdowns underneath still escape correctly. (Not
  // that this dialog itself contains a picker -- just keeping within
  // the documented stacking budget.)
  // ---------------------------------------------------------------------------
  function ConfirmDialog({
    show,
    title,
    message,
    confirmLabel,
    confirmVariant,
    onConfirm,
    onCancel,
  }) {
    // Escape closes. Same-keyed effect re-runs when onCancel identity
    // changes (the parent creates a fresh closure each render, which is
    // fine -- this is one listener add/remove per render of a rarely
    // open dialog, not a hot path).
    React.useEffect(() => {
      if (!show) return undefined;
      function onKey(e) {
        if (e.key === "Escape") onCancel();
      }
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }, [show, onCancel]);

    if (!show) return null;

    function onOverlayClick(e) {
      if (e.target === e.currentTarget) onCancel();
    }

    const dialog = React.createElement(
      "div",
      {
        style: {
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(0, 0, 0, 0.5)",
          zIndex: 1400,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "20px",
        },
        onClick: onOverlayClick,
      },
      React.createElement(
        "div",
        {
          role: "dialog",
          "aria-label": title || "Confirm",
          style: {
            backgroundColor: "#2d2d2d",
            color: "#eee",
            borderRadius: "6px",
            width: "100%",
            maxWidth: "420px",
            boxShadow: "0 4px 24px rgba(0,0,0,0.6)",
            border: "1px solid #444",
          },
        },
        title
          ? React.createElement(
              "div",
              {
                style: {
                  padding: "12px 16px",
                  borderBottom: "1px solid #444",
                  fontSize: "16px",
                  fontWeight: 500,
                },
              },
              title
            )
          : null,
        React.createElement(
          "div",
          {
            style: {
              padding: "16px",
              fontSize: "14px",
              // pre-line so multi-line messages (the listed-names case
              // in batch delete) render with their line breaks intact.
              whiteSpace: "pre-line",
              wordBreak: "break-word",
            },
          },
          message
        ),
        React.createElement(
          "div",
          {
            style: {
              padding: "12px 16px",
              borderTop: "1px solid #444",
              display: "flex",
              justifyContent: "flex-end",
              gap: "8px",
            },
          },
          React.createElement(
            PlainButton,
            { variant: "secondary", onClick: onCancel },
            "Cancel"
          ),
          React.createElement(
            PlainButton,
            { variant: confirmVariant || "danger", onClick: onConfirm },
            confirmLabel || "Confirm"
          )
        )
      )
    );

    if (ReactDOM && ReactDOM.createPortal) {
      return ReactDOM.createPortal(dialog, document.body);
    }
    return dialog;
  }

  // ---------------------------------------------------------------------------
  // Main modal body
  // ---------------------------------------------------------------------------
  function TagSetsModalBody({ onHide }) {
    const { loading, config, save } = usePluginConfig();
    const findTagsHook = GQL.useFindTagsLazyQuery;
    const bulkSceneUpdateHook = GQL.useBulkSceneUpdateMutation;
    const TagSelect = Components.TagSelect;

    // Always call hooks unconditionally to keep order stable.
    // If the hook itself doesn't exist, fall back to a stub.
    const findTagsTuple = findTagsHook ? findTagsHook() : null;
    const bulkSceneUpdateTuple = bulkSceneUpdateHook ? bulkSceneUpdateHook() : null;
    const findTags = findTagsTuple
      ? findTagsTuple[0]
      : () => Promise.resolve({ data: null });
    const bulkSceneUpdate = bulkSceneUpdateTuple
      ? bulkSceneUpdateTuple[0]
      : () => Promise.reject(new Error("bulkSceneUpdate not available"));

    const [tagSets, setTagSets] = React.useState([]);
    const [editingId, setEditingId] = React.useState(null);
    const [editName, setEditName] = React.useState("");
    // editTags holds full tag objects [{id, name, ...}] while editing,
    // because Stash's TagSelect expects `values` as an array of objects,
    // not IDs. We extract the IDs at save time.
    const [editTags, setEditTags] = React.useState([]);
    // knownTags is a Map of id (string) -> full tag object, used both to
    // render tag names in the read-only list view and to seed the editor
    // with full objects when the user clicks Edit on an existing tag set.
    // Populated from the self-heal findTags query.
    const [knownTags, setKnownTags] = React.useState(new Map());
    const [selectedToApply, setSelectedToApply] = React.useState([]);
    const [selectedSceneIds, setSelectedSceneIds] = React.useState([]);
    const [isApplying, setIsApplying] = React.useState(false);
    // statusMsg is for inline VALIDATION messages (e.g. "select a tag set first")
    // shown above the footer. It is NOT used for the after-apply success/error
    // banner -- that uses applyResult below.
    const [statusMsg, setStatusMsg] = React.useState("");
    // applyResult tracks the after-apply state. null = normal mode (Close +
    // Apply buttons in footer). "success" / "error" = result mode (banner
    // shows, footer becomes OK button only).
    const [applyResult, setApplyResult] = React.useState(null); // null | "success" | "error"
    const [applyResultMsg, setApplyResultMsg] = React.useState("");
    const [didSelfHeal, setDidSelfHeal] = React.useState(false);
    // confirmState holds the props for the themed ConfirmDialog when a
    // destructive action wants user confirmation (single/batch delete).
    // null = no dialog shown. Object shape: { title, message,
    // confirmLabel, onConfirm }. Set via the destructive action handler;
    // cleared on Cancel or after onConfirm runs.
    const [confirmState, setConfirmState] = React.useState(null);
    // Drag-and-drop reorder state. dragIndex = which row is currently
    // being dragged (null = none). dropIndex = which row is being
    // hovered as the drop target during drag (null = none). Both reset
    // to null on drag end / drop. Only used for visual feedback and to
    // compute the new order on drop -- not persisted.
    const [dragIndex, setDragIndex] = React.useState(null);
    const [dropIndex, setDropIndex] = React.useState(null);

    // Sync local tag sets when config loads
    const configKey = JSON.stringify(config.tagSets);
    React.useEffect(() => {
      if (loading) return;
      setTagSets(config.tagSets || []);
    }, [loading, configKey]);

    // Capture scene selection on mount
    React.useEffect(() => {
      setSelectedSceneIds(getSelectedSceneIds());
    }, []);

    // Self-heal once when config first arrives.
    //
    // Strategy: fetch ALL tags and build a name lookup. Then scrub stored
    // tag IDs against the set of existing tag IDs.
    //
    // Why fetch all instead of filtering by ID?
    //   The Stash GraphQL schema's tag_filter.id field is an IntCriterion
    //   that takes a single int (value/value2/modifier), NOT an array of
    //   IDs. There's no clean way to pass a set of arbitrary IDs through
    //   the filter. Since most users have at most a few thousand tags,
    //   one unfiltered fetch is fine and avoids the malformed-query 400.
    React.useEffect(() => {
      if (loading || didSelfHeal) return;
      setDidSelfHeal(true);

      const stored = config.tagSets || [];

      if (!findTagsHook) {
        return;
      }

      let cancelled = false;
      (async () => {
        try {
          const result = await findTags({
            variables: {
              filter: { per_page: -1 },
            },
            fetchPolicy: "network-only",
          });
          if (cancelled) return;
          const tagsArr =
            (result && result.data && result.data.findTags && result.data.findTags.tags) || [];

          // Build the id -> tag object map for display and editor seeding
          const newKnown = new Map();
          tagsArr.forEach((t) => newKnown.set(String(t.id), t));
          setKnownTags(newKnown);

          // Scrub stored tag IDs against existing tags
          const foundSet = new Set(tagsArr.map((t) => String(t.id)));
          const { cleaned, changed } = cleanTagSets(stored, foundSet);
          if (changed) {
            setTagSets(cleaned);
            try {
              await save({ tagSets: cleaned });
            } catch (e) {
              console.error("[tag-sets] failed to persist self-heal:", e);
            }
          }
        } catch (err) {
          console.error("[tag-sets] self-heal error:", err);
        }
      })();

      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading]);

    function persistTagSets(newTagSets) {
      setTagSets(newTagSets);
      save({ tagSets: newTagSets }).catch((err) => {
        console.error("[tag-sets] failed to save:", err);
        setStatusMsg("Failed to save: " + (err.message || err));
      });
    }

    function startNew() {
      setEditingId("new");
      setEditName("");
      setEditTags([]);
    }
    function startEdit(ts) {
      setEditingId(ts.id);
      setEditName(ts.name || "");
      // Resolve stored IDs to full tag objects from knownTags. If a tag
      // isn't in knownTags (e.g. self-heal hasn't completed yet), fall
      // back to a stub so the editor still mounts cleanly.
      const objs = (ts.tagIds || []).map((id) => {
        const known = knownTags.get(String(id));
        return known || { id: String(id), name: "(loading...)" };
      });
      setEditTags(objs);
    }
    function cancelEdit() {
      setEditingId(null);
      setEditName("");
      setEditTags([]);
    }
    function saveEdit() {
      const trimmed = (editName || "").trim();
      if (!trimmed) {
        setStatusMsg("Tag set name cannot be empty.");
        return;
      }
      // editTags holds full tag objects; extract just the IDs for storage
      const idsAsStrings = (editTags || []).map((x) => String(x.id));
      // Also fold these tags into knownTags so they're available for
      // immediate display in the list view (no need to wait for re-fetch)
      if (editTags && editTags.length) {
        setKnownTags((prev) => {
          const next = new Map(prev);
          editTags.forEach((t) => {
            if (t && t.id != null) next.set(String(t.id), t);
          });
          return next;
        });
      }
      let next;
      if (editingId === "new") {
        next = tagSets.concat([
          { id: newTagSetId(), name: trimmed, tagIds: idsAsStrings },
        ]);
      } else {
        next = tagSets.map((ts) =>
          ts.id === editingId
            ? Object.assign({}, ts, { name: trimmed, tagIds: idsAsStrings })
            : ts
        );
      }
      persistTagSets(next);
      cancelEdit();
    }
    function deleteTagSet(id) {
      const ts = tagSets.find((x) => x.id === id);
      const name = ts ? ts.name : id;
      setConfirmState({
        title: "Delete tag set",
        message: `Delete tag set "${name}"?`,
        confirmLabel: "Delete",
        onConfirm: () => {
          persistTagSets(tagSets.filter((x) => x.id !== id));
          setSelectedToApply((prev) => prev.filter((x) => x !== id));
          setConfirmState(null);
        },
      });
    }
    // Batch delete using the same checkbox selection that drives Apply.
    // The `selectedToApply` state is now dual-purpose: it tracks which
    // tag sets the user has ticked for either Apply or Delete. The two
    // actions are surfaced as separate buttons in the footer.
    function deleteSelectedTagSets() {
      if (selectedToApply.length === 0) return;
      const names = selectedToApply
        .map((id) => {
          const ts = tagSets.find((x) => x.id === id);
          return ts ? ts.name : null;
        })
        .filter(Boolean);
      const n = selectedToApply.length;
      // Inline the names in the prompt up to 5 so the user can sanity-
      // check what they're about to lose. Above that the list becomes
      // unwieldy and we fall back to just the count.
      const msg =
        n === 1
          ? `Delete tag set "${names[0]}"?`
          : names.length <= 5
          ? `Delete ${n} tag sets?\n\n• ${names.join("\n• ")}`
          : `Delete ${n} tag sets?`;
      setConfirmState({
        title: n === 1 ? "Delete tag set" : "Delete tag sets",
        message: msg,
        confirmLabel: n === 1 ? "Delete" : `Delete ${n}`,
        onConfirm: () => {
          const idsToDelete = new Set(selectedToApply);
          persistTagSets(tagSets.filter((x) => !idsToDelete.has(x.id)));
          setSelectedToApply([]);
          setConfirmState(null);
        },
      });
    }
    function toggleApplySelection(id) {
      setSelectedToApply((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : prev.concat([id])
      );
    }

    // Drag-and-drop reordering of tag sets. The persisted tagSets array
    // order IS the display order across the whole plugin -- the manager
    // list (this modal), the per-row injector popover (when you click
    // "Tag Sets" beside any TagSelect), and the apply-selection list
    // all iterate tagSets in array order. So reordering here flows
    // through automatically; no companion change in the injector.
    //
    // Strategy: HTML5 native DnD. dragstart records the source index,
    // dragover (with preventDefault) marks the hovered drop target,
    // drop reorders the array and persists. Insert-BEFORE semantics:
    // dropping on row X puts the dragged item at X's old position and
    // X shifts down (or up if dragging upward).
    function onRowDragStart(e, index) {
      setDragIndex(index);
      e.dataTransfer.effectAllowed = "move";
      // Firefox refuses to start a drag unless some data is set on the
      // transfer object. Value itself is unused -- we read dragIndex
      // from React state in the drop handler.
      e.dataTransfer.setData("text/plain", String(index));
    }
    function onRowDragOver(e, index) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dropIndex !== index) setDropIndex(index);
    }
    function onRowDragEnd() {
      setDragIndex(null);
      setDropIndex(null);
    }
    function onRowDrop(e, index) {
      e.preventDefault();
      const src = dragIndex;
      setDragIndex(null);
      setDropIndex(null);
      if (src === null || src === index) return;
      const next = tagSets.slice();
      const [moved] = next.splice(src, 1);
      // Removing the source shifts indices for any row after it; adjust
      // the target so the dropped item lands BEFORE the original target.
      const targetIdx = src < index ? index - 1 : index;
      next.splice(targetIdx, 0, moved);
      persistTagSets(next);
    }
    async function applyNow() {
      if (selectedSceneIds.length === 0) {
        setStatusMsg(
          "No scenes selected. Select scenes on the Scenes page first, then re-open this dialog."
        );
        return;
      }
      if (selectedToApply.length === 0) {
        setStatusMsg("Select at least one tag set to apply.");
        return;
      }
      const tagIds = unionTagIds(selectedToApply, tagSets);
      if (tagIds.length === 0) {
        setStatusMsg("The selected tag sets contain no tags.");
        return;
      }

      setIsApplying(true);
      setStatusMsg("");
      try {
        await bulkSceneUpdate({
          variables: {
            input: {
              ids: selectedSceneIds,
              tag_ids: { mode: "ADD", ids: tagIds },
            },
          },
        });
        // Move into post-apply result mode. The footer becomes a single OK
        // button until the user dismisses; clicking OK closes the modal.
        setApplyResult("success");
        setApplyResultMsg(
          `Tag Sets Applied (${tagIds.length} tag${tagIds.length === 1 ? "" : "s"} added to ${selectedSceneIds.length} scene${selectedSceneIds.length === 1 ? "" : "s"}).`
        );
        setStatusMsg("");
      } catch (err) {
        console.error("[tag-sets] apply error:", err);
        setApplyResult("error");
        setApplyResultMsg("Apply failed: " + (err.message || err));
        setStatusMsg("");
      } finally {
        setIsApplying(false);
      }
    }

    // OK button handler when in post-apply result mode.
    // For success: close the whole modal.
    // For error: clear the result and return to normal mode so the user can
    //   adjust and retry.
    function handleResultOk() {
      if (applyResult === "success") {
        setApplyResult(null);
        setApplyResultMsg("");
        onHide();
      } else {
        setApplyResult(null);
        setApplyResultMsg("");
      }
    }

    function renderEditor(targetId) {
      const isNew = targetId === "new";
      // Stash's TagSelect API (verified via React DevTools):
      //   - prop: `values` (array of full tag objects, NOT `ids`)
      //   - prop: `isMulti` (boolean)
      //   - callback: `onSelect(items)` where items is the new array of
      //     selected tag objects
      //
      // We also pass two react-select-style props that flow through to the
      // underlying Select component:
      //   - menuPortalTarget: render the dropdown menu as a portal to
      //     document.body so it can extend beyond the modal's clipping
      //     bounds (the modal has overflow:auto which would otherwise
      //     truncate the dropdown).
      //   - styles.menuPortal.zIndex: the modal's overlay sits at z-index
      //     1050; bump the dropdown above that so it actually appears on
      //     top of the modal.
      const tagPicker = TagSelect
        ? React.createElement(TagSelect, {
            values: editTags,
            isMulti: true,
            onSelect: (items) => {
              setEditTags(items || []);
            },
            menuPortalTarget: document.body,
            styles: {
              menuPortal: (base) => Object.assign({}, base, { zIndex: 1100 }),
            },
          })
        : React.createElement(
            "div",
            { style: { color: "#f88" } },
            "TagSelect component not available; cannot pick tags here."
          );

      return React.createElement(
        "div",
        {
          key: `editor-${targetId}`,
          style: {
            border: "1px solid #555",
            borderRadius: "4px",
            padding: "10px",
            backgroundColor: "#383838",
            // Editor always spans every column of the parent grid so
            // the TagSelect picker has full modal width to work with.
            gridColumn: "1 / -1",
          },
        },
        React.createElement(
          "div",
          { style: { marginBottom: "8px" } },
          React.createElement(
            "label",
            { style: { display: "block", marginBottom: "4px", fontSize: "13px" } },
            "Name"
          ),
          React.createElement("input", {
            type: "text",
            value: editName,
            onChange: (e) => setEditName(e.target.value),
            placeholder: "e.g. Outdoor Scene",
            style: {
              width: "100%",
              padding: "6px",
              backgroundColor: "#222",
              color: "#eee",
              border: "1px solid #555",
              borderRadius: "3px",
            },
          })
        ),
        React.createElement(
          "div",
          { style: { marginBottom: "8px" } },
          React.createElement(
            "label",
            { style: { display: "block", marginBottom: "4px", fontSize: "13px" } },
            "Tags"
          ),
          tagPicker
        ),
        React.createElement(
          "div",
          { style: { display: "flex", justifyContent: "flex-end", gap: "6px" } },
          React.createElement(
            PlainButton,
            { size: "sm", variant: "secondary", onClick: cancelEdit },
            "Cancel"
          ),
          React.createElement(
            PlainButton,
            { size: "sm", variant: "primary", onClick: saveEdit },
            isNew ? "Create" : "Save"
          )
        )
      );
    }

    const sceneCount = selectedSceneIds.length;
    const tagsToApplyCount = unionTagIds(selectedToApply, tagSets).length;

    // -------------------------------------------------------------------
    // Render: merged tag-set list. Each row has:
    //   - a checkbox (apply selection)
    //   - clickable area showing name + tag preview (toggles checkbox)
    //   - Edit and Delete buttons on the right (do NOT toggle checkbox)
    // While in post-apply result mode (applyResult set), the rest of the
    // modal is read-only: edit/delete are hidden, checkbox cannot be toggled.
    // -------------------------------------------------------------------
    const inResultMode = applyResult !== null;

    function renderRow(ts, index) {
      // If we're editing this row, show the inline editor instead
      if (editingId === ts.id) {
        return renderEditor(ts.id);
      }

      const isChecked = selectedToApply.includes(ts.id);
      const tagNames =
        (ts.tagIds || []).length === 0
          ? "(no tags)"
          : (ts.tagIds || [])
              .map((id) => {
                const t = knownTags.get(String(id));
                return t ? t.name : "(loading...)";
              })
              .join(", ");

      // Drag is gated off in result mode (the modal is read-only after
      // an apply succeeds/fails) and while any editor is open (the
      // editor row spans full width via grid-column: 1/-1, which
      // complicates drop semantics -- simplest to disable reorder until
      // the user closes the editor).
      const canDrag = !inResultMode && editingId === null;
      const isDragging = dragIndex === index;
      const isDropTarget =
        canDrag &&
        dropIndex === index &&
        dragIndex !== null &&
        dragIndex !== index;

      return React.createElement(
        "div",
        {
          key: ts.id,
          draggable: canDrag,
          onDragStart: canDrag ? (e) => onRowDragStart(e, index) : undefined,
          onDragOver: canDrag ? (e) => onRowDragOver(e, index) : undefined,
          onDragEnd: canDrag ? onRowDragEnd : undefined,
          onDrop: canDrag ? (e) => onRowDrop(e, index) : undefined,
          style: {
            display: "flex",
            alignItems: "center",
            padding: "8px",
            border: "1px solid #444",
            borderRadius: "4px",
            backgroundColor: isChecked ? "#2a3a4a" : "transparent",
            opacity: isDragging ? 0.4 : 1,
            // grab when reorderable so users get the affordance even
            // without consulting the handle icon; default cursor while
            // editing / in result mode where drag is disabled.
            cursor: canDrag ? "grab" : "default",
            // Use outline (no layout effect) for the drop-target
            // indicator so the row doesn't shift in the grid when it
            // becomes a target. Negative offset overlays it on the
            // existing border instead of pushing siblings.
            outline: isDropTarget ? "2px solid #137cbd" : "none",
            outlineOffset: "-1px",
          },
        },
        // Drag handle glyph -- visual hint that the row can be
        // reordered. The whole row is draggable so this is just an
        // affordance, not a separate hit target. Hidden while drag is
        // disabled so it doesn't suggest a behaviour that won't work.
        canDrag
          ? React.createElement(
              "span",
              {
                style: {
                  color: "#888",
                  marginRight: "6px",
                  fontSize: "14px",
                  lineHeight: 1,
                  userSelect: "none",
                  flexShrink: 0,
                },
                title: "Drag to reorder",
                "aria-hidden": "true",
              },
              "⠿" // BRAILLE PATTERN DOTS-123456 -- six-dot drag handle look
            )
          : null,
        // Checkbox
        React.createElement("input", {
          type: "checkbox",
          id: `row-check-${ts.id}`,
          checked: isChecked,
          disabled: inResultMode,
          onChange: () => toggleApplySelection(ts.id),
          style: { marginRight: "10px", flexShrink: 0, cursor: inResultMode ? "not-allowed" : "pointer" },
        }),
        // Clickable area: name + tags preview
        React.createElement(
          "div",
          {
            style: {
              flex: 1,
              marginRight: "8px",
              minWidth: 0,
              cursor: inResultMode ? "default" : "pointer",
            },
            onClick: () => {
              if (!inResultMode) toggleApplySelection(ts.id);
            },
          },
          React.createElement("strong", null, ts.name),
          React.createElement(
            "div",
            {
              style: {
                color: "#aaa",
                fontSize: "12px",
                wordBreak: "break-word",
              },
            },
            tagNames
          )
        ),
        // Edit / Delete buttons (hidden during result mode)
        inResultMode
          ? null
          : React.createElement(
              "div",
              {
                style: { display: "flex", gap: "4px", flexShrink: 0 },
                // Stop propagation so clicks on these buttons don't toggle
                // the row's apply checkbox.
                onClick: (e) => e.stopPropagation(),
              },
              React.createElement(
                PlainButton,
                { size: "sm", variant: "secondary", onClick: () => startEdit(ts) },
                "Edit"
              ),
              React.createElement(
                PlainButton,
                { size: "sm", variant: "danger", onClick: () => deleteTagSet(ts.id) },
                "Delete"
              )
            )
      );
    }

    const list = React.createElement(
      "div",
      null,
      React.createElement(
        "h5",
        { style: { marginTop: 0, marginBottom: "8px", fontSize: "16px" } },
        "Tag Sets"
      ),
      tagSets.length === 0 && editingId !== "new"
        ? React.createElement(
            "p",
            { style: { color: "#aaa", margin: "4px 0" } },
            "No tag sets yet. Click ",
            React.createElement("em", null, "+ New tag set"),
            " to create one."
          )
        : null,
      React.createElement(
        "div",
        {
          style: {
            marginBottom: "8px",
            display: "grid",
            // ~440px lets two columns fit comfortably at the 1100px
            // modal width; auto-fill lets it grow to 3+ cols on
            // wider screens. The inline editor (renderEditor) spans
            // all columns via `gridColumn: "1 / -1"` so the picker
            // isn't cramped into a single cell.
            gridTemplateColumns: "repeat(auto-fill, minmax(440px, 1fr))",
            gap: "4px 8px",
          },
        },
        tagSets.map((ts, i) => renderRow(ts, i)),
        editingId === "new" ? renderEditor("new") : null
      ),
      editingId === null && !inResultMode
        ? React.createElement(
            PlainButton,
            { size: "sm", variant: "primary", onClick: startNew },
            "+ New tag set"
          )
        : null
    );

    // Inline validation messages (NOT the post-apply success banner)
    const inlineStatus =
      statusMsg && !inResultMode
        ? React.createElement(
            "div",
            {
              style: {
                padding: "8px 10px",
                backgroundColor: "#1d4054",
                color: "#cee",
                border: "1px solid #2a6480",
                borderRadius: "3px",
                margin: "8px 0",
                fontSize: "13px",
              },
            },
            statusMsg
          )
        : null;

    // Post-apply result banner (success = green, error = red).
    // Persists until user clicks OK in the footer.
    const resultBanner = inResultMode
      ? React.createElement(
          "div",
          {
            style: {
              padding: "10px 12px",
              backgroundColor: applyResult === "success" ? "#1d4a2c" : "#5a2222",
              color: applyResult === "success" ? "#bfd" : "#fcc",
              border:
                applyResult === "success"
                  ? "1px solid #2e7a45"
                  : "1px solid #8a3535",
              borderRadius: "3px",
              margin: "8px 0",
              fontSize: "14px",
              fontWeight: 500,
            },
          },
          applyResultMsg
        )
      : null;

    // Footer: switches based on whether we're in result mode
    const footer = React.createElement(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: "8px",
          marginTop: "12px",
          paddingTop: "12px",
          borderTop: "1px solid #444",
        },
      },
      // Left side: contextual info
      React.createElement(
        "div",
        {
          style: { marginRight: "auto", color: "#aaa", fontSize: "12px" },
        },
        inResultMode
          ? ""
          : sceneCount === 0
          ? "No scenes selected (select on Scenes page)"
          : selectedToApply.length > 0
          ? `${tagsToApplyCount} unique tag(s) will be added to ${sceneCount} scene(s)`
          : `${sceneCount} scene(s) selected`
      ),
      // Right side buttons: depends on mode
      inResultMode
        ? React.createElement(
            PlainButton,
            { variant: "primary", onClick: handleResultOk },
            "OK"
          )
        : React.createElement(
            React.Fragment,
            null,
            // Batch delete: only rendered when at least one tag set is
            // ticked. The same checkbox selection feeds both this and
            // Apply -- the user picks tag sets once and chooses which
            // action to run from the footer. Hidden (not just disabled)
            // when empty so the footer stays uncluttered in the common
            // 0-selected case.
            selectedToApply.length > 0
              ? React.createElement(
                  PlainButton,
                  {
                    variant: "danger",
                    onClick: deleteSelectedTagSets,
                    disabled: isApplying,
                  },
                  `Delete Selected (${selectedToApply.length})`
                )
              : null,
            React.createElement(
              PlainButton,
              { variant: "secondary", onClick: onHide, disabled: isApplying },
              "Close"
            ),
            React.createElement(
              PlainButton,
              {
                variant: "primary",
                onClick: applyNow,
                disabled:
                  isApplying ||
                  sceneCount === 0 ||
                  selectedToApply.length === 0 ||
                  tagsToApplyCount === 0,
              },
              isApplying ? "Applying..." : "Apply"
            )
          )
    );

    return React.createElement(
      React.Fragment,
      null,
      list,
      inlineStatus,
      resultBanner,
      footer,
      // Themed confirmation dialog. Sits at z-index 1400, over the
      // manager modal at 1050. Visible only when a destructive action
      // has populated confirmState; Cancel / Escape / overlay-click
      // dismiss without running the confirm callback.
      React.createElement(ConfirmDialog, {
        show: !!confirmState,
        title: confirmState && confirmState.title,
        message: confirmState && confirmState.message,
        confirmLabel: confirmState && confirmState.confirmLabel,
        confirmVariant: confirmState && confirmState.confirmVariant,
        onConfirm: () => {
          if (confirmState && confirmState.onConfirm) confirmState.onConfirm();
        },
        onCancel: () => setConfirmState(null),
      })
    );
  }

  function TagSetsModal({ show, onHide }) {
    return React.createElement(
      PortalModal,
      { show, onHide, title: "Tag Sets" },
      React.createElement(
        ErrorBoundary,
        null,
        show ? React.createElement(TagSetsModalBody, { onHide }) : null
      )
    );
  }

  // ---------------------------------------------------------------------------
  // Toolbar entry: a button injected into the scenes-page toolbar
  //
  // Constraints:
  //   - ListOperationButtons (the toolbar btn-group) is NOT wrapped in
  //     PatchComponent, so we can't inject a React component directly into it.
  //   - But the modal needs to be rendered INSIDE Stash's React tree, because
  //     it depends on Apollo Client's context (for GraphQL hooks) and Intl
  //     context (used by Stash components like TagSelect). A separate
  //     ReactDOM root mounted at document.body would escape both contexts
  //     and break the modal.
  //
  // Solution:
  //   1. We patch SceneList (which IS wrapped, per PluginApi.components) and
  //      have our patch render a small invisible "ToolbarModalHost" component
  //      as a sibling of SceneList. This host lives inside the same provider
  //      tree as Stash, so Apollo and Intl work correctly.
  //   2. The host listens on `window` for a custom event "tag-sets:open".
  //   3. The visible toolbar button is DOM-injected (because we can't patch
  //      ListOperationButtons), but on click it just dispatches the event;
  //      the actual React component opening lives inside Stash's tree.
  // ---------------------------------------------------------------------------

  const TOOLBAR_BUTTON_MARKER_CLASS = "tag-sets-toolbar-button";
  const OPEN_EVENT_NAME = "tag-sets:open";

  // The ToolbarModalHost lives inside Stash's React tree (rendered via the
  // navbar patch below). It listens for our custom open event and toggles
  // modal visibility. Because it's inside the tree, useConfigurationQuery /
  // TagSelect / etc. all have the contexts they need.
  //
  // Important: the navbar patch may run on every render of the navbar, and
  // each run may add another host instance (because patch.before sees the
  // previous-render's output as `props.children`). To avoid having multiple
  // hosts each open their own modal copy, we use a module-level counter to
  // ensure only the FIRST mounted host is "active" -- other instances render
  // nothing and skip the event listener registration.
  let activeHostCount = 0;
  function ToolbarModalHost() {
    const [showModal, setShowModal] = React.useState(false);
    const [isActive, setIsActive] = React.useState(false);

    React.useEffect(() => {
      // Only the first host to mount becomes active. Subsequent hosts
      // (created by repeated patch applications) render null and ignore
      // events.
      if (activeHostCount > 0) {
        // We are a duplicate; do nothing.
        return undefined;
      }
      activeHostCount += 1;
      setIsActive(true);

      function handler() {
        setShowModal(true);
      }
      window.addEventListener(OPEN_EVENT_NAME, handler);
      return () => {
        window.removeEventListener(OPEN_EVENT_NAME, handler);
        activeHostCount -= 1;
      };
    }, []);

    if (!isActive) return null;

    return React.createElement(TagSetsModal, {
      show: showModal,
      onHide: () => setShowModal(false),
    });
  }

  function SafeToolbarModalHost() {
    return React.createElement(
      ErrorBoundary,
      null,
      React.createElement(ToolbarModalHost, null)
    );
  }

  // Build the toolbar button DOM. On click it dispatches a window event that
  // ToolbarModalHost listens for; that's how DOM and React communicate.
  // v1.0.7: render the toolbar button via React + Stash's own
  // react-bootstrap OverlayTrigger + Tooltip so the hover tooltip
  // matches the native Grid/List/Wall/Tagger styling exactly (dark
  // bubble + arrow above the button, same delay/dismiss behaviour).
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
        className: "svg-inline--fa fa-layer-group fa-icon",
        "aria-hidden": "true",
        focusable: "false",
        "data-prefix": "fas",
        "data-icon": "layer-group",
        role: "img",
        xmlns: "http://www.w3.org/2000/svg",
        viewBox: "0 0 512 512",
      },
      React.createElement("path", {
        fill: "currentColor",
        d:
          "M12.41 148.02l232.94 105.67c3.54 1.6 7.36 2.41 11.18 2.41 3.83 0 " +
          "7.65-.81 11.18-2.41l232.94-105.67c16.97-7.7 16.97-31.65 0-39.35L267.72 " +
          "2.41C264.18.81 260.36 0 256.54 0c-3.83 0-7.65.81-11.18 2.41L12.41 " +
          "108.66c-16.97 7.7-16.97 31.66 0 39.36zm487.18 88.28l-58.09-26.33-161.64 " +
          "73.27c-7.56 3.43-15.59 5.17-23.86 5.17-8.28 0-16.31-1.74-23.87-5.17L70.51 " +
          "209.97l-58.1 26.33c-16.55 7.5-16.55 32.5 0 40l232.94 105.59c3.55 1.61 " +
          "7.38 2.42 11.22 2.42 3.84 0 7.66-.81 11.21-2.41L499.59 276.3c16.55-7.5 " +
          "16.55-32.5 0-40zm0 127.8l-57.87-26.23-161.86 73.37c-7.56 3.43-15.59 " +
          "5.17-23.86 5.17-8.28 0-16.31-1.74-23.87-5.17L70.29 337.87 12.41 " +
          "364.1c-16.55 7.5-16.55 32.5 0 40l232.94 105.59c3.55 1.61 7.38 2.42 11.22 " +
          "2.42 3.84 0 7.66-.81 11.21-2.41L499.59 404.1c16.55-7.5 16.55-32.5 0-40z",
      })
    );

    const tooltip = React.createElement(
      Tooltip,
      { id: "tag-sets-toolbar-tooltip" },
      "Tag Sets"
    );

    const btn = React.createElement(
      "button",
      {
        type: "button",
        className: "btn btn-secondary",
        "aria-label": "Tag Sets",
        onClick: () => window.dispatchEvent(new CustomEvent(OPEN_EVENT_NAME)),
      },
      iconSvg
    );

    const trigger = React.createElement(
      Bootstrap.OverlayTrigger,
      { placement: "top", overlay: tooltip },
      btn
    );

    ReactDOM.render(trigger, host);
  }

  // Fallback: plain DOM button without the react-bootstrap tooltip.
  // Used only if the OverlayTrigger render fails. Keeps the feature
  // alive at the cost of a worse tooltip.
  function buildToolbarButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-secondary " + TOOLBAR_BUTTON_MARKER_CLASS;
    btn.title = "Tag Sets";
    btn.setAttribute("aria-label", "Tag Sets");

    // FontAwesome 'fa-layer-group' icon (stacked layers; "grouped tags").
    btn.innerHTML =
      '<svg class="svg-inline--fa fa-layer-group fa-icon" ' +
      'aria-hidden="true" focusable="false" data-prefix="fas" ' +
      'data-icon="layer-group" role="img" xmlns="http://www.w3.org/2000/svg" ' +
      'viewBox="0 0 512 512">' +
      '<path fill="currentColor" d="M12.41 148.02l232.94 105.67c3.54 1.6 7.36 ' +
      '2.41 11.18 2.41 3.83 0 7.65-.81 11.18-2.41l232.94-105.67c16.97-7.7 ' +
      '16.97-31.65 0-39.35L267.72 2.41C264.18.81 260.36 0 256.54 0c-3.83 0-' +
      '7.65.81-11.18 2.41L12.41 108.66c-16.97 7.7-16.97 31.66 0 39.36zm487.18 ' +
      '88.28l-58.09-26.33-161.64 73.27c-7.56 3.43-15.59 5.17-23.86 5.17-8.28 ' +
      '0-16.31-1.74-23.87-5.17L70.51 209.97l-58.1 26.33c-16.55 7.5-16.55 32.5 ' +
      '0 40l232.94 105.59c3.55 1.61 7.38 2.42 11.22 2.42 3.84 0 7.66-.81 ' +
      '11.21-2.41L499.59 276.3c16.55-7.5 16.55-32.5 0-40zm0 127.8l-57.87-26.23-' +
      '161.86 73.37c-7.56 3.43-15.59 5.17-23.86 5.17-8.28 0-16.31-1.74-23.87-' +
      '5.17L70.29 337.87 12.41 364.1c-16.55 7.5-16.55 32.5 0 40l232.94 ' +
      '105.59c3.55 1.61 7.38 2.42 11.22 2.42 3.84 0 7.66-.81 11.21-2.41L499.59 ' +
      '404.1c16.55-7.5 16.55-32.5 0-40z"></path></svg>';

    btn.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent(OPEN_EVENT_NAME));
    });

    return btn;
  }

  // Find the list-page view-mode toolbar group (grid / list / wall etc.)
  // and inject our button as the last child. Returns true if injected or
  // already present.
  //
  // v1.2.1: anchored on `svg.fa-table-cells-large` (the grid-view icon)
  // instead of `svg.fa-tags` (the tagger icon).
  //
  // Why: the tagger button only exists on pages that have the Tagger
  // feature -- Scenes, Tags, Studios, Performers. On Galleries, Images,
  // and Markers the tagger isn't rendered, so anchoring on `fa-tags`
  // silently skipped those pages. The grid-view icon is part of the
  // universal view-mode group present on every list page that has a
  // toolbar (Groups is naturally excluded because its toolbar has no
  // view-mode toggle -- just filter / sort / save).
  //
  // Same approach Tag Categories uses (anchored there since v0.3.5 for
  // the identical reason).
  function tryInjectToolbarButton() {
    const gridIcons = document.querySelectorAll("svg.fa-table-cells-large");
    for (const icon of gridIcons) {
      const button = icon.closest("button");
      if (!button) continue;
      const group = button.closest('div[role="group"].btn-group');
      if (!group) continue;
      if (group.querySelector("." + TOOLBAR_BUTTON_MARKER_CLASS)) {
        return true;
      }
      // The view-mode group always has at least grid + list. Guard
      // against a stray grid icon sitting alone in some unrelated group.
      const buttonCount = group.querySelectorAll("button").length;
      if (buttonCount < 2) continue;
      // v1.0.7: prefer React-Bootstrap tooltip; fall back to plain
      // DOM button if the render fails.
      const host = document.createElement("span");
      host.className = TOOLBAR_BUTTON_MARKER_CLASS;
      host.style.display = "contents";
      group.appendChild(host);
      try {
        renderToolbarButton(host);
      } catch (err) {
        console.error("[tag-sets] toolbar button render error:", err);
        host.remove();
        group.appendChild(buildToolbarButton());
      }
      return true;
    }
    return false;
  }

  // Throttled re-injection: MutationObserver fires often, we only want to
  // try injection once per animation frame at most.
  let injectionPending = false;
  function scheduleInjection() {
    if (injectionPending) return;
    injectionPending = true;
    requestAnimationFrame(() => {
      injectionPending = false;
      tryInjectToolbarButton();
    });
  }

  function startObserver() {
    if (!document.body) {
      setTimeout(startObserver, 50);
      return;
    }
    tryInjectToolbarButton();
    const observer = new MutationObserver(() => {
      scheduleInjection();
    });
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

  // ---------------------------------------------------------------------------
  // Mount the modal host INSIDE Stash's React tree by patching the navbar.
  //
  // We piggyback on MainNavBar.UtilityItems with patch.before (the only patch
  // shape we've confirmed works with this Stash version). The modal host is
  // rendered inside the navbar's children, but it itself renders nothing
  // visible until the toolbar button dispatches the open event.
  //
  // Why not patch SceneList? patch.after / patch.instead semantics aren't
  // documented and our attempt to use them caused React error #31 (rendering
  // an unrenderable object). MainNavBar.UtilityItems patch.before is the
  // pattern verified to work in our previous v0.2 tests.
  //
  // The host being in the navbar is fine even though the trigger is in the
  // scenes toolbar -- they communicate via a window event, not via parent /
  // child component relationships.
  // ---------------------------------------------------------------------------
  if (PluginApi.patch && PluginApi.patch.before) {
    PluginApi.patch.before("MainNavBar.UtilityItems", function (props) {
      return [
        Object.assign({}, props, {
          children: React.createElement(
            React.Fragment,
            null,
            React.createElement(SafeToolbarModalHost, null),
            props.children
          ),
        }),
      ];
    });
  } else {
    console.error(
      "[tag-sets] PluginApi.patch.before is not available; modal will not function"
    );
  }

  // ===========================================================================
  // v1.0 — Per-row Tag Sets injector button (next to Copy/Paste)
  //
  // What this does
  //   On every TagSelect render across Stash (Tagger view, scene/image/gallery
  //   /performer/etc. edit forms), inject a small "Tag Sets" button group next
  //   to the picker. Clicking it opens a popover listing the user's tag sets;
  //   clicking a tag set merges its tags into the picker's staged values via
  //   props.onSelect. Idempotent (deduped by ID). One-shot (closes popover
  //   on click). Silent (no toast). No DB write — purely a staging assist.
  //
  // Coexistence with tagCopyPaste
  //   That plugin also patches TagSelect with patch.after and returns
  //   [<div.tagCopyPaste>, originalComponent]. We do the same shape with
  //   <div.tag-sets-injector>. Both groups use absolute positioning to land
  //   inside the same parent (the wrapper around the TagSelect input), so
  //   their visual order is controlled by CSS, not patch ordering.
  //
  // Suppression inside our own manager modal
  //   Showing the injector inside our Tag Sets editor's tag picker would be
  //   confusing (you'd be injecting tag sets into a tag set). We suppress it
  //   when an ancestor with class "tag-sets-modal-root" exists. The check is
  //   done at render via a ref on a sentinel element; if it lands inside the
  //   manager modal, we render null instead.
  // ===========================================================================

  const INJECTOR_MARKER_CLASS = "tag-sets-injector";
  const INJECTOR_SUPPRESS_ANCESTOR_CLASS = "tag-sets-modal-root";

  function mergeTagsByid(existing, incoming) {
    const seen = new Set();
    const merged = [];
    function push(t) {
      if (!t || t.id == null) return;
      const key = String(t.id);
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(t);
    }
    (existing || []).forEach(push);
    (incoming || []).forEach(push);
    return merged;
  }

  function TagSetInjector(props) {
    // Hooks must always run in the same order — never gate them behind
    // `if (suppressed)`. We compute suppression in an effect.
    const sentinelRef = React.useRef(null);
    const buttonRef = React.useRef(null);
    const popoverRef = React.useRef(null);
    const [suppressed, setSuppressed] = React.useState(false);
    const [open, setOpen] = React.useState(false);
    const [popoverPos, setPopoverPos] = React.useState({ top: 0, bottom: null, right: 0, left: null });
    // liveTagIds: Set<string> of tag IDs that currently exist in Stash. null
    // means "never queried yet". Populated when the popover first opens.
    // Used to (a) show honest counts in the popover (excluding deleted tags)
    // and (b) avoid a second findTags call inside applyTagSet.
    // liveTagMap: Map<string, fullTagObj> alongside the Set, for resolving
    // stored IDs to objects in applyTagSet without re-querying.
    const [liveTagIds, setLiveTagIds] = React.useState(null);
    const liveTagMapRef = React.useRef(null);

    const useConfigurationQuery = GQL.useConfigurationQuery;
    const useFindTagsLazyQuery = GQL.useFindTagsLazyQuery;

    // Always call these hooks (stable order). If GQL hooks are missing, fall
    // back to safe stubs.
    //
    // fetchPolicy: cache-first means the *first* popover open per page
    // session issues a network query, and subsequent opens are instant cache
    // hits. We don't use cache-and-network here because it would fire a
    // background refetch on every popover open, which is exactly the
    // per-click cost we want to avoid. Stale counts within a single page
    // session are accepted; the manager modal handles persistent cleanup.
    const configQuery = useConfigurationQuery
      ? useConfigurationQuery({ fetchPolicy: "cache-and-network" })
      : { data: null };
    const findTagsTuple = useFindTagsLazyQuery
      ? useFindTagsLazyQuery({ fetchPolicy: "cache-first" })
      : null;
    const findTags = findTagsTuple
      ? findTagsTuple[0]
      : () => Promise.resolve({ data: null });

    const tagSets =
      (configQuery.data &&
        configQuery.data.configuration &&
        configQuery.data.configuration.plugins &&
        configQuery.data.configuration.plugins[PLUGIN_ID] &&
        Array.isArray(
          configQuery.data.configuration.plugins[PLUGIN_ID].tagSets
        )
        ? configQuery.data.configuration.plugins[PLUGIN_ID].tagSets
        : []) || [];

    // Suppression check: after mount, look up the ancestor chain. If the
    // sentinel lives inside our own manager modal, suppress entirely.
    React.useEffect(() => {
      const el = sentinelRef.current;
      if (!el) return;
      if (el.closest("." + INJECTOR_SUPPRESS_ANCESTOR_CLASS)) {
        setSuppressed(true);
      }
    }, []);

    // When the popover opens for the first time, fire findTags to populate
    // the live id set. Subsequent opens reuse the cached result and don't
    // re-query (cache-first). Counts shown in the popover use this to
    // exclude tags that have been deleted in Stash since the tag set was
    // last edited.
    React.useEffect(() => {
      if (!open) return;
      if (liveTagIds !== null) return; // already populated this session
      if (!useFindTagsLazyQuery) return;
      let cancelled = false;
      (async () => {
        try {
          const result = await findTags({
            variables: { filter: { per_page: -1 } },
          });
          if (cancelled) return;
          const tagsArr =
            (result && result.data && result.data.findTags &&
              result.data.findTags.tags) || [];
          const idSet = new Set();
          const idMap = new Map();
          tagsArr.forEach((t) => {
            const sid = String(t.id);
            idSet.add(sid);
            idMap.set(sid, t);
          });
          liveTagMapRef.current = idMap;
          setLiveTagIds(idSet);
        } catch (err) {
          console.error("[tag-sets] live tag query failed:", err);
        }
      })();
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // Click-outside-to-close
    React.useEffect(() => {
      if (!open) return undefined;
      function onDocMouseDown(e) {
        if (
          buttonRef.current &&
          !buttonRef.current.contains(e.target) &&
          popoverRef.current &&
          !popoverRef.current.contains(e.target)
        ) {
          setOpen(false);
        }
      }
      function onKey(e) {
        if (e.key === "Escape") setOpen(false);
      }
      document.addEventListener("mousedown", onDocMouseDown);
      document.addEventListener("keydown", onKey);
      return () => {
        document.removeEventListener("mousedown", onDocMouseDown);
        document.removeEventListener("keydown", onKey);
      };
    }, [open]);

    // Count of tags in a tag set that still exist in Stash. Falls back to
    // the stored count (tagIds.length) if we haven't queried yet — that way
    // the first render of the popover (before the query resolves) shows
    // *something* rather than blank, then updates seamlessly when the query
    // returns.
    function liveCount(ts) {
      const stored = (ts.tagIds || []).map(String);
      if (liveTagIds === null) return stored.length;
      let n = 0;
      for (const id of stored) if (liveTagIds.has(id)) n++;
      return n;
    }

    // Names of tags in a tag set that still exist in Stash, in stored order
    // (matches the order the user added them in the manager modal). Returns
    // null if the live tag map hasn't been populated yet — callers should
    // fall back to a count-based string in that case. Deleted tags are
    // silently skipped, consistent with liveCount().
    function liveTagNames(ts) {
      const map = liveTagMapRef.current;
      if (!map) return null;
      const stored = (ts.tagIds || []).map(String);
      const names = [];
      for (const id of stored) {
        const t = map.get(id);
        if (t && t.name) names.push(t.name);
      }
      return names;
    }

    function openPopover() {
      const btn = buttonRef.current;
      if (!btn) {
        setOpen(true);
        return;
      }
      const rect = btn.getBoundingClientRect();
      // Anchor the popover above OR below the button depending on
      // available room. Position is in viewport coordinates because the
      // popover is rendered into document.body via a portal
      // (position: fixed). The popover has max-height: 400px (see CSS).
      //
      // Decision: if the space below the button is less than ~300px
      // (a bit under the CSS max so the popover doesn't sit jammed
      // against the viewport edge), open upward. Otherwise downward.
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const openUp = spaceBelow < 300 && spaceAbove > spaceBelow;
      setPopoverPos({
        // We anchor using EITHER top or bottom, never both. The unused
        // one is null and the popover style picks accordingly.
        top: openUp ? null : rect.bottom + 4,
        bottom: openUp ? window.innerHeight - rect.top + 4 : null,
        // We render right-aligned by default: the popover's right edge sits
        // at the button's right edge. CSS uses `right: <viewportRight>` so
        // we pass distance-from-viewport-right. The horizontal-overflow
        // useLayoutEffect below may flip this to a `left` anchor if the
        // popover (especially in grid mode at up to 840px wide) would grow
        // past the viewport's left edge.
        right: Math.max(0, window.innerWidth - rect.right),
        left: null,
      });
      setOpen(true);
    }

    // After the popover renders, check for left-edge viewport overflow and
    // flip the anchor if needed. Happens in grid mode when there are many
    // tag sets and the button sits in the left half of the viewport: the
    // popover grows leftward from the button and can land off-screen.
    //
    // useLayoutEffect runs synchronously after DOM mutation but before
    // paint, so the position shift is invisible to the user (no flicker).
    //
    // CSS caps popover width at min(840px, 100vw - 32px), so anchoring
    // left:8px can't then overflow the right edge either.
    React.useLayoutEffect(() => {
      if (!open) return;
      const pop = popoverRef.current;
      if (!pop) return;
      const rect = pop.getBoundingClientRect();
      const margin = 8;
      if (rect.left < margin) {
        setPopoverPos((prev) => ({
          ...prev,
          right: null,
          left: margin,
        }));
      }
    }, [open]);

    async function applyTagSet(ts) {
      try {
        // Resolve stored IDs to full tag objects. We need full objects (with
        // at least {id, name}) because TagSelect's `values` prop expects
        // full objects, not IDs.
        let tagObjs = [];
        const storedIds = (ts.tagIds || []).map(String);
        if (storedIds.length > 0) {
          // Prefer the in-memory map populated when the popover first
          // opened. Fall back to a fresh findTags call only if it isn't
          // populated yet (e.g. the user clicked a tag set before the
          // initial query resolved — unlikely but possible).
          let idMap = liveTagMapRef.current;
          if (!idMap && useFindTagsLazyQuery) {
            const result = await findTags({
              variables: { filter: { per_page: -1 } },
            });
            const tagsArr =
              (result && result.data && result.data.findTags &&
                result.data.findTags.tags) || [];
            idMap = new Map();
            tagsArr.forEach((t) => idMap.set(String(t.id), t));
            liveTagMapRef.current = idMap;
          }
          if (idMap) {
            tagObjs = storedIds
              .map((id) => idMap.get(id))
              .filter(Boolean);
          }
        }
        if (typeof props.onSelect === "function") {
          const next = mergeTagsByid(props.values, tagObjs);
          props.onSelect(next);
        }
      } catch (err) {
        console.error("[tag-sets] inject failed:", err);
      } finally {
        setOpen(false);
      }
    }

    if (suppressed) {
      // Still render an empty span (with the sentinel ref already attached
      // via a previous render) so we don't break React reconciliation.
      return React.createElement("span", {
        ref: sentinelRef,
        style: { display: "none" },
        "data-tag-sets-injector": "suppressed",
      });
    }

    const button = React.createElement(
      "button",
      {
        type: "button",
        ref: buttonRef,
        onClick: (e) => {
          e.preventDefault();
          if (open) setOpen(false);
          else openPopover();
        },
        className:
          "tag-sets-injector-button btn btn-secondary btn-sm",
        title: "Apply a tag set",
      },
      "Tag Sets"
    );

    let popover = null;
    if (open && ReactDOM && ReactDOM.createPortal) {
      const popoverStyle = {
        position: "fixed",
        // Use top OR bottom depending on which one openPopover populated
        // (see flip logic there). Same pattern for left OR right: default
        // is right-anchored, useLayoutEffect flips to left:8 if the
        // popover would overflow the viewport's left edge. The unused
        // anchor on each axis is null and the style picks accordingly.
        ...(popoverPos.top != null ? { top: popoverPos.top + "px" } : {}),
        ...(popoverPos.bottom != null ? { bottom: popoverPos.bottom + "px" } : {}),
        ...(popoverPos.right != null ? { right: popoverPos.right + "px" } : {}),
        ...(popoverPos.left != null ? { left: popoverPos.left + "px" } : {}),
        zIndex: 1100,
      };
      let body;
      if (!tagSets.length) {
        body = React.createElement(
          "div",
          { className: "tag-sets-injector-empty" },
          "No tag sets yet. Create some via the Tag Sets button in the navbar."
        );
      } else {
        body = React.createElement(
          "ul",
          { className: "tag-sets-injector-list" },
          tagSets.map((ts) =>
            React.createElement(
              "li",
              { key: ts.id },
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "tag-sets-injector-item",
                  onClick: (e) => {
                    e.preventDefault();
                    applyTagSet(ts);
                  },
                  title: (() => {
                    const names = liveTagNames(ts);
                    if (names && names.length) return names.join(", ");
                    return liveCount(ts) + " tag(s)";
                  })(),
                },
                React.createElement(
                  "span",
                  { className: "tag-sets-injector-item-name" },
                  ts.name || "(unnamed)"
                ),
                React.createElement(
                  "span",
                  { className: "tag-sets-injector-item-count" },
                  String(liveCount(ts))
                )
              )
            )
          )
        );
      }
      // Switch the popover to a multi-column grid when there are enough
      // tag sets that a single column would be awkwardly long. CSS does
      // the actual layout — we just toggle the class. Threshold + max
      // column count are tunables (see CSS: --max-columns).
      const useGrid = tagSets.length > 8;
      const popoverEl = React.createElement(
        "div",
        {
          ref: popoverRef,
          className:
            "tag-sets-injector-popover" +
            (useGrid ? " tag-sets-injector-popover-grid" : ""),
          style: popoverStyle,
        },
        React.createElement(
          "div",
          { className: "tag-sets-injector-popover-header" },
          "Apply tag set"
        ),
        body
      );
      popover = ReactDOM.createPortal(popoverEl, document.body);
    }

    return React.createElement(
      "div",
      { className: INJECTOR_MARKER_CLASS, ref: sentinelRef },
      React.createElement(
        "div",
        { className: "btn-group" },
        button
      ),
      popover
    );
  }

  function SafeTagSetInjector(props) {
    return React.createElement(
      ErrorBoundary,
      null,
      React.createElement(TagSetInjector, props)
    );
  }

  // Patch TagSelect. Same hook + return shape as the tagCopyPaste plugin so
  // they coexist cleanly.
  //
  // Why deferred via setTimeout: registering this patch synchronously at
  // script-load time results in the patch never firing for any TagSelect
  // instance. tagCopyPaste happens to work because its registration is
  // gated behind an awaited config call, which defers it past the same
  // threshold. We don't need an awaited call so we use a plain setTimeout.
  //
  // Why no Components.TagSelect guard: TagSelect is registered into
  // PluginApi.components asynchronously and isn't necessarily present at
  // setTimeout(0) time. patch.after accepts a name string and queues the
  // patch for whenever the component first renders, so the guard was over-
  // defensive. The tagCopyPaste plugin doesn't guard either.
  function registerTagSelectPatch() {
    if (!PluginApi.patch || !PluginApi.patch.after) {
      console.warn(
        "[tag-sets] PluginApi.patch.after not available; per-row injector disabled"
      );
      return;
    }
    PluginApi.patch.after("TagSelect", function (props, _, originalComponent) {
      // IMPORTANT: return a single React element wrapped in an array, NOT a
      // raw array of two children. Other plugins (notably tagCopyPaste) also
      // patch TagSelect and pass `originalComponent` as a single child to
      // React.createElement. If we return [<Injector/>, <Original/>], the
      // next patch in the chain receives `originalComponent` as an *array*,
      // which createElement collapses unpredictably (often dropping the
      // TagSelect itself). Wrapping in a Fragment guarantees `originalComponent`
      // is always a single element from the next patch's perspective.
      return [
        React.createElement(
          React.Fragment,
          null,
          React.createElement(SafeTagSetInjector, Object.assign({ key: "tsi" }, props)),
          React.createElement(React.Fragment, { key: "orig" }, originalComponent)
        ),
      ];
    });
  }
  setTimeout(registerTagSelectPatch, 0);
})();
