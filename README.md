# Pineapplestorm's Stash Plugins

My plugins for [Stash](https://github.com/stashapp/stash). All AGPL-3.0.

## Install

In Stash, go to **Settings → Plugins → Available Plugins → Add Source** and paste:

```
https://pineapplestorm.github.io/pineapplestorm-stash-plugins/main/index.yml
```

Find any plugin below in the list and click Install. Stash will notify you when a new version ships.

## Plugins

### [Tag Categories](plugins/tag-categories/)

Gives your tag library structure. Group tags into categories and optional sub-categories, give each category a colour, and that structure shows up everywhere a tag appears in Stash, from the tag picker to scene badges to hover popovers. Ships with a default taxonomy you can reshape as you go.

### [Tag Sets](plugins/tag-sets/)

Reusable bundles of tags applied in one click. A small Tag Sets button sits above every tag picker for inline use, and a manager on every list page lets you bulk-apply one or more sets across a batch of scenes. Useful if you constantly retype the same handful of tags.

### [Power Tagger](plugins/power-tagger/)

A structured, rules-driven tagging workflow. Define a configuration per scene type, then layer on rules to cascade tags, hide irrelevant ones, cap selections, and audit existing tags that break the rules. Requires Tag Categories, which gets auto-installed alongside it.

### [Climax Bridge](plugins/climax-bridge/)

The Stash companion to Climax, a desktop activity tracker. Reports scene playback to the Climax app and adds a live tracking indicator to the navbar. Requires the Climax desktop app; it does nothing on its own.

## License

All plugins in this repository are licensed under [AGPL-3.0](LICENCE). Each plugin folder also carries its own copy of the licence for redistribution.
