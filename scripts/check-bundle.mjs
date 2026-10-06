import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { verifyArtifacts } from "./artifacts.mjs";

const temporaryBuild = await mkdtemp(join(tmpdir(), "skyvista-build-"));
try {
  // Verification must never overwrite the artifacts it is checking.
  await build({ mode: "verify", build: { outDir: temporaryBuild } });
  await verifyArtifacts(temporaryBuild, ["dist", "custom_components/flight_card"]);
  console.info("Card bundle and source map match a fresh build in both destinations.");
} finally {
  await rm(temporaryBuild, { recursive: true, force: true });
}
