/** One card's cancellable view of HA's cached snapshots (no receiver requests). */
export interface HassConnection {
  connected: boolean;
  addEventListener(event: "ready" | "disconnected", listener: () => void): void;
  removeEventListener(event: "ready" | "disconnected", listener: () => void): void;
}

export interface SnapshotHass {
  connection?: HassConnection;
  callWS?<T>(message: Record<string, unknown>): Promise<T>;
}

export interface Snapshot {
  config_entry_id: string;
  updated: string;
  aircraft_count: number;
  geojson: { type: "FeatureCollection"; features: unknown[] };
}

export class GeoJsonClient {
  private hass?: SnapshotHass;
  private connection?: HassConnection;
  private source = "";
  private entry = "";
  private revision = "";
  private generation = 0;
  private dirty = false;
  private pending = false;
  private retry?: ReturnType<typeof setTimeout>;
  private timeout?: ReturnType<typeof setTimeout>;
  private retryDelay = 1000;
  private offline = false;

  constructor(
    private readonly render: (snapshot: Snapshot) => void,
    private readonly status: (state: "loading" | "error", message: string, keepSnapshot?: boolean) => void,
  ) {}

  update(hass: SnapshotHass, entityId: string, entry: string, revision: string): void {
    const source = `${entityId}\n${entry}`;
    if (source !== this.source || hass.connection !== this.connection) {
      this.stop();
      this.source = source;
      this.entry = entry;
      this.connection = hass.connection;
      this.offline = this.connection?.connected === false;
      this.connection?.addEventListener("ready", this.ready);
      this.connection?.addEventListener("disconnected", this.disconnected);
      this.dirty = true;
    }
    this.hass = hass;
    if (revision !== this.revision) {
      this.revision = revision;
      this.dirty = true;
    }
    if (this.offline) this.status("error", "Disconnected from Home Assistant");
    else this.request();
  }

  stop(): void {
    this.cancel();
    this.connection?.removeEventListener("ready", this.ready);
    this.connection?.removeEventListener("disconnected", this.disconnected);
    this.connection = undefined;
    this.hass = undefined;
    this.source = this.entry = this.revision = "";
    this.dirty = false;
    this.retryDelay = 1000;
  }

  private cancel(): void {
    // callWS has no abort API. Retire its generation and ignore any late result.
    this.generation++;
    this.pending = false;
    clearTimeout(this.retry);
    clearTimeout(this.timeout);
    this.retry = this.timeout = undefined;
  }

  private disconnected = (): void => {
    this.cancel();
    this.offline = true;
    this.dirty = true;
    this.status("error", "Disconnected from Home Assistant");
  };

  private ready = (): void => {
    this.cancel();
    this.offline = false;
    this.dirty = true;
    this.retryDelay = 1000;
    this.request();
  };

  private request(): void {
    if (!this.source || !this.hass || this.offline || this.pending || this.retry || !this.dirty) return;
    if (!this.hass.callWS) {
      this.status("error", "Home Assistant WebSocket API unavailable");
      return;
    }
    const generation = ++this.generation;
    const requestedRevision = this.revision;
    this.pending = true;
    this.dirty = false;
    this.status("loading", "Loading aircraft");
    const fail = (message: string, retryable = true, keepSnapshot = true) => {
      if (generation !== this.generation) return;
      this.cancel();
      this.dirty = true;
      this.status("error", message, keepSnapshot);
      if (retryable) {
        this.retry = setTimeout(() => {
          this.retry = undefined;
          this.request();
        }, this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 30000);
      } else {
        // Permission/protocol failures retry only on a new state or connection.
        this.dirty = false;
      }
    };
    this.timeout = setTimeout(() => fail("Aircraft request timed out"), 15000);
    // Also handle synchronous client errors through the same bounded retry path.
    Promise.resolve().then(() => {
      if (generation !== this.generation) return undefined;
      return this.hass!.callWS!<Snapshot>({ type: "flight_card/get_geojson", config_entry_id: this.entry });
    }).then((snapshot) => {
      if (generation !== this.generation) return;
      if (!snapshot || snapshot.config_entry_id !== this.entry || typeof snapshot.updated !== "string" ||
          !snapshot.updated || !Number.isFinite(snapshot.aircraft_count) || snapshot.aircraft_count < 0 ||
          snapshot.geojson?.type !== "FeatureCollection" || !Array.isArray(snapshot.geojson.features)) {
        fail("Invalid SkyVista snapshot");
        return;
      }
      const received = Date.parse(snapshot.updated);
      const wanted = Date.parse(this.revision);
      const behind = Number.isFinite(received) && Number.isFinite(wanted) && received < wanted;
      // If an update arrived in flight, an older/opaque response cannot consume it.
      const superseded = this.revision !== requestedRevision && snapshot.updated !== this.revision &&
        !(Number.isFinite(received) && Number.isFinite(wanted) && received >= wanted);
      if (behind || superseded) {
        fail("Waiting for latest aircraft snapshot");
        return;
      }
      clearTimeout(this.timeout);
      this.timeout = undefined;
      this.pending = false;
      this.dirty = false;
      this.retryDelay = 1000;
      this.render(snapshot);
    }).catch((error: unknown) => {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      const message = code === "unauthorized" ? "Aircraft access denied" :
        code === "not_found" ? "SkyVista entry is not loaded" :
        code === "unavailable" ? "SkyVista data is unavailable" :
        code === "unknown_command" ? "Update SkyVista backend or use a legacy GeoJSON entity" :
        "Could not load aircraft";
      fail(message, code !== "unauthorized" && code !== "unknown_command",
        !["unauthorized", "unknown_command", "not_found", "unavailable"].includes(code));
    });
  }
}
