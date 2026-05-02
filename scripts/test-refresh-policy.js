const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(repoRoot, "main.js"), "utf8");

class FakeBase {}
class FakeSetting {}

const sandbox = {
  console,
  module: { exports: {} },
  exports: {},
  require(id) {
    if (id === "obsidian") {
      return {
        ItemView: FakeBase,
        Modal: FakeBase,
        Notice: FakeBase,
        Plugin: FakeBase,
        PluginSettingTab: FakeBase,
        requestUrl: async () => {
          throw new Error("requestUrl should not be called by refresh-policy tests");
        },
        Setting: FakeSetting,
        setIcon() {},
        TFile: FakeBase,
      };
    }
    return require(id);
  },
  window: {
    clearTimeout() {},
    setTimeout() {},
  },
};

vm.runInNewContext(source, sandbox, { filename: "main.js" });

const policy = sandbox.module.exports.__test;
assert.ok(policy, "main.js must expose pure policy helpers under __test");
assert.ok(policy.applyConnectionCounts, "main.js must expose connection count helper under __test");
assert.ok(policy.buildDocumentLinks, "main.js must expose document link helper under __test");
assert.ok(policy.calculateNodeScreenSize, "main.js must expose node screen size helper under __test");
assert.ok(policy.calculateDragRotationDelta, "main.js must expose drag rotation helper under __test");
assert.ok(policy.calculateWheelZoom, "main.js must expose wheel zoom helper under __test");
assert.ok(policy.createEmbeddingRecord, "main.js must expose createEmbeddingRecord under __test");
assert.ok(policy.getVisualDimensionLabels, "main.js must expose visual dimension labels under __test");
assert.ok(policy.shouldClearEmbeddingRecordForDimension, "main.js must expose dimension clear helper under __test");
assert.ok(policy.shouldAutoRotateNow, "main.js must expose auto-rotation policy under __test");

const base = Date.parse("2026-05-02T00:00:00.000Z");
const oneHour = 60 * 60 * 1000;
const oneDay = 24 * oneHour;
const sevenDays = 7 * oneDay;

function meta(overrides = {}) {
  return {
    path: "digested/example.md",
    fileCreatedAt: new Date(base).toISOString(),
    contentHash: "hash:new",
    provider: "gemini",
    model: "gemini-embedding-2",
    dimensions: 768,
    nowMs: base,
    ...overrides,
  };
}

function record(overrides = {}) {
  return {
    path: "digested/example.md",
    firstSeenAt: new Date(base).toISOString(),
    fileCreatedAt: new Date(base).toISOString(),
    twentyFourHourSweepStartedAt: new Date(base).toISOString(),
    contentHash: "hash:old",
    embeddedContentHash: "hash:old",
    lastChangedAt: new Date(base).toISOString(),
    lastRefreshedAt: new Date(base).toISOString(),
    provider: "gemini",
    model: "gemini-embedding-2",
    dimensions: 768,
    embedding: [0.1, 0.2],
    projection7d: [0, 0, 0, 0, 0, 0, 0],
    ...overrides,
  };
}

{
  const decision = policy.shouldRefreshEmbeddingRecord(null, meta());
  assert.equal(decision.refresh, true);
  assert.equal(decision.reason, "missing_record");
}

{
  const decision = policy.shouldRefreshEmbeddingRecord(
    record(),
    meta({ nowMs: base + 30 * 60 * 1000 })
  );
  assert.equal(decision.refresh, false);
  assert.equal(decision.reason, "hot_window_wait");
  assert.equal(decision.nextRefreshAfter, new Date(base + oneHour).toISOString());
}

{
  const decision = policy.shouldRefreshEmbeddingRecord(
    record(),
    meta({ nowMs: base + oneHour + 1 })
  );
  assert.equal(decision.refresh, true);
  assert.equal(decision.reason, "hot_window_hour_elapsed");
}

{
  const decision = policy.shouldRefreshEmbeddingRecord(
    record(),
    meta({ nowMs: base + oneDay + oneHour })
  );
  assert.equal(decision.refresh, false);
  assert.equal(decision.reason, "seven_day_wait");
  assert.equal(decision.nextRefreshAfter, new Date(base + sevenDays).toISOString());
}

{
  const decision = policy.shouldRefreshEmbeddingRecord(
    record(),
    meta({ nowMs: base + sevenDays + 1 })
  );
  assert.equal(decision.refresh, true);
  assert.equal(decision.reason, "seven_days_elapsed");
}

{
  const decision = policy.shouldRefreshEmbeddingRecord(
    record({ contentHash: "hash:same", embeddedContentHash: "hash:same" }),
    meta({ contentHash: "hash:same", nowMs: base + 30 * oneDay })
  );
  assert.equal(decision.refresh, false);
  assert.equal(decision.reason, "unchanged");
}

{
  const decision = policy.shouldRefreshEmbeddingRecord(
    record({ dimensions: 1536, embeddedContentHash: "hash:new", contentHash: "hash:new" }),
    meta({ contentHash: "hash:new", dimensions: 768, nowMs: base + oneHour })
  );
  assert.equal(decision.refresh, true);
  assert.equal(decision.reason, "embedding_config_changed");
}

{
  const key768 = policy.fileEmbeddingCacheKey("digested/example.md", "gemini", "gemini-embedding-2", 768);
  const key1536 = policy.fileEmbeddingCacheKey("digested/example.md", "gemini", "gemini-embedding-2", 1536);
  assert.notEqual(key768.id, key1536.id);
  assert.match(key768.path, /^index\/files\/[a-f0-9]{2}\/[a-f0-9]+\.json$/);
}

{
  const built = policy.createEmbeddingRecord(
    null,
    {
      path: "digested/example.md",
      title: "example",
      size: 42,
    },
    meta({ nowMs: base + oneHour }),
    { refresh: true, reason: "missing_record" },
    {
      embedding: [0.1, 0.2],
      embeddedContentHash: "hash:new",
      lastRefreshedAt: new Date(base + oneHour).toISOString(),
    }
  );

  assert.equal(built.path, "digested/example.md");
  assert.equal(built.fileCreatedAt, new Date(base).toISOString());
  assert.equal(built.provider, "gemini");
  assert.equal(built.model, "gemini-embedding-2");
  assert.equal(built.dimensions, 768);
  assert.equal(built.contentHash, "hash:new");
  assert.equal(built.embeddedContentHash, "hash:new");
  assert.equal(built.stats.timeSinceTwentyFourHourSweepStartedMs, oneHour);
  assert.equal(built.stats.timeSinceLastRefreshMs, 0);
}

{
  assert.equal(policy.shouldClearEmbeddingRecordForDimension(record({ dimensions: 768 }), 768), true);
  assert.equal(policy.shouldClearEmbeddingRecordForDimension(record({ dimensions: 1536 }), 768), false);
  assert.equal(policy.shouldClearEmbeddingRecordForDimension({ dimensions: "768" }, 768), true);
  assert.equal(policy.shouldClearEmbeddingRecordForDimension(null, 768), false);
}

{
  assert.equal(JSON.stringify(policy.getVisualDimensionLabels()), JSON.stringify(["x", "y", "z", "r", "g", "b", "light"]));
  assert.equal(source.includes("const aura"), false, "bloom aura should not be drawn");
  assert.equal(source.includes("Light and bloom"), false, "bloom should not be named in the graph UI");
}

{
  assert.equal(policy.shouldAutoRotateNow(true, 0, base), true);
  assert.equal(policy.shouldAutoRotateNow(false, 0, base), false);
  assert.equal(policy.shouldAutoRotateNow(true, base - 4999, base), false);
  assert.equal(policy.shouldAutoRotateNow(true, base - 5000, base), true);
  assert.equal(policy.shouldAutoRotateNow(true, base - 7000, base), true);
}

{
  const delta = policy.calculateDragRotationDelta(10, 8);
  assert.equal(delta.y, 0.06);
  assert.equal(delta.x, 0.048);
}

{
  const links = policy.buildDocumentLinks(
    [
      { path: "a.md", index: 0 },
      { path: "b.md", index: 1 },
      { path: "c.md", index: 2 },
    ],
    {
      "a.md": { "b.md": 1, "c.md": 2 },
      "b.md": { "a.md": 1 },
      "missing.md": { "a.md": 1 },
    }
  );
  assert.equal(JSON.stringify(links), JSON.stringify([
    { a: 0, b: 1, count: 2 },
    { a: 0, b: 2, count: 2 },
  ]));
}

{
  const points = [{ index: 0 }, { index: 1 }, { index: 2 }];
  const maxConnectionCount = policy.applyConnectionCounts(points, [
    { a: 0, b: 1, count: 2 },
    { a: 0, b: 2, count: 1 },
  ]);
  assert.equal(maxConnectionCount, 3);
  assert.equal(points[0].connectionCount, 3);
  assert.equal(points[1].connectionCount, 2);
  assert.equal(points[2].connectionCount, 1);
}

{
  assert.equal(policy.calculateNodeScreenSize(0, 10, 9), 3.5);
  assert.equal(policy.calculateNodeScreenSize(10, 10, 9), 9);
  assert.ok(policy.calculateNodeScreenSize(4, 10, 9) > policy.calculateNodeScreenSize(1, 10, 9));
}

{
  assert.ok(policy.calculateWheelZoom(1, -100) > 1);
  assert.ok(policy.calculateWheelZoom(1, 100) < 1);
  assert.equal(policy.calculateWheelZoom(1, -10000), 2.8);
  assert.equal(policy.calculateWheelZoom(1, 10000), 0.45);
}

console.log("refresh policy tests passed");
