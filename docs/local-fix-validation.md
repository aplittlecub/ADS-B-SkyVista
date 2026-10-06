# Local combined fix validation — 6 October 2026

Base: `7f502d1d1d9a28e0d874acee7aaea5a2538be0ec`, including the user's merge
of PR 6. Branch: `fix/map-recorder-package`. Version remains `0.3.2` pending
release review. No push, release publication, issue closure, or live HA changes
were performed by this task.

## Changes

- Issue 4: `sensor.py` declares `_unrecorded_attributes = frozenset({"geojson"})`.
  GeoJSON remains in live sensor attributes; the aircraft count remains the state.
  This uses the supported HA entity API, documented in September 2023 and
  confirmed in HA 2024.7.0 and 2026.9.4 source.
- Issues 3/5: the default layer uses `https://tile.openstreetmap.org/{z}/{x}/{y}.png`
  and `strict-origin-when-cross-origin`. Custom URLs retain the page's referrer
  policy. No provider is forced to use anonymous CORS.
- Builds and watch builds copy JS and its map into the HACS integration package.
  Source-map paths and TypeScript line endings are stable across output locations
  and Windows/Linux checkouts. The new checker builds separately and rejects stale
  or missing artifacts without rewriting the package. CI runs it before rebuilding.

Chris Hawthorne (@KJ7PPK) identified the referrer-policy fix in
[PR 6](https://github.com/aplittlecub/ADS-B-SkyVista/pull/6). His original commit
`375a69e346ef6a80ef43be1bfd19fe03dcf24d49` is preserved in branch ancestry.
The follow-up adapts the policy and removes the unconditional CORS option to
preserve custom-provider image loading. Previous recovery-map commits were not copied.

## Completed validation

- `npm ci`, `npm run check`, `npm run build`.
- `npm run check:bundle`: both JS/map destinations match a fresh build byte for byte.
- `npm run test:package`: 2 tests, including independent stale JS/map rejection,
  missing map rejection, and current TypeScript embedded in the map.
- `npm run test:frontend`: 6 Chromium tests using installed Chrome and synthetic
  HA state/tile responses. Canonical OSM gets only an origin Referer under a
  `no-referrer` page policy. Custom HTTP/HTTPS/subdomain URLs preserve that page
  policy and load without CORS response headers. Cold native element upgrade,
  duplicate module URLs, reload/reconnect, initially hidden card, and widths
  1280/390/768 pixels pass without console errors. No real tile service was contacted.
- Watch synchronization passed across an initial build and a file-change rebuild.
- Python 3.14.7 with actual PyPI `homeassistant==2026.9.4`, installed in a temporary
  dependency directory: 2 backend tests pass. Actual HA initializes the sensor's
  exclusion metadata; actual Recorder serialization and SQLAlchemy SQLite models
  omit a GeoJSON payload over 16 KB while preserving live GeoJSON, small attributes,
  and count rows `70`/`71`. Removing the metadata reproduces HA's oversize warning.
  Frontend registration is also checked for idempotence, cache-header setting, and
  retry after a missing bundle, using a mocked HTTP registrar.

The backend test does **not** run a Recorder worker or a live HA HTTP server. These
tests do not confirm behavior on the user's installed configuration or receiver.
The new Linux CI workflow is prepared but has not run remotely.

## Issue 2 remains unresolved

The packaged bundle registers `flight-card` successfully in the browser harness.
The HA static registration keeps `cache_headers=False`. The latest reporter uses
modified files and cannot reproduce the original failure. No demonstrated defect
justifies changing resource loading or introducing a new cache/version mechanism.
Collect the first console error, JS response status/body, version banner,
HA/browser versions, and private-window comparison from an affected unmodified
installation before claiming a fix. A downloaded module can fail before registration.

## Reversible live test

The local test overlay contains exactly:

- `custom_components/flight_card/sensor.py`
- `custom_components/flight_card/flight-card.js`
- `custom_components/flight_card/flight-card.js.map`

Confirm the exact target and access first. Back up the **actual installed** copies
of these three files outside the integration folder, preserving any local changes.
For an issue-4-only trial, apply just `sensor.py`. For the combined trial, apply all
three files. Keep configuration entries, YAML, and the database unchanged.
Restart HA once to load the Python change, wait for startup, then hard-refresh the
dashboard or use a private window. The version banner will still say `0.3.2`;
identify this local test by its archive checksum and local commit instead.

Verify live aircraft/GeoJSON, advancing count history, no new oversized-attribute
warnings, tile requests/Referer, and desktop/mobile rendering. The change prevents
new GeoJSON history storage; it does not purge existing database rows. To roll back,
restore those exact backed-up files, restart HA once, and refresh the dashboard.
Deployment/restart awaits target/access/backup confirmation in the parent task.

## Release review

Suggested next coherent patch version: `0.3.3`. Before publishing: complete live
validation, review the full diff, run Linux CI/HACS/hassfest, then update package.json,
package-lock.json, the integration manifest, and the card version together and rebuild.
Explain the Recorder history behavior and credit PR 6 in release notes. Keep issue 2
open pending diagnostics. Push/tag/publish only after authorization.

Existing development dependencies report 5 npm audit findings (4 high, 1 moderate).
They are outside this focused change; no dependency-upgrade refactor was attempted.

## Sources

- [HA Recorder exclusion API](https://developers.home-assistant.io/blog/2023/09/20/excluding-state-attributes-from-recording/)
- [OSM tile policy](https://operations.osmfoundation.org/policies/tiles/)
- [Leaflet tile options](https://leafletjs.com/reference.html#tilelayer-referrerpolicy)
