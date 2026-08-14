# Climax Bridge

Full-featured stats tracking for Stash. [Climax](https://github.com/pineapplestorm/climax) builds on the limited play history Stash keeps, adding sessions, watch time, trends and records, and syncing back as you go. This plugin is the Stash side of it, reporting what you play and adding a live tracking indicator to the navbar.

Requires [Climax](https://github.com/pineapplestorm/climax), running either on the same machine or as a server on your network.

## What it does

### Reports what is playing

While a scene plays, the bridge sends Climax a small heartbeat so it can record which scenes a session covered and how long you stayed with each one.

It only ever sends playback state. Titles, performers, studios and tags are never read here; Climax asks Stash for those itself.

### Tracking indicator in the navbar

A Climax pill in the top bar shows whether a session is running, and its menu starts, pauses and stops sessions or opens Climax without leaving the page you are on.

It has a third state for when you are not watching at all. Switch on organising mode while you tag and tidy, and Stash stops logging plays until you switch it off, so an afternoon of scrubbing through scenes never turns up as watching.

Turn the pill off in the plugin settings if you would rather not have it.

### Keeps O counts in step

Press Stash's O button and the bridge passes it to Climax. Remove one and that follows too, so the two never drift apart.

## Installation

Climax installs this for you during its first-run setup, which is the easiest route. To do it yourself:

### Via plugin source (recommended)

In Stash, go to **Settings → Plugins → Available Plugins → Add Source** and paste:

    https://pineapplestorm.github.io/pineapplestorm-stash-plugins/main/index.yml

Find **Climax Bridge** in the list and click Install, then reload the page. Stash will notify you when a new version ships.

### Manual install

Download this folder, drop `climax-bridge` into your Stash plugins directory, and click **Reload Plugins** in Stash settings. No automatic updates this way.

## Settings

- **Bridge enabled**: master switch. Off means no heartbeats are sent.
- **Show tracking indicator in navbar**: the Climax pill, on by default.
- **Climax URL**: where Climax is listening. Empty uses `http://localhost:9998`, the desktop app on this machine. Point it at an address like `http://192.168.1.20:9998` for a Climax server on your network.
- **Climax server token**: only needed if that server requires one. Leave empty otherwise.
- **Open Climax in the desktop app**: where the pill sends you. Left off, Climax decides, using a browser tab for a server and its own window for the desktop app. Worth turning on if you run a server for your data but keep the desktop app open for reminders and idle detection.

## License

AGPL-3.0. See [LICENSE](LICENSE).
