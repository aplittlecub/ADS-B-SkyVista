import { mkdir, readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const bundle = await readFile("custom_components/flight_card/flight-card.js", "utf8");
const origin = "http://skyvista.test";
const previewDir = "artifacts/popup-previews";
const compact = { hex: "abc123", flight: "SKY204", aircraft_type: "Airbus A320", altitude_ft: 32000, speed_kt: 430, track_deg: 240, seen_s: 0.4 };
const detailed = { ...compact, flight: "SHT8H", aircraft_type: "A320-232", registration: "G-EUUE", manufacturer: "Airbus", registered_owners: "British Airways", altitude_ft: 2100, speed_kt: 172, airframe_image_url: `${origin}/sample-airframe.svg` };
const palettes = {
  light: { "ha-card-background": "#ffffff", "card-background-color": "#ffffff", "primary-text-color": "#172b3a", "secondary-text-color": "#526775", "divider-color": "#dce5eb", "secondary-background-color": "#f0f4f7" },
  dark: { "ha-card-background": "#102637", "card-background-color": "#102637", "primary-text-color": "#f2f7fa", "secondary-text-color": "#a6bac8", "divider-color": "#365161", "secondary-background-color": "#172f41" },
};

async function setTheme(page: Page, theme: "light" | "dark", inherited = true) {
  await page.locator("flight-card").evaluate((card: any, { theme, palette }) => {
    for (const name of Object.keys(palette)) document.documentElement.style.setProperty(`--${name}`, palette[name]);
    card.hass = { ...card.hass, themes: { darkMode: theme === "dark" } };
  }, { theme, palette: inherited ? palettes[theme] : {} });
}

async function openPopup(page: Page, theme: "light" | "dark", properties: Record<string, unknown>, width = 920, mapHeight = 580) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.setViewportSize({ width, height: 850 });
  await page.route("**/*", async route => {
    const url = route.request().url();
    if (url === `${origin}/flight-card.js`) {
      await route.fulfill({ contentType: "text/javascript", body: bundle });
    } else if (url === `${origin}/dashboard`) {
      // These are representative HA variables and synthetic aircraft/tile/photo fixtures.
      const fixture = JSON.stringify(properties).replace(/</g, "\\u003c");
      await route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>body{margin:0;padding:20px;background:var(--secondary-background-color);font-family:system-ui,sans-serif}flight-card{display:block;max-width:680px;margin:0 auto}ha-card{display:block;background:var(--ha-card-background);border-radius:16px}</style>
        <script type="module">await import('/flight-card.js');const card=document.createElement('flight-card');
        card.setConfig({map_height:${mapHeight},fit_bounds:false,center_lat:51.5,center_lon:-0.1});
        card.hass={states:{'sensor.aircraft':{entity_id:'sensor.aircraft',state:'1',attributes:{source_domain:'flight_card',updated:'2026-10-06T14:00:00Z',geojson:{type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'Point',coordinates:[-0.1,51.5]},properties:${fixture}}]}}}}};document.body.append(card);</script>` });
    } else if (url === `${origin}/sample-airframe.svg`) {
      await route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="250" viewBox="0 0 720 250"><rect width="720" height="250" fill="#d7e6ef"/><path d="M0 200H720" stroke="#7c93a2" stroke-width="3"/><path d="M85 151L537 142Q615 134 633 155L535 175H164Z" fill="#f8fafc" stroke="#607d8b" stroke-width="3"/><path d="M174 151L135 65H183L254 149M341 161L305 208H369L422 158" fill="#334c61"/><path d="M202 154H548" stroke="#597996" stroke-width="5"/><text x="28" y="35" font-family="sans-serif" font-size="20" fill="#334c61">Synthetic photo fixture</text></svg>` });
    } else if (url === `${origin}/missing-photo.svg`) {
      await route.fulfill({ contentType: "image/svg+xml", body: "invalid image" });
    } else if (/\.png$/.test(url)) {
      const bg = theme === "dark" ? "#233d48" : "#d8e5df";
      const road = theme === "dark" ? "#45606c" : "#f9faf5";
      await route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="${bg}"/><path d="M-20 150L276 72M68 -20L159 276" stroke="${road}" stroke-width="12"/><path d="M-20 150L276 72M68 -20L159 276" stroke="#92a697" stroke-width="1"/><path d="M0 220Q110 180 256 240" stroke="#75a3b8" stroke-width="22" fill="none"/></svg>` });
    } else await route.abort();
  });
  await page.goto(`${origin}/dashboard`);
  await expect(page.locator(".flight-card__aircraft-marker")).toHaveCount(1);
  await setTheme(page, theme);
  await page.locator(".flight-card__aircraft-marker").click();
  await expect(page.locator(".flight-card__popup")).toBeVisible();
  // Leaflet pans asynchronously; validate the settled popup, including its header.
  await expect.poll(async () => {
    const popup = await page.locator(".leaflet-popup-content-wrapper").boundingBox();
    const map = await page.locator(".flight-card__map").boundingBox();
    return popup!.y - map!.y;
  }).toBeGreaterThanOrEqual(4);
  return errors;
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme} popup preserves readings, themed Leaflet chrome and desktop/mobile layout`, async ({ page }) => {
    const errors = await openPopup(page, theme, compact);
    await expect(page.locator(".flight-card__popup-title")).toHaveText("SKY204");
    await expect(page.locator(".flight-card__popup-type")).toHaveText("Airbus A320");
    const values = page.locator(".flight-card__popup-readings dd");
    await expect(values).toHaveText(["32,000 ft", "430 kt", "240 °", "0.4 s ago"]);
    const wrapper = page.locator(".flight-card__leaflet-popup .leaflet-popup-content-wrapper");
    await expect(wrapper).toHaveCSS("background-color", theme === "dark" ? "rgb(16, 38, 55)" : "rgb(255, 255, 255)");
    await expect(page.locator(".leaflet-popup-tip")).toHaveCSS("background-color", theme === "dark" ? "rgb(16, 38, 55)" : "rgb(255, 255, 255)");
    await mkdir(previewDir, { recursive: true });
    await page.locator("flight-card").screenshot({ path: `${previewDir}/popup-${theme}-desktop.png` });
    for (const width of [390, 320, 920]) {
      await page.setViewportSize({ width, height: 850 });
      await expect.poll(() => page.locator("flight-card").evaluate((card: any) => card._map.getSize().x)).toBe(Math.min(680, width - 40));
      // Relayout and animated pan must settle with the popup inside the resized map.
      await expect.poll(async () => {
        const bounds = await wrapper.boundingBox();
        return { fits: Boolean(bounds && bounds.width <= width - 40 && bounds.x >= 19 && bounds.x + bounds.width <= width - 19), width, bounds };
      }).toMatchObject({ fits: true });
      await expect(values).toHaveText(["32,000 ft", "430 kt", "240 °", "0.4 s ago"]);
    }
    await page.locator(".leaflet-popup-close-button").click();
    await expect(page.locator(".flight-card__popup")).toHaveCount(0);
    await expect(page.locator(".leaflet-control-zoom-in")).toBeVisible();
    await expect(page.locator(".leaflet-control-attribution a[href='https://www.openstreetmap.org/copyright']")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test(`${theme} mobile details and optional photo stay inside the popup`, async ({ page }) => {
    const errors = await openPopup(page, theme, detailed, 390);
    await expect(page.locator(".flight-card__popup-details")).toContainText("British Airways");
    await expect.poll(() => page.locator(".flight-card__popup-image").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    const image = await page.locator(".flight-card__popup-image").boundingBox();
    const content = await page.locator(".flight-card__popup").boundingBox();
    expect(image!.width).toBeLessThan(content!.width);
    expect(await page.locator(".flight-card__popup-image").getAttribute("referrerpolicy")).toBe("no-referrer");
    await page.locator("flight-card").screenshot({ path: `${previewDir}/popup-${theme}-mobile-details.png` });
    expect(errors).toEqual([]);
  });
}

test("open popup follows HA theme changes, including mode fallbacks", async ({ page }) => {
  const errors = await openPopup(page, "light", compact);
  const popup = page.locator(".leaflet-popup-content-wrapper");
  await setTheme(page, "dark");
  await expect(popup).toHaveCSS("background-color", "rgb(16, 38, 55)");
  await setTheme(page, "light");
  await expect(popup).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.evaluate(() => document.documentElement.removeAttribute("style"));
  await setTheme(page, "dark", false);
  await expect(popup).toHaveCSS("background-color", "rgb(16, 38, 55)");
  await setTheme(page, "light", false);
  await expect(popup).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator("flight-card").evaluate((card: any) => { card.hass = { ...card.hass, themes: undefined }; });
  await expect(popup).toHaveCSS("background-color", "rgb(16, 38, 55)");
  await expect(page.locator(".flight-card__aircraft-marker")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("missing readings and long untrusted strings remain honest, escaped and scrollable", async ({ page }) => {
  const errors = await openPopup(page, "light", { hex: "abc123", flight: '<img src=x onerror="window.injected=true">' + "LONG".repeat(18), registration: "REGISTRATION".repeat(15), manufacturer: "Manufacturer".repeat(20), registered_owners: "Owner ".repeat(80), altitude_ft: null, speed_kt: "", track_deg: null, seen_s: null, airframe_image_url: "javascript:alert(1)" }, 320, 300);
  await expect(page.locator(".flight-card__popup-readings dd")).toHaveText(["—", "—", "—", "—"]);
  await expect(page.locator(".flight-card__popup img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).injected)).toBeUndefined();
  expect(await page.locator(".leaflet-popup-content").evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await page.locator(".flight-card__popup").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.locator("flight-card").screenshot({ path: `${previewDir}/popup-light-mobile-long-missing.png` });
  expect(errors).toEqual([]);
});

test("default-height card keeps photo popup scrollable; failed photo is omitted", async ({ page }) => {
  const errors = await openPopup(page, "dark", detailed, 390, 420);
  await expect(page.locator(".flight-card__popup-title")).toBeVisible();
  await expect(page.locator(".leaflet-popup-close-button")).toBeVisible();
  const content = page.locator(".leaflet-popup-content");
  expect(await content.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await content.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator(".flight-card__popup-image")).toBeVisible();
  await page.locator(".leaflet-popup-close-button").click();
  await page.locator("flight-card").evaluate((card: any, url) => {
    const state = card.hass.states['sensor.aircraft'];
    state.attributes.geojson.features[0].properties.airframe_image_url = url;
    state.attributes.updated = '2026-10-06T14:00:01Z';
    card.hass = { ...card.hass };
  }, `${origin}/missing-photo.svg`);
  await page.locator(".flight-card__aircraft-marker").click();
  await expect(page.locator(".flight-card__popup-image")).toHaveAttribute("src", `${origin}/missing-photo.svg`);
  await page.locator(".leaflet-popup-content").evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator(".flight-card__popup-photo")).toHaveCount(0);
  await expect(page.locator(".flight-card__popup-title")).toHaveText("SHT8H");
  expect(errors).toEqual([]);
});

for (const theme of ["light", "dark"] as const) {
  test(`${theme} missing telemetry and long owner preview`, async ({ page }) => {
    const errors = await openPopup(page, theme, { ...compact, flight: "NO DATA", altitude_ft: null, speed_kt: null, track_deg: null, seen_s: null, registered_owners: "A very long aircraft owner name that needs to wrap safely within a narrow mobile popup" }, 320);
    await expect(page.locator(".flight-card__popup-readings dd")).toHaveText(["—", "—", "—", "—"]);
    const title = await page.locator(".flight-card__popup-title").boundingBox();
    const zoom = await page.locator(".leaflet-control-zoom").boundingBox();
    expect(title!.x).toBeGreaterThan(zoom!.x + zoom!.width);
    await page.locator("flight-card").screenshot({ path: `${previewDir}/popup-${theme}-mobile-missing.png` });
    expect(errors).toEqual([]);
  });
}
