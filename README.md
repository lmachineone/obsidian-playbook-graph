# Playbook Graph

Playbook Graph is an Obsidian plugin that renders Markdown notes as an 8D visual graph.

The plugin uses a local deterministic projection today:

- `x`, `y`, `z`: 3D position
- `r`, `g`, `b`: note color
- `light`: brightness and perceived confidence
- `bloom`: aura intensity and urgency

The source vector is intentionally separate from the visual vector. Retrieval-quality embeddings should stay high-dimensional, such as Gemini `768D`; the graph should render a derived `8D` projection.

## Current Status

This is a working first plugin, not an Obsidian core graph patch.

Obsidian's supported plugin path is to create a custom view. Replacing or altering the built-in graph viewer depends on internal, unsupported surfaces, so this repo starts with a separate graph view and keeps the visual contract portable.

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
- `Source dimensions`: switches the mocked source-vector size between `128`, `768`, and `1536`.
- `Auto rotate`: keeps the graph moving when idle.

## Release Files

Obsidian installs community plugins from GitHub release assets. Each release should attach:

- `manifest.json`
- `main.js`
- `styles.css`

Keep the GitHub release tag exactly equal to the version in `manifest.json`, for example `0.1.0`, with no `v` prefix.

## Future Direction

The next serious version should add a sidecar vector index loader:

```text
.obsidian/plugins/playbook-graph/vector-index.json
```

That file can contain Gemini-generated `768D` vectors and a precomputed `8D` projection per Markdown path. The plugin should render the projection, not call external embedding APIs from inside Obsidian.
