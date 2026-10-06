import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const bundle = await readFile("custom_components/flight_card/flight-card.js", "utf8");
const origin = "http://skyvista.test";
const tile = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");

async function openCard(page: Page, config: Record<string, unknown> = {}, hidden = false) {
  const errors: string[] = [];
  const tileRequests: Array<{ url: string; referer?: string; origin?: string }> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  // All tiles are synthetic; tests never contact OSM or a real custom provider.
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === `${origin}/flight_card/flight-card.js` || url.startsWith(`${origin}/flight_card/flight-card.js?`)) {
      await route.fulfill({ contentType: "text/javascript", body: bundle, headers: { "Cache-Control": "no-cache" } });
    } else if (url.startsWith(`${origin}/dashboard`)) {
      await route.fulfill({ contentType: "text/html", body: `<!doctype html>
        <meta name="referrer" content="no-referrer"><style>body{margin:0}ha-card{display:block}</style>
        ${config.tile_url ? "" : `<flight-card style="${hidden ? "display:none" : ""}"></flight-card>`}
        <script type="module">
          // The element exists before the module loads: exercise native custom-element upgrade.
          await import('/flight_card/flight-card.js');
          await customElements.whenDefined('flight-card');
          const card = document.querySelector('flight-card') || document.createElement('flight-card');
          card.setConfig(${JSON.stringify(config)});
          card.hass = {config: {latitude: 51.5, longitude: -0.1}, states: {
            'sensor.skyvista_aircraft': {entity_id: 'sensor.skyvista_aircraft', state: '1', attributes: {
              source_domain: 'flight_card', updated: '2026-10-06T14:00:00Z',
              geojson: {type: 'FeatureCollection', features: [{type: 'Feature',
                geometry: {type: 'Point', coordinates: [-0.1, 51.5]},
                properties: {hex: 'abc123', flight: 'TEST123', altitude_ft: 10000}}]}
            }}
          }};
          if (!card.isConnected) document.body.append(card);
        </script>` });
    } else if (/\.png(?:\?|$)/.test(url)) {
      const headers = await route.request().allHeaders();
      tileRequests.push({ url, referer: headers.referer, origin: headers.origin });
      // No Access-Control-Allow-Origin: normal image requests must still render.
      await route.fulfill({ contentType: "image/png", body: tile });
    } else {
      await route.abort();
    }
  });
  await page.goto(`${origin}/dashboard/private-path?token=private-value`);
  await expect.poll(() => page.evaluate(() => Boolean(customElements.get("flight-card")))).toBe(true);
  if (!hidden) await expect(page.locator(".leaflet-tile-loaded").first()).toBeVisible();
  return { errors, tileRequests };
}

test("cold startup upgrades an existing element and sends only the origin to canonical OSM", async ({ page }) => {
  const { errors, tileRequests } = await openCard(page);
  await expect(page.locator(".flight-card__count")).toHaveText("Aircraft: 1");
  await expect(page.locator(".flight-card__aircraft-marker")).toHaveCount(1);
  expect(tileRequests.length).toBeGreaterThan(0);
  for (const request of tileRequests) {
    expect(new URL(request.url).hostname).toBe("tile.openstreetmap.org");
    expect(request.referer).toBe(`${origin}/`);
    expect(request.origin).toBeUndefined();
  }
  expect(await page.locator(".leaflet-tile").first().getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
  expect(await page.locator(".leaflet-tile").first().getAttribute("crossorigin")).toBeNull();
  expect(errors).toEqual([]);
});

for (const tileUrl of ["https://tiles.example.test/{z}/{x}/{y}.png", "http://tiles.example.test/{z}/{x}/{y}.png", "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"]) {
  test(`custom provider retains document referrer policy and works without CORS: ${tileUrl}`, async ({ page }) => {
    const { errors, tileRequests } = await openCard(page, { tile_url: tileUrl, attribution: "Custom provider" });
    expect(await page.locator(".leaflet-tile").first().getAttribute("referrerpolicy")).toBeNull();
    expect(await page.locator(".leaflet-tile").first().getAttribute("crossorigin")).toBeNull();
    expect(tileRequests.length).toBeGreaterThan(0);
    expect(tileRequests.every((request) => request.referer === undefined && request.origin === undefined)).toBe(true);
    await expect(page.locator(".leaflet-control-attribution")).toContainText("Custom provider");
    expect(errors).toEqual([]);
  });
}

test("duplicate module URLs register once; reload and reconnect initialize the map", async ({ page }) => {
  const { errors } = await openCard(page);
  await page.evaluate(async () => {
    const original = customElements.get("flight-card");
    await import(/* @vite-ignore */ `/flight_card/flight-card.js?upgrade-test`);
    if (customElements.get("flight-card") !== original) throw new Error("registration changed");
    const card = document.querySelector("flight-card")!;
    card.remove();
    document.body.append(card);
  });
  await expect(page.locator(".leaflet-tile-loaded").first()).toBeVisible();
  expect(await page.evaluate(() => (window as any).customCards.filter((card: any) => card.type === "flight-card").length)).toBe(1);
  await page.reload();
  await expect(page.locator(".leaflet-tile-loaded").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("hidden startup and mobile/desktop resizing preserve map size and aircraft", async ({ page }, testInfo) => {
  const { errors } = await openCard(page, {}, true);
  await page.locator("flight-card").evaluate((card: HTMLElement) => { card.style.display = "block"; });
  await expect(page.locator(".leaflet-tile-loaded").first()).toBeVisible();
  for (const width of [1280, 390, 768]) {
    await page.setViewportSize({ width, height: 850 });
    await expect.poll(() => page.locator("flight-card").evaluate((card: any) => card._map.getSize().x)).toBe(width);
    await expect(page.locator(".flight-card__aircraft-marker")).toHaveCount(1);
    if (width !== 768) await page.screenshot({ path: testInfo.outputPath(`card-${width}.png`) });
  }
  expect(errors).toEqual([]);
});
