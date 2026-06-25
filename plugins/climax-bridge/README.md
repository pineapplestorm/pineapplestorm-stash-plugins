# Climax Bridge

The Stash side of [Climax](https://github.com/pineapplestorm/climax), a desktop activity tracker. This tiny plugin reports which scene you're playing to the Climax app over a local WebSocket and shows a live tracking indicator in the Stash navbar. If you run Climax, this is how it knows what you're watching.

## Requires

The **Climax desktop app**, running on the same machine. The bridge does nothing on its own; it just relays playback to Climax.

## What it does

### Reports playback

While you watch a scene, the bridge sends Climax lightweight heartbeats (which scene, playing or paused, and the video's current time) so Climax can record sessions and per-scene watch time. It uses the video's actual progress, not the unreliable `paused` flag, so background tabs and player quirks don't inflate your numbers.

### Navbar tracking indicator

A small Climax pill in the top bar shows your state at a glance: grey "not tracking", coral "tracking", or red "organising" (play history paused while you tidy your library). Click it to start a session, stop, or enter organising mode. Toggle it off in the plugin settings if you'd rather not have it.

### Two-way cumshot sync

When you click Stash's O button, the bridge forwards it to Climax so it's recorded there too, and it mirrors O removals back the same way, keeping the two in step.

The bridge sends only realtime playback state. It does not read scene titles, performers, studios, tags, or thumbnails; Climax queries Stash for those itself.

## Installation

### Via plugin source (recommended)

In Stash, go to **Settings → Plugins → Available Plugins → Add Source** and paste:

    https://pineapplestorm.github.io/pineapplestorm-stash-plugins/main/index.yml

Find **Climax Bridge** in the list and click Install, then reload the page. Stash will notify you when a new version ships. (Climax can also install the bridge for you during its first-run setup.)

### Manual install

Download this folder, drop `climax-bridge` into your Stash plugins directory, and click **Reload Plugins** in Stash settings. No automatic updates this way.

## Settings

- **Climax app URL**: WebSocket origin of the Climax app, default `http://localhost:9876`.
- **Bridge enabled**: master switch.
- **Show tracking indicator in navbar**: the navbar pill, default on.

## License

AGPL-3.0. See [LICENSE](LICENSE).
