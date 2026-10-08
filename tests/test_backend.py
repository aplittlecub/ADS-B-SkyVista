"""Offline tests using actual HA entity metadata and Recorder serializer/ORM.

These tests do not start a Recorder worker or a live Home Assistant instance.
Run with Python 3.14 and homeassistant==2026.9.4 installed.
"""

import asyncio
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from homeassistant.components.recorder.db_schema import (
    Base,
    StateAttributes,
    States,
    StatesMeta,
)
from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import Event, HomeAssistant, State
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from custom_components.flight_card import (
    CARD_JS_URL,
    _async_setup_frontend,
)
from custom_components.flight_card.sensor import FlightCardAircraftSensor
from custom_components.flight_card.coordinator import FlightCardDataUpdateCoordinator
from custom_components.flight_card.websocket import async_setup_websocket, websocket_get_geojson


class RecorderTest(unittest.IsolatedAsyncioTestCase):
    async def test_large_geojson_stays_in_coordinator_and_count_history_is_preserved(self):
        payload = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [-0.1, 51.5]},
                    "properties": {"hex": f"{index:06x}", "details": "x" * 400},
                }
                for index in range(70)
            ],
        }
        self.assertGreater(len(json.dumps(payload).encode()), 16384)
        coordinator = SimpleNamespace(
            data={"aircraft_count": 70, "geojson": payload, "updated": "first"},
            last_update_success=True,
        )
        sensor = FlightCardAircraftSensor(coordinator, SimpleNamespace(entry_id="test"))
        config_dir = self.enterContext(TemporaryDirectory(prefix="skyvista-hass-"))
        sensor.hass = HomeAssistant(config_dir)
        sensor.platform = SimpleNamespace(platform_name="flight_card", config_entry=None)
        sensor.entity_id = "sensor.skyvista_aircraft"
        # Let actual HA initialize its combined Recorder exclusion metadata.
        await sensor.async_internal_added_to_hass()
        self.assertIn("geojson", sensor._state_info["unrecorded_attributes"])

        engine = create_engine("sqlite:///:memory:")
        try:
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                metadata = StatesMeta(entity_id=sensor.entity_id)
                session.add(metadata)
                session.flush()
                previous = None
                for count in (70, 71):
                    coordinator.data["aircraft_count"] = count
                    coordinator.data["updated"] = str(count)
                    state = State(
                        sensor.entity_id,
                        str(sensor.native_value),
                        sensor.extra_state_attributes,
                        state_info=sensor._state_info,
                    )
                    self.assertNotIn("geojson", state.attributes)
                    self.assertIs(coordinator.data["geojson"], payload)
                    event = Event(EVENT_STATE_CHANGED, {
                        "entity_id": sensor.entity_id,
                        "old_state": previous,
                        "new_state": state,
                    })
                    encoded = StateAttributes.shared_attrs_bytes_from_event(event, None)
                    recorded = json.loads(encoded)
                    self.assertNotIn("geojson", recorded)
                    self.assertEqual(recorded["updated"], str(count))
                    self.assertEqual(recorded["source_domain"], "flight_card")
                    self.assertLess(len(encoded), 16384)
                    attributes = StateAttributes(shared_attrs=encoded.decode())
                    session.add(attributes)
                    session.flush()
                    row = States.from_event(event)
                    row.attributes_id = attributes.attributes_id
                    row.metadata_id = metadata.metadata_id
                    session.add(row)
                    previous = state
                session.commit()
                self.assertEqual(session.scalars(select(States.state).order_by(States.state_id)).all(), ["70", "71"])
                for value in session.scalars(select(StateAttributes.shared_attrs)):
                    self.assertNotIn("geojson", json.loads(value))

            # Negative control: the same payload exceeds HA's limit without metadata.
            unfiltered = State(sensor.entity_id, "71", {**sensor.extra_state_attributes, "geojson": payload})
            event = Event(EVENT_STATE_CHANGED, {"new_state": unfiltered})
            with self.assertLogs("homeassistant.components.recorder.db_schema", "WARNING"):
                self.assertEqual(StateAttributes.shared_attrs_bytes_from_event(event, None), b"{}")
        finally:
            engine.dispose()

    async def test_frontend_registers_once_and_missing_bundle_can_retry(self):
        hass = SimpleNamespace(data={}, http=SimpleNamespace(async_register_static_paths=AsyncMock()))
        with patch("custom_components.flight_card.add_extra_js_url") as add_url:
            await asyncio.gather(_async_setup_frontend(hass), _async_setup_frontend(hass))
            hass.http.async_register_static_paths.assert_awaited_once()


            registration = hass.http.async_register_static_paths.call_args.args[0][0]
            self.assertEqual(registration.url_path, CARD_JS_URL)
            self.assertFalse(registration.cache_headers)
            self.assertTrue(Path(registration.path).is_file())
            add_url.assert_called_once_with(hass, CARD_JS_URL)

        hass = SimpleNamespace(data={}, http=SimpleNamespace(async_register_static_paths=AsyncMock()))
        with patch("custom_components.flight_card.add_extra_js_url") as add_url:
            with patch("custom_components.flight_card.CARD_JS_FILE", Path("missing-test-bundle.js")):
                with self.assertLogs("custom_components.flight_card", "WARNING"):
                    await _async_setup_frontend(hass)
                hass.http.async_register_static_paths.assert_not_awaited()
                add_url.assert_not_called()
            await _async_setup_frontend(hass)
            hass.http.async_register_static_paths.assert_awaited_once()


class WebSocketTest(unittest.TestCase):
    def setUp(self):
        self.coordinator = MagicMock(spec=FlightCardDataUpdateCoordinator)
        self.coordinator.last_update_success = True
        self.coordinator.data = {
            "geojson": {"type": "FeatureCollection", "features": [{"properties": {"hex": "abc123"}}]},
            "updated": "2026-10-08T14:00:00Z",
            "aircraft_count": 1,
        }
        self.entry = SimpleNamespace(domain="flight_card", state=ConfigEntryState.LOADED)
        self.hass = MagicMock()
        self.hass.data = {"flight_card": {"test": self.coordinator}}
        self.hass.config_entries.async_get_entry.return_value = self.entry
        self.hass.states.get.return_value = State("sensor.renamed_aircraft", "1")
        self.connection = MagicMock()
        self.connection.user.is_active = True
        self.connection.user.permissions.check_entity.return_value = True
        self.registry = MagicMock()
        self.registry.async_get_entity_id.return_value = "sensor.renamed_aircraft"
        self.enterContext(patch("custom_components.flight_card.websocket.er.async_get", return_value=self.registry))
        self.message = {"id": 1, "type": "flight_card/get_geojson", "config_entry_id": "test"}

    def test_cached_snapshot_and_permission_follow_actual_entity_not_client(self):
        for _ in range(2):
            websocket_get_geojson(self.hass, self.connection, self.message)
        self.registry.async_get_entity_id.assert_called_with("sensor", "flight_card", "test_aircraft")
        self.connection.user.permissions.check_entity.assert_called_with("sensor.renamed_aircraft", "read")
        result = self.connection.send_result.call_args.args[1]
        self.assertIs(result["geojson"], self.coordinator.data["geojson"])
        self.assertEqual(result["updated"], self.coordinator.data["updated"])
        self.assertEqual(result["config_entry_id"], "test")
        self.assertEqual(result["aircraft_count"], 1)
        self.coordinator.async_request_refresh.assert_not_called()
        self.coordinator._async_update_data.assert_not_called()

    def test_denied_or_inactive_user_cannot_read_cached_payload(self):
        for user in (None, SimpleNamespace(is_active=False), self.connection.user):
            self.connection.user = user
            if user is not None and user.is_active:
                user.permissions.check_entity.return_value = False
            websocket_get_geojson(self.hass, self.connection, self.message)
            self.assertEqual(self.connection.send_error.call_args.args[1], "unauthorized")
        self.connection.send_result.assert_not_called()

    def test_unloaded_missing_failed_and_disabled_entry_are_not_live(self):
        for state in (ConfigEntryState.NOT_LOADED, ConfigEntryState.UNLOAD_IN_PROGRESS):
            self.entry.state = state
            websocket_get_geojson(self.hass, self.connection, self.message)
            self.assertEqual(self.connection.send_error.call_args.args[1], "not_found")
        self.entry.state = ConfigEntryState.LOADED
        for state in (None, State("sensor.renamed_aircraft", "unavailable")):
            self.hass.states.get.return_value = state
            websocket_get_geojson(self.hass, self.connection, self.message)
            self.assertEqual(self.connection.send_error.call_args.args[1], "unavailable")
        self.hass.states.get.return_value = State("sensor.renamed_aircraft", "1")
        self.coordinator.last_update_success = False
        websocket_get_geojson(self.hass, self.connection, self.message)
        self.assertEqual(self.connection.send_error.call_args.args[1], "unavailable")
        self.hass.data["flight_card"].pop("test")
        websocket_get_geojson(self.hass, self.connection, self.message)
        self.assertEqual(self.connection.send_error.call_args.args[1], "not_found")
        self.connection.send_result.assert_not_called()

    def test_multiple_entries_are_isolated_and_registration_is_once(self):
        second = MagicMock(spec=FlightCardDataUpdateCoordinator)
        second.last_update_success = True
        second.data = {**self.coordinator.data, "aircraft_count": 0, "geojson": {"type": "FeatureCollection", "features": []}}
        self.hass.data["flight_card"]["second"] = second
        websocket_get_geojson(self.hass, self.connection, {**self.message, "config_entry_id": "second"})
        self.assertIs(self.connection.send_result.call_args.args[1]["geojson"], second.data["geojson"])
        with patch("custom_components.flight_card.websocket.websocket_api.async_register_command") as register:
            async_setup_websocket(self.hass)
            async_setup_websocket(self.hass)
            register.assert_called_once()
if __name__ == "__main__":
    unittest.main()
