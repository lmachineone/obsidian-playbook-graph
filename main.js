const { ItemView, Notice, Plugin, PluginSettingTab, requestUrl, Setting, setIcon, TFile } = require("obsidian");

const VIEW_TYPE = "playbook-graph-view";
const EMBEDDING_RECORD_SCHEMA_VERSION = 1;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SEVEN_DAYS_MS = 7 * DAY_MS;
const AUTO_ROTATE_MOUSE_PAUSE_MS = 5000;
const GEMINI_SOURCE_DIMENSIONS = [768, 1536, 3072];
const VISUAL_DIMENSION_LABELS = ["x", "y", "z", "r", "g", "b", "light"];
const DEFAULT_GRAPH_ZOOM = 1;
const MIN_GRAPH_ZOOM = 0.45;
const MAX_GRAPH_ZOOM = 2.8;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const NODE_MIN_SCREEN_SIZE = 3.5;
const NODE_DEFAULT_MAX_SCREEN_SIZE = 9;

const DEFAULT_SETTINGS = {
  scanFolder: "",
  excludedFolders: "private_raw",
  maxFiles: 300,
  maxCharactersPerFile: 10000,
  sourceDimensions: 768,
  useGemini: false,
  geminiApiKey: "",
  geminiModel: "gemini-embedding-2",
  autoRotate: true,
  projectionRadius: 1,
  nodeMaxSize: NODE_DEFAULT_MAX_SCREEN_SIZE,
  linkThickness: 1,
  linkOpacity: 0.16,
};

const AXES = [
  { id: "x", positive: "revenue sales growth pricing money", negative: "infra backend automation ops" },
  { id: "y", positive: "customer retention churn support account", negative: "internal workflow sop meta" },
  { id: "z", positive: "urgent active deploy production risk", negative: "planned future backlog longterm" },
  { id: "r", positive: "revenue sales pricing growth cash", negative: "security infra automation" },
  { id: "g", positive: "customer retention support trust lifecycle", negative: "cleanup internal ci" },
  { id: "b", positive: "backend infra automation integration security", negative: "sales pricing public" },
  { id: "light", positive: "confidence ready proof done verified", negative: "risk uncertain blocked" },
];

module.exports = class PlaybookGraphPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new PlaybookGraphView(leaf, this));

    this.addRibbonIcon("git-fork", "Open Playbook Graph", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-playbook-graph",
      name: "Open Playbook Graph",
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: "rescan-playbook-graph",
      name: "Rescan Playbook Graph",
      callback: () => this.refreshVisibleViews(),
    });

    this.addCommand({
      id: "open-playbook-graph-settings",
      name: "Open Playbook Graph Settings",
      callback: () => this.openPluginSettings(),
    });

    this.addCommand({
      id: "clear-current-dimension-embedding-cache",
      name: "Clear Current Dimension Embedding Cache",
      callback: async () => {
        const dimension = normalizeSourceDimensions(this.settings.sourceDimensions);
        try {
          const removed = await this.clearEmbeddingIndexForDimension(dimension);
          this.refreshVisibleViews();
          new Notice(`Cleared ${removed} cached records for ${dimension}D.`);
        } catch (error) {
          console.warn("Playbook Graph could not clear embedding dimension", error);
          new Notice("Could not clear that embedding dimension on this adapter.");
        }
      },
    });

    this.addCommand({
      id: "clear-gemini-embedding-cache",
      name: "Clear Gemini Embedding Cache",
      callback: async () => {
        try {
          await this.clearEmbeddingIndex();
          this.refreshVisibleViews();
          new Notice("Playbook Graph embedding index cleared.");
        } catch (error) {
          console.warn("Playbook Graph could not clear embedding index", error);
          new Notice("Could not clear the embedding index on this adapter.");
        }
      },
    });

    this.addSettingTab(new PlaybookGraphSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (file instanceof TFile && file.extension === "md") this.refreshVisibleViewsDebounced();
        })
      );
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (file instanceof TFile && file.extension === "md") this.refreshVisibleViewsDebounced();
        })
      );
      this.registerEvent(
        this.app.vault.on("delete", (file) => {
          if (file instanceof TFile && file.extension === "md") this.refreshVisibleViewsDebounced();
        })
      );
    });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) {
      await this.app.workspace.revealLeaf(leaves[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false) || this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  openPluginSettings() {
    const settings = this.app.setting;
    if (settings && typeof settings.open === "function") {
      settings.open();
      if (typeof settings.openTabById === "function") settings.openTabById(this.manifest.id);
      return;
    }

    new Notice("Open Settings, then select Playbook Graph.");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    delete this.settings.geminiCache;
    this.settings.sourceDimensions = normalizeSourceDimensions(this.settings.sourceDimensions);
    this.settings.geminiModel = normalizeGeminiModel(this.settings.geminiModel);
    this.settings.nodeMaxSize = clampFloat(this.settings.nodeMaxSize, 5, 14, NODE_DEFAULT_MAX_SCREEN_SIZE);
    this.settings.linkThickness = clampFloat(this.settings.linkThickness, 0.2, 4, 1);
    this.settings.linkOpacity = clampFloat(this.settings.linkOpacity, 0.03, 0.8, 0.16);
  }

  async saveSettings(options = {}) {
    delete this.settings.geminiCache;
    await this.saveData(this.settings);
    if (options.refresh !== false) this.refreshVisibleViews();
  }

  getPluginFolderPath() {
    if (this.manifest && this.manifest.dir) return normalizeVaultPath(this.manifest.dir);

    const configDir = this.app && this.app.vault && this.app.vault.configDir ? this.app.vault.configDir : ".obsidian";
    const pluginId = this.manifest && this.manifest.id ? this.manifest.id : "playbook-graph";
    return normalizeVaultPath(`${configDir}/plugins/${pluginId}`);
  }

  getIndexPath(relativePath) {
    return normalizeVaultPath(`${this.getPluginFolderPath()}/${relativePath}`);
  }

  async readIndexJson(relativePath) {
    const adapter = this.app.vault.adapter;
    const path = this.getIndexPath(relativePath);
    if (!(await adapter.exists(path))) return null;

    try {
      return JSON.parse(await adapter.read(path));
    } catch (error) {
      console.warn("Playbook Graph could not read embedding index file", path, error);
      return null;
    }
  }

  async writeIndexJson(relativePath, value) {
    const path = this.getIndexPath(relativePath);
    await this.ensureFolder(path.split("/").slice(0, -1).join("/"));
    await this.app.vault.adapter.write(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  async ensureFolder(folderPath) {
    const adapter = this.app.vault.adapter;
    const parts = normalizeVaultPath(folderPath).split("/").filter(Boolean);
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await adapter.exists(current))) await adapter.mkdir(current);
    }
  }

  async clearEmbeddingIndex() {
    const adapter = this.app.vault.adapter;
    const indexPath = this.getIndexPath("index");
    if (!(await adapter.exists(indexPath))) return;

    if (typeof adapter.rmdir !== "function") {
      throw new Error("This Obsidian adapter does not support clearing folders.");
    }

    await adapter.rmdir(indexPath, true);
  }

  async clearEmbeddingIndexForDimension(dimension) {
    const adapter = this.app.vault.adapter;
    if (typeof adapter.list !== "function" || typeof adapter.remove !== "function") {
      throw new Error("This Obsidian adapter does not support dimension cache cleanup.");
    }

    const roots = [this.getIndexPath("index/files"), this.getIndexPath("index/axes")];
    let removed = 0;

    for (const root of roots) {
      if (!(await adapter.exists(root))) continue;

      const files = await collectAdapterJsonFiles(adapter, root);
      for (const file of files) {
        try {
          const record = JSON.parse(await adapter.read(file));
          if (!shouldClearEmbeddingRecordForDimension(record, dimension)) continue;

          await adapter.remove(file);
          removed += 1;
        } catch (error) {
          console.warn("Playbook Graph skipped cache file during dimension cleanup", file, error);
        }
      }
    }

    return removed;
  }

  refreshVisibleViewsDebounced() {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.refreshVisibleViews(), 800);
  }

  refreshVisibleViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view && typeof leaf.view.scheduleLoad === "function") leaf.view.scheduleLoad();
    }
  }
};

class PlaybookGraphView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.points = [];
    this.links = [];
    this.pointer = { x: -9999, y: -9999 };
    this.hovered = null;
    this.rotation = { x: -0.48, y: 0.72 };
    this.zoom = DEFAULT_GRAPH_ZOOM;
    this.animationFrame = 0;
    this.resizeObserver = null;
    this.loadTimer = 0;
    this.lastMouseInteractionAt = 0;
    this.isDragging = false;
    this.lastDragPoint = null;
    this.suppressNextClick = false;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Playbook Graph";
  }

  getIcon() {
    return "git-fork";
  }

  async onOpen() {
    const root = this.contentEl || this.containerEl.children[1] || this.containerEl;
    root.replaceChildren();
    root.classList.add("playbook-graph-root");

    root.innerHTML = `
      <div class="playbook-graph-stage">
        <canvas class="playbook-graph-canvas" aria-label="Playbook Graph"></canvas>
        <div class="playbook-graph-hud">
          <div class="playbook-graph-kicker">7D note projection</div>
          <div class="playbook-graph-title-row">
            <div class="playbook-graph-title">Playbook Graph</div>
            <button class="playbook-graph-settings" type="button" aria-label="Open Playbook Graph settings" title="Settings"></button>
          </div>
          <div class="playbook-graph-controls">
            <button class="playbook-graph-rescan" type="button">Rescan</button>
            <select class="playbook-graph-dimensions" aria-label="Source dimensions">
              <option value="768">768D source</option>
              <option value="1536">1536D source</option>
              <option value="3072">3072D source</option>
            </select>
          </div>
          <div class="playbook-graph-metrics">
            <div><span>Notes</span><strong data-metric="notes">0</strong></div>
            <div><span>Projection</span><strong>7D</strong></div>
            <div><span>Links</span><strong data-metric="links">0</strong></div>
            <div><span>Status</span><strong data-metric="status">Idle</strong></div>
          </div>
          <div class="playbook-graph-legend">
            <span><i style="--swatch:#ff5a7a"></i>Revenue</span>
            <span><i style="--swatch:#77e0a5"></i>Customer</span>
            <span><i style="--swatch:#7aa7ff"></i>Infra</span>
            <span><i style="--swatch:#f7f4ea"></i>Light</span>
          </div>
        </div>
        <div class="playbook-graph-inspector">
          <div class="playbook-graph-inspector-title">No note selected</div>
          <div class="playbook-graph-inspector-path">Move across the graph to inspect a note.</div>
          <div class="playbook-graph-dims"></div>
        </div>
      </div>
    `;

    this.stageEl = root.querySelector(".playbook-graph-stage");
    this.canvas = root.querySelector(".playbook-graph-canvas");
    this.ctx = this.canvas.getContext("2d");
    this.metrics = {
      notes: root.querySelector('[data-metric="notes"]'),
      links: root.querySelector('[data-metric="links"]'),
      status: root.querySelector('[data-metric="status"]'),
    };
    this.inspectorTitle = root.querySelector(".playbook-graph-inspector-title");
    this.inspectorPath = root.querySelector(".playbook-graph-inspector-path");
    this.dimsEl = root.querySelector(".playbook-graph-dims");
    this.dimensionSelect = root.querySelector(".playbook-graph-dimensions");
    this.dimensionSelect.value = String(this.plugin.settings.sourceDimensions);
    this.settingsButton = root.querySelector(".playbook-graph-settings");
    setIcon(this.settingsButton, "settings");

    this.registerDomEvent(root.querySelector(".playbook-graph-rescan"), "click", () => this.scheduleLoad());
    this.registerDomEvent(this.settingsButton, "click", () => this.plugin.openPluginSettings());
    this.registerDomEvent(this.dimensionSelect, "change", async () => {
      this.plugin.settings.sourceDimensions = Number(this.dimensionSelect.value);
      await this.plugin.saveSettings();
    });
    this.registerDomEvent(this.canvas, "mousemove", (evt) => this.onPointerMove(evt));
    this.registerDomEvent(this.canvas, "mousedown", (evt) => this.onPointerDown(evt));
    this.registerDomEvent(window, "mouseup", () => this.onPointerUp());
    this.registerDomEvent(this.canvas, "mouseleave", () => {
      this.pointer = { x: -9999, y: -9999 };
      this.hovered = null;
      this.onPointerUp();
    });
    this.registerDomEvent(this.canvas, "click", () => {
      this.markMouseInteraction();
      if (this.suppressNextClick) {
        this.suppressNextClick = false;
        return;
      }
      this.openHoveredFile();
    });
    this.registerDomEvent(this.canvas, "wheel", (evt) => {
      evt.preventDefault();
      this.markMouseInteraction();
      this.zoom = calculateWheelZoom(this.zoom, evt.deltaY);
    });

    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
    this.resizeObserver.observe(this.stageEl);
    this.resizeCanvas();
    await this.loadGraph();
    this.renderLoop();
  }

  async onClose() {
    window.clearTimeout(this.loadTimer);
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    if (this.resizeObserver) this.resizeObserver.disconnect();
  }

  scheduleLoad() {
    window.clearTimeout(this.loadTimer);
    this.loadTimer = window.setTimeout(() => void this.loadGraph(), 80);
  }

  setStatus(value) {
    if (this.metrics && this.metrics.status) this.metrics.status.textContent = value;
  }

  async loadGraph() {
    this.setStatus("Scanning");
    const settings = this.plugin.settings;
    const files = this.getCandidateFiles().slice(0, Number(settings.maxFiles) || DEFAULT_SETTINGS.maxFiles);

    const documents = [];
    for (const file of files) {
      try {
        const text = await this.app.vault.cachedRead(file);
        const sourceText = `${file.basename}\n${text.slice(0, settings.maxCharactersPerFile)}`;
        documents.push({
          path: file.path,
          title: file.basename,
          text: sourceText,
          contentHash: hashText(sourceText),
          fileCreatedAt: isoFromMs(file.stat && file.stat.ctime),
          fileModifiedAt: isoFromMs(file.stat && file.stat.mtime),
          size: file.stat && Number.isFinite(file.stat.size) ? file.stat.size : 0,
        });
      } catch (error) {
        console.warn("Playbook Graph could not read file", file.path, error);
      }
    }

    const radius = Number(settings.projectionRadius) || 1;
    const dimension = normalizeSourceDimensions(settings.sourceDimensions);
    if (this.dimensionSelect) this.dimensionSelect.value = String(dimension);

    if (settings.useGemini && String(settings.geminiApiKey || "").trim()) {
      try {
        this.points = await this.projectWithGemini(documents, dimension, radius);
      } catch (error) {
        console.error("Playbook Graph Gemini projection failed", error);
        new Notice("Gemini embeddings failed. Falling back to local projection.");
        this.points = projectDocuments(documents, dimension, radius);
      }
    } else {
      if (settings.useGemini) this.setStatus("Missing key");
      this.points = projectDocuments(documents, dimension, radius);
    }

    this.links = buildDocumentLinks(this.points, this.app.metadataCache && this.app.metadataCache.resolvedLinks);
    this.maxConnectionCount = applyConnectionCounts(this.points, this.links);
    this.hovered = this.points[0] || null;
    this.updateInspector();
    this.metrics.notes.textContent = String(this.points.length);
    this.metrics.links.textContent = String(this.links.length);
    const mode = settings.useGemini && String(settings.geminiApiKey || "").trim() ? "Gemini" : "Local";
    this.setStatus(this.points.length ? mode : "Empty");
  }

  async projectWithGemini(documents, dimension, radius) {
    const settings = this.plugin.settings;
    const model = normalizeGeminiModel(settings.geminiModel);
    const axisVectors = [];

    this.setStatus("Axes");
    for (const axis of AXES) {
      const positive = await this.getGeminiAxisEmbedding(axis.id, "positive", axis.positive, model, dimension);
      const negative = await this.getGeminiAxisEmbedding(axis.id, "negative", axis.negative, model, dimension);
      axisVectors.push(normalize(positive.map((value, index) => value - negative[index])));
    }

    const items = [];
    for (let index = 0; index < documents.length; index += 1) {
      const doc = documents[index];
      this.setStatus(`Gemini ${index + 1}/${documents.length}`);
      const cached = await this.getGeminiFileEmbedding(doc, model, dimension);
      items.push({ doc, index, vector: cached.vector, cacheKey: cached.cacheKey });
    }

    const projected = projectVectorItems(items, axisVectors, radius);
    await this.writeProjectionRecords(projected, items, model, dimension);
    return projected;
  }

  async getGeminiAxisEmbedding(axisId, polarity, text, model, dimension) {
    const cacheKey = axisEmbeddingCacheKey(axisId, polarity, "gemini", model, dimension);
    const existing = await this.plugin.readIndexJson(cacheKey.path);
    const contentHash = hashText(text);

    if (isUsableEmbeddingRecord(existing, "gemini", model, dimension, contentHash)) {
      return normalize(existing.embedding.map(Number));
    }

    const nowIso = new Date().toISOString();
    const vector = await this.requestGeminiEmbedding(text, model, dimension);
    await this.plugin.writeIndexJson(cacheKey.path, {
      schemaVersion: EMBEDDING_RECORD_SCHEMA_VERSION,
      kind: "axis",
      axisId,
      polarity,
      provider: "gemini",
      model,
      dimensions: dimension,
      contentHash,
      embeddedContentHash: contentHash,
      lastRefreshedAt: nowIso,
      updatedAt: nowIso,
      embedding: vector,
    });

    return vector;
  }

  async getGeminiFileEmbedding(doc, model, dimension) {
    const cacheKey = fileEmbeddingCacheKey(doc.path, "gemini", model, dimension);
    const existing = await this.plugin.readIndexJson(cacheKey.path);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const meta = {
      path: doc.path,
      fileCreatedAt: doc.fileCreatedAt || nowIso,
      fileModifiedAt: doc.fileModifiedAt || nowIso,
      contentHash: doc.contentHash || hashText(doc.text),
      provider: "gemini",
      model,
      dimensions: dimension,
      nowMs,
    };
    let decision = shouldRefreshEmbeddingRecord(existing, meta);
    if (!decision.refresh && (!Array.isArray(existing.embedding) || existing.embedding.length !== dimension)) {
      decision = { refresh: true, reason: "embedding_vector_dimension_mismatch" };
    }

    if (!decision.refresh) {
      const record = createEmbeddingRecord(existing, doc, meta, decision, {
        embedding: existing.embedding,
        embeddedContentHash: existing.embeddedContentHash || existing.contentHash,
        lastRefreshedAt: existing.lastRefreshedAt,
      });
      await this.plugin.writeIndexJson(cacheKey.path, record);
      return { cacheKey, vector: normalize(existing.embedding.map(Number)) };
    }

    try {
      const vector = await this.requestGeminiEmbedding(doc.text, model, dimension);
      const record = createEmbeddingRecord(existing, doc, meta, decision, {
        embedding: vector,
        embeddedContentHash: meta.contentHash,
        lastRefreshedAt: nowIso,
        lastRefreshErrorAt: null,
        lastRefreshError: null,
      });
      await this.plugin.writeIndexJson(cacheKey.path, record);
      return { cacheKey, vector };
    } catch (error) {
      if (existing && Array.isArray(existing.embedding) && existing.embedding.length === dimension) {
        const record = createEmbeddingRecord(existing, doc, meta, decision, {
          embedding: existing.embedding,
          embeddedContentHash: existing.embeddedContentHash || existing.contentHash,
          lastRefreshedAt: existing.lastRefreshedAt,
          lastRefreshErrorAt: nowIso,
          lastRefreshError: String(error && error.message ? error.message : error).slice(0, 300),
        });
        await this.plugin.writeIndexJson(cacheKey.path, record);
        return { cacheKey, vector: normalize(existing.embedding.map(Number)) };
      }

      throw error;
    }
  }

  async writeProjectionRecords(projected, items, model, dimension) {
    const byPath = new Map(projected.map((point) => [point.path, point]));

    for (const item of items) {
      if (!item.cacheKey) continue;
      const point = byPath.get(item.doc.path);
      if (!point) continue;

      const existing = await this.plugin.readIndexJson(item.cacheKey.path);
      if (!existing) continue;

      const nowIso = new Date().toISOString();
      await this.plugin.writeIndexJson(item.cacheKey.path, {
        ...existing,
        provider: "gemini",
        model,
        dimensions: dimension,
        projection7d: point.dims,
        visual: {
          position: point.position,
          color: point.color,
          light: point.dims[6],
        },
        updatedAt: nowIso,
      });
    }
  }

  async requestGeminiEmbedding(text, model, dimension) {
    const apiKey = String(this.plugin.settings.geminiApiKey || "").trim();
    const response = await requestUrl({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        model: `models/${model}`,
        content: {
          parts: [{ text: String(text).slice(0, this.plugin.settings.maxCharactersPerFile) }],
        },
        outputDimensionality: dimension,
      }),
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Gemini embedContent failed ${response.status}: ${String(response.text || "").slice(0, 240)}`);
    }

    const payload = response.json || JSON.parse(response.text);
    const values = extractGeminiEmbeddingValues(payload);
    if (!Array.isArray(values) || values.length === 0) throw new Error("Gemini response did not contain embedding values.");
    if (values.length !== dimension) {
      throw new Error(`Gemini returned ${values.length} dimensions, expected ${dimension}.`);
    }

    return normalize(values.map(Number));
  }

  getCandidateFiles() {
    const settings = this.plugin.settings;
    const scanFolder = normalizeFolder(settings.scanFolder);
    const excluded = String(settings.excludedFolders || "")
      .split(",")
      .map((value) => normalizeFolder(value.trim()))
      .filter(Boolean);

    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => {
        const path = file.path;
        if (scanFolder && path !== scanFolder && !path.startsWith(`${scanFolder}/`)) return false;
        return !excluded.some((folder) => path === folder || path.startsWith(`${folder}/`));
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  resizeCanvas() {
    if (!this.canvas || !this.stageEl) return;
    const rect = this.stageEl.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  onPointerMove(evt) {
    this.markMouseInteraction();
    const rect = this.canvas.getBoundingClientRect();
    this.pointer = {
      x: evt.clientX - rect.left,
      y: evt.clientY - rect.top,
    };
    if (this.isDragging && this.lastDragPoint) {
      const dx = this.pointer.x - this.lastDragPoint.x;
      const dy = this.pointer.y - this.lastDragPoint.y;
      if (Math.hypot(dx, dy) > 3) this.suppressNextClick = true;
      const delta = calculateDragRotationDelta(dx, dy);
      this.rotation.y += delta.y;
      this.rotation.x += delta.x;
      this.lastDragPoint = { ...this.pointer };
    }
    const next = this.findNearestPoint();
    if (next !== this.hovered) {
      this.hovered = next;
      this.updateInspector();
    }
  }

  onPointerDown(evt) {
    this.markMouseInteraction();
    const rect = this.canvas.getBoundingClientRect();
    this.isDragging = true;
    this.lastDragPoint = {
      x: evt.clientX - rect.left,
      y: evt.clientY - rect.top,
    };
  }

  onPointerUp() {
    if (!this.isDragging) return;
    this.markMouseInteraction();
    this.isDragging = false;
    this.lastDragPoint = null;
  }

  markMouseInteraction() {
    this.lastMouseInteractionAt = Date.now();
  }

  openHoveredFile() {
    if (!this.hovered) return;
    void this.app.workspace.openLinkText(this.hovered.path, "", false);
  }

  findNearestPoint() {
    let best = null;
    let bestScore = Infinity;
    for (const point of this.points) {
      if (!point.screen) continue;
      const distance = Math.hypot(point.screen.x - this.pointer.x, point.screen.y - this.pointer.y);
      const score = distance - point.screen.size * 0.7;
      if (score < bestScore) {
        bestScore = score;
        best = point;
      }
    }
    return bestScore < 70 ? best : this.hovered;
  }

  updateInspector() {
    if (!this.hovered) {
      this.inspectorTitle.textContent = "No note selected";
      this.inspectorPath.textContent = "Move across the graph to inspect a note.";
      this.dimsEl.replaceChildren();
      return;
    }

    this.inspectorTitle.textContent = this.hovered.title;
    this.inspectorPath.textContent = this.hovered.path;
    this.dimsEl.replaceChildren();
    const labels = getVisualDimensionLabels();
    labels.forEach((label, index) => {
      const el = document.createElement("div");
      el.className = "playbook-graph-dim";
      el.textContent = `${label} ${this.hovered.dims[index].toFixed(2)}`;
      this.dimsEl.appendChild(el);
    });
  }

  renderLoop() {
    this.animationFrame = requestAnimationFrame(() => this.renderLoop());
    if (!this.ctx) return;
    if (shouldAutoRotateNow(this.plugin.settings.autoRotate, this.lastMouseInteractionAt, Date.now())) {
      this.rotation.y += 0.0013;
    }
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    const width = this.width || 1;
    const height = this.height || 1;

    ctx.clearRect(0, 0, width, height);
    const background = ctx.createLinearGradient(0, 0, width, height);
    background.addColorStop(0, "#050706");
    background.addColorStop(0.55, "#09110f");
    background.addColorStop(1, "#030504");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    this.drawGrid(ctx, width, height);

    const nodeMaxSize = clampFloat(this.plugin.settings.nodeMaxSize, 5, 14, NODE_DEFAULT_MAX_SCREEN_SIZE);
    const projected = this.points.map((point) => {
      const screen = projectPoint(point.position, this.rotation, width, height, this.zoom);
      screen.size = calculateNodeScreenSize(point.connectionCount || 0, this.maxConnectionCount || 0, nodeMaxSize);
      point.screen = screen;
      return point;
    });

    ctx.save();
    const linkThickness = clampFloat(this.plugin.settings.linkThickness, 0.2, 4, 1);
    const linkOpacity = clampFloat(this.plugin.settings.linkOpacity, 0.03, 0.8, 0.16);
    for (const link of this.links) {
      const a = projected[link.a];
      const b = projected[link.b];
      if (!a || !b || !a.screen || !b.screen) continue;
      ctx.lineWidth = linkThickness * Math.min(2.4, Math.max(1, Math.sqrt(link.count || 1)));
      ctx.strokeStyle = `rgba(247, 244, 234, ${linkOpacity})`;
      ctx.beginPath();
      ctx.moveTo(a.screen.x, a.screen.y);
      ctx.lineTo(b.screen.x, b.screen.y);
      ctx.stroke();
    }
    ctx.restore();

    projected
      .slice()
      .sort((a, b) => a.screen.depth - b.screen.depth)
      .forEach((point) => this.drawNode(ctx, point));
  }

  drawGrid(ctx, width, height) {
    ctx.save();
    ctx.strokeStyle = "rgba(123, 223, 242, 0.08)";
    ctx.lineWidth = 1;
    const baseY = height * 0.73;
    for (let i = -6; i <= 6; i += 1) {
      ctx.beginPath();
      ctx.moveTo(width * 0.5 + i * 42, baseY - 160);
      ctx.lineTo(width * 0.5 + i * 70, height + 40);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(width * 0.18, baseY + i * 22);
      ctx.lineTo(width * 0.88, baseY + i * 34);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawNode(ctx, point) {
    const screen = point.screen;
    const isHovered = point === this.hovered;
    const radius = screen.size * (isHovered ? 1.2 : 1);
    const color = point.color;

    ctx.save();
    ctx.shadowColor = rgb(color);
    ctx.shadowBlur = isHovered ? 18 : 10;
    const fill = ctx.createRadialGradient(
      screen.x - radius * 0.35,
      screen.y - radius * 0.42,
      1,
      screen.x,
      screen.y,
      radius * 1.25
    );
    fill.addColorStop(0, lighten(color, 0.46 + point.dims[6] * 0.28));
    fill.addColorStop(0.65, rgb(color));
    fill.addColorStop(1, darken(color, 0.28));
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (isHovered) {
      ctx.save();
      ctx.strokeStyle = "rgba(247, 244, 234, 0.88)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, radius + 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
}

class PlaybookGraphSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    let cacheClearDimension = normalizeSourceDimensions(this.plugin.settings.sourceDimensions);
    let cacheClearButton = null;

    containerEl.replaceChildren();
    containerEl.createEl("h2", { text: "Playbook Graph" });

    new Setting(containerEl)
      .setName("Scan folder")
      .setDesc("Optional folder to graph. Leave empty to scan the whole vault.")
      .addText((text) =>
        text
          .setPlaceholder("digested")
          .setValue(this.plugin.settings.scanFolder)
          .onChange(async (value) => {
            this.plugin.settings.scanFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("Comma-separated folder prefixes. Keep private_raw excluded for product playbooks.")
      .addText((text) =>
        text
          .setPlaceholder("private_raw")
          .setValue(this.plugin.settings.excludedFolders)
          .onChange(async (value) => {
            this.plugin.settings.excludedFolders = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max files")
      .setDesc("Caps the first render so large vaults do not freeze.")
      .addText((text) =>
        text
          .setPlaceholder("300")
          .setValue(String(this.plugin.settings.maxFiles))
          .onChange(async (value) => {
            this.plugin.settings.maxFiles = clampNumber(Number(value), 20, 5000, 300);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Source dimensions")
      .setDesc("Source-vector dimensionality before projection to the 7D visual contract. Gemini mode should usually stay at 768D.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("768", "768D")
          .addOption("1536", "1536D")
          .addOption("3072", "3072D")
          .setValue(String(this.plugin.settings.sourceDimensions))
          .onChange(async (value) => {
            this.plugin.settings.sourceDimensions = Number(value);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Node max size")
      .setDesc("Maximum node radius. Actual size follows each note's incoming and outgoing link count.")
      .addSlider((slider) =>
        slider
          .setLimits(5, 14, 0.5)
          .setValue(clampFloat(this.plugin.settings.nodeMaxSize, 5, 14, NODE_DEFAULT_MAX_SCREEN_SIZE))
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.nodeMaxSize = clampFloat(value, 5, 14, NODE_DEFAULT_MAX_SCREEN_SIZE);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Link thickness")
      .setDesc("Base stroke width for note links.")
      .addSlider((slider) =>
        slider
          .setLimits(0.2, 4, 0.1)
          .setValue(clampFloat(this.plugin.settings.linkThickness, 0.2, 4, 1))
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.linkThickness = clampFloat(value, 0.2, 4, 1);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Link transparency")
      .setDesc("Opacity for visible note links.")
      .addSlider((slider) =>
        slider
          .setLimits(0.03, 0.8, 0.01)
          .setValue(clampFloat(this.plugin.settings.linkOpacity, 0.03, 0.8, 0.16))
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.linkOpacity = clampFloat(value, 0.03, 0.8, 0.16);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Use Gemini API embeddings")
      .setDesc("When enabled, scanned Markdown note text is sent to the Gemini API. Leave off for local deterministic projection.")
      .addToggle((toggle) =>
        toggle.setValue(Boolean(this.plugin.settings.useGemini)).onChange(async (value) => {
          this.plugin.settings.useGemini = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Gemini API key")
      .setDesc("Stored in local plugin data.json, masked in settings, and never written to embedding cache records.")
      .addText((text) => {
        const mask = "****************";
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        text.inputEl.addEventListener("focus", () => {
          if (text.inputEl.value === mask) text.setValue("");
        });
        return text
          .setPlaceholder("Paste key")
          .setValue(this.plugin.settings.geminiApiKey ? mask : "")
          .onChange(async (value) => {
            if (/^\*+$/.test(value)) return;
            this.plugin.settings.geminiApiKey = value.trim();
            await this.plugin.saveSettings({ refresh: false });
          });
      })
      .addButton((button) => {
        return button.setButtonText("Forget key").onClick(async () => {
          this.plugin.settings.geminiApiKey = "";
          await this.plugin.saveSettings({ refresh: false });
          this.display();
          new Notice("Gemini API key removed.");
        });
      });

    new Setting(containerEl)
      .setName("Gemini model")
      .setDesc("Gemini API embedding model. First beta supports Gemini only.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("gemini-embedding-2", "gemini-embedding-2")
          .addOption("gemini-embedding-001", "gemini-embedding-001")
          .setValue(normalizeGeminiModel(this.plugin.settings.geminiModel))
          .onChange(async (value) => {
            this.plugin.settings.geminiModel = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Clear embedding cache")
      .setDesc("Removes cached embedding records for one source-vector dimension. The API key is kept.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("768", "768D")
          .addOption("1536", "1536D")
          .addOption("3072", "3072D")
          .setValue(String(cacheClearDimension))
          .onChange((value) => {
            cacheClearDimension = normalizeSourceDimensions(value);
            if (cacheClearButton) cacheClearButton.setButtonText(`Clear ${cacheClearDimension}D`);
          })
      )
      .addButton((button) => {
        cacheClearButton = button;
        return button.setButtonText(`Clear ${cacheClearDimension}D`).onClick(async () => {
          try {
            const removed = await this.plugin.clearEmbeddingIndexForDimension(cacheClearDimension);
            this.plugin.refreshVisibleViews();
            new Notice(`Cleared ${removed} cached records for ${cacheClearDimension}D.`);
          } catch (error) {
            console.warn("Playbook Graph could not clear embedding dimension", error);
            new Notice("Could not clear that embedding dimension on this adapter.");
          }
          return undefined;
        });
      });

    new Setting(containerEl)
      .setName("Auto rotate")
      .setDesc("Keep the graph moving while the view is open.")
      .addToggle((toggle) =>
        toggle.setValue(Boolean(this.plugin.settings.autoRotate)).onChange(async (value) => {
          this.plugin.settings.autoRotate = value;
          await this.plugin.saveSettings();
        })
      );
  }
}

function normalizeFolder(value) {
  return String(value || "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function normalizeVaultPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");
}

function normalizeSourceDimensions(value) {
  const dimension = Number(value);
  return GEMINI_SOURCE_DIMENSIONS.includes(dimension) ? dimension : 768;
}

function normalizeGeminiModel(value) {
  const model = String(value || DEFAULT_SETTINGS.geminiModel)
    .trim()
    .replace(/^models\//, "");
  if (model === "gemini-embedding-001") return model;
  return "gemini-embedding-2";
}

function getVisualDimensionLabels() {
  return [...VISUAL_DIMENSION_LABELS];
}

function shouldAutoRotateNow(autoRotate, lastMouseInteractionAt, nowMs) {
  if (!autoRotate) return false;
  const lastInteraction = Number(lastMouseInteractionAt) || 0;
  if (!lastInteraction) return true;
  return Number(nowMs) - lastInteraction >= AUTO_ROTATE_MOUSE_PAUSE_MS;
}

function calculateDragRotationDelta(dx, dy) {
  return {
    y: dx * 0.006,
    x: dy * 0.006,
  };
}

function calculateWheelZoom(currentZoom, deltaY) {
  const current = clampFloat(currentZoom, MIN_GRAPH_ZOOM, MAX_GRAPH_ZOOM, DEFAULT_GRAPH_ZOOM);
  const next = current * Math.exp(-Number(deltaY || 0) * WHEEL_ZOOM_SENSITIVITY);
  return clampFloat(next, MIN_GRAPH_ZOOM, MAX_GRAPH_ZOOM, DEFAULT_GRAPH_ZOOM);
}

function calculateNodeScreenSize(connectionCount, maxConnectionCount, maxSize) {
  const max = clampFloat(maxSize, 5, 14, NODE_DEFAULT_MAX_SCREEN_SIZE);
  const count = Math.max(0, Number(connectionCount) || 0);
  const maxCount = Math.max(0, Number(maxConnectionCount) || 0);
  if (!maxCount || !count) return NODE_MIN_SCREEN_SIZE;

  const ratio = Math.sqrt(count) / Math.sqrt(maxCount);
  return NODE_MIN_SCREEN_SIZE + (max - NODE_MIN_SCREEN_SIZE) * Math.min(1, ratio);
}

function fileEmbeddingCacheKey(filePath, provider, model, dimensions) {
  const dimension = normalizeSourceDimensions(dimensions);
  const id = hashHex(["file", provider, model, dimension, normalizeVaultPath(filePath)].join("\n"));
  return {
    id,
    path: `index/files/${id.slice(0, 2)}/${id}.json`,
  };
}

function axisEmbeddingCacheKey(axisId, polarity, provider, model, dimensions) {
  const dimension = normalizeSourceDimensions(dimensions);
  const id = hashHex(["axis", provider, model, dimension, axisId, polarity].join("\n"));
  return {
    id,
    path: `index/axes/${id.slice(0, 2)}/${id}.json`,
  };
}

function shouldRefreshEmbeddingRecord(record, meta) {
  if (!record) return { refresh: true, reason: "missing_record" };
  if (!Array.isArray(record.embedding)) return { refresh: true, reason: "missing_embedding" };

  const expectedDimensions = normalizeSourceDimensions(meta.dimensions);
  if (
    record.provider !== meta.provider ||
    record.model !== meta.model ||
    Number(record.dimensions) !== expectedDimensions
  ) {
    return { refresh: true, reason: "embedding_config_changed" };
  }

  const embeddedContentHash = record.embeddedContentHash || record.contentHash;
  if (embeddedContentHash === meta.contentHash) return { refresh: false, reason: "unchanged" };

  const nowMs = Number.isFinite(meta.nowMs) ? meta.nowMs : Date.now();
  const sweepStartedMs =
    dateMs(record.twentyFourHourSweepStartedAt) || dateMs(record.firstSeenAt) || dateMs(meta.fileCreatedAt) || nowMs;
  const lastRefreshMs = dateMs(record.lastRefreshedAt);

  if (nowMs - sweepStartedMs < DAY_MS) {
    if (!lastRefreshMs || nowMs - lastRefreshMs >= HOUR_MS) {
      return { refresh: true, reason: "hot_window_hour_elapsed" };
    }

    return {
      refresh: false,
      reason: "hot_window_wait",
      nextRefreshAfter: new Date(lastRefreshMs + HOUR_MS).toISOString(),
    };
  }

  if (!lastRefreshMs || nowMs - lastRefreshMs >= SEVEN_DAYS_MS) {
    return { refresh: true, reason: "seven_days_elapsed" };
  }

  return {
    refresh: false,
    reason: "seven_day_wait",
    nextRefreshAfter: new Date(lastRefreshMs + SEVEN_DAYS_MS).toISOString(),
  };
}

function shouldClearEmbeddingRecordForDimension(record, dimension) {
  if (!record) return false;
  return Number(record.dimensions) === normalizeSourceDimensions(dimension);
}

function createEmbeddingRecord(existing, doc, meta, decision, overrides) {
  const nowMs = Number.isFinite(meta.nowMs) ? meta.nowMs : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const previousContentHash = existing && existing.contentHash;
  const firstSeenAt = (existing && existing.firstSeenAt) || nowIso;
  const twentyFourHourSweepStartedAt =
    (existing && existing.twentyFourHourSweepStartedAt) || (existing && existing.firstSeenAt) || meta.fileCreatedAt || nowIso;
  const lastChangedAt =
    !existing || previousContentHash !== meta.contentHash ? nowIso : existing.lastChangedAt || nowIso;
  const lastRefreshedAt = overrides.lastRefreshedAt || (existing && existing.lastRefreshedAt) || null;

  return {
    ...(existing || {}),
    ...overrides,
    schemaVersion: EMBEDDING_RECORD_SCHEMA_VERSION,
    kind: "file",
    path: doc.path,
    title: doc.title,
    fileCreatedAt: meta.fileCreatedAt,
    fileModifiedAt: meta.fileModifiedAt,
    size: doc.size || 0,
    firstSeenAt,
    twentyFourHourSweepStartedAt,
    contentHash: meta.contentHash,
    lastChangedAt,
    lastScannedAt: nowIso,
    lastRefreshedAt,
    provider: meta.provider,
    model: meta.model,
    dimensions: normalizeSourceDimensions(meta.dimensions),
    refreshPolicyReason: decision.reason,
    nextRefreshAfter: decision.nextRefreshAfter || null,
    stats: {
      timeSinceTwentyFourHourSweepStartedMs: millisecondsSince(twentyFourHourSweepStartedAt, nowMs),
      timeSinceLastRefreshMs: lastRefreshedAt ? millisecondsSince(lastRefreshedAt, nowMs) : null,
    },
    updatedAt: nowIso,
  };
}

function isUsableEmbeddingRecord(record, provider, model, dimensions, contentHash) {
  const dimension = normalizeSourceDimensions(dimensions);
  if (!record || !Array.isArray(record.embedding) || record.embedding.length !== dimension) return false;
  if (record.provider !== provider || record.model !== model || Number(record.dimensions) !== dimension) return false;
  return (record.embeddedContentHash || record.contentHash) === contentHash;
}

function millisecondsSince(isoValue, nowMs) {
  const startedMs = dateMs(isoValue);
  return startedMs ? Math.max(0, nowMs - startedMs) : null;
}

function dateMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoFromMs(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

async function collectAdapterJsonFiles(adapter, folderPath) {
  const files = [];
  const listing = await adapter.list(folderPath);

  for (const file of listing.files || []) {
    if (String(file).endsWith(".json")) files.push(normalizeVaultPath(file));
  }

  for (const folder of listing.folders || []) {
    files.push(...(await collectAdapterJsonFiles(adapter, folder)));
  }

  return files;
}

function extractGeminiEmbeddingValues(payload) {
  const candidates = [
    payload && payload.embedding && payload.embedding.values,
    payload && payload.embeddings && payload.embeddings[0] && payload.embeddings[0].values,
    payload && payload.embeddings && payload.embeddings[0] && payload.embeddings[0].embedding && payload.embeddings[0].embedding.values,
    payload && payload.embeddings && payload.embeddings.values,
  ];
  return candidates.find((candidate) => Array.isArray(candidate));
}

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampFloat(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function projectDocuments(documents, dimension, radius) {
  if (!documents.length) return [];

  const axes = AXES.map((axis) => makeAxis(axis, dimension));
  const items = documents.map((doc, index) => {
    return { doc, index, vector: textEmbedding(doc.text, dimension) };
  });
  return projectVectorItems(items, axes, radius);
}

function projectVectorItems(items, axes, radius) {
  if (!items.length) return [];

  const raw = items.map((item) => {
    const dims = axes.map((axis) => dot(item.vector, axis));
    dims[6] += scoreKeywords(item.doc.text, "ready proof verified shipped done confidence") * 0.2;
    return { doc: item.doc, index: item.index, dims };
  });

  const mins = Array(VISUAL_DIMENSION_LABELS.length).fill(Infinity);
  const maxes = Array(VISUAL_DIMENSION_LABELS.length).fill(-Infinity);
  for (const row of raw) {
    row.dims.forEach((value, index) => {
      mins[index] = Math.min(mins[index], value);
      maxes[index] = Math.max(maxes[index], value);
    });
  }

  return raw.map((row) => {
    const dims = row.dims.map((value, index) => normalizeRange(value, mins[index], maxes[index]));
    const x = (dims[0] * 2 - 1) * radius;
    const y = (dims[1] * 2 - 1) * radius;
    const z = (dims[2] * 2 - 1) * radius;
    const color = {
      r: Math.round(dims[3] * 255),
      g: Math.round(dims[4] * 255),
      b: Math.round(dims[5] * 255),
    };
    return {
      index: row.index,
      path: row.doc.path,
      title: row.doc.title,
      dims,
      position: { x, y, z },
      color,
    };
  });
}

function buildDocumentLinks(points, resolvedLinks) {
  const byPath = new Map(points.map((point) => [point.path, point]));
  const byPair = new Map();

  for (const [sourcePath, targets] of Object.entries(resolvedLinks || {})) {
    const source = byPath.get(sourcePath);
    if (!source || !targets || typeof targets !== "object") continue;

    for (const [targetPath, count] of Object.entries(targets)) {
      const target = byPath.get(targetPath);
      if (!target || target === source) continue;

      const a = Math.min(source.index, target.index);
      const b = Math.max(source.index, target.index);
      const key = `${a}:${b}`;
      const value = Math.max(1, Number(count) || 1);
      const existing = byPair.get(key);
      if (existing) existing.count += value;
      else byPair.set(key, { a, b, count: value });
    }
  }

  return Array.from(byPair.values()).sort((left, right) => left.a - right.a || left.b - right.b);
}

function applyConnectionCounts(points, links) {
  for (const point of points) point.connectionCount = 0;

  for (const link of links) {
    const count = Math.max(1, Number(link.count) || 1);
    if (points[link.a]) points[link.a].connectionCount += count;
    if (points[link.b]) points[link.b].connectionCount += count;
  }

  return points.reduce((max, point) => Math.max(max, point.connectionCount || 0), 0);
}

function normalizeRange(value, min, max) {
  const span = max - min || 1;
  return Math.max(0, Math.min(1, (value - min) / span));
}

const tokenCache = new Map();

function makeAxis(axis, dimension) {
  const positive = textEmbedding(axis.positive, dimension);
  const negative = textEmbedding(axis.negative, dimension);
  return normalize(positive.map((value, index) => value - negative[index]));
}

function textEmbedding(text, dimension) {
  const tokens = tokenize(text);
  const vector = Array(dimension).fill(0);
  if (!tokens.length) return vector;

  for (const token of tokens) {
    const tokenVectorValue = tokenVector(token, dimension);
    const weight = token.length > 5 ? 1.16 : 1;
    for (let i = 0; i < dimension; i += 1) vector[i] += tokenVectorValue[i] * weight;
  }

  return normalize(vector);
}

function tokenize(text) {
  const matches = String(text).toLowerCase().match(/[a-z0-9_]+/g) || [];
  const stop = new Set(["the", "and", "for", "with", "from", "that", "this", "into", "your", "you", "are"]);
  return matches.filter((token) => token.length > 2 && !stop.has(token)).slice(0, 900);
}

function tokenVector(token, dimension) {
  const key = `${dimension}:${token}`;
  const cached = tokenCache.get(key);
  if (cached) return cached;

  const next = seededRandom(hash32(token));
  const vector = Array(dimension);
  for (let i = 0; i < dimension; i += 1) vector[i] = next();
  const normalized = normalize(vector);
  tokenCache.set(key, normalized);
  return normalized;
}

function scoreKeywords(text, words) {
  const haystack = String(text).toLowerCase();
  const needles = words.split(/\s+/).filter(Boolean);
  const hits = needles.reduce((count, word) => count + (haystack.includes(word) ? 1 : 0), 0);
  return needles.length ? hits / needles.length : 0;
}

function hashText(input) {
  return `fnv1a:${hashHex(String(input || ""))}`;
}

function hashHex(input) {
  const text = String(input || "");
  const reversed = text.split("").reverse().join("");
  return `${hash32(text).toString(16).padStart(8, "0")}${hash32(`${text.length}:${reversed}`).toString(16).padStart(8, "0")}`;
}

function hash32(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) / 4294967295) * 2 - 1;
  };
}

function normalize(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const magnitude = Math.sqrt(sum) || 1;
  return vector.map((value) => value / magnitude);
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function projectPoint(position, rotation, width, height, zoom = DEFAULT_GRAPH_ZOOM) {
  const sinY = Math.sin(rotation.y);
  const cosY = Math.cos(rotation.y);
  const sinX = Math.sin(rotation.x);
  const cosX = Math.cos(rotation.x);

  const x1 = position.x * cosY - position.z * sinY;
  const z1 = position.x * sinY + position.z * cosY;
  const y1 = position.y * cosX - z1 * sinX;
  const z2 = position.y * sinX + z1 * cosX;

  const focal = 4.2;
  const scale = focal / (focal + z2 + 1.8);
  const unit = Math.min(width, height) * 0.32 * clampFloat(zoom, MIN_GRAPH_ZOOM, MAX_GRAPH_ZOOM, DEFAULT_GRAPH_ZOOM);

  return {
    x: width * 0.5 + x1 * unit * scale,
    y: height * 0.54 - y1 * unit * scale,
    depth: z2,
    size: NODE_MIN_SCREEN_SIZE,
  };
}

function rgb(color) {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

function rgba(color, alpha) {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}

function lighten(color, amount) {
  const mix = (value) => Math.round(value + (255 - value) * amount);
  return `rgb(${mix(color.r)}, ${mix(color.g)}, ${mix(color.b)})`;
}

function darken(color, amount) {
  const mix = (value) => Math.round(value * (1 - amount));
  return `rgb(${mix(color.r)}, ${mix(color.g)}, ${mix(color.b)})`;
}

module.exports.__test = {
  applyConnectionCounts,
  buildDocumentLinks,
  calculateNodeScreenSize,
  calculateDragRotationDelta,
  calculateWheelZoom,
  createEmbeddingRecord,
  fileEmbeddingCacheKey,
  getVisualDimensionLabels,
  shouldClearEmbeddingRecordForDimension,
  shouldAutoRotateNow,
  shouldRefreshEmbeddingRecord,
};
