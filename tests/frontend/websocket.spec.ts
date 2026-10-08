import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const bundle = await readFile("custom_components/flight_card/flight-card.js", "utf8");

async function setup(page: Page) {
  await page.route("**/*", async route => {
    if (route.request().url().endsWith("/card.js")) {
      await route.fulfill({ contentType: "text/javascript", body: bundle });
    } else if (route.request().url().endsWith("/dashboard")) {
      await route.fulfill({ contentType: "text/html", body: `<style>ha-card{display:block}</style><script type="module">
        await import('/card.js');
        const listeners = {ready:new Set(),disconnected:new Set()};
        window.requests=[]; window.listeners=listeners;
        window.connection={connected:true,addEventListener:(e,f)=>listeners[e].add(f),removeEventListener:(e,f)=>listeners[e].delete(f)};
        window.makeState=(entry,updated='2026-10-08T14:00:00Z')=>({entity_id:'sensor.'+entry,state:'1',attributes:{source_domain:'flight_card',config_entry_id:entry,updated}});
        window.hass={connection,states:{'sensor.a':makeState('a'),'sensor.b':makeState('b')},callWS:message=>new Promise((resolve,reject)=>requests.push({message,resolve,reject}))};
        window.card=document.createElement('flight-card'); card.setConfig({entity:'sensor.a',fit_bounds:false});card.hass=hass; document.body.append(card);
      </script>` });
    } else await route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>' });
  });
  await page.goto("http://skyvista.test/dashboard");
  await expect.poll(() => page.evaluate(() => (window as any).requests?.length)).toBe(1);
}

async function resolve(page: Page, index: number, entry = "a", updated = "2026-10-08T14:00:00Z", longitude = -0.1, count = 1) {
  await page.evaluate(({index,entry,updated,longitude,count}) => {
    (window as any).requests[index].resolve({config_entry_id:entry,updated,aircraft_count:count,geojson:{type:"FeatureCollection",features:count ? [{type:"Feature",geometry:{type:"Point",coordinates:[longitude,51.5]},properties:{hex:"abc123",flight:"TEST"}}] : []}});
  }, {index,entry,updated,longitude,count});
}

test("cached snapshot refreshes same-count positions and coalesces HA assignments", async ({page}) => {
  await setup(page);
  await resolve(page,0);
  await expect(page.locator(".flight-card__aircraft-marker")).toHaveCount(1);
  await page.evaluate(() => { const w=window as any; for(let i=0;i<20;i++)w.card.hass={...w.hass}; });
  expect(await page.evaluate(()=>(window as any).requests.length)).toBe(1);
  await page.evaluate(() => { const w=window as any; w.hass.states['sensor.a']=w.makeState('a','2026-10-08T14:00:01Z');w.card.hass={...w.hass}; });
  await expect.poll(()=>page.evaluate(()=>(window as any).requests.length)).toBe(2);
  await resolve(page,1,"a","2026-10-08T14:00:01Z",1.2);
  await expect.poll(()=>page.evaluate(()=>(window as any).card._latestGeoJson.features[0]?.geometry.coordinates[0])).toBe(1.2);
  await expect(page.locator(".flight-card__count")).toHaveText("Aircraft: 1");
});

test("switching entities ignores a late old response; detach cleans listeners and reattach reloads", async ({page}) => {
  await setup(page);
  await page.evaluate(()=>{const w=window as any; w.card.setConfig({entity:'sensor.b',fit_bounds:false});});
  await expect.poll(()=>page.evaluate(()=>(window as any).requests.length)).toBe(2);
  await resolve(page,1,"b","2026-10-08T14:00:00Z",3);
  await resolve(page,0,"a","2026-10-08T14:00:00Z",7);
  await expect.poll(()=>page.evaluate(()=>(window as any).card._latestGeoJson.features[0]?.geometry.coordinates[0])).toBe(3);
  await page.evaluate(()=>(window as any).card.remove());
  expect(await page.evaluate(()=>(window as any).listeners.ready.size)).toBe(0);
  await page.evaluate(()=>document.body.append((window as any).card));
  await expect.poll(()=>page.evaluate(()=>(window as any).requests.length)).toBe(3);
  await resolve(page,2,"b");
  await expect(page.locator(".flight-card__aircraft-marker")).toHaveCount(1);
  expect(await page.evaluate(()=>(window as any).listeners.ready.size)).toBe(1);
});

test("disconnect clears stale data and reconnect loads without a state change", async ({page}) => {
  await setup(page); await resolve(page,0);
  await expect(page.locator(".flight-card__aircraft-marker")).toHaveCount(1);
  await page.evaluate(()=>{const w=window as any;w.connection.connected=false;w.listeners.disconnected.forEach((f:any)=>f());});
  await expect(page.locator(".flight-card__aircraft-marker")).toHaveCount(0);
  await page.evaluate(()=>{const w=window as any;w.connection.connected=true;w.listeners.ready.forEach((f:any)=>f());});
  await expect.poll(()=>page.evaluate(()=>(window as any).requests.length)).toBe(2);
  await resolve(page,1,"a","2026-10-08T14:00:00Z",0,0);
  await expect(page.locator(".flight-card__count")).toHaveText("Aircraft: 0");
});

test("in-flight older snapshot cannot consume a newer state; timeout retires late responses", async ({page}) => {
  await page.clock.install(); await setup(page);
  await page.evaluate(()=>{const w=window as any;w.hass.states['sensor.a']=w.makeState('a','2026-10-08T14:00:02Z');w.card.hass={...w.hass};});
  await resolve(page,0);
  await expect(page.locator(".flight-card__count")).toHaveText("Aircraft: \u2014");
  await page.clock.runFor(1100);
  await expect.poll(()=>page.evaluate(()=>(window as any).requests.length)).toBe(2);
  await page.clock.runFor(17100);
  await expect.poll(()=>page.evaluate(()=>(window as any).requests.length)).toBe(3);
  await resolve(page,2,"a","2026-10-08T14:00:02Z",8);
  await resolve(page,1,"a","2026-10-08T14:00:02Z",9);
  await expect.poll(()=>page.evaluate(()=>(window as any).card._latestGeoJson.features[0]?.geometry.coordinates[0])).toBe(8);
});

test("permission failures do not spin; legacy inline data takes precedence over inherited entry IDs", async ({page}) => {
  await page.clock.install(); await setup(page);
  await page.evaluate(()=>(window as any).requests[0].reject({code:'unauthorized'}));
  await expect(page.locator("flight-card")).toContainText("Aircraft access denied");
  await page.clock.runFor(60000);
  expect(await page.evaluate(()=>(window as any).requests.length)).toBe(1);
  await page.evaluate(()=>{const w=window as any;w.hass.states['sensor.a'].attributes.geojson={type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'Point',coordinates:[2,51]},properties:{hex:'abcdef'}}]};w.card.hass={...w.hass};});
  await expect(page.locator(".flight-card__aircraft-marker")).toHaveCount(1);
  await page.evaluate(()=>{const w=window as any;w.hass.states['sensor.a'].attributes.geojson.features[0].geometry.coordinates[0]=4;w.card.hass={...w.hass};});
  await expect.poll(()=>page.evaluate(()=>(window as any).card._latestGeoJson.features[0]?.geometry.coordinates[0])).toBe(4);
  expect(await page.evaluate(()=>(window as any).requests.length)).toBe(1);
});

test("two cards bind independently and unavailable sources clear their own data", async ({page}) => {
  await setup(page);
  await page.evaluate(()=>{const w=window as any;w.second=document.createElement('flight-card');w.second.setConfig({entity:'sensor.b'});w.second.hass=w.hass;document.body.append(w.second);});
  await expect.poll(()=>page.evaluate(()=>(window as any).requests.length)).toBe(2);
  expect(await page.evaluate(()=>(window as any).requests.map((r:any)=>r.message.config_entry_id))).toEqual(['a','b']);
  await resolve(page,0); await resolve(page,1,'b');
  await expect(page.locator('.flight-card__aircraft-marker')).toHaveCount(2);
  await page.evaluate(()=>{const w=window as any;w.hass.states['sensor.a'].state='unavailable';w.card.hass={...w.hass};});
  await expect(page.locator('.flight-card__aircraft-marker')).toHaveCount(1);
  await expect(page.locator('flight-card').first()).toContainText('Entity unavailable');
  await page.evaluate(()=>{const w=window as any;w.hass.states['sensor.a'].state='1';w.card.hass={...w.hass};});
  await expect.poll(()=>page.evaluate(()=>(window as any).requests.length)).toBe(3);
  await resolve(page,2);
  await expect(page.locator('.flight-card__aircraft-marker')).toHaveCount(2);
});

test("ambiguous automatic selection and a missing explicit entity never choose another receiver", async ({page}) => {
  await setup(page);
  await page.evaluate(()=>{const w=window as any;w.card.setConfig({entity:''});});
  await expect(page.locator('flight-card')).toContainText('required for multiple sources');
  await resolve(page,0);
  await expect(page.locator('.flight-card__aircraft-marker')).toHaveCount(0);
  await page.evaluate(()=>{const w=window as any;w.card.setConfig({entity:'sensor.missing'});});
  await expect(page.locator('flight-card')).toContainText('Entity not found: sensor.missing');
  expect(await page.evaluate(()=>(window as any).requests.length)).toBe(1);
});

test("malformed response retries; hidden detach and reattach cannot initialize a retired map", async ({page}) => {
  await page.clock.install(); await setup(page);
  await page.evaluate(()=>{const w=window as any;w.requests[0].resolve({config_entry_id:'wrong'});});
  await expect(page.locator('flight-card')).toContainText('Invalid SkyVista snapshot');
  await page.clock.runFor(1100);
  await expect.poll(()=>page.evaluate(()=>(window as any).requests.length)).toBe(2);
  await page.evaluate(()=>{const w=window as any;w.card.remove();w.card.style.display='none';document.body.append(w.card);w.card.remove();w.card.style.display='';document.body.append(w.card);});
  await expect.poll(()=>page.evaluate(()=>(window as any).requests.length)).toBe(3);
  await resolve(page,2);
  await resolve(page,1,'a','2026-10-08T14:00:00Z',20);
  await expect(page.locator('.leaflet-container')).toHaveCount(1);
  await expect(page.locator('.flight-card__aircraft-marker')).toHaveCount(1);
  await expect.poll(()=>page.evaluate(()=>(window as any).card._latestGeoJson.features[0]?.geometry.coordinates[0])).toBe(-0.1);
});

test('freshness stays Live during requests, expires after 30 seconds and uses source age', async ({page})=>{
  await page.clock.install({time:new Date('2026-10-08T13:59:00Z')});
  await page.clock.pauseAt(new Date('2026-10-08T14:00:00Z'));
  await setup(page); await resolve(page,0);
  await expect(page.locator('.flight-card__status')).toHaveText('Live');
  await page.evaluate(()=>{const w=window as any;w.statusChanges=[];new MutationObserver(records=>w.statusChanges.push(...records.map(r=>r.type))).observe(w.card.shadowRoot.querySelector('.flight-card__status'),{attributes:true,childList:true,characterData:true,subtree:true});});
  await page.clock.runFor(2000);
  await page.evaluate(()=>{const w=window as any;w.hass.states['sensor.a']=w.makeState('a','2026-10-08T14:00:02Z');w.card.hass={...w.hass};});
  await expect.poll(()=>page.evaluate(()=>(window as any).requests.length)).toBe(2);
  await expect(page.locator('.flight-card__status')).toHaveText('Live');
  await resolve(page,1,'a','2026-10-08T14:00:02Z');
  await expect(page.locator('.flight-card__status')).toHaveText('Live');
  expect(await page.evaluate(()=>(window as any).statusChanges)).toEqual([]);
  await page.clock.runFor(30000);
  await expect(page.locator('.flight-card__status')).toHaveText('Live');
  await page.clock.runFor(1);
  await expect(page.locator('.flight-card__status')).toHaveText('Stale (>30 s)');
  // A reconnect returning exactly the same old cache must not refresh its age.
  await page.evaluate(()=>(window as any).listeners.ready.forEach((f:any)=>f()));
  await expect.poll(()=>page.evaluate(()=>(window as any).requests.length)).toBe(3);
  await resolve(page,2,'a','2026-10-08T14:00:02Z');
  await expect(page.locator('.flight-card__status')).toHaveText('Stale (>30 s)');
  await page.evaluate(()=>{const w=window as any;w.hass.states['sensor.a']=w.makeState('a',new Date().toISOString());w.card.hass={...w.hass};});
  await expect.poll(()=>page.evaluate(()=>(window as any).requests.length)).toBe(4);
  await resolve(page,3,'a','2026-10-08T14:00:32.001Z',0,0);
  await expect(page.locator('.flight-card__status')).toHaveText('Live');
  await expect(page.locator('.flight-card__count')).toHaveText('Aircraft: 0');
});

test('transient refresh failures preserve the last snapshot until it ages, but denial clears it', async ({page})=>{
  await page.clock.install({time:new Date('2026-10-08T13:59:00Z')});
  await page.clock.pauseAt(new Date('2026-10-08T14:00:00Z'));
  await setup(page); await resolve(page,0);
  await page.clock.runFor(2000);
  await page.evaluate(()=>{const w=window as any;w.hass.states['sensor.a']=w.makeState('a','2026-10-08T14:00:02Z');w.card.hass={...w.hass};});
  await expect.poll(()=>page.evaluate(()=>(window as any).requests.length)).toBe(2);
  await page.evaluate(()=>(window as any).requests[1].reject(new Error('temporary transport failure')));
  await expect(page.locator('.flight-card__status')).toHaveText('Live');
  await expect(page.locator('.flight-card__aircraft-marker')).toHaveCount(1);
  await page.clock.runFor(28001);
  await expect(page.locator('.flight-card__status')).toHaveText('Stale (>30 s)');
  await expect(page.locator('.flight-card__aircraft-marker')).toHaveCount(1);
  await page.evaluate(()=>{const w=window as any;w.requests.at(-1).reject({code:'unauthorized'});});
  await expect(page.locator('.flight-card__status')).toHaveText('Aircraft access denied');
  await expect(page.locator('.flight-card__aircraft-marker')).toHaveCount(0);
});
