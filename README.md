# Playbook Graph

Playbook Graph is an Obsidian plugin that renders Markdown notes as an 8D visual graph.

The plugin supports two source-vector modes:

- Local deterministic projection, useful for instant offline previews.
- Gemini API embeddings, useful for semantic note placement during beta testing.

Both modes render the same 8D visual contract:

- `x`, `y`, `z`: 3D position
- `r`, `g`, `b`: note color
- `light`: brightness and perceived confidence
- `bloom`: aura intensity and urgency

The source vector is intentionally separate from the visual vector. Retrieval-quality embeddings should stay high-dimensional, such as Gemini `768D`; the graph should render a derived `8D` projection.

## Current Status

This is a working beta plugin, not an Obsidian core graph patch.

Obsidian's supported plugin path is to create a custom view. Replacing or altering the built-in graph viewer depends on internal, unsupported surfaces, so this repo starts with a separate graph view and keeps the visual contract portable.

The beta track is `0.2.0-beta.N`. The first public prototype was `0.1.0`; Gemini-backed iterations should stay prerelease until `0.2.0` is ready.

## Install Locally

Clone this repo directly into your vault's plugin folder:

```bash
cd "/path/to/Your Vault/.obsidian/plugins"
git clone https://github.com/lmachineone/obsidian-playbook-graph playbook-graph
```

Then in Obsidian:

1. Open `Settings`.
2. Go to `Community plugins`.
3. Turn off `Restricted mode` if needed.
4. Reload plugins or restart Obsidian.
5. Enable `Playbook Graph`.
6. Run the command `Open Playbook Graph`.

For local development before the GitHub repo exists, copy or symlink this folder:

```bash
mkdir -p "/path/to/Your Vault/.obsidian/plugins"
ln -s /Users/hariseldon/dev/obsidian-playbook-graph "/path/to/Your Vault/.obsidian/plugins/playbook-graph"
```

## Settings

- `Scan folder`: limits the graph to one folder, such as `digested` or `agenda`.
- `Excluded folders`: defaults to `private_raw` so raw sources do not appear.
- `Max files`: caps the number of Markdown files scanned per render.
- `Source dimensions`: switches the source-vector size between `768`, `1536`, and `3072`; Gemini mode should usually stay at `768`.
- `Use Gemini API embeddings`: sends scanned Markdown note text to Gemini and renders the resulting projection.
- `Gemini API key`: stored locally in Obsidian's plugin `data.json`; never commit it.
- `Gemini model`: first beta supports Gemini only, defaulting to `gemini-embedding-2`.
- `Auto rotate`: keeps the graph moving when idle.

## Release Files

Obsidian installs community plugins from GitHub release assets. Each release should attach:

- `manifest.json`
- `main.js`
- `styles.css`

Keep the GitHub release tag exactly equal to the version in `manifest.json`, for example `0.2.0-beta.1`, with no `v` prefix.

## Gemini Privacy Boundary

Gemini mode sends the scanned Markdown text to the Gemini API. Keep `private_raw` excluded and scope `Scan folder` tightly when graphing private product playbooks.

The API key is stored by Obsidian in local plugin data. It is not tracked by git, not included in releases, and not printed by this plugin.

## Future Direction

A later version should add a sidecar vector index loader:

```text
.obsidian/plugins/playbook-graph/vector-index.json
```

That file can contain Gemini-generated `768D` vectors and a precomputed `8D` projection per Markdown path. The plugin can then render cached projections without sending note text during normal graph use.
