import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CARD_ARTIFACTS, verifyArtifacts } from "../scripts/artifacts.mjs";

test("stale JS and stale maps are rejected independently, without modifying files", async () => {
  const root = await mkdtemp(join(tmpdir(), "skyvista-artifacts-"));
  try {
    const fresh = join(root, "fresh");
    const destination = join(root, "package");
    await mkdir(fresh);
    await mkdir(destination);
    for (const name of CARD_ARTIFACTS) {
      await writeFile(join(fresh, name), `fresh ${name}`);
      await writeFile(join(destination, name), `fresh ${name}`);
    }
    await verifyArtifacts(fresh, [destination]);
    for (const name of CARD_ARTIFACTS) {
      await writeFile(join(destination, name), "stale");
      await assert.rejects(verifyArtifacts(fresh, [destination]), /is stale/);
      assert.equal(await readFile(join(destination, name), "utf8"), "stale");
      await writeFile(join(destination, name), `fresh ${name}`);
    }
    await rm(join(destination, "flight-card.js.map"));
    await assert.rejects(verifyArtifacts(fresh, [destination]), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HACS package has a matching map with the current TypeScript source", async () => {
  const bundle = await readFile("custom_components/flight_card/flight-card.js", "utf8");
  const map = JSON.parse(await readFile("custom_components/flight_card/flight-card.js.map", "utf8"));
  assert.match(bundle, /sourceMappingURL=flight-card\.js\.map/);
  assert.equal(map.file, "flight-card.js");
  const sourceIndex = map.sources.findIndex((source) => source.endsWith("src/flight-card.ts"));
  assert.ok(sourceIndex >= 0);
  assert.equal(map.sourcesContent[sourceIndex], await readFile("src/flight-card.ts", "utf8"));
});
