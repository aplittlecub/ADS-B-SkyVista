import type { Feature, FeatureCollection, Point } from "geojson";
import leafletCss from "leaflet/dist/leaflet.css?inline";

const CARD_VERSION = "0.3.1";
const CARD_TYPE = "flight-card";
const ADSB_ICON_MODULES = import.meta.glob("./assets/adsb-icons/*.svg", {
  eager: true,
  import: "default",
}) as Record<string, string>;
const ADSB_ICON_URLS = Object.fromEntries(
  Object.entries(ADSB_ICON_MODULES)
    .map(([modulePath, url]) => {
      const match = modulePath.match(/\/([^/]+)\.svg$/i);
      return match ? [match[1].toLowerCase(), url] : null;
    })
    .filter((entry): entry is [string, string] => entry !== null)
);
const ADSB_DEFAULT_ICON_KEY = "a320";
const ALTITUDE_COLOR_STOPS: Array<{ altitudeFt: number; color: [number, number, number] }> = [
  { altitudeFt: 0, color: [198, 44, 22] },
  { altitudeFt: 500, color: [233, 79, 23] },
  { altitudeFt: 1000, color: [242, 121, 28] },
  { altitudeFt: 2000, color: [245, 164, 30] },
  { altitudeFt: 4000, color: [239, 204, 38] },
  { altitudeFt: 6000, color: [204, 220, 48] },
  { altitudeFt: 8000, color: [138, 221, 63] },
  { altitudeFt: 10000, color: [48, 216, 85] },
  { altitudeFt: 20000, color: [94, 212, 206] },
  { altitudeFt: 30000, color: [86, 140, 242] },
  { altitudeFt: 40000, color: [224, 82, 248] },
];

interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_updated?: string;
}

interface HomeAssistant {
  states?: Record<string, HassEntity>;
  config?: {
    latitude?: number;
    longitude?: number;
  };
}

interface FlightCardConfig {
  title: string;
  entity: string;
  map_height: number;
  default_zoom: number;
  fit_bounds: boolean;
  center_lat: number | null;
  center_lon: number | null;
  tile_url: string;
  attribution: string;
}

interface FlightFeatureProperties {
  hex: string;
  flight: string;
  category: string;
  aircraft_type: string;
  registration: string;
  manufacturer: string;
  icao_type_code: string;
  operator_flag_code: string;
  registered_owners: string;
  airframe_image_url: string;
  altitude_ft: number | null;
  speed_kt: number | null;
  track_deg: number | null;
  seen_s: number | null;
}

interface CustomCardRegistration {
  type: string;
  name: string;
  description: string;
  preview?: boolean;
  documentationURL?: string;
}

type FlightFeature = Feature<Point, FlightFeatureProperties>;
type FlightCollection = FeatureCollection<Point, FlightFeatureProperties>;
type LeafletModule = typeof import("leaflet");

const DEFAULT_CONFIG: FlightCardConfig = {
  title: "ADS-B Nearby Aircraft",
  entity: "",
  map_height: 420,
  default_zoom: 8,
  fit_bounds: true,
  center_lat: null,
  center_lon: null,
  tile_url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: "&copy; <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap contributors</a>",
};

const EMPTY_COLLECTION: FlightCollection = {
  type: "FeatureCollection",
  features: [],
};

class FlightCard extends HTMLElement {
  private _hass?: HomeAssistant;
  private _config: FlightCardConfig = { ...DEFAULT_CONFIG };

  private _map?: import("leaflet").Map;
  private _leaflet?: LeafletModule;
  private _aircraftLayer?: import("leaflet").GeoJSON;
  private _mapInitPromise?: Promise<void>;
  private _mapResizeObserver?: ResizeObserver;
  private _resizeFixTimeouts: number[] = [];

  private _hasAutofit = false;
  private _root?: ShadowRoot;
  private _latestGeoJson: FlightCollection = EMPTY_COLLECTION;
  private _lastRenderedFingerprint = "";
  private _resolvedEntityId = "";

  private _els: {
    card?: HTMLElement;
    title?: HTMLElement;
    status?: HTMLElement;
    count?: HTMLElement;
    updated?: HTMLElement;
    map?: HTMLElement;
  } = {};

  static getStubConfig(): Partial<FlightCardConfig> {
    return {
      title: DEFAULT_CONFIG.title,
    };
  }

  static getConfigForm(): Record<string, unknown> {
    return {
      schema: [
        { name: "title", selector: { text: {} } },
        { name: "entity", selector: { entity: { domain: "sensor" } } },
        {
          type: "grid",
          name: "",
          flatten: true,
          schema: [
            { name: "default_zoom", selector: { number: { min: 1, max: 18, mode: "box" } } },
            { name: "map_height", selector: { number: { min: 200, max: 1200, mode: "box" } } },
          ],
        },
        { name: "fit_bounds", selector: { boolean: {} } },
        {
          type: "expandable",
          name: "advanced",
          title: "Advanced",
          flatten: false,
          schema: [
            { name: "center_lat", selector: { number: { min: -90, max: 90, step: 0.000001, mode: "box" } } },
            { name: "center_lon", selector: { number: { min: -180, max: 180, step: 0.000001, mode: "box" } } },
            { name: "tile_url", selector: { text: {} } },
            { name: "attribution", selector: { text: {} } },
          ],
        },
      ],
      computeLabel(schema: { name?: string }) {
        if (schema.name === "entity") return "Aircraft entity";
        if (schema.name === "default_zoom") return "Default zoom";
        if (schema.name === "map_height") return "Map height (px)";
        if (schema.name === "fit_bounds") return "Auto-fit map to aircraft";
        if (schema.name === "center_lat") return "Center latitude";
        if (schema.name === "center_lon") return "Center longitude";
        if (schema.name === "tile_url") return "Tile URL";
        if (schema.name === "attribution") return "Tile attribution";
        return undefined;
      },
    };
  }

  set hass(hass: HomeAssistant) {
    this._hass = hass;

    if (this._map && !this._hasConfiguredCenter() && this._latestGeoJson.features.length === 0) {
      const center = this._resolveInitialCenter();
      this._map.setView(center, this._config.default_zoom, { animate: false });
    }

    this._syncFromHass();
  }

  get hass(): HomeAssistant | undefined {
    return this._hass;
  }

  setConfig(config: Partial<FlightCardConfig> & Record<string, unknown>): void {
    this._config = normalizeConfig(config);
    this._hasAutofit = false;

    this._render();
    this._applyVisualConfig();

    if (this._map) {
      const center = this._resolveInitialCenter();
      this._map.setView(center, this._config.default_zoom, { animate: false });
      this._scheduleResizeFixes();
    }

    if (this.isConnected) {
      void this._ensureMap();
      this._syncFromHass();
    }
  }

  connectedCallback(): void {
    this._render();
    this._applyVisualConfig();
    void this._ensureMap();
    this._syncFromHass();
  }

  disconnectedCallback(): void {
    if (this._map) {
      this._map.remove();
      this._map = undefined;
      this._aircraftLayer = undefined;
    }

    if (this._mapResizeObserver) {
      this._mapResizeObserver.disconnect();
      this._mapResizeObserver = undefined;
    }

    this._resizeFixTimeouts.forEach((id) => window.clearTimeout(id));
    this._resizeFixTimeouts = [];
    this._mapInitPromise = undefined;
  }

  getCardSize(): number {
    const rows = Math.ceil((this._config.map_height + 110) / 50);
    return Math.max(4, rows);
  }

  getGridOptions(): Record<string, number> {
    const rows = Math.ceil((this._config.map_height + 70) / 56);
    return {
      columns: 12,
      rows: Math.max(4, rows),
      min_rows: 4,
    };
  }

  private _render(): void {
    if (!this._root) {
      this._root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    }
    if (this._els.card) {
      return;
    }

    this._root.innerHTML = `
      <style>
        ${leafletCss}

        :host {
          display: block;
        }

        .flight-card {
          display: block;
        }

        .flight-card__header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 8px;
        }

        .flight-card__title {
          font-size: 1.1rem;
          font-weight: 600;
          color: var(--primary-text-color);
          margin: 0;
        }

        .flight-card__meta {
          display: flex;
          flex-wrap: wrap;
          gap: 8px 16px;
          margin-bottom: 12px;
          font-size: 0.875rem;
          color: var(--secondary-text-color);
        }

        .flight-card__status {
          font-size: 0.75rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          border-radius: 999px;
          padding: 4px 10px;
          line-height: 1;
        }

        .flight-card__status--idle {
          color: var(--secondary-text-color);
          background: var(--secondary-background-color);
        }

        .flight-card__status--ok {
          color: #14632f;
          background: #d8f7e2;
        }

        .flight-card__status--error {
          color: #7a2020;
          background: #ffe2e2;
        }

        .flight-card__map {
          position: relative;
          width: 100%;
          border-radius: 12px;
          overflow: hidden;
          border: 1px solid var(--divider-color);
          background: var(--secondary-background-color);
        }

        .flight-card__map .leaflet-container {
          width: 100%;
          height: 100%;
        }

        .flight-card__map .leaflet-tile,
        .flight-card__map .leaflet-marker-icon,
        .flight-card__map .leaflet-marker-shadow,
        .flight-card__map .leaflet-container img {
          max-width: none !important;
          max-height: none !important;
        }

        .flight-card__map .flight-card__aircraft-marker {
          background: transparent;
          border: 0;
        }

        .flight-card__aircraft-icon {
          width: 24px;
          height: 24px;
          display: block;
          transform: rotate(var(--aircraft-rotation, 0deg));
          transform-origin: 50% 50%;
          filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.35));
        }

        .flight-card__aircraft-icon-mask {
          width: 100%;
          height: 100%;
          display: block;
          -webkit-mask-repeat: no-repeat;
          mask-repeat: no-repeat;
          -webkit-mask-size: contain;
          mask-size: contain;
          -webkit-mask-position: center;
          mask-position: center;
          pointer-events: none;
        }

        .flight-card__aircraft-fallback {
          width: 12px;
          height: 12px;
          border-radius: 50%;
          display: block;
          background: var(--aircraft-color, #ef4444);
          border: 2px solid rgba(15, 23, 42, 0.65);
        }

        .flight-card__popup {
          margin: 0;
          line-height: 1.35;
        }

        .flight-card__popup-image {
          margin-top: 6px;
          width: 160px;
          max-width: 100%;
          height: auto;
          border-radius: 6px;
          border: 1px solid #cbd5e1;
          background: #f8fafc;
        }
      </style>
      <ha-card>
        <div class="card-content flight-card">
          <div class="flight-card__header">
            <h2 class="flight-card__title"></h2>
            <span class="flight-card__status flight-card__status--idle">Idle</span>
          </div>
          <div class="flight-card__meta">
            <span class="flight-card__count">Aircraft: 0</span>
            <span class="flight-card__updated">Updated: never</span>
          </div>
          <div class="flight-card__map"></div>
        </div>
      </ha-card>
    `;

    this._els = {
      card: this._root.querySelector<HTMLElement>("ha-card") ?? undefined,
      title: this._root.querySelector<HTMLElement>(".flight-card__title") ?? undefined,
      status: this._root.querySelector<HTMLElement>(".flight-card__status") ?? undefined,
      count: this._root.querySelector<HTMLElement>(".flight-card__count") ?? undefined,
      updated: this._root.querySelector<HTMLElement>(".flight-card__updated") ?? undefined,
      map: this._root.querySelector<HTMLElement>(".flight-card__map") ?? undefined,
    };
  }

  private _applyVisualConfig(): void {
    if (!this._els.title || !this._els.map) {
      return;
    }

    this._els.title.textContent = this._config.title;
    this._els.map.style.height = `${this._config.map_height}px`;
    this._invalidateMapSize(false);
  }

  private async _ensureMap(): Promise<void> {
    if (this._map || !this._els.map) {
      return;
    }

    if (this._mapInitPromise) {
      return this._mapInitPromise;
    }

    this._mapInitPromise = (async () => {
      try {
        this._setStatus("idle", "Loading map");
        this._leaflet = await loadLeaflet();
        await this._waitForMapContainerReady();

        const L = this._leaflet;
        const center = this._resolveInitialCenter();

        this._map = L.map(this._els.map as HTMLElement, {
          zoomControl: true,
          scrollWheelZoom: true,
          zoomAnimation: false,
          fadeAnimation: false,
          markerZoomAnimation: false,
        });

        L.tileLayer(this._config.tile_url, {
          attribution: this._config.attribution,
          maxZoom: 19,
          updateWhenIdle: true,
          keepBuffer: 4,
        }).addTo(this._map);

        this._map.setView(center, this._config.default_zoom);
        this._aircraftLayer = L.geoJSON([], {
          pointToLayer: (feature, latlng) => {
            const props = feature?.properties as FlightFeatureProperties | undefined;
            return L.marker(latlng, {
              icon: L.divIcon({
                className: "flight-card__aircraft-marker",
                html: aircraftIconHtml(props),
                iconSize: [24, 24],
                iconAnchor: [12, 12],
                popupAnchor: [0, -10],
              }),
              keyboard: false,
            });
          },
          onEachFeature: (feature, layer) => {
            layer.bindPopup(this._popupHtml(feature.properties as FlightFeatureProperties));
          },
        });

        this._aircraftLayer.addTo(this._map);
        this._startResizeObserver();
        this._map.whenReady(() => this._scheduleResizeFixes());

        this._renderGeoJson(this._latestGeoJson);
        this._syncFromHass();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown map error";
        this._setStatus("error", `Map error: ${message}`);
      } finally {
        this._mapInitPromise = undefined;
      }
    })();

    return this._mapInitPromise;
  }

  private _syncFromHass(): void {
    if (!this._hass) {
      return;
    }

    const entityId = resolveConfiguredOrAutoEntity(this._hass, this._config.entity);
    this._resolvedEntityId = entityId;
    const entity = entityId ? this._hass.states?.[entityId] : undefined;
    if (!entity) {
      if (this._els.count) {
        this._els.count.textContent = "Aircraft: 0";
      }
      if (this._els.updated) {
        this._els.updated.textContent = "Updated: never";
      }
      const configured = this._config.entity.trim();
      this._setStatus(
        configured ? "error" : "idle",
        configured ? `Entity not found: ${configured}` : "Select Aircraft entity"
      );
      this._latestGeoJson = EMPTY_COLLECTION;
      this._renderGeoJson(this._latestGeoJson);
      return;
    }

    const rawGeoJson = entity.attributes?.geojson;
    const hasGeoJson =
      isObjectRecord(rawGeoJson) &&
      rawGeoJson.type === "FeatureCollection" &&
      Array.isArray(rawGeoJson.features);
    const geoJson = normalizeGeoJson(rawGeoJson);
    const updated = formatUpdated(entity.attributes?.updated ?? entity.last_updated);

    const fingerprint = `${entity.state}|${String(entity.attributes?.updated ?? "")}|${geoJson.features.length}`;
    if (fingerprint !== this._lastRenderedFingerprint) {
      this._lastRenderedFingerprint = fingerprint;
      this._latestGeoJson = geoJson;
      this._renderGeoJson(geoJson);
    }

    if (this._els.count) {
      const countFromState = Number(entity.state);
      const displayCount = Number.isFinite(countFromState) ? countFromState : geoJson.features.length;
      this._els.count.textContent = `Aircraft: ${Math.max(0, Math.round(displayCount))}`;
    }

    if (this._els.updated) {
      this._els.updated.textContent = `Updated: ${updated}`;
    }

    if (entity.state === "unavailable") {
      this._setStatus("error", "Entity unavailable");
      return;
    }
    if (entity.state === "unknown" || !hasGeoJson) {
      this._setStatus("idle", `Waiting for backend data (${entity.entity_id})`);
      return;
    }

    this._setStatus("ok", "Live");
  }

  private _renderGeoJson(geoJson: FlightCollection): void {
    if (!this._aircraftLayer || !this._map) {
      return;
    }

    this._aircraftLayer.clearLayers();
    this._aircraftLayer.addData(geoJson as unknown as GeoJSON.FeatureCollection);

    if (geoJson.features.length === 0) {
      this._hasAutofit = false;
      return;
    }

    if (this._config.fit_bounds) {
      const bounds = this._aircraftLayer.getBounds();
      if (bounds.isValid() && !this._hasAutofit) {
        this._map.fitBounds(bounds, {
          padding: [24, 24],
          maxZoom: this._config.default_zoom + 3,
        });
        this._hasAutofit = true;
      }
    }
  }

  private _setStatus(type: "idle" | "ok" | "error", text: string): void {
    if (!this._els.status) {
      return;
    }

    this._els.status.className = `flight-card__status flight-card__status--${type}`;
    this._els.status.textContent = text;
  }

  private _resolveInitialCenter(): [number, number] {
    if (this._hasConfiguredCenter()) {
      return [this._config.center_lat as number, this._config.center_lon as number];
    }

    const homeZone = this._hass?.states?.["zone.home"];
    const zoneLat = Number(homeZone?.attributes?.latitude);
    const zoneLon = Number(homeZone?.attributes?.longitude);
    if (Number.isFinite(zoneLat) && Number.isFinite(zoneLon)) {
      return [zoneLat, zoneLon];
    }

    if (
      this._hass?.config &&
      Number.isFinite(this._hass.config.latitude) &&
      Number.isFinite(this._hass.config.longitude)
    ) {
      return [this._hass.config.latitude as number, this._hass.config.longitude as number];
    }

    const firstFeature = this._latestGeoJson.features[0];
    const firstLon = Number(firstFeature?.geometry?.coordinates?.[0]);
    const firstLat = Number(firstFeature?.geometry?.coordinates?.[1]);
    if (Number.isFinite(firstLat) && Number.isFinite(firstLon)) {
      return [firstLat, firstLon];
    }

    return [0, 0];
  }

  private _hasConfiguredCenter(): boolean {
    return Number.isFinite(this._config.center_lat) && Number.isFinite(this._config.center_lon);
  }

  private _popupHtml(props: FlightFeatureProperties): string {
    const lines: string[] = [];
    const title = firstNonEmptyString([props.flight, props.registration, props.aircraft_type, "Aircraft"]);

    lines.push(`<strong>${escapeHtml(title)}</strong>`);
    if (props.aircraft_type) {
      lines.push(`Type: ${escapeHtml(props.aircraft_type)}`);
    }
    if (props.registration) {
      lines.push(`Registration: ${escapeHtml(props.registration)}`);
    }
    if (props.manufacturer) {
      lines.push(`Manufacturer: ${escapeHtml(props.manufacturer)}`);
    }
    if (props.registered_owners) {
      lines.push(`Owner: ${escapeHtml(props.registered_owners)}`);
    }

    if (Number.isFinite(props.altitude_ft)) {
      lines.push(`Altitude: ${Math.round(props.altitude_ft as number).toLocaleString()} ft`);
    }

    if (Number.isFinite(props.speed_kt)) {
      lines.push(`Speed: ${Math.round(props.speed_kt as number)} kt`);
    }

    if (Number.isFinite(props.track_deg)) {
      lines.push(`Track: ${Math.round(props.track_deg as number)}°`);
    }

    if (Number.isFinite(props.seen_s)) {
      lines.push(`Seen: ${(props.seen_s as number).toFixed(1)} s ago`);
    }

    const imageHtml = props.airframe_image_url
      ? `<img class="flight-card__popup-image" src="${escapeHtml(props.airframe_image_url)}" alt="Airframe image" loading="lazy" referrerpolicy="no-referrer" />`
      : "";

    return `<p class="flight-card__popup">${lines.join("<br>")}${imageHtml ? `<br>${imageHtml}` : ""}</p>`;
  }

  private _startResizeObserver(): void {
    if (this._mapResizeObserver || !this._els.map || !this._map) {
      return;
    }

    this._mapResizeObserver = new ResizeObserver(() => {
      this._invalidateMapSize(false);
    });
    this._mapResizeObserver.observe(this._els.map);
  }

  private _scheduleResizeFixes(): void {
    this._resizeFixTimeouts.forEach((id) => window.clearTimeout(id));
    this._resizeFixTimeouts = [];

    [0, 150, 600, 1200, 2500].forEach((delayMs) => {
      const id = window.setTimeout(() => this._invalidateMapSize(false), delayMs);
      this._resizeFixTimeouts.push(id);
    });
  }

  private _invalidateMapSize(pan: boolean): void {
    if (!this._map) {
      return;
    }

    requestAnimationFrame(() => {
      if (!this._map) {
        return;
      }
      this._map.invalidateSize({ pan });
    });
  }

  private async _waitForMapContainerReady(): Promise<void> {
    const mapEl = this._els.map;
    if (!mapEl) {
      return;
    }

    const hasUsableSize = () => mapEl.clientWidth >= 280 && mapEl.clientHeight >= 200;
    if (hasUsableSize()) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeoutId = window.setTimeout(() => {
        observer.disconnect();
        resolve();
      }, 5000);
      this._resizeFixTimeouts.push(timeoutId);

      const observer = new ResizeObserver(() => {
        if (!hasUsableSize()) {
          return;
        }
        observer.disconnect();
        window.clearTimeout(timeoutId);
        resolve();
      });

      observer.observe(mapEl);
    });
  }
}

function normalizeConfig(config: Partial<FlightCardConfig> & Record<string, unknown>): FlightCardConfig {
  if (!config || typeof config !== "object") {
    throw new Error("Invalid configuration");
  }

  const merged: FlightCardConfig = {
    ...DEFAULT_CONFIG,
    ...(config as Partial<FlightCardConfig>),
  };

  merged.title = String(merged.title || DEFAULT_CONFIG.title);
  merged.entity = String(merged.entity ?? "").trim();
  merged.map_height = clampNumber(merged.map_height, 200, 1200, DEFAULT_CONFIG.map_height);
  merged.default_zoom = clampNumber(merged.default_zoom, 1, 18, DEFAULT_CONFIG.default_zoom);
  merged.fit_bounds = merged.fit_bounds !== false;

  merged.center_lat = optionalNumber(merged.center_lat);
  merged.center_lon = optionalNumber(merged.center_lon);

  const advanced = (config as { advanced?: Record<string, unknown> }).advanced;
  if (advanced && typeof advanced === "object") {
    merged.center_lat = optionalNumber((advanced.center_lat as number | string | null | undefined) ?? merged.center_lat);
    merged.center_lon = optionalNumber((advanced.center_lon as number | string | null | undefined) ?? merged.center_lon);

    if (typeof advanced.tile_url === "string" && advanced.tile_url.length > 0) {
      merged.tile_url = advanced.tile_url;
    }

    if (typeof advanced.attribution === "string" && advanced.attribution.length > 0) {
      merged.attribution = advanced.attribution;
    }
  }

  merged.tile_url = String(merged.tile_url || DEFAULT_CONFIG.tile_url);
  merged.attribution = String(merged.attribution || DEFAULT_CONFIG.attribution);

  return merged;
}

function optionalNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, num));
}

function normalizeGeoJson(value: unknown): FlightCollection {
  if (!isObjectRecord(value) || value.type !== "FeatureCollection" || !Array.isArray(value.features)) {
    return EMPTY_COLLECTION;
  }

  const features: FlightFeature[] = [];
  for (const rawFeature of value.features) {
    const normalized = normalizeFeature(rawFeature);
    if (normalized) {
      features.push(normalized);
    }
  }

  return {
    type: "FeatureCollection",
    features,
  };
}

function resolveConfiguredOrAutoEntity(hass: HomeAssistant, configuredEntity: string): string {
  const states = hass.states ?? {};
  const trimmedConfigured = configuredEntity.trim();
  if (trimmedConfigured && states[trimmedConfigured]) {
    return trimmedConfigured;
  }

  const entries = Object.values(states);

  const byDomainTag = entries.find((entity) => {
    const source = entity.attributes?.source_domain;
    return typeof source === "string" && source === "flight_card";
  });
  if (byDomainTag) {
    return byDomainTag.entity_id;
  }

  const byGeoJsonShape = entries.find((entity) => {
    const attrs = entity.attributes;
    const geojson = attrs?.geojson;
    return (
      isObjectRecord(geojson) &&
      geojson.type === "FeatureCollection" &&
      Array.isArray(geojson.features) &&
      typeof attrs?.config_entry_id === "string"
    );
  });

  return byGeoJsonShape?.entity_id ?? "";
}

function normalizeFeature(value: unknown): FlightFeature | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  const geometry = value.geometry;
  if (!isObjectRecord(geometry) || geometry.type !== "Point" || !Array.isArray(geometry.coordinates)) {
    return null;
  }

  const lon = Number(geometry.coordinates[0]);
  const lat = Number(geometry.coordinates[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  const props = isObjectRecord(value.properties) ? value.properties : {};

  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [lon, lat],
    },
    properties: {
      hex: stringOrDefault(props.hex, "unknown"),
      flight: stringOrDefault(props.flight),
      category: stringOrDefault(props.category),
      aircraft_type: stringOrDefault(props.aircraft_type),
      registration: stringOrDefault(props.registration),
      manufacturer: stringOrDefault(props.manufacturer),
      icao_type_code: stringOrDefault(props.icao_type_code),
      operator_flag_code: stringOrDefault(props.operator_flag_code),
      registered_owners: stringOrDefault(props.registered_owners),
      airframe_image_url: stringOrDefault(props.airframe_image_url),
      altitude_ft: numberOrNull(props.altitude_ft),
      speed_kt: numberOrNull(props.speed_kt),
      track_deg: numberOrNull(props.track_deg),
      seen_s: numberOrNull(props.seen_s),
    },
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function stringOrDefault(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function formatUpdated(value: unknown): string {
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleTimeString();
    }
  }
  return "unknown";
}

function markerColor(altitudeFt: number | null | undefined): string {
  if (!Number.isFinite(altitudeFt)) {
    return "#64748b";
  }

  const altitude = Math.max(0, altitudeFt as number);
  const maxStop = ALTITUDE_COLOR_STOPS[ALTITUDE_COLOR_STOPS.length - 1];
  if (altitude >= maxStop.altitudeFt) {
    return rgbToHex(maxStop.color);
  }

  for (let index = 1; index < ALTITUDE_COLOR_STOPS.length; index += 1) {
    const lower = ALTITUDE_COLOR_STOPS[index - 1];
    const upper = ALTITUDE_COLOR_STOPS[index];
    if (altitude > upper.altitudeFt) {
      continue;
    }

    const range = upper.altitudeFt - lower.altitudeFt;
    const t = range > 0 ? (altitude - lower.altitudeFt) / range : 0;
    return rgbToHex([
      lerp(lower.color[0], upper.color[0], t),
      lerp(lower.color[1], upper.color[1], t),
      lerp(lower.color[2], upper.color[2], t),
    ]);
  }

  return rgbToHex(maxStop.color);
}

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

function rgbToHex(rgb: [number, number, number]): string {
  const byteToHex = (value: number) => {
    const clamped = Math.max(0, Math.min(255, Math.round(value)));
    return clamped.toString(16).padStart(2, "0");
  };
  return `#${byteToHex(rgb[0])}${byteToHex(rgb[1])}${byteToHex(rgb[2])}`;
}

function normalizeHeading(headingDeg: number | null | undefined): number {
  if (!Number.isFinite(headingDeg)) {
    return 0;
  }

  const heading = headingDeg as number;
  return ((heading % 360) + 360) % 360;
}

function aircraftIconHtml(props: FlightFeatureProperties | undefined): string {
  const rotation = normalizeHeading(props?.track_deg);
  const color = markerColor(props?.altitude_ft);
  const iconKey = resolveAircraftIconKey(props);
  const iconUrl = ADSB_ICON_URLS[iconKey] ?? ADSB_ICON_URLS[ADSB_DEFAULT_ICON_KEY];

  if (!iconUrl) {
    return `<span class="flight-card__aircraft-fallback" style="--aircraft-color: ${color};"></span>`;
  }

  const safeIconUrl = escapeHtml(iconUrl);
  const maskStyle = `background: ${color}; -webkit-mask-image: url(&quot;${safeIconUrl}&quot;); mask-image: url(&quot;${safeIconUrl}&quot;);`;

  return `
    <span class="flight-card__aircraft-icon" style="--aircraft-rotation: ${rotation}deg;">
      <span class="flight-card__aircraft-icon-mask" style="${maskStyle}"></span>
    </span>
  `;
}

function resolveAircraftIconKey(props: FlightFeatureProperties | undefined): string {
  if (!props) {
    return ADSB_DEFAULT_ICON_KEY;
  }

  const seen = new Set<string>();
  const candidates = [
    ...extractTypeTokens(props.icao_type_code),
    ...extractTypeTokens(props.aircraft_type),
    ...extractTypeTokens(props.category),
  ];

  for (const token of candidates) {
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);

    const icon = iconFromTypeToken(token);
    if (icon && ADSB_ICON_URLS[icon]) {
      return icon;
    }
  }

  const fallbackCategory = normalizeEmitterCategory(props.category);
  if (fallbackCategory && ADSB_ICON_URLS[fallbackCategory]) {
    return fallbackCategory;
  }

  return ADSB_DEFAULT_ICON_KEY;
}

function extractTypeTokens(value: string): string[] {
  if (!value) {
    return [];
  }

  const rawTokens = value
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const expanded: string[] = [];
  for (const token of rawTokens) {
    expanded.push(token);

    const compact = token.replace(/[^A-Z0-9]/g, "");
    if (compact && compact !== token) {
      expanded.push(compact);
    }

    if (compact.length >= 5) {
      expanded.push(compact.slice(0, 4));
    }
    if (compact.length >= 4) {
      expanded.push(compact.slice(0, 3));
    }

    const icaoMatch = compact.match(/^([A-Z]{1,3}\d{1,3}[A-Z]?)/);
    if (icaoMatch && icaoMatch[1] !== compact) {
      expanded.push(icaoMatch[1]);
    }
  }

  return expanded;
}

function normalizeEmitterCategory(value: string): string {
  const token = value.trim().toUpperCase();
  if (!/^[A-F]\d{1,2}$/.test(token)) {
    return "";
  }
  return `${token[0].toLowerCase()}${Number(token.slice(1))}`;
}

function iconFromTypeToken(token: string): string {
  const code = token.toUpperCase();
  if (!code) {
    return "";
  }

  const directCategory = normalizeEmitterCategory(code);
  if (directCategory && ADSB_ICON_URLS[directCategory]) {
    return directCategory;
  }

  if (matchesAny(code, ["A7", "F3", "F03", "EC35", "EC45", "H145"])) return "a7";
  if (matchesAny(code, ["B0", "B5", "B6", "B7", "F13"])) return "b0";
  if (matchesAny(code, ["B1", "F1", "F01", "ULM", "ULTRALIGHT"])) return "b1";
  if (matchesAny(code, ["B2", "F12"])) return "b2";
  if (matchesAny(code, ["B3", "F4", "F04"])) return "b3";
  if (matchesAny(code, ["B4", "F6", "F7", "F06", "F07"])) return "b4";
  if (matchesAny(code, ["C0", "C1", "C2", "C3"])) return "c0";
  if (matchesAny(code, ["F5", "F05"])) return "f5";
  if (matchesAny(code, ["F11"])) return "f11";
  if (matchesAny(code, ["F15"])) return "f15";

  if (code.startsWith("A32") || matchesAny(code, ["A318", "A319", "A320", "A321", "A20N", "A21N"])) return "a320";
  if (code.startsWith("A33") || matchesAny(code, ["A300", "A306", "A310", "A332", "A333", "A339"])) return "a330";
  if (code.startsWith("A34") || code.startsWith("A35") || matchesAny(code, ["A340", "A350", "A359", "A35K"])) return "a340";
  if (code.startsWith("A38") || matchesAny(code, ["A380", "A388"])) return "a380";

  if (
    code.startsWith("B73") ||
    code.startsWith("B38") ||
    code.startsWith("B39") ||
    matchesAny(code, ["B727", "B737", "B738", "B739", "B37M", "B38M", "B39M"])
  ) {
    return "b737";
  }
  if (code.startsWith("B74") || matchesAny(code, ["B741", "B742", "B743", "B744", "B748"])) return "b747";
  if (code.startsWith("B76") || matchesAny(code, ["B761", "B762", "B763", "B764", "B767"])) return "b767";
  if (code.startsWith("B77") || matchesAny(code, ["B772", "B773", "B77L", "B77W"])) return "b777";
  if (code.startsWith("B78") || matchesAny(code, ["B788", "B789", "B78X"])) return "b787";

  if (code.startsWith("C13") || code.startsWith("C30") || matchesAny(code, ["C130", "C135", "C17"])) return "c130";
  if (code.startsWith("CRJ") || matchesAny(code, ["CRJ1", "CRJ2", "CRJ7", "CRJ9", "CRJX"])) return "crjx";
  if (code.startsWith("DH8") || code.startsWith("AT7") || code.startsWith("AT4") || matchesAny(code, ["DHC8"])) return "dh8a";
  if (code.startsWith("E17") || code.startsWith("E19") || matchesAny(code, ["E170", "E175", "E190", "E195"])) return "e195";
  if (code.startsWith("E13") || code.startsWith("E14") || matchesAny(code, ["ERJ", "E135", "E145"])) return "erj";
  if (code.startsWith("F10") || code.startsWith("MD8") || matchesAny(code, ["F100", "MD80", "MD81", "MD82", "MD83", "MD87", "MD88"])) return "f100";
  if (code.startsWith("FA7") || code.startsWith("FA8") || matchesAny(code, ["E35L"])) return "fa7x";
  if (code.startsWith("GLF") || code.startsWith("G5") || code.startsWith("G6") || matchesAny(code, ["GLEX"])) return "glf5";
  if (code.startsWith("C25") || code.startsWith("LJ") || code.startsWith("LEAR")) return "learjet";
  if (code.startsWith("C15") || code.startsWith("C17") || code.startsWith("C18") || code.startsWith("C20")) return "cessna";
  if (code.startsWith("CESS")) return "cessna";
  if (code.startsWith("MD11") || matchesAny(code, ["MD11"])) return "md11";

  return "";
}

function matchesAny(value: string, expected: string[]): boolean {
  return expected.includes(value);
}

function firstNonEmptyString(values: Array<unknown>): string {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const cleaned = value.trim();
    if (cleaned.length > 0) {
      return cleaned;
    }
  }
  return "";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

let leafletPromise: Promise<LeafletModule> | undefined;

function loadLeaflet(): Promise<LeafletModule> {
  if (!leafletPromise) {
    leafletPromise = import("leaflet");
  }

  return leafletPromise;
}

function registerCustomCard(): void {
  window.customCards = window.customCards || [];
  if (!window.customCards.find((card) => card.type === CARD_TYPE)) {
    window.customCards.push({
      type: CARD_TYPE,
      name: "ADS-B Nearby Aircraft",
      description: "Display aircraft from the ADS-B Nearby Aircraft integration sensor on a live map.",
      documentationURL: "https://developers.home-assistant.io/docs/frontend/custom-ui/custom-card/",
    });
  }
}

if (!customElements.get(CARD_TYPE)) {
  customElements.define(CARD_TYPE, FlightCard);
}

registerCustomCard();

console.info(
  `%c ADS-B NEARBY AIRCRAFT %c ${CARD_VERSION} `,
  "color: white; background: #3b82f6; font-weight: 700;",
  "color: #3b82f6; background: white; font-weight: 700;"
);

declare global {
  interface Window {
    customCards?: CustomCardRegistration[];
  }
}
