import {readFile} from 'node:fs/promises';
import {test,expect} from '@playwright/test';

const bundle=await readFile('custom_components/flight_card/flight-card.js','utf8');
const polyfill=await readFile('node_modules/@webcomponents/scoped-custom-element-registry/scoped-custom-element-registry.min.js','utf8');

for (const bootstrapFirst of [false,true]) {
test(`card loaded ${bootstrapFirst?'after':'before'} HA scoped-registry bootstrap remains registered and constructible`,async({page})=>{
  await page.route('**/*',route=>route.fulfill({body:'',contentType:'text/plain'}));
  await page.setContent('<home-assistant></home-assistant>');
  if (bootstrapFirst) {
    await page.addScriptTag({content:polyfill});
    await page.evaluate(()=>customElements.define('home-assistant',class extends HTMLElement {}));
  }
  // Start import without waiting: the corrected card may wait for HA bootstrap.
  await page.evaluate(code=>{
    const blob=new Blob(['window.moduleStarted=true;\n'+code],{type:'text/javascript'});
    const url=URL.createObjectURL(blob);
    (window as any).cardImport=import(url).finally(()=>URL.revokeObjectURL(url));
  },bundle);
  // The old synchronous module completes in that turn; the fixed one awaits HA.
  await expect.poll(()=>page.evaluate(()=>(window as any).moduleStarted)).toBe(true);
  if (!bootstrapFirst) {
    await page.addScriptTag({content:polyfill});
    // Model HA's placeholder recovery waiting on the replacement registry.
    await page.evaluate(()=>{
      (window as any).recovery=customElements.whenDefined('flight-card');
      customElements.define('home-assistant',class extends HTMLElement {});
    });
  }
  await page.evaluate(()=>(window as any).cardImport);
  if (!bootstrapFirst) await page.evaluate(()=>(window as any).recovery);
  expect(await page.evaluate(()=>Boolean(customElements.get('flight-card')))).toBe(true);
  expect(await page.evaluate(async code=>{
    const original=customElements.get('flight-card');
    const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
    try { await import(url); } finally { URL.revokeObjectURL(url); }
    return customElements.get('flight-card')===original &&
      (window as any).customCards.filter((card:any)=>card.type==='flight-card').length===1;
  },bundle)).toBe(true);
  const result=await page.evaluate(()=>{
    const card=document.createElement('flight-card') as any;
    card.setConfig({entity:'sensor.aircraft'});
    card.hass={states:{'sensor.aircraft':{entity_id:'sensor.aircraft',state:'0',attributes:{geojson:{type:'FeatureCollection',features:[]},updated:new Date().toISOString()}}}};
    document.body.append(card);
    return Boolean(card.shadowRoot?.querySelector('ha-card'));
  });
  expect(result).toBe(true);
  await expect(page.locator('.flight-card__count')).toHaveText('Aircraft: 0');
});
}
