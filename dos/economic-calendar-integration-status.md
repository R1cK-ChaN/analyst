# Economic Calendar Integration Status

Updated: 2026-02-16

## Scope

This note summarizes the current `economic_calendar` tool integration status for:

- FRED (official, free)
- BLS (official, free)
- Trading Economics (paid API)

## Current Tool Behavior

The `economic_calendar` tool supports multiple providers via `provider`:

- `fred` (default)
- `bls`
- `tradingeconomics`

Supported actions:

- `action: "calendar"`
- `action: "series"`

Provider/action support matrix:

- `fred + calendar`: supported (release schedule)
- `fred + series`: supported (time series values)
- `bls + series`: supported (time series values)
- `bls + calendar`: not supported (returns explicit unsupported_action message)
- `tradingeconomics + calendar`: supported

## Credentials and Config

Environment variables:

- `FRED_API_KEY`
- `BLS_API_KEY` (or `BLS_PUBLIC_DATA_API_KEY`)
- `TRADING_ECONOMICS_API_KEY`

Tool config path:

- `tools.web.economicCalendar`

Config keys currently supported:

- `enabled`
- `provider`
- `apiKey` (Trading Economics)
- `fredApiKey`
- `blsApiKey`
- `baseUrl`
- `defaultCountry`
- `defaultDaysAhead`
- `maxEvents`
- `timeoutSeconds`
- `cacheTtlMinutes`

## Data Capability Notes

Important differences by provider:

- FRED/BLS provide official release/time-series data but generally do not provide market consensus forecasts.
- Trading Economics provides calendar entries with actual/forecast(previous) style fields, including consensus-like forecast fields.

Returned payload includes capability hints, for example:

- `capabilities.actual`
- `capabilities.consensus`
- `capabilities.previous`
- `capabilities.official`

## Validation Status

### FRED

Status: verified working end-to-end.

Observed successful calls:

- FRED release dates endpoint returned release items.
- FRED `UNRATE` observations endpoint returned recent numeric values.
- In-tool `provider=fred` tests returned expected parsed output.

### BLS

Status: code path implemented; live connectivity may fail depending on environment/network path.

Observed in this environment:

- Repeated transport-level failures to `api.bls.gov` (connection reset/fetch failed).
- This appears to be network/TLS path related, not a schema/logic error in tool parsing.

Action for operator:

- Re-run BLS curl tests from a network that can reliably reach `https://api.bls.gov/publicAPI/v2/timeseries/data/`.

### Trading Economics

Status: supported as optional provider.

Notes:

- Requires API key (`TRADING_ECONOMICS_API_KEY` or config `apiKey`).
- Paid plan required by Trading Economics for API access.

## Example Calls

FRED release calendar:

```json
{
  "provider": "fred",
  "action": "calendar",
  "startDate": "2026-02-01",
  "endDate": "2026-02-28",
  "maxEvents": 30
}
```

FRED series:

```json
{
  "provider": "fred",
  "action": "series",
  "seriesIds": ["CPIAUCSL", "UNRATE"],
  "startDate": "2025-01-01",
  "endDate": "2026-02-28"
}
```

BLS series:

```json
{
  "provider": "bls",
  "action": "series",
  "seriesIds": ["CUUR0000SA0", "LNS14000000"],
  "startDate": "2025-01-01",
  "endDate": "2026-02-28"
}
```

Trading Economics calendar:

```json
{
  "provider": "tradingeconomics",
  "action": "calendar",
  "country": "united states",
  "startDate": "2026-02-01",
  "endDate": "2026-02-28",
  "importance": 3
}
```

## Summary

Current default path is free official providers first (`fred` default, `bls` available for series), with Trading Economics retained as optional paid provider for richer consensus-style calendar fields.
