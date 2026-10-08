import type { Feature, FeatureCollection, Point } from "geojson";
import leafletCss from "leaflet/dist/leaflet.css?inline";
import { GeoJsonClient, type SnapshotHass } from "./geojson-client";

// HA's extra modules can execute before its scoped-registry polyfill replaces
// customElements AND HTMLElement. Wait before evaluating the class declaration,
// not merely before define(), so it inherits from the final HTMLElement base.
// Standalone previews/tests without HA's root retain immediate registration.
if (document.querySelector("home-assistant") && !customElements.get("home-assistant")) {
  await customElements.whenDefined("home-assistant");
}

const CARD_VERSION = "1.0.3";
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

interface HomeAssistant extends SnapshotHass {
  themes?: { darkMode?: boolean };
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
interface AircraftMarker {
  marker: import("leaflet").Marker;
  content: HTMLDivElement;
  iconHtml: string;
  popupHtml: string;
  photo?: HTMLImageElement;
  failedPhoto?: string;
}

const DEFAULT_CONFIG: FlightCardConfig = {
  title: "ADS-B SkyVista",
  entity: "",
  map_height: 420,
  default_zoom: 8,
  fit_bounds: true,
  center_lat: null,
  center_lon: null,
  tile_url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
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
  private _aircraftLayer?: import("leaflet").FeatureGroup;
  private _aircraftMarkers = new Map<string, AircraftMarker>();
  private _anonymousMarkerId = 0;
  private _mapInitPromise?: Promise<void>;
  private _mapGeneration = 0;
  private _cancelMapWait?: () => void;
  private _mapResizeObserver?: ResizeObserver;
  private _resizeFixTimeouts: number[] = [];

  private _hasAutofit = false;
  private _root?: ShadowRoot;
  private _latestGeoJson: FlightCollection = EMPTY_COLLECTION;
  private _lastRenderedFingerprint = "";
  private _resolvedEntityId = "";
  private _sourceKey = "";
  private _snapshotAt?: number;
  private _freshnessTimer?: ReturnType<typeof setTimeout>;
  private _snapshotClient = new GeoJsonClient(
    (snapshot) => this._showSnapshot(normalizeGeoJson(snapshot.geojson), snapshot.aircraft_count, snapshot.updated),
    (state, message, keepSnapshot) => {
      if ((state === "loading" || keepSnapshot) && this._snapshotAt !== undefined) {
        this._updateFreshness();
        return;
      }
      if (state === "error") this._clearSnapshot();
      this._setStatus(state === "error" ? "error" : "idle", message);
    },
  );

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
    // HA supplies the active mode; inherited theme colours update open popups too.
    if (typeof hass.themes?.darkMode === "boolean") {
      this.dataset.popupTheme = hass.themes.darkMode ? "dark" : "light";
    } else {
      delete this.dataset.popupTheme;
    }

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
    try {
      this._configure(config);
    } catch (error) {
      // HA's card wrapper can replace this card without logging the exception.
      // Keep the original stack, but do not log user configuration or state.
      console.error("ADS-B SkyVista: card configuration failed", error);
      throw error;
    }
  }

  private _configure(config: Partial<FlightCardConfig> & Record<string, unknown>): void {
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
    this._snapshotClient.stop();
    clearTimeout(this._freshnessTimer);
    this._snapshotAt = undefined;
    this._sourceKey = "";
    this._aircraftMarkers.clear();
    this._mapGeneration++;
    this._cancelMapWait?.();
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
    this._hasAutofit = false;
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

        ha-card {
          position: relative;
        }

        .flight-card {
          display: block;
          position: relative;
          z-index: 0;
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
          z-index: 0;
          isolation: isolate;
          contain: layout paint;
          container-type: inline-size;
          width: 100%;
          border-radius: 12px;
          overflow: hidden;
          border: 1px solid var(--divider-color);
          background: var(--secondary-background-color);
        }

        .flight-card__map .leaflet-container {
          position: relative;
          z-index: 0;
          width: 100%;
          height: 100%;
        }

        .flight-card__map .leaflet-pane {
          z-index: 1;
        }

        .flight-card__map .leaflet-top,
        .flight-card__map .leaflet-bottom {
          z-index: 2;
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

        .flight-card__leaflet-popup {
          --popup-fallback-bg: #ffffff;
          --popup-fallback-text: #172b3a;
          --popup-fallback-muted: #526775;
          --popup-fallback-border: #dce5eb;
          --popup-bg: var(--ha-card-background, var(--card-background-color, var(--popup-fallback-bg)));
          --popup-text: var(--primary-text-color, var(--popup-fallback-text));
          --popup-muted: var(--secondary-text-color, var(--popup-fallback-muted));
          --popup-border: var(--divider-color, var(--popup-fallback-border));
          font-family: var(--ha-font-family-body, var(--paper-font-body1_-_font-family, system-ui, sans-serif));
        }

        :host([data-popup-theme="dark"]) .flight-card__leaflet-popup {
          --popup-fallback-bg: #102637;
          --popup-fallback-text: #f2f7fa;
          --popup-fallback-muted: #a6bac8;
          --popup-fallback-border: #365161;
        }

        @media (prefers-color-scheme: dark) {
          :host(:not([data-popup-theme])) .flight-card__leaflet-popup {
            --popup-fallback-bg: #102637;
            --popup-fallback-text: #f2f7fa;
            --popup-fallback-muted: #a6bac8;
            --popup-fallback-border: #365161;
          }
        }

        .flight-card__leaflet-popup .leaflet-popup-content-wrapper {
          padding: 0;
          border: 1px solid var(--popup-border);
          border-radius: 14px;
          color: var(--popup-text);
          background: var(--popup-bg);
          box-shadow: 0 8px 28px rgb(0 0 0 / 24%);
          overflow: hidden;
        }

        .flight-card__leaflet-popup .leaflet-popup-content {
          margin: 0;
          width: min(280px, calc(100vw - 72px)) !important;
          max-width: calc(100cqw - 32px);
          line-height: 1.35;
        }

        .flight-card__leaflet-popup .leaflet-popup-tip {
          background: var(--popup-bg);
          border: 1px solid var(--popup-border);
          box-shadow: none;
        }

        .flight-card__leaflet-popup .leaflet-popup-scrolled { border: 0; }

        .flight-card__leaflet-popup a.leaflet-popup-close-button {
          color: var(--popup-muted);
          width: 30px;
          height: 30px;
          line-height: 30px;
        }

        .flight-card__leaflet-popup a.leaflet-popup-close-button:hover,
        .flight-card__leaflet-popup a.leaflet-popup-close-button:focus-visible {
          color: var(--popup-text);
          background: var(--secondary-background-color, rgb(127 127 127 / 12%));
          border-radius: 0 14px 0 8px;
        }

        .flight-card__popup { overflow-wrap: anywhere; }
        .flight-card__popup-header { padding: 16px 32px 14px 18px; }
        .flight-card__popup-title { font-size: 23px; font-weight: 750; letter-spacing: .01em; }
        .flight-card__popup-type { color: var(--popup-muted); font-size: 13px; margin-top: 3px; }
        @container (max-width: 320px) {
          .flight-card__popup-header { padding-left: 32px; }
        }
        .flight-card__popup-readings, .flight-card__popup-details {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
          margin: 0;
          border-top: 1px solid var(--popup-border);
        }
        .flight-card__popup-reading { padding: 13px 18px; }
        .flight-card__popup-reading:nth-child(even) { border-left: 1px solid var(--popup-border); }
        .flight-card__popup-label {
          margin: 0 0 5px;
          color: var(--popup-muted);
          font-size: 10px;
          font-weight: 650;
          letter-spacing: .09em;
          text-transform: uppercase;
        }
        .flight-card__popup-value { margin: 0; font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
        .flight-card__popup-unit { font-size: 13px; font-weight: 500; white-space: nowrap; }
        .flight-card__popup-readings--secondary .flight-card__popup-value { font-size: 16px; font-weight: 600; }
        .flight-card__popup-details { gap: 12px 16px; padding: 14px 18px; }
        .flight-card__popup-detail--wide { grid-column: 1 / -1; }
        .flight-card__popup-details dd { margin: 0; font-size: 14px; font-weight: 600; }
        .flight-card__popup-photo { margin: 0; padding: 0 18px 16px; }
        .flight-card__map .flight-card__popup-image {
          display: block;
          width: 100%;
          max-width: 100% !important;
          height: auto;
          aspect-ratio: auto 16 / 9;
          max-height: 160px !important;
          object-fit: contain;
          border-radius: 8px;
          background: var(--secondary-background-color, rgb(127 127 127 / 12%));
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
    if (!this.isConnected || this._map || !this._els.map) {
      return;
    }

    if (this._mapInitPromise) {
      return this._mapInitPromise;
    }

    const generation = this._mapGeneration;
    this._mapInitPromise = (async () => {
      try {
        this._setStatus("idle", "Loading map");
        this._leaflet = await loadLeaflet();
        if (!this.isConnected || generation !== this._mapGeneration) return;
        await this._waitForMapContainerReady();
        if (!this.isConnected || generation !== this._mapGeneration) return;

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
          // OSM requires a Referer even when HA's page policy suppresses it.
          // Leave custom providers' referrer and CORS behavior unchanged.
          referrerPolicy: this._config.tile_url === DEFAULT_CONFIG.tile_url
            ? "strict-origin-when-cross-origin"
            : false,
        }).addTo(this._map);

        this._map.setView(center, this._config.default_zoom);
        this._aircraftLayer = L.featureGroup();

        this._aircraftLayer.addTo(this._map);
        this._startResizeObserver();
        this._map.whenReady(() => this._scheduleResizeFixes());

        this._renderGeoJson(this._latestGeoJson);
        this._syncFromHass();
      } catch (error) {
        if (!this.isConnected || generation !== this._mapGeneration) return;
        const message = error instanceof Error ? error.message : "Unknown map error";
        this._setStatus("error", `Map error: ${message}`);
      } finally {
        if (generation === this._mapGeneration) this._mapInitPromise = undefined;
      }
    })();

    return this._mapInitPromise;
  }

  private _syncFromHass(): void {
    if (!this._hass || !this.isConnected) {
      return;
    }

    const entityId = resolveConfiguredOrAutoEntity(this._hass, this._config.entity);
    this._resolvedEntityId = entityId;
    const entity = entityId ? this._hass.states?.[entityId] : undefined;
    const rawGeoJson = entity?.attributes?.geojson;
    const hasGeoJson = isObjectRecord(rawGeoJson) && rawGeoJson.type === "FeatureCollection" && Array.isArray(rawGeoJson.features);
    const entryId = typeof entity?.attributes?.config_entry_id === "string" ? entity.attributes.config_entry_id : "";
    // Prefer explicit inline data: combined/template entities may inherit a source entry ID.
    const sourceKey = `${entityId}|${hasGeoJson ? "inline" : entryId}`;
    if (sourceKey !== this._sourceKey) {
      this._snapshotClient.stop();
      this._sourceKey = sourceKey;
      this._lastRenderedFingerprint = "";
      this._clearSnapshot();
    }
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
        configured ? `Entity not found: ${configured}` : "Select Aircraft entity (required for multiple sources)"
      );
      this._latestGeoJson = EMPTY_COLLECTION;
      this._renderGeoJson(this._latestGeoJson);
      return;
    }

    if (entity.state === "unavailable" || entity.state === "unknown") {
      this._snapshotClient.stop();
      this._lastRenderedFingerprint = "";
      this._clearSnapshot();
      this._setStatus("error", "Entity unavailable");
      return;
    }
    if (!hasGeoJson) {
      if (entryId) {
        this._snapshotClient.update(this._hass, entityId, entryId, String(entity.attributes.updated ?? entity.last_updated ?? ""));
      } else {
        this._snapshotClient.stop();
        this._clearSnapshot();
        this._setStatus("error", "Select a SkyVista sensor or provide inline GeoJSON");
      }
      return;
    }

    this._snapshotClient.stop();
    const geoJson = normalizeGeoJson(rawGeoJson);
    // Legacy/template sources can move aircraft without changing count or timestamp.
    const fingerprint = JSON.stringify([entityId, entity.state, entity.attributes.updated, entity.last_updated, geoJson]);
    if (fingerprint !== this._lastRenderedFingerprint) {
      this._lastRenderedFingerprint = fingerprint;
      const count = Number(entity.state);
      this._showSnapshot(geoJson, Number.isFinite(count) ? count : geoJson.features.length, entity.attributes.updated ?? entity.last_updated);
    }
  }

  private _showSnapshot(geoJson: FlightCollection, count: number, updated: unknown): void {
    this._latestGeoJson = geoJson;
    this._renderGeoJson(geoJson);
    if (this._els.count) {
      this._els.count.textContent = `Aircraft: ${Math.max(0, Math.round(count))}`;
    }

    if (this._els.updated) {
      this._els.updated.textContent = `Updated: ${formatUpdated(updated)}`;
    }

    this._snapshotAt = typeof updated === "string" ? Date.parse(updated) : NaN;
    this._updateFreshness();
  }

  private _updateFreshness(): void {
    clearTimeout(this._freshnessTimer);
    this._freshnessTimer = undefined;
    if (this._snapshotAt === undefined || !this.isConnected) return;
    const age = Date.now() - this._snapshotAt;
    if (!Number.isFinite(age) || age < -5000) {
      this._setStatus("idle", "Stale (unknown age)");
    } else if (age > 30000) {
      this._setStatus("idle", "Stale (>30 s)");
    } else {
      this._setStatus("ok", "Live");
      // Expire from the source timestamp, even if no HA event arrives.
      this._freshnessTimer = setTimeout(() => this._updateFreshness(), 30001 - age);
    }
  }

  private _clearSnapshot(): void {
    clearTimeout(this._freshnessTimer);
    this._freshnessTimer = undefined;
    this._snapshotAt = undefined;
    this._latestGeoJson = EMPTY_COLLECTION;
    this._renderGeoJson(EMPTY_COLLECTION);
    if (this._els.count) this._els.count.textContent = "Aircraft: —";
    if (this._els.updated) this._els.updated.textContent = "Updated: never";
  }

  private _renderGeoJson(geoJson: FlightCollection): void {
    if (!this._aircraftLayer || !this._map) {
      return;
    }

    const identities = geoJson.features.map(aircraftIdentity);
    const occurrences = new Map<string, number>();
    for (const id of identities) if (id) occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
    const retained = new Set<string>();
    geoJson.features.forEach((feature, index) => {
      const identity = identities[index];
      // Missing/duplicate IDs are not safe to follow across snapshots or array reorders.
      const key = identity && occurrences.get(identity) === 1
        ? identity : `anonymous:${++this._anonymousMarkerId}`;
      retained.add(key);
      const L = this._leaflet!;
      const [lon, lat] = feature.geometry.coordinates;
      const iconHtml = aircraftIconHtml(feature.properties);
      const icon = () => L.divIcon({
        className: "flight-card__aircraft-marker", html: iconHtml,
        iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -10],
      });
      let record = this._aircraftMarkers.get(key);
      if (!record) {
        const marker = L.marker([lat, lon], { icon: icon(), keyboard: false });
        record = { marker, content: document.createElement("div"), iconHtml, popupHtml: "" };
        marker.bindPopup(record.content, {
          className: "flight-card__leaflet-popup", minWidth: 200, maxWidth: 280,
          maxHeight: Math.max(120, this._config.map_height - 70),
        });
        const current = record;
        marker.on("popupopen", () => this._refreshPopupPhoto(current));
        this._aircraftMarkers.set(key, record);
        this._aircraftLayer!.addLayer(marker);
      } else {
        // Leaflet moves an open popup with its existing marker.
        record.marker.setLatLng([lat, lon]);
        if (record.iconHtml !== iconHtml) {
          record.marker.setIcon(icon());
          record.iconHtml = iconHtml;
        }
      }
      this._updateAircraftPopup(record, feature.properties);
    });
    for (const [key, record] of this._aircraftMarkers) {
      if (!retained.has(key)) {
        record.marker.closePopup();
        this._aircraftLayer.removeLayer(record.marker);
        this._aircraftMarkers.delete(key);
      }
    }

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

  private _updateAircraftPopup(record: AircraftMarker, props: FlightFeatureProperties): void {
    const html = this._popupHtml(props);
    if (record.popupHtml === html) return;
    record.popupHtml = html;
    const next = document.createElement("div");
    next.innerHTML = html;
    const nextImage = next.querySelector<HTMLImageElement>(".flight-card__popup-image");
    const oldImage = record.content.querySelector<HTMLImageElement>(".flight-card__popup-image");
    const src = nextImage?.getAttribute("src");
    if (src && src === record.failedPhoto) nextImage?.closest("figure")?.remove();
    else {
      record.failedPhoto = undefined;
      if (nextImage && oldImage && src === oldImage.getAttribute("src")) {
        oldImage.alt = nextImage.alt;
        nextImage.closest("figure")!.replaceWith(oldImage.closest("figure")!);
      }
    }
    const popup = record.marker.getPopup();
    const scroll = popup?.getElement()?.querySelector<HTMLElement>(".leaflet-popup-content");
    const scrollTop = scroll?.scrollTop ?? 0;
    record.content.replaceChildren(...Array.from(next.childNodes));
    if (record.marker.isPopupOpen()) {
      popup?.update();
      this._refreshPopupPhoto(record);
      if (scroll) scroll.scrollTop = scrollTop;
    }
  }

  private _refreshPopupPhoto(record: AircraftMarker): void {
    const popup = record.marker.getPopup();
    const image = record.content.querySelector<HTMLImageElement>(".flight-card__popup-image");
    if (!popup || !image) return;
    const refresh = () => {
      if (!record.content.contains(image)) return;
      if (!image.naturalWidth) {
        record.failedPhoto = image.getAttribute("src") ?? undefined;
        image.closest("figure")?.remove();
      }
      if (record.marker.isPopupOpen()) popup.update();
    };
    if (image.complete) refresh();
    else if (record.photo !== image) {
      record.photo = image;
      image.addEventListener("load", refresh, { once: true });
      image.addEventListener("error", refresh, { once: true });
    }
  }

  private _setStatus(type: "idle" | "ok" | "error", text: string): void {
    if (!this._els.status) {
      return;
    }

    const className = `flight-card__status flight-card__status--${type}`;
    if (this._els.status.className !== className) this._els.status.className = className;
    if (this._els.status.textContent !== text) this._els.status.textContent = text;
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
    const title = firstNonEmptyString([props.flight, props.registration, props.aircraft_type, "Aircraft"]);
    const reading = (label: string, value: number | null, unit: string, decimals?: number) => {
      const formatted = Number.isFinite(value)
        ? decimals === undefined ? Math.round(value as number).toLocaleString() : (value as number).toFixed(decimals)
        : "—";
      return `<div class="flight-card__popup-reading"><dt class="flight-card__popup-label">${label}</dt>
        <dd class="flight-card__popup-value">${formatted}${Number.isFinite(value) ? ` <span class="flight-card__popup-unit">${unit}</span>` : ""}</dd></div>`;
    };
    const details = [
      ["Registration", props.registration],
      ["Manufacturer", props.manufacturer],
      ["Owner", props.registered_owners],
    ].filter(([, value]) => value).map(([label, value]) =>
      `<div class="flight-card__popup-detail${label === "Owner" ? " flight-card__popup-detail--wide" : ""}">
        <dt class="flight-card__popup-label">${label}</dt><dd>${escapeHtml(value)}</dd></div>`
    ).join("");
    // Remote photos carry no photographer metadata; do not invent a credit or link.
    const imageHtml = /^https?:\/\//i.test(props.airframe_image_url)
      ? `<figure class="flight-card__popup-photo"><img class="flight-card__popup-image" src="${escapeHtml(props.airframe_image_url)}"
          alt="Airframe image for ${escapeHtml(title)}" loading="lazy" referrerpolicy="no-referrer" /></figure>`
      : "";
    return `<article class="flight-card__popup" aria-label="Aircraft details">
      <header class="flight-card__popup-header"><div class="flight-card__popup-title">${escapeHtml(title)}</div>
        ${props.aircraft_type ? `<div class="flight-card__popup-type">${escapeHtml(props.aircraft_type)}</div>` : ""}</header>
      <dl class="flight-card__popup-readings">${reading("Altitude", props.altitude_ft, "ft")}${reading("Speed", props.speed_kt, "kt")}</dl>
      <dl class="flight-card__popup-readings flight-card__popup-readings--secondary">${reading("Track", props.track_deg, "°")}${reading("Seen", props.seen_s, "s ago", 1)}</dl>
      ${details ? `<dl class="flight-card__popup-details">${details}</dl>` : ""}${imageHtml}</article>`;
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
      // Responsive CSS changes popup width; refresh Leaflet's cached layout and pan.
      this._aircraftLayer?.eachLayer((layer) => {
        const popup = layer.getPopup();
        if (popup?.isOpen()) popup.update();
      });
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
      const finish = () => {
        observer.disconnect();
        window.clearTimeout(timeoutId);
        if (this._cancelMapWait === finish) this._cancelMapWait = undefined;
        resolve();
      };
      const timeoutId = window.setTimeout(finish, 5000);
      this._cancelMapWait = finish;

      const observer = new ResizeObserver(() => {
        if (!hasUsableSize()) {
          return;
        }
        finish();
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
  if (trimmedConfigured) {
    return trimmedConfigured;
  }

  const entries = Object.values(states);

  const byDomainTag = entries.filter((entity) => {
    const source = entity.attributes?.source_domain;
    return typeof source === "string" && source === "flight_card";
  });
  if (byDomainTag.length) {
    return byDomainTag.length === 1 ? byDomainTag[0].entity_id : "";
  }

  const byGeoJsonShape = entries.filter((entity) => {
    const attrs = entity.attributes;
    const geojson = attrs?.geojson;
    return (
      isObjectRecord(geojson) &&
      geojson.type === "FeatureCollection" &&
      Array.isArray(geojson.features) &&
      typeof attrs?.config_entry_id === "string"
    );
  });

  return byGeoJsonShape.length === 1 ? byGeoJsonShape[0].entity_id : "";
}

function aircraftIdentity(feature: FlightFeature): string {
  const hex = feature.properties.hex.trim().toLowerCase();
  if (hex && hex !== "unknown") return `hex:${hex}`;
  return typeof feature.id === "string" || typeof feature.id === "number"
    ? `feature:${typeof feature.id}:${feature.id}` : "";
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
    ...(typeof value.id === "string" || typeof value.id === "number" ? { id: value.id } : {}),
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
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
    return null;
  }
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
      name: "ADS-B SkyVista",
      description: "Display aircraft from the ADS-B SkyVista integration sensor on a live map.",
      documentationURL: "https://developers.home-assistant.io/docs/frontend/custom-ui/custom-card/",
    });
  }
}

if (!customElements.get(CARD_TYPE)) {
  customElements.define(CARD_TYPE, FlightCard);
}

registerCustomCard();

console.info(
  `%c ADS-B SKYVISTA %c ${CARD_VERSION} `,
  "color: white; background: #3b82f6; font-weight: 700;",
  "color: #3b82f6; background: white; font-weight: 700;"
);

declare global {
  interface Window {
    customCards?: CustomCardRegistration[];
  }
}
