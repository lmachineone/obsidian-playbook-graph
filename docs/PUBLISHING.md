# Publishing Playbook Graph

## Beta Path

Use this first. It is faster and gives you real user feedback before the community plugin review.

1. Push the repo to `https://github.com/lmachineone/obsidian-playbook-graph`.
2. Create a release whose tag matches `manifest.json` exactly, for example `0.1.0`.
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
  "description": "Render Markdown notes as an 8D semantic visual graph using position, RGB color, light, and bloom channels.",
  "repo": "lmachineone/obsidian-playbook-graph"
}
```

## Version Bumps

1. Update `manifest.json`.
2. Update `versions.json` only when `minAppVersion` changes.
3. Commit the change.
4. Tag the exact version:

```bash
git tag 0.1.1
git push origin main --tags
```

5. Create a GitHub release for that exact tag and attach `manifest.json`, `main.js`, and `styles.css`.
