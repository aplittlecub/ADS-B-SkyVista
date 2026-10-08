import { mkdir, readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const bundle = await readFile("custom_components/flight_card/flight-card.js", "utf8");
const origin = "http://skyvista.test";
const palettes = {
  light: { background: "#ffffff", text: "#172b3a", muted: "#526775", divider: "#dce5eb", surface: "#f0f4f7" },
  dark: { background: "#102637", text: "#f2f7fa", muted: "#a6bac8", divider: "#365161", surface: "#172f41" },
};

async function openCards(page: Page, configs: Record<string, unknown>[] = [{}]) {
  const errors: string[] = [];
  const tileRequests: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.route("**/*", async route => {
    const url = route.request().url();
    if (url === `${origin}/flight-card.js`) {
      await route.fulfill({ contentType: "text/javascript", body: bundle });
    } else if (url === `${origin}/dashboard`) {
      await route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>body{margin:0;padding:16px;background:var(--secondary-background-color);font-family:system-ui,sans-serif}flight-card{display:block;max-width:760px;margin:0 auto 16px}</style>
        <script type="module">
          await import('/flight-card.js');
          for (const config of ${JSON.stringify(configs)}) {
            const card=document.createElement('flight-card');
            card.setConfig({entity:'sensor.aircraft',map_height:580,fit_bounds:false,center_lat:55.95,center_lon:-3.2,...config});
            card.hass={themes:{darkMode:false},states:{'sensor.aircraft':{entity_id:'sensor.aircraft',state:'1',attributes:{source_domain:'flight_card',updated:new Date().toISOString(),geojson:{type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'Point',coordinates:[-3.2,55.95]},properties:{hex:'abc123',flight:'SHT8H',aircraft_type:'Airbus A320',registration:'G-EUUE',altitude_ft:32000,speed_kt:430,track_deg:240,seen_s:0.4,airframe_image_url:'${origin}/photo.svg'}}]}}}}};
            document.body.append(card);
            // Representative HA card styles; production HA supplies these values.
            const style=document.createElement('style');
            style.textContent='ha-card{display:block;background:var(--ha-card-background);border-radius:16px}.flight-card{padding:16px;box-sizing:border-box}';
            card.shadowRoot.append(style);
          }
        </script>` });
    } else if (url === `${origin}/photo.svg`) {
      await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><rect width="300" height="100" fill="#90c9ed"/><path d="M25 60H275L240 75H60Z" fill="#ffffff"/><path d="M80 60L65 25H85L120 60" fill="#c42f35"/></svg>' });
    } else if (new URL(url).hostname === "tile.openstreetmap.org") {
      tileRequests.push(url);
      // OSM-like colours and labels, entirely synthetic; no provider requests.
      await route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
        <rect width="256" height="256" fill="#f2efe9"/><path d="M0 0H110L70 85H0Z" fill="#cde4be"/>
        <path d="M210 0Q140 95 220 170L256 190V0Z" fill="#add6ed"/>
        <path d="M-20 160L280 70M60 -20L160 280" stroke="#c9c3b8" stroke-width="14"/>
        <path d="M-20 160L280 70M60 -20L160 280" stroke="#ffffff" stroke-width="10"/>
        <path d="M0 220Q110 180 256 240" stroke="#d4ad65" stroke-width="9" fill="none"/>
        <path d="M0 220Q110 180 256 240" stroke="#f4d88b" stroke-width="6" fill="none"/>
        <text x="90" y="120" font-family="sans-serif" font-size="13" fill="#333333">Edinburgh</text>
        <text x="12" y="36" font-family="sans-serif" font-size="10" fill="#36672d">Park</text></svg>` });
    } else await route.abort();
  });
  await page.goto(`${origin}/dashboard`);
  await expect(page.locator("flight-card")).toHaveCount(configs.length);
  await expect(page.locator(".flight-card__aircraft-marker")).toHaveCount(configs.length);
  await expect.poll(() => page.locator(".leaflet-tile:not(.leaflet-tile-loaded)").count()).toBe(0);
  await setHaTheme(page, "light");
  return { errors, tileRequests };
}

async function setHaTheme(page: Page, theme?: "light" | "dark") {
  const palette = palettes[theme ?? "light"];
  await page.locator("flight-card").evaluateAll((cards, { theme, palette }) => {
    const vars = { "ha-card-background": palette.background, "card-background-color": palette.background, "primary-text-color": palette.text, "secondary-text-color": palette.muted, "divider-color": palette.divider, "secondary-background-color": palette.surface };
    for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(`--${name}`, value);
    for (const card of cards as any[]) card.hass = { ...card.hass, themes: theme ? { darkMode: theme === "dark" } : undefined };
  }, { theme, palette });
}

async function expectPixelsPreserved(page: Page, before: Buffer, after: Buffer) {
  const result = await page.evaluate(async ({ before, after }) => {
    async function pixels(data: string) {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
    }
    const a = await pixels(before), b = await pixels(after);
    let delta = 0;
    for (let i = 0; i < a.data.length; i++) delta += Math.abs(a.data[i] - b.data[i]);
    return { sameSize: a.width === b.width && a.height === b.height, meanChannelDelta: delta / a.data.length };
  }, { before: before.toString('base64'), after: after.toString('base64') });
  expect(result.sameSize).toBe(true);
  // Allow tiny compositor antialiasing differences, not a palette change.
  expect(result.meanChannelDelta).toBeLessThan(1);
}

test("Auto follows HA; header overrides stay independent and do not write dashboard config", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const { errors } = await openCards(page, [{}, {}]);
  const first = page.locator("flight-card").nth(0);
  const second = page.locator("flight-card").nth(1);
  await first.evaluate(card => { (window as any).configEvents = 0; card.addEventListener("config-changed", () => (window as any).configEvents++); });
  await expect(first).toHaveAttribute("data-map-theme", "light");
  await setHaTheme(page, "dark");
  await expect(first).toHaveAttribute("data-map-theme", "dark");
  await first.getByRole("combobox", { name: "Map theme" }).selectOption("light");
  await expect(first).toHaveAttribute("data-map-theme", "light");
  await expect(second).toHaveAttribute("data-map-theme", "dark");
  await setHaTheme(page, "light");
  await first.getByRole("combobox", { name: "Map theme" }).selectOption("dark");
  await expect(first).toHaveAttribute("data-map-theme", "dark");
  await expect(second).toHaveAttribute("data-map-theme", "light");
  await first.getByRole("combobox", { name: "Map theme" }).selectOption("auto");
  await expect(first).toHaveAttribute("data-map-theme", "light");
  expect(await first.evaluate((card: any) => card._config.map_theme)).toBe("auto");
  expect(await page.evaluate(() => (window as any).configEvents)).toBe(0);
  expect(errors).toEqual([]);
});

test("theme switches preserve map, tiles, marker colours, open popup, photo and unfiltered attribution", async ({ page }) => {
  await page.clock.install();
  const { errors, tileRequests } = await openCards(page);
  await page.clock.runFor(2600);
  const card = page.locator("flight-card");
  await card.locator(".flight-card__aircraft-marker").click();
  await expect(card.locator(".flight-card__popup-image")).toBeVisible();
  await expect.poll(() => card.locator(".flight-card__popup-image").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await page.clock.runFor(1000);
  await card.evaluate((c: any) => {
    c._map.panBy([20, 10], { animate: false });
    (window as any).beforeTheme = { map: c._map, center: c._map.getCenter(), zoom: c._map.getZoom(), marker: c.shadowRoot.querySelector('.flight-card__aircraft-marker'), popup: c.shadowRoot.querySelector('.leaflet-popup'), tiles: [...c.shadowRoot.querySelectorAll('.leaflet-tile')] };
    (window as any).removedMapNodes = 0;
    const observer = new MutationObserver(records => { for (const record of records) (window as any).removedMapNodes += record.removedNodes.length; });
    observer.observe(c.shadowRoot.querySelector('.flight-card__map'), { childList: true, subtree: true });
  });
  // Exclude the changing map and popup shadow from the marker's transparent crop.
  const markerScreenshot = { style: ".flight-card__basemap, .leaflet-popup { visibility: hidden !important; }" };
  const markerPixels = await card.locator(".flight-card__aircraft-marker").screenshot(markerScreenshot);
  const photoPixels = await card.locator(".flight-card__popup-image").screenshot();
  const requests = tileRequests.length;
  for (const mode of ["dark", "light", "auto", "dark"]) {
    await card.getByRole("combobox", { name: "Map theme" }).selectOption(mode);
    await expect(card).toHaveAttribute("data-map-theme", mode === "dark" ? "dark" : "light");
  }
  await expectPixelsPreserved(page, markerPixels, await card.locator(".flight-card__aircraft-marker").screenshot(markerScreenshot));
  await expectPixelsPreserved(page, photoPixels, await card.locator(".flight-card__popup-image").screenshot());
  await expect(card.locator(".flight-card__basemap")).not.toHaveCSS("filter", "none");
  expect(await card.evaluate((c: any) => ['.leaflet-marker-pane', '.leaflet-popup-pane', '.leaflet-control-attribution', '.leaflet-control-zoom', '.flight-card__popup-image'].every(selector => {
    for (let el = c.shadowRoot.querySelector(selector); el && el !== c; el = el.parentElement) if (getComputedStyle(el).filter !== 'none') return false;
    return true;
  }))).toBe(true);
  // Saving a theme config resets the temporary header override, without resetting view.
  await card.evaluate((c: any) => c.setConfig({ ...c._config, map_theme: "light" }));
  await expect(card.getByRole("combobox", { name: "Map theme" })).toHaveValue("light");
  expect(await card.evaluate((c: any) => {
    const b = (window as any).beforeTheme;
    const unfiltered = ['.leaflet-marker-pane', '.leaflet-popup-pane', '.leaflet-control-attribution', '.leaflet-control-zoom', '.flight-card__popup-image'].every(selector => {
      for (let el = c.shadowRoot.querySelector(selector); el && el !== c; el = el.parentElement) if (getComputedStyle(el).filter !== 'none') return false;
      return true;
    });
    return { sameMap: c._map === b.map, center: c._map.getCenter().equals(b.center), zoom: c._map.getZoom() === b.zoom, marker: c.shadowRoot.querySelector('.flight-card__aircraft-marker') === b.marker, popup: c.shadowRoot.querySelector('.leaflet-popup') === b.popup, tiles: b.tiles.every(tile => tile.isConnected), unfiltered, removed: (window as any).removedMapNodes };
  })).toEqual({ sameMap: true, center: true, zoom: true, marker: true, popup: true, tiles: true, unfiltered: true, removed: 0 });
  expect(tileRequests.length).toBe(requests);
  await card.getByRole("combobox", { name: "Map theme" }).selectOption("dark");
  await expect(card.locator(".flight-card__basemap")).not.toHaveCSS("filter", "none");
  await expect(card.locator(".leaflet-control-attribution")).toContainText("OpenStreetMap contributors");
  expect(errors).toEqual([]);
});

test("Auto theme assignments also preserve a manually panned map with no aircraft", async ({ page }) => {
  await page.clock.install();
  const { errors } = await openCards(page, [{ center_lat: null, center_lon: null }]);
  // Finish startup size corrections before checking a user's settled view.
  await page.clock.runFor(2600);
  const card = page.locator("flight-card");
  await card.evaluate((c: any) => {
    const state = c.hass.states['sensor.aircraft'];
    c.hass = { ...c.hass, config: { latitude: 55.95, longitude: -3.2 }, states: { 'sensor.aircraft': { ...state, state: '0', attributes: { ...state.attributes, geojson: { type: 'FeatureCollection', features: [] } } } } };
    c._map.setView([56, -3.5], 9, { animate: false });
    (window as any).emptyMapView = { map: c._map, center: c._map.getCenter(), zoom: c._map.getZoom() };
  });
  await expect(card.locator(".flight-card__aircraft-marker")).toHaveCount(0);
  await setHaTheme(page, "dark");
  await expect(card).toHaveAttribute("data-map-theme", "dark");
  await setHaTheme(page, "light");
  expect(await card.evaluate((c: any) => {
    const b = (window as any).emptyMapView;
    return c._map === b.map && c._map.getCenter().equals(b.center) && c._map.getZoom() === b.zoom;
  })).toBe(true);
  expect(errors).toEqual([]);
});

test("system fallback updates live and subscriptions survive disconnect/reconnect", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  const { errors } = await openCards(page);
  const card = page.locator("flight-card");
  await setHaTheme(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(card).toHaveAttribute("data-map-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(card).toHaveAttribute("data-map-theme", "light");
  await card.evaluate(c => { (window as any).detachedCard = c; c.remove(); });
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await page.evaluate(() => (window as any).detachedCard.dataset.mapTheme)).toBe("light");
  await page.evaluate(() => document.body.append((window as any).detachedCard));
  await expect(card).toHaveAttribute("data-map-theme", "dark");
  await setHaTheme(page, "light");
  await expect(card).toHaveAttribute("data-map-theme", "light");
  expect(errors).toEqual([]);
});

test("saved defaults are exposed in the editor; invalid config falls back to Auto", async ({ page }) => {
  await openCards(page, [{ map_theme: "dark" }, { map_theme: "light" }, { map_theme: "unexpected" }]);
  for (const [index, mode] of ["dark", "light", "auto"].entries()) {
    await expect(page.locator("flight-card").nth(index).getByRole("combobox", { name: "Map theme" })).toHaveValue(mode);
  }
  expect(await page.locator("flight-card").first().evaluate((c: any) => {
    const form = c.constructor.getConfigForm();
    const schema = form.schema.find(field => field.name === 'map_theme');
    return { label: form.computeLabel(schema), values: schema.selector.select.options.map(option => option.value) };
  })).toEqual({ label: "Map theme", values: ["auto", "light", "dark"] });
});

test("header control has native keyboard semantics and fits mobile light/dark layouts", async ({ page }) => {
  const { errors } = await openCards(page);
  const control = page.getByRole("combobox", { name: "Map theme" });
  await expect(control).toHaveAccessibleDescription(/Auto follows Home Assistant.*only to this card/);
  await page.keyboard.press("Tab");
  await expect(control).toBeFocused();
  await page.keyboard.press("End");
  await expect(control).toHaveValue("dark");
  await expect(page.locator("flight-card")).toHaveAttribute("data-map-theme", "dark");
  await expect(control).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Home");
  await expect(control).toHaveValue("auto");
  expect(await control.ariaSnapshot()).toContain('combobox "Map theme"');
  const previewDir = "artifacts/map-theme-previews";
  await mkdir(previewDir, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await setHaTheme(page, theme);
    for (const width of [920, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const header = await page.locator(".flight-card__header").boundingBox();
      const select = await control.boundingBox();
      const title = await page.locator(".flight-card__title").boundingBox();
      const status = await page.locator(".flight-card__status").boundingBox();
      expect(select!.x).toBeGreaterThanOrEqual(title!.x + title!.width);
      expect(status!.x + status!.width).toBeLessThanOrEqual(header!.x + header!.width + 1);
      expect(await page.locator("flight-card").evaluate(c => c.shadowRoot!.querySelector('.flight-card__header')!.scrollWidth <= c.shadowRoot!.querySelector('.flight-card__header')!.clientWidth)).toBe(true);
      await page.locator("flight-card").screenshot({ path: `${previewDir}/map-${theme}-${width}.png` });
    }
  }
  expect(errors).toEqual([]);
});
