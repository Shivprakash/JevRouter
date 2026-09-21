import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CapabilityRegistry, resolveCapabilitiesDir } from "../src/manifest.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jevrouter-manifest-"));
}

function manifest(id: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ id, name: id, type: "skill", description: `Capability ${id}`, version: "1.0.0", ...overrides });
}

test("list() returns [] without creating the directory when it does not exist", async () => {
  const base = await tempDir();
  const missing = join(base, "does-not-exist");
  const registry = new CapabilityRegistry(missing);
  const result = await registry.list();
  assert.deepEqual(result, []);
  await assert.rejects(stat(missing), { code: "ENOENT" });
});

test("list() recurses into nested kind directories and skips aggregate/private files", async () => {
  const base = await tempDir();
  await mkdir(join(base, "skills"), { recursive: true });
  await mkdir(join(base, "mcp"), { recursive: true });
  await writeFile(join(base, "_index.json"), manifest("_index"));
  await writeFile(join(base, "candidates.json"), JSON.stringify([{ id: "should.not.load" }]));
  await writeFile(join(base, "skills", "jev-ultrafast.json"), manifest("skill.jev-ultrafast"));
  await writeFile(join(base, "skills", "bhuh-builder.json"), manifest("skill.bhuh-builder"));
  await writeFile(join(base, "skills", "_private.json"), manifest("skill._private"));
  await writeFile(join(base, "mcp", "jevrouter.json"), manifest("mcp_tool.jevrouter", { type: "mcp_tool" }));

  const registry = new CapabilityRegistry(base);
  const list = await registry.list();
  const ids = list.map((entry) => entry.id).sort();

  assert.deepEqual(ids, ["mcp_tool.jevrouter", "skill.bhuh-builder", "skill.jev-ultrafast"]);
  assert.ok(!ids.includes("_index"));
  assert.ok(!ids.includes("skill._private"));
  assert.ok(!ids.includes("should.not.load"));
});

test("list() skips files that fail to parse instead of throwing, and records them", async () => {
  const base = await tempDir();
  await mkdir(join(base, "skills"), { recursive: true });
  await writeFile(join(base, "skills", "good.json"), manifest("skill.good"));
  await writeFile(join(base, "skills", "broken.json"), "{ not valid json");
  await writeFile(join(base, "skills", "incomplete.json"), JSON.stringify({ id: "skill.incomplete" })); // missing required fields

  const registry = new CapabilityRegistry(base);
  const list = await registry.list();

  assert.deepEqual(list.map((entry) => entry.id), ["skill.good"]);
  assert.equal(registry.skippedFiles.length, 2);
  assert.ok(registry.skippedFiles.some((path) => path.endsWith("broken.json")));
  assert.ok(registry.skippedFiles.some((path) => path.endsWith("incomplete.json")));
});

test("list() de-duplicates by id, first match wins", async () => {
  const base = await tempDir();
  await mkdir(join(base, "a"), { recursive: true });
  await mkdir(join(base, "b"), { recursive: true });
  await writeFile(join(base, "a", "dupe.json"), manifest("dupe", { description: "first copy" }));
  await writeFile(join(base, "b", "dupe.json"), manifest("dupe", { description: "second copy" }));

  const registry = new CapabilityRegistry(base);
  const list = await registry.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].description, "first copy");
});

test("resolveCapabilitiesDir prefers --capabilities flag over everything else", () => {
  const dir = resolveCapabilitiesDir({
    argv: ["serve-mcp", "--capabilities", "/tmp/explicit-caps"],
    env: { JEVROUTER_CAPABILITIES: "/tmp/env-caps" },
    cwd: "/tmp/cwd",
  });
  assert.equal(dir, "/tmp/explicit-caps");
});

test("resolveCapabilitiesDir falls back to JEVROUTER_CAPABILITIES env var", () => {
  const dir = resolveCapabilitiesDir({
    argv: ["serve-mcp"],
    env: { JEVROUTER_CAPABILITIES: "/tmp/env-caps" },
    cwd: "/tmp/cwd",
  });
  assert.equal(dir, "/tmp/env-caps");
});

test("resolveCapabilitiesDir uses <cwd>/.jevrouter/capabilities only if it already exists", async () => {
  const cwd = await tempDir();
  const withoutLocalDir = resolveCapabilitiesDir({ argv: [], env: {}, cwd });
  assert.equal(withoutLocalDir, join(homedir(), ".config", "lm", "capabilities"));

  await mkdir(join(cwd, ".jevrouter", "capabilities"), { recursive: true });
  const withLocalDir = resolveCapabilitiesDir({ argv: [], env: {}, cwd });
  assert.equal(withLocalDir, join(cwd, ".jevrouter", "capabilities"));
});

test("resolveCapabilitiesDir defaults to the machine-wide registry under ~/.config/lm/capabilities", () => {
  const dir = resolveCapabilitiesDir({ argv: [], env: {}, cwd: "/tmp/some-unrelated-repo" });
  assert.equal(dir, join(homedir(), ".config", "lm", "capabilities"));
});
