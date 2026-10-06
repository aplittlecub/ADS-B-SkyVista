import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const CARD_ARTIFACTS = ["flight-card.js", "flight-card.js.map"];

export async function verifyArtifacts(freshBuild, destinations) {
  for (const name of CARD_ARTIFACTS) {
    const expected = await readFile(join(freshBuild, name));
    for (const destination of destinations) {
      const actual = await readFile(join(destination, name));
      if (!expected.equals(actual)) {
        throw new Error(`${join(destination, name)} is stale. Run npm run build and commit the generated artifacts.`);
      }
    }
  }
}
