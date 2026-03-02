"""Constants for the ADS-B Nearby Aircraft integration."""

from __future__ import annotations

from homeassistant.const import Platform

DOMAIN = "flight_card"
PLATFORMS: list[Platform] = [Platform.SENSOR]

CONF_NAME = "name"
CONF_DATA_URL = "data_url"
CONF_UPDATE_INTERVAL = "update_interval"
CONF_MAX_AGE = "max_age"
CONF_HEXDB_ENABLED = "hexdb_enabled"

DEFAULT_NAME = "ADS-B Nearby Aircraft"
DEFAULT_DATA_URL = "http://192.168.1.250/skyaware/data/aircraft.json"
LEGACY_DATA_URLS = {
    "http://10.10.0.249/skyaware/data/aircraft.json",
}
DEFAULT_UPDATE_INTERVAL = 10
DEFAULT_MAX_AGE = 60
DEFAULT_HEXDB_ENABLED = True

HEXDB_LOOKUP_ENDPOINT = "https://hexdb.io/api/v1/aircraft/"
HEXDB_IMAGE_THUMB_ENDPOINT = "https://hexdb.io/hex-image-thumb?hex="
MAX_HEXDB_LOOKUPS_PER_UPDATE = 6


def normalize_data_url(value: object) -> str:
    """Normalize data URL and rewrite legacy defaults."""
    url = str(value or "").strip()
    if not url:
        return DEFAULT_DATA_URL
    if url in LEGACY_DATA_URLS:
        return DEFAULT_DATA_URL
    return url
