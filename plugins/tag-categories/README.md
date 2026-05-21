# Tag Categories

A [Stash](https://github.com/stashapp/stash) plugin that gives your tag library structure. Group your tags into categories (and optional sub-categories), and give each category a colour, so a flat alphabetical list turns into a structured library you can actually navigate.

Stash's built-in way to group tags is to make one tag the parent of another. That works fine when the parent is a tag you'd genuinely apply to scenes. When it isn't, you're stuck either inventing a tag just to act as a bucket and then quietly never using it, or skipping the grouping. Tag Categories gives you that grouping layer directly, so your tag list stays full of tags you actually use, and the structure shows up wherever those tags do.

A default taxonomy ships with the plugin, so you can start using it right away and reshape it as you go. If your tag list has grown to the point where it is difficult to make sense of, this is for you.

## What it does

### Categorise your tags

Each tag can belong to one **Category** and one optional **Sub-Category**. Pick them at the moment you create or edit a tag: a new pair of category fields slots into Stash's tag form, so you don't have to break flow to assign one.

For bulk work, open the full tag categories editor from the **Tag Categories** button on the toolbar of any list page, or from **Settings → Plugins → Edit Tag Categories**. Rename, reorder, recolour, hide, or delete categories from one place, and every tag follows.

### Colour-code your tags by category

Each category carries a colour, and that colour follows the tag on every read-only badge across Stash: scenes, performers, galleries, images, card hover popovers. Any unassigned tag keeps Stash's default styling. Once you're set up, a scene's tags tell you what kind of scene it is at a glance, without having to read every label.

### Hide system tags from your tags page

Not every tag in your library is one you actively want to see. Mark a category as **hidden** in the tag categories editor and all its tags disappear from the tags page. Hidden tags still exist and can be applied to scenes; they just stop getting in the way while you're browsing.

### Group badges by category on every card

By default Stash shows tag badges in fixed alphabetical order. Turn on **Reorder tag badges by category** in Settings → Plugins to group them by a category hierarchy of your choosing instead, so every scene card and detail panel is much easier to read at a glance. Heavily tagged scenes become legible again.

### Filter by category from anywhere

Every tag card and tag detail page shows its category as a small badge. Turn on **Make tag categories clickable** in Settings → Plugins, and those badges become clickable filters: click the category pill to jump straight to a list filtered to every tag in that category (or to a single sub-category, when the badge has one).

Stash's filter modal can do this for only one tag at a time. Filtering by "every tag in this category" otherwise means manually rebuilding the same filter list every time you want it. With this setting on, the badge already knows.

Note: This feature is off by default because the plugin has to resolve every tag in the category up front, which can be slow depending on the size of your library.

### Pairs with Power Tagger

[Power Tagger](https://github.com/pineapplestorm/power-tagger) is a filtered tagging workflow built on top of the taxonomy you set up here. It uses your categories to group Stash's tag picker into scene-specific sections, then layers on a custom user-built rules engine to cascade tags, hide irrelevant ones, and cap how many of one kind can apply per scene.

## Installation

### Via plugin source (recommended)

In Stash, go to **Settings → Plugins → Available Plugins → Add Source** and paste:

```
https://pineapplestorm.github.io/pineapplestorm-stash-plugins/main/index.yml
```

Find **Tag Categories** in the list and click Install. Stash will notify you when a new version ships.

### Manual install

Download this repo as a zip, drop the `Tag Categories` folder into your Stash plugins directory, and click **Reload Plugins** in Stash settings. No automatic updates this way.

## License

AGPL-3.0. See [LICENSE](LICENSE) for the full terms.
