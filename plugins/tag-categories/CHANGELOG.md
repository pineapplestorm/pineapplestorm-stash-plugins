# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] - 2026-05-22

### Fixed

- **Badge reorder now updates correctly when navigating between scenes via the player's next/previous buttons.** Previously the reorder only ran on full page navigation; clicking "next" left the new scene's badges in alphabetical order because the parent container's reorder marker persisted across React's child swap. The marker is now a content-aware signature of the badge tag IDs, so any change to the badge set re-triggers sorting.

### Added

- **Reorder tag badges by category now also applies to the staged chips inside Stash's native tag picker** (e.g. on the scene Edit form). Same setting drives both surfaces. Chips group by category as you tag, and adding a new tag inserts it in the correct category position instead of appending to the end. No effect on non-tag pickers (performers, studios, etc.).

## [1.0.0] - 2026-05-22

First public release. See the README for the feature overview.
