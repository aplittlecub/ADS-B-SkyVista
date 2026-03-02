"""Config flow for ADS-B Nearby Aircraft integration."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import callback

from .const import (
    CONF_DATA_URL,
    CONF_HEXDB_ENABLED,
    CONF_MAX_AGE,
    CONF_NAME,
    CONF_UPDATE_INTERVAL,
    DEFAULT_DATA_URL,
    DEFAULT_HEXDB_ENABLED,
    DEFAULT_MAX_AGE,
    DEFAULT_NAME,
    DEFAULT_UPDATE_INTERVAL,
    DOMAIN,
    normalize_data_url,
)


def _data_schema() -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(CONF_NAME): str,
            vol.Required(CONF_DATA_URL): str,
            vol.Required(CONF_UPDATE_INTERVAL): vol.All(
                vol.Coerce(int),
                vol.Range(min=2, max=600),
            ),
            vol.Required(CONF_MAX_AGE): vol.All(
                vol.Coerce(int),
                vol.Range(min=1, max=3600),
            ),
            vol.Required(CONF_HEXDB_ENABLED): bool,
        }
    )


def _options_schema() -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(CONF_DATA_URL): str,
            vol.Required(CONF_UPDATE_INTERVAL): vol.All(
                vol.Coerce(int),
                vol.Range(min=2, max=600),
            ),
            vol.Required(CONF_MAX_AGE): vol.All(
                vol.Coerce(int),
                vol.Range(min=1, max=3600),
            ),
            vol.Required(CONF_HEXDB_ENABLED): bool,
        }
    )


class FlightCardConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for ADS-B Nearby Aircraft."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None):
        """Handle initial user setup."""
        if user_input is not None:
            cleaned_input = dict(user_input)
            cleaned_input[CONF_DATA_URL] = normalize_data_url(cleaned_input.get(CONF_DATA_URL))

            await self.async_set_unique_id(cleaned_input[CONF_NAME].strip().lower())
            self._abort_if_unique_id_configured()

            title = cleaned_input[CONF_NAME].strip() or DEFAULT_NAME
            return self.async_create_entry(title=title, data=cleaned_input)

        defaults = {
            CONF_NAME: DEFAULT_NAME,
            CONF_DATA_URL: DEFAULT_DATA_URL,
            CONF_UPDATE_INTERVAL: DEFAULT_UPDATE_INTERVAL,
            CONF_MAX_AGE: DEFAULT_MAX_AGE,
            CONF_HEXDB_ENABLED: DEFAULT_HEXDB_ENABLED,
        }

        return self.async_show_form(
            step_id="user",
            data_schema=self.add_suggested_values_to_schema(_data_schema(), defaults),
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: config_entries.ConfigEntry):
        """Return options flow handler."""
        return FlightCardOptionsFlow(config_entry)


class FlightCardOptionsFlow(config_entries.OptionsFlow):
    """Handle options flow for ADS-B Nearby Aircraft."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        """Initialize options flow."""
        self._config_entry = config_entry

    async def async_step_init(self, user_input: dict[str, Any] | None = None):
        """Manage options."""
        if user_input is not None:
            cleaned_input = dict(user_input)
            cleaned_input[CONF_DATA_URL] = normalize_data_url(cleaned_input.get(CONF_DATA_URL))
            return self.async_create_entry(title="", data=cleaned_input)

        defaults = {
            CONF_DATA_URL: normalize_data_url(
                self._config_entry.options.get(
                    CONF_DATA_URL,
                    self._config_entry.data.get(CONF_DATA_URL, DEFAULT_DATA_URL),
                )
            ),
            CONF_UPDATE_INTERVAL: self._config_entry.options.get(
                CONF_UPDATE_INTERVAL,
                self._config_entry.data.get(CONF_UPDATE_INTERVAL, DEFAULT_UPDATE_INTERVAL),
            ),
            CONF_MAX_AGE: self._config_entry.options.get(
                CONF_MAX_AGE,
                self._config_entry.data.get(CONF_MAX_AGE, DEFAULT_MAX_AGE),
            ),
            CONF_HEXDB_ENABLED: self._config_entry.options.get(
                CONF_HEXDB_ENABLED,
                self._config_entry.data.get(CONF_HEXDB_ENABLED, DEFAULT_HEXDB_ENABLED),
            ),
        }

        return self.async_show_form(
            step_id="init",
            data_schema=self.add_suggested_values_to_schema(_options_schema(), defaults),
        )
