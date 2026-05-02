# Publishing Playbook Graph

## Beta Path

Use this first. It is faster and gives you real user feedback before the community plugin review.

1. Push the repo to `https://github.com/lmachineone/obsidian-playbook-graph`.
2. Create a release whose tag matches `manifest.json` exactly, for example `0.2.0-beta.1`.
3. Attach these files as release assets:
   - `manifest.json`
   - `main.js`
   - `styles.css`
4. Install it with BRAT by adding the GitHub repo URL.

## Community Plugin Path

Once the beta is stable:

1. Confirm the repo has a root `README.md`.
2. Confirm the root `manifest.json` has the same `id`, `name`, `version`, `author`, and `description` you want in the plugin directory.
3. Confirm the latest GitHub release tag exactly matches `manifest.json.version`.
4. Confirm the release includes `manifest.json`, `main.js`, and `styles.css`.
5. Open a pull request to `obsidianmd/obsidian-releases`.
6. Add this entry at the end of `community-plugins.json`:

```json
{
  "id": "playbook-graph",
  "name": "Playbook Graph",
  "author": "lmachineone",
  "description": "Render Markdown notes as a 7D semantic visual graph using position, RGB color, and light channels.",
  "repo": "lmachineone/obsidian-playbook-graph"
}
```

## Version Bumps

1. Update `manifest.json`.
2. Update `versions.json` with the new plugin version and minimum Obsidian app version.
3. Commit the change.
4. Tag the exact version:

```bash
git tag 0.2.0-beta.6
git push origin main --tags
```

5. Create a GitHub release for that exact tag and attach `manifest.json`, `main.js`, and `styles.css`.

## Beta Versioning

`0.1.0` is the initial public prototype. Gemini-backed iterations use the `0.2.0-beta.N` lane:

- `0.2.0-beta.1`: first Gemini API-key beta
- `0.2.0-beta.2`: portable sharded JSON embedding index with per-dimension Gemini caches
- `0.2.0-beta.3`: graph-view settings cog plus dimension-specific cache clearing
- `0.2.0-beta.4`: remove bloom aura and pause auto-spin during mouse interaction
- `0.2.0-beta.5`: invert horizontal drag rotation while keeping vertical drag unchanged
- `0.2.0-beta.6`: wheel zoom plus actual note-link edges and connection-based node sizing
- `0.2.0`: official community-submission candidate

Do not submit prerelease tags to the official Obsidian community plugin directory. Use BRAT or manual installation for beta releases.
