const { ItemView, Notice, Plugin, PluginSettingTab, requestUrl, Setting, TFile } = require("obsidian");

const VIEW_TYPE = "playbook-graph-view";

const DEFAULT_SETTINGS = {
  scanFolder: "",
  excludedFolders: "private_raw",
  maxFiles: 300,
  maxCharactersPerFile: 10000,
  sourceDimensions: 768,
  useGemini: false,
  geminiApiKey: "",
  geminiModel: "gemini-embedding-2",
  geminiCache: {},
  autoRotate: true,
  projectionRadius: 1,
};

const AXES = [
  { id: "x", positive: "revenue sales growth pricing money", negative: "infra backend automation ops" },
  { id: "y", positive: "customer retention churn support account", negative: "internal workflow sop meta" },
  { id: "z", positive: "urgent active deploy production risk", negative: "planned future backlog longterm" },
  { id: "r", positive: "revenue sales pricing growth cash", negative: "security infra automation" },
  { id: "g", positive: "customer retention support trust lifecycle", negative: "cleanup internal ci" },
  { id: "b", positive: "backend infra automation integration security", negative: "sales pricing public" },
  { id: "light", positive: "confidence ready proof done verified", negative: "risk uncertain blocked" },
  { id: "bloom", positive: "urgent active risk production revenue churn", negative: "done meta cleanup" },
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
      id: "clear-gemini-embedding-cache",
      name: "Clear Gemini Embedding Cache",
      callback: async () => {
        this.settings.geminiCache = {};
        await this.saveSettings({ refresh: true });
        new Notice("Playbook Graph Gemini cache cleared.");
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

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.geminiCache || typeof this.settings.geminiCache !== "object") {
      this.settings.geminiCache = {};
    }
  }

  async saveSettings(options = {}) {
    await this.saveData(this.settings);
    if (options.refresh !== false) this.refreshVisibleViews();
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
    this.animationFrame = 0;
    this.resizeObserver = null;
    this.loadTimer = 0;
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
          <div class="playbook-graph-kicker">8D note projection</div>
          <div class="playbook-graph-title">Playbook Graph</div>
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
            <div><span>Projection</span><strong>8D</strong></div>
            <div><span>Radius</span><strong data-metric="radius">1.0</strong></div>
            <div><span>Status</span><strong data-metric="status">Idle</strong></div>
          </div>
          <div class="playbook-graph-legend">
            <span><i style="--swatch:#ff5a7a"></i>Revenue</span>
            <span><i style="--swatch:#77e0a5"></i>Customer</span>
            <span><i style="--swatch:#7aa7ff"></i>Infra</span>
            <span><i style="--swatch:#f7f4ea"></i>Light and bloom</span>
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
      radius: root.querySelector('[data-metric="radius"]'),
      status: root.querySelector('[data-metric="status"]'),
    };
    this.inspectorTitle = root.querySelector(".playbook-graph-inspector-title");
    this.inspectorPath = root.querySelector(".playbook-graph-inspector-path");
    this.dimsEl = root.querySelector(".playbook-graph-dims");
    this.dimensionSelect = root.querySelector(".playbook-graph-dimensions");
    this.dimensionSelect.value = String(this.plugin.settings.sourceDimensions);

    this.registerDomEvent(root.querySelector(".playbook-graph-rescan"), "click", () => this.scheduleLoad());
    this.registerDomEvent(this.dimensionSelect, "change", async () => {
      this.plugin.settings.sourceDimensions = Number(this.dimensionSelect.value);
      await this.plugin.saveSettings();
    });
    this.registerDomEvent(this.canvas, "mousemove", (evt) => this.onPointerMove(evt));
    this.registerDomEvent(this.canvas, "mouseleave", () => {
      this.pointer = { x: -9999, y: -9999 };
      this.hovered = null;
    });
    this.registerDomEvent(this.canvas, "click", () => this.openHoveredFile());
    this.registerDomEvent(this.canvas, "wheel", (evt) => {
      evt.preventDefault();
      this.rotation.y += evt.deltaX * 0.002;
      this.rotation.x += evt.deltaY * 0.002;
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
        documents.push({
          path: file.path,
          title: file.basename,
          text: `${file.basename}\n${text.slice(0, settings.maxCharactersPerFile)}`,
        });
      } catch (error) {
        console.warn("Playbook Graph could not read file", file.path, error);
      }
    }

    const radius = Number(settings.projectionRadius) || 1;
    const dimension = Number(settings.sourceDimensions) || 768;

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

    this.links = buildLinks(this.points);
    this.hovered = this.points[0] || null;
    this.updateInspector();
    this.metrics.notes.textContent = String(this.points.length);
    this.metrics.radius.textContent = radius.toFixed(1);
    const mode = settings.useGemini && String(settings.geminiApiKey || "").trim() ? "Gemini" : "Local";
    this.setStatus(this.points.length ? mode : "Empty");
  }

  async projectWithGemini(documents, dimension, radius) {
    const settings = this.plugin.settings;
    const model = normalizeGeminiModel(settings.geminiModel);
    const axisVectors = [];

    this.setStatus("Axes");
    for (const axis of AXES) {
      const positive = await this.getGeminiEmbedding(axis.positive, `axis:${axis.id}:positive`, model, dimension);
      const negative = await this.getGeminiEmbedding(axis.negative, `axis:${axis.id}:negative`, model, dimension);
      axisVectors.push(normalize(positive.map((value, index) => value - negative[index])));
    }

    const items = [];
    for (let index = 0; index < documents.length; index += 1) {
      const doc = documents[index];
      this.setStatus(`Gemini ${index + 1}/${documents.length}`);
      const vector = await this.getGeminiEmbedding(doc.text, `doc:${doc.path}`, model, dimension);
      items.push({ doc, index, vector });
    }

    await this.plugin.saveSettings({ refresh: false });
    return projectVectorItems(items, axisVectors, radius);
  }

  async getGeminiEmbedding(text, cacheKeyHint, model, dimension) {
    const settings = this.plugin.settings;
    const apiKey = String(settings.geminiApiKey || "").trim();
    const fingerprint = `${model}:${dimension}:${cacheKeyHint}:${hash32(text)}:${String(text).length}`;
    const cached = settings.geminiCache[fingerprint];
    if (Array.isArray(cached) && cached.length === dimension) return cached;

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
        output_dimensionality: dimension,
      }),
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Gemini embedContent failed ${response.status}: ${String(response.text || "").slice(0, 240)}`);
    }

    const payload = response.json || JSON.parse(response.text);
    const values = extractGeminiEmbeddingValues(payload);
    if (!Array.isArray(values) || values.length === 0) throw new Error("Gemini response did not contain embedding values.");

    const normalized = normalize(values.map(Number));
    settings.geminiCache[fingerprint] = normalized;
    return normalized;
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
    const rect = this.canvas.getBoundingClientRect();
    this.pointer = {
      x: evt.clientX - rect.left,
      y: evt.clientY - rect.top,
    };
    const next = this.findNearestPoint();
    if (next !== this.hovered) {
      this.hovered = next;
      this.updateInspector();
    }
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
    const labels = ["x", "y", "z", "r", "g", "b", "light", "bloom"];
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
    if (this.plugin.settings.autoRotate) this.rotation.y += 0.0013;
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

    const projected = this.points.map((point) => {
      const screen = projectPoint(point.position, this.rotation, width, height);
      point.screen = screen;
      return point;
    });

    ctx.save();
    ctx.lineWidth = 1;
    for (const link of this.links) {
      const a = projected[link.a];
      const b = projected[link.b];
      if (!a || !b || !a.screen || !b.screen) continue;
      ctx.strokeStyle = "rgba(247, 244, 234, 0.13)";
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
    ctx.globalCompositeOperation = "lighter";
    const aura = ctx.createRadialGradient(screen.x, screen.y, 0, screen.x, screen.y, radius * (5 + point.dims[7] * 6));
    aura.addColorStop(0, rgba(color, 0.32 + point.dims[7] * 0.28));
    aura.addColorStop(0.38, rgba(color, 0.1));
    aura.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius * (5 + point.dims[7] * 6), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.shadowColor = rgb(color);
    ctx.shadowBlur = 16 + point.dims[7] * 32;
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
          .setDesc("Source-vector dimensionality before projection to the 8D visual contract. Gemini mode should usually stay at 768D.")
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
      .setDesc("Stored locally by Obsidian in this plugin's data.json. Never commit this value.")
      .addText((text) => {
        text.inputEl.type = "password";
        return text
          .setPlaceholder("AIza...")
          .setValue(this.plugin.settings.geminiApiKey ? "****************" : "")
          .onChange(async (value) => {
            if (/^\*+$/.test(value)) return;
            this.plugin.settings.geminiApiKey = value.trim();
            await this.plugin.saveSettings({ refresh: false });
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
      .setName("Clear Gemini cache")
      .setDesc("Removes locally cached embedding vectors. The API key is kept.")
      .addButton((button) =>
        button.setButtonText("Clear cache").onClick(async () => {
          this.plugin.settings.geminiCache = {};
          await this.plugin.saveSettings({ refresh: true });
          new Notice("Playbook Graph Gemini cache cleared.");
        })
      );

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

function normalizeGeminiModel(value) {
  const model = String(value || DEFAULT_SETTINGS.geminiModel)
    .trim()
    .replace(/^models\//, "");
  if (model === "gemini-embedding-001") return model;
  return "gemini-embedding-2";
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
    dims[7] += scoreKeywords(item.doc.text, "urgent active risk production revenue churn blocked") * 0.28;
    return { doc: item.doc, index: item.index, dims };
  });

  const mins = Array(8).fill(Infinity);
  const maxes = Array(8).fill(-Infinity);
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

function buildLinks(points) {
  const links = [];
  const seen = new Set();
  for (const point of points) {
    const neighbors = points
      .filter((candidate) => candidate !== point)
      .map((candidate) => ({
        index: candidate.index,
        distance: distance3(point.position, candidate.position),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 2);

    for (const neighbor of neighbors) {
      const key = [point.index, neighbor.index].sort((a, b) => a - b).join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ a: point.index, b: neighbor.index });
    }
  }
  return links;
}

function distance3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
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

function projectPoint(position, rotation, width, height) {
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
  const unit = Math.min(width, height) * 0.32;

  return {
    x: width * 0.5 + x1 * unit * scale,
    y: height * 0.54 - y1 * unit * scale,
    depth: z2,
    size: Math.max(7, 12 + scale * 15),
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
