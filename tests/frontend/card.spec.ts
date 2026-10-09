import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const bundle = await readFile("custom_components/flight_card/flight-card.js", "utf8");
const origin = "http://skyvista.test";
const tile = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");

test('late custom-element registration rebuilds the HA-style placeholder before fetching', async ({page})=>{
  await page.clock.install();
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
    const url=route.request().url();
    if(url.endsWith('/flight-card.js')){await gate;await route.fulfill({contentType:'text/javascript',body:bundle});}
    else if(url.endsWith('/delayed'))await route.fulfill({contentType:'text/html',body:`<style>ha-card{display:block}</style><main></main><script>
      window.requests=0;
      const hass={states:{'sensor.aircraft':{entity_id:'sensor.aircraft',state:'0',attributes:{source_domain:'flight_card',config_entry_id:'test',updated:'2026-10-08T14:00:00Z'}}},callWS:async()=>{requests++;return {config_entry_id:'test',updated:'2026-10-08T14:00:00Z',aircraft_count:0,geojson:{type:'FeatureCollection',features:[]}}}};
      // Installed HA 20260826.7 factory contract: whenDefined emits ll-rebuild;
      // its wrapper installs a once-listener and recreates the configured element.
      function build(){let card;if(customElements.get('flight-card')){card=document.createElement('flight-card');card.setConfig({entity:'sensor.aircraft'});}else{card=document.createElement('hui-error-card');card.textContent='Custom element missing';card.style.display='none';const timer=setTimeout(()=>card.style.display='',2000);customElements.whenDefined('flight-card').then(()=>{clearTimeout(timer);card.dispatchEvent(new Event('ll-rebuild',{bubbles:true}));});}card.hass=hass;card.addEventListener('ll-rebuild',event=>{event.stopPropagation();build();},{once:true});document.querySelector('main').replaceChildren(card);}
      build();import('/flight-card.js');
    </script>`});
    else await route.fulfill({contentType:'image/png',body:tile});
  });
  await page.goto(`${origin}/delayed`,{waitUntil:'domcontentloaded'});
  await page.clock.runFor(2100);
  await expect(page.locator('hui-error-card')).toBeVisible();
  expect(await page.evaluate(()=>(window as any).requests)).toBe(0);
  release();
  await expect(page.locator('.flight-card__count')).toHaveText('Aircraft: 0');
  await expect(page.locator('hui-error-card')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).requests)).toBe(1);
  expect(errors).toEqual([]);
});

test('configuration exceptions retain diagnostics even when the host catches them',async({page})=>{
  const {errors}=await openCard(page);
  expect(await page.locator('flight-card').evaluate((card:any)=>{try{card.setConfig(null);}catch(error){return (error as Error).message;}return null;})).toBe('Invalid configuration');
  expect(errors.some(message=>message.includes('ADS-B SkyVista: card configuration failed'))).toBe(true);
});

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

for (const receiverCount of [0, 1, 2]) {
  test(`picker stub preview renders with ${receiverCount} receivers and accepts editor updates`, async ({ page }) => {
    const { errors } = await openCard(page);
    const metadata = await page.locator("flight-card").evaluate((current: any, count) => {
      const registration = (window as any).customCards.find((entry: any) => entry.type === "flight-card");
      const stub = current.constructor.getStubConfig();
      const sensor = current.hass.states["sensor.skyvista_aircraft"];
      const states = Object.fromEntries(Array.from({ length: count }, (_, index) => {
        const entity_id = `sensor.receiver_${index + 1}`;
        return [entity_id, { ...sensor, entity_id }];
      }));
      const hass = { ...current.hass, states };
      current.remove();
      // HA's picker adds the type to getStubConfig and renders the registered card.
      const preview = document.createElement(registration.type) as any;
      preview.setConfig({ type: `custom:${registration.type}`, ...stub });
      preview.hass = hass;
      document.body.append(preview);
      return { registration, stub, entityField: preview.constructor.getConfigForm().schema.find((field: any) => field.name === "entity") };
    }, receiverCount);
    expect(metadata.registration).toMatchObject({ type: "flight-card", name: "ADS-B SkyVista", preview: true });
    expect(metadata.stub).toEqual({ title: "ADS-B SkyVista" });
    expect(metadata.entityField.selector).toEqual({ entity: { domain: "sensor" } });
    await expect(page.locator(".flight-card__title")).toHaveText("ADS-B SkyVista");
    await expect(page.locator(".leaflet-tile-loaded").first()).toBeVisible();
    await expect(page.locator(".flight-card__count")).toHaveText(`Aircraft: ${receiverCount === 1 ? 1 : 0}`);
    await expect(page.locator(".flight-card__aircraft-marker")).toHaveCount(receiverCount === 1 ? 1 : 0);
    if (receiverCount !== 1) await expect(page.locator(".flight-card__status")).toContainText("Select Aircraft entity");

    // Configuration editor updates keep rendering the same preview card.
    await page.locator("flight-card").evaluate((preview: any, count) => {
      preview.setConfig({ title: "Edited preview", entity: count ? "sensor.receiver_1" : "", map_theme: "dark" });
    }, receiverCount);
    await expect(page.locator(".flight-card__title")).toHaveText("Edited preview");
    await expect(page.locator("flight-card")).toHaveAttribute("data-map-theme", "dark");
    await expect(page.locator(".flight-card__count")).toHaveText(`Aircraft: ${receiverCount ? 1 : 0}`);
    await expect(page.locator(".flight-card__aircraft-marker")).toHaveCount(receiverCount ? 1 : 0);
    expect(errors).toEqual([]);
  });
}
