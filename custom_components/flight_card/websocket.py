"""Read cached aircraft snapshots over HA's authenticated WebSocket API."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.auth.permissions.const import POLICY_READ
from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er

from .const import DOMAIN
from .coordinator import FlightCardDataUpdateCoordinator

DATA_WEBSOCKET_REGISTERED = "_websocket_registered"


@callback
def async_setup_websocket(hass: HomeAssistant) -> None:
    """Register once, independently of entries and frontend file availability."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if not domain_data.get(DATA_WEBSOCKET_REGISTERED):
        websocket_api.async_register_command(hass, websocket_get_geojson)
        domain_data[DATA_WEBSOCKET_REGISTERED] = True


@websocket_api.websocket_command(
    {
        vol.Required("type"): "flight_card/get_geojson",
        vol.Required("config_entry_id"): vol.All(str, vol.Length(min=1)),
    }
)
@callback
def websocket_get_geojson(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return one coherent cached snapshot; never poll the receiver here."""
    entry_id = msg["config_entry_id"]
    # Resolve the integration-owned entity, never a caller-supplied entity ID.
    entity_id = er.async_get(hass).async_get_entity_id(
        "sensor", DOMAIN, f"{entry_id}_aircraft"
    )
    user = connection.user
    if user is None or not user.is_active or (
        entity_id is not None and not user.permissions.check_entity(entity_id, POLICY_READ)
    ):
        connection.send_error(msg["id"], "unauthorized", "Aircraft entity read access required")
        return

    entry = hass.config_entries.async_get_entry(entry_id)
    coordinator = hass.data.get(DOMAIN, {}).get(entry_id)
    if (
        entity_id is None
        or entry is None
        or entry.domain != DOMAIN
        or entry.state is not ConfigEntryState.LOADED
        or not isinstance(coordinator, FlightCardDataUpdateCoordinator)
    ):
        connection.send_error(msg["id"], "not_found", "SkyVista entry is not loaded")
        return

    state = hass.states.get(entity_id)
    data = coordinator.data
    if (
        state is None
        or state.state in {"unavailable", "unknown"}
        or not coordinator.last_update_success
        or not data
    ):
        connection.send_error(msg["id"], "unavailable", "SkyVista data is unavailable")
        return

    # No await: geometry, count and timestamp belong to the same coordinator update.
    connection.send_result(msg["id"], {
        "config_entry_id": entry_id,
        "geojson": data["geojson"],
        "aircraft_count": data["aircraft_count"],
        "updated": data["updated"],
    })
