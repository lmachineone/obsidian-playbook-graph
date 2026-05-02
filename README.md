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

## Embedding Storage

The API key and normal settings stay in Obsidian's local plugin `data.json`.

Gemini vectors are cached as portable vault-adapter JSON, so the same plugin path works on macOS, Windows, Linux, iPad, iPhone, and Android:

```text
.obsidian/plugins/playbook-graph/index/files/<shard>/<id>.json
.obsidian/plugins/playbook-graph/index/axes/<shard>/<id>.json
```

Each file embedding record stores:

- `path`: Markdown path relative to the vault
- `fileCreatedAt` and `fileModifiedAt`
- `firstSeenAt`, `twentyFourHourSweepStartedAt`, `lastChangedAt`, `lastScannedAt`, and `lastRefreshedAt`
- `stats.timeSinceTwentyFourHourSweepStartedMs` and `stats.timeSinceLastRefreshMs`
- `provider`, `model`, and `dimensions`
- `contentHash`, `embeddedContentHash`, `embedding`, and the latest `projection8d`

The embedding vector length technically reveals the dimensionality, but the cache still stores `dimensions` as metadata and includes it in the cache key. That means the same note can safely keep separate Gemini `768`, `1536`, and `3072` records without overwriting or misreading another dimension.

Refresh policy:

- Missing records refresh immediately.
- Changed files inside their first 24-hour sweep refresh at most once per hour.
- Changed files after that sweep refresh after seven days since the last refresh.
- Unchanged files keep using the cached embedding.

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

A later version can experiment with deeper Obsidian graph integration. This beta keeps the custom view isolated because the built-in graph viewer is not a stable plugin API surface.
