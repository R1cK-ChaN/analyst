import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import {
  CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  withTimeout,
  writeCache,
} from "./web-shared.js";

const DEFAULT_TRADING_ECONOMICS_BASE_URL = "https://api.tradingeconomics.com";
const DEFAULT_DAYS_AHEAD = 7;
const DEFAULT_MAX_EVENTS = 50;
const MAX_EVENTS_CAP = 200;
const IMPORTANCE_LEVELS = [1, 2, 3] as const;

const CALENDAR_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

const EconomicCalendarSchema = Type.Object({
  country: Type.Optional(
    Type.String({
      description:
        "Country filter. Use one country (e.g. 'united states') or a comma-separated list.",
    }),
  ),
  startDate: Type.Optional(
    Type.String({
      description: "Start date in YYYY-MM-DD format. Defaults to today (UTC).",
    }),
  ),
  endDate: Type.Optional(
    Type.String({
      description: "End date in YYYY-MM-DD format. Defaults to startDate + 7 days (UTC).",
    }),
  ),
  importance: Type.Optional(
    Type.Number({
      description: "Filter by importance level (1=low, 2=medium, 3=high).",
      minimum: 1,
      maximum: 3,
    }),
  ),
  event: Type.Optional(
    Type.String({
      description: "Optional case-insensitive event name filter (applied after fetch).",
    }),
  ),
  maxEvents: Type.Optional(
    Type.Number({
      description: "Maximum events to return (1-200).",
      minimum: 1,
      maximum: MAX_EVENTS_CAP,
    }),
  ),
});

type EconomicCalendarConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { economicCalendar?: infer Calendar }
    ? Calendar
    : undefined
  : undefined;

type TradingEconomicsCalendarItem = {
  CalendarId?: string | number;
  Date?: string;
  Country?: string;
  Category?: string;
  Event?: string;
  Actual?: string | number | null;
  Previous?: string | number | null;
  Forecast?: string | number | null;
  TEForecast?: string | number | null;
  Importance?: number | string;
  Currency?: string;
  Unit?: string;
  Source?: string;
  Reference?: string;
  URL?: string;
  LastUpdate?: string;
};

function resolveCalendarConfig(cfg?: OpenClawConfig): EconomicCalendarConfig {
  const economicCalendar = cfg?.tools?.web?.economicCalendar;
  if (!economicCalendar || typeof economicCalendar !== "object") {
    return undefined;
  }
  return economicCalendar as EconomicCalendarConfig;
}

function resolveCalendarEnabled(params: {
  calendar?: EconomicCalendarConfig;
  sandboxed?: boolean;
}): boolean {
  if (typeof params.calendar?.enabled === "boolean") {
    return params.calendar.enabled;
  }
  return true;
}

function resolveCalendarApiKey(calendar?: EconomicCalendarConfig): string | undefined {
  const fromConfig =
    calendar && "apiKey" in calendar && typeof calendar.apiKey === "string"
      ? normalizeSecretInput(calendar.apiKey)
      : "";
  const fromEnv = normalizeSecretInput(process.env.TRADING_ECONOMICS_API_KEY);
  return fromConfig || fromEnv || undefined;
}

function resolveBaseUrl(calendar?: EconomicCalendarConfig): string {
  const fromConfig =
    calendar && "baseUrl" in calendar && typeof calendar.baseUrl === "string"
      ? calendar.baseUrl.trim()
      : "";
  return fromConfig || DEFAULT_TRADING_ECONOMICS_BASE_URL;
}

function missingCalendarKeyPayload() {
  return {
    error: "missing_trading_economics_api_key",
    message: `economic_calendar needs a Trading Economics API key. Set TRADING_ECONOMICS_API_KEY in the Gateway environment, or configure tools.web.economicCalendar.apiKey (for example via \`${formatCliCommand("openclaw configure --section web")}\`).`,
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function formatUtcDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const d = `${date.getUTCDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addUtcDays(start: string, days: number): string {
  const [year, month, day] = start.split("-").map((part) => Number.parseInt(part, 10));
  const date = new Date(Date.UTC(year, month - 1, day + Math.max(0, Math.floor(days))));
  return formatUtcDate(date);
}

function resolveDateRange(params: {
  startDate?: string;
  endDate?: string;
  daysAhead: number;
}): { startDate: string; endDate: string } | { error: Record<string, unknown> } {
  const today = formatUtcDate(new Date());
  const startDate = params.startDate?.trim() || today;
  if (!isValidIsoDate(startDate)) {
    return {
      error: {
        error: "invalid_start_date",
        message: "startDate must be in YYYY-MM-DD format.",
      },
    };
  }

  const defaultEndDate = addUtcDays(startDate, params.daysAhead);
  const endDate = params.endDate?.trim() || defaultEndDate;
  if (!isValidIsoDate(endDate)) {
    return {
      error: {
        error: "invalid_end_date",
        message: "endDate must be in YYYY-MM-DD format.",
      },
    };
  }

  if (startDate > endDate) {
    return {
      error: {
        error: "invalid_date_range",
        message: "startDate must be before or equal to endDate.",
      },
    };
  }

  return { startDate, endDate };
}

function resolveImportance(value: unknown): (typeof IMPORTANCE_LEVELS)[number] | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.trunc(value);
  if (!IMPORTANCE_LEVELS.includes(normalized as (typeof IMPORTANCE_LEVELS)[number])) {
    return undefined;
  }
  return normalized as (typeof IMPORTANCE_LEVELS)[number];
}

function resolveCountries(value: string | undefined, fallbackCountry?: string): string[] {
  const source = value?.trim() || fallbackCountry?.trim() || "all";
  const countries = source
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return countries.length > 0 ? countries : ["all"];
}

function parseNumericValue(raw: string | number | null | undefined): number | undefined {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : undefined;
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const match = raw.trim().match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return undefined;
  }
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeImportance(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeEventItem(item: TradingEconomicsCalendarItem) {
  return {
    calendarId: item.CalendarId,
    date: item.Date,
    country: item.Country,
    category: item.Category,
    event: item.Event,
    actual: item.Actual ?? undefined,
    consensus: item.Forecast ?? undefined,
    previous: item.Previous ?? undefined,
    teForecast: item.TEForecast ?? undefined,
    actualNumber: parseNumericValue(item.Actual),
    consensusNumber: parseNumericValue(item.Forecast),
    previousNumber: parseNumericValue(item.Previous),
    importance: normalizeImportance(item.Importance),
    currency: item.Currency,
    unit: item.Unit,
    source: item.Source,
    reference: item.Reference,
    url: item.URL,
    lastUpdate: item.LastUpdate,
  };
}

async function runEconomicCalendar(params: {
  apiKey: string;
  baseUrl: string;
  countries: string[];
  startDate: string;
  endDate: string;
  importance?: (typeof IMPORTANCE_LEVELS)[number];
  eventFilter?: string;
  maxEvents: number;
  timeoutSeconds: number;
  cacheTtlMs: number;
}): Promise<Record<string, unknown>> {
  const countriesPath = params.countries.map((country) => encodeURIComponent(country)).join(",");
  const trimmedBase = params.baseUrl.trim().replace(/\/$/, "");
  const url = new URL(
    `${trimmedBase}/calendar/country/${countriesPath}/${params.startDate}/${params.endDate}`,
  );
  url.searchParams.set("c", params.apiKey);
  url.searchParams.set("f", "json");
  if (params.importance !== undefined) {
    url.searchParams.set("importance", String(params.importance));
  }

  const cacheKey = normalizeCacheKey(
    `economic_calendar:${url.toString()}:${params.eventFilter ?? ""}:${params.maxEvents}`,
  );
  const cached = readCache(CALENDAR_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detailResult = await readResponseText(res, { maxBytes: 64_000 });
    const detail = detailResult.text;
    throw new Error(`Trading Economics API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as TradingEconomicsCalendarItem[] | Record<string, unknown>;
  const items = Array.isArray(data) ? data : [];
  const eventFilter = params.eventFilter?.trim().toLowerCase() || "";

  const normalized = items
    .map(normalizeEventItem)
    .filter((item) => !eventFilter || item.event?.toLowerCase().includes(eventFilter))
    .sort((a, b) => {
      const aDate = a.date ?? "";
      const bDate = b.date ?? "";
      return aDate.localeCompare(bDate);
    })
    .slice(0, params.maxEvents);

  const payload = {
    query: {
      countries: params.countries,
      startDate: params.startDate,
      endDate: params.endDate,
      importance: params.importance,
      event: params.eventFilter || undefined,
      maxEvents: params.maxEvents,
    },
    count: normalized.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "api",
      provider: "tradingeconomics",
      wrapped: false,
    },
    events: normalized,
  };
  writeCache(CALENDAR_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

export function createEconomicCalendarTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  const calendar = resolveCalendarConfig(options?.config);
  if (!resolveCalendarEnabled({ calendar, sandboxed: options?.sandboxed })) {
    return null;
  }

  return {
    label: "Economic Calendar",
    name: "economic_calendar",
    description:
      "Fetch Trading Economics calendar events with actual values and market consensus (forecast).",
    parameters: EconomicCalendarSchema,
    execute: async (_toolCallId, args) => {
      const apiKey = resolveCalendarApiKey(calendar);
      if (!apiKey) {
        return jsonResult(missingCalendarKeyPayload());
      }

      const params = args as Record<string, unknown>;
      const startDate = readStringParam(params, "startDate");
      const endDate = readStringParam(params, "endDate");
      const dateRange = resolveDateRange({
        startDate,
        endDate,
        daysAhead:
          typeof calendar?.defaultDaysAhead === "number" && Number.isFinite(calendar.defaultDaysAhead)
            ? Math.max(0, Math.floor(calendar.defaultDaysAhead))
            : DEFAULT_DAYS_AHEAD,
      });
      if ("error" in dateRange) {
        return jsonResult(dateRange.error);
      }

      const rawImportance = readNumberParam(params, "importance", { integer: true });
      const importance = resolveImportance(rawImportance);
      if (rawImportance !== undefined && importance === undefined) {
        return jsonResult({
          error: "invalid_importance",
          message: "importance must be 1, 2, or 3.",
        });
      }

      const maxEventsDefault =
        typeof calendar?.maxEvents === "number" && Number.isFinite(calendar.maxEvents)
          ? Math.max(1, Math.floor(calendar.maxEvents))
          : DEFAULT_MAX_EVENTS;
      const maxEvents = Math.min(
        MAX_EVENTS_CAP,
        Math.max(1, Math.floor(readNumberParam(params, "maxEvents", { integer: true }) ?? maxEventsDefault)),
      );

      const countries = resolveCountries(
        readStringParam(params, "country"),
        typeof calendar?.defaultCountry === "string" ? calendar.defaultCountry : undefined,
      );

      const result = await runEconomicCalendar({
        apiKey,
        baseUrl: resolveBaseUrl(calendar),
        countries,
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        importance,
        eventFilter: readStringParam(params, "event"),
        maxEvents,
        timeoutSeconds: resolveTimeoutSeconds(calendar?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
        cacheTtlMs: resolveCacheTtlMs(calendar?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
      });
      return jsonResult(result);
    },
  };
}

export const __testing = {
  parseNumericValue,
  resolveCountries,
  resolveDateRange,
  resolveImportance,
  normalizeEventItem,
} as const;
