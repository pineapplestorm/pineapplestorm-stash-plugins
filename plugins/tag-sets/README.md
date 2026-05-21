# Tag Sets

A [Stash](https://github.com/stashapp/stash) plugin for saving named bundles of tags and applying them all in one click. If you find yourself constantly retyping the same handful of tags, this is for you.

## What it does

The plugin has two halves: a manager for naming, editing, ordering, and bulk applying your sets, and an injector that drops them into any tag picker across Stash.

### The manager

Every list page in Stash (Scenes, Tags, Studios, Performers, Galleries, Images, Markers) gets a Tag Sets button in its toolbar. Click it to open the manager, where you can:

- Make a new set: give it a name, pick the tags that belong in it.
- Edit, delete (one at a time or several at once), and drag rows around to reorder. The order sticks everywhere the plugin shows your sets, so put your most-used bundle first.
- On the Scenes page, select some scenes first, then bulk-apply one or more of your sets to them. This uses ADD mode, so it only ever adds tags. Anything already on a scene stays put.

If a tag in a set gets deleted from Stash later, the manager quietly drops it the next time you open the modal. Nothing to clean up by hand.

### The injector

Anywhere Stash shows a tag picker (scene edit, image edit, gallery, performer, marker, and the rest), a small Tag Sets button sits just above the picker. Click it and a popover lists all your sets with a live count of tags in each. Pick one and its tags drop into the picker. Nothing is written to the database until you hit Save on the form itself, so you can pull tags from several sets and edit the result before committing.

## Installation

### Via plugin source (recommended)

In Stash, go to **Settings → Plugins → Available Plugins → Add Source** and paste:

```
https://pineapplestorm.github.io/pineapplestorm-stash-plugins/main/index.yml
```

Find **Tag Sets** in the list and click Install. Stash will notify you when a new version ships.

### Manual install

Download this repo as a zip, drop the `tag-sets` folder into your Stash plugins directory, and click **Reload Plugins** in Stash settings. No automatic updates this way.

## License

AGPL-3.0. See [LICENSE](LICENSE) for the full terms.
