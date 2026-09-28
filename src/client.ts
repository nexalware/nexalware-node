import { NexalwareApiError } from "./errors.js";
import type {
  CommandDefinition,
  CreateScheduleInput,
  Device,
  LatestTelemetry,
  Schedule,
  SendCommandResult,
  SubDevice,
  TelemetryQuery,
  TelemetryReading,
  UpdateScheduleInput,
} from "./types.js";

export interface NexalwareClientOptions {
  /** A secret API key from the dashboard (API Keys). Must have a
   * DeviceGrant scoping it to whatever device(s)/command(s) it will call. */
  apiKey: string;
  /** Override for self-hosted or staging deployments. Defaults to the
   * production API. */
  baseUrl?: string;
  /** Milliseconds to wait for a response before aborting. Defaults to
   * 30s - a stalled connection should fail loudly, not hang an agent's
   * tool call forever. */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://api.nexalware.com";
const DEFAULT_TIMEOUT_MS = 30_000;

function buildQuery(query?: Record<string, unknown>): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Thin typed wrapper over the Nexalware "Device Control" API tier, the same
 * endpoints an API key can already call today. No MCP, no agent framework,
 * no subprocess, just plain HTTPS, so it works inside any Node/TypeScript
 * agent loop or app, whatever LLM or framework is driving it.
 *
 * A key's actual reach is decided entirely by its DeviceGrant(s) on the
 * dashboard, this client never expands or assumes permissions beyond that.
 */
export class NexalwareClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: NexalwareClientOptions) {
    if (!options.apiKey) throw new Error("NexalwareClient requires an apiKey");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options?: { body?: unknown; query?: Record<string, unknown> }
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}${buildQuery(options?.query)}`;
    // Content-Type describes the body, so it's only sent when there is
    // one - a bodyless POST (turnOn/turnOff) that still claims
    // application/json trips the API's own empty-JSON-body rejection.
    const hasBody = options?.body !== undefined;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "X-Api-Key": this.apiKey,
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
          "User-Agent": "nexalware-sdk",
        },
        body: hasBody ? JSON.stringify(options!.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error(`Nexalware API request to ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    }

    const text = await res.text();
    // The API always returns JSON, but a proxy/CDN error page in front of
    // it (502, WAF block) won't - fail with a clear NexalwareApiError
    // either way rather than an unhandled SyntaxError.
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      if (!res.ok) throw new NexalwareApiError(res.status, { message: text.slice(0, 200) || undefined });
      throw new Error(`Nexalware API returned a non-JSON response from ${path}`);
    }

    if (!res.ok) {
      throw new NexalwareApiError(res.status, (data ?? {}) as { error?: string; message?: string; details?: unknown[] });
    }
    return data as T;
  }

  /**
   * The devices this key can actually act on - only what its own
   * DeviceGrant(s) cover, never the rest of the account. Call this first
   * to discover valid `deviceId`s instead of needing them hardcoded or
   * pasted in from the dashboard.
   *
   * @param query - Omit entirely to list every device this key can reach.
   * @param query.projectId - Only devices in this project. Get a valid
   * value from the `project.projectId` field on a device returned by a
   * prior unfiltered `listDevices()` call, there's no separate "list
   * projects" call.
   * @returns Each device's `deviceId`, `name`, `boardType`, `appType`,
   * `deviceStatus`, `enabled`, `isOnline`, `lastSeen`, and `project`.
   */
  listDevices(query?: { projectId?: string }): Promise<Device[]> {
    return this.request("GET", "/devices", { query });
  }

  /**
   * The command catalog this device accepts. Call this before
   * `sendCommand` so you know what `cmd` values are valid, an
   * unrecognized `cmd` is rejected.
   *
   * @param deviceId - A device's public id, e.g. `"dev_a1b2c3"`, from `listDevices()`.
   * @returns Each command's `name` (use as `cmd`), `label`, `kind`
   * (`"ACTION"` | `"QUERY"`), `paramsSchema` (JSON Schema, or `null` if it
   * takes no params), and `requiresApproval`.
   */
  getCommands(deviceId: string): Promise<CommandDefinition[]> {
    return this.request("GET", `/devices/${deviceId}/commands`);
  }

  /**
   * Send a command to a device, or, with `target` set, to one specific
   * sub-device behind it (see `sendSubDeviceCommand` for the convenience
   * form). Rejected with a `NexalwareApiError` (status 403) if the calling
   * key has no DeviceGrant covering this command.
   *
   * @param deviceId - The device to command, from `listDevices()`.
   * @param cmd - Must exactly match a `name` from `getCommands(deviceId)`, case-sensitive.
   * @param params - Only if that command's catalog entry has a non-null
   * `paramsSchema`, e.g. `SET_BRIGHTNESS` might expect `{ level: 60 }`.
   * Omit entirely for a command that takes none, don't pass `{}`.
   * @param target - Only set this if `deviceId` is a "master" and you want
   * to aim the command at one specific sub-device instead. Prefer
   * `sendSubDeviceCommand` for that case, same call, clearer argument names.
   * @returns `{ ok: true }`, plus `approvalRequired`/`approvalId` if this
   * command required manual approval instead of executing immediately.
   */
  sendCommand(
    deviceId: string,
    cmd: string,
    params?: Record<string, unknown>,
    target?: string
  ): Promise<SendCommandResult> {
    return this.request("POST", `/devices/${deviceId}/command`, {
      body: params ? { cmd, params, target } : { cmd, target },
    });
  }

  /**
   * Shorthand for `sendCommand(deviceId, "ON")`.
   * @param deviceId - The device to turn on.
   */
  turnOn(deviceId: string): Promise<SendCommandResult> {
    return this.request("POST", `/devices/${deviceId}/command/on`);
  }

  /**
   * Shorthand for `sendCommand(deviceId, "OFF")`.
   * @param deviceId - The device to turn off.
   */
  turnOff(deviceId: string): Promise<SendCommandResult> {
    return this.request("POST", `/devices/${deviceId}/command/off`);
  }

  /**
   * Historical telemetry readings, newest first.
   *
   * @param deviceId - The device whose history to read.
   * @param query - Omit entirely for the last 100 readings across every metric.
   * @param query.metric - Only this metric name, e.g. `"power_draw"`. Omit to get every metric.
   * @param query.limit - Max rows, 1-1000. Defaults to 100.
   * @param query.since - Unix **milliseconds**, only readings at or after
   * this instant. For "the last hour": `Date.now() - 60 * 60 * 1000`.
   * @returns Each reading's `metric`, `value`/`valueText` (exactly one is
   * set), `unit`, and `recordedAt`.
   */
  getTelemetry(deviceId: string, query?: TelemetryQuery): Promise<TelemetryReading[]> {
    return this.request("GET", `/devices/${deviceId}/telemetry`, { query });
  }

  /**
   * The device's current state plus the most recent reading per metric,
   * one call instead of paging through `getTelemetry` per metric.
   * @param deviceId - The device to snapshot.
   * @returns `state` (free-form JSON, shape varies per device),
   * `relayState` (`"ON"` | `"OFF"` | `null`), and `telemetry` (latest `TelemetryReading` per metric).
   */
  getLatestTelemetry(deviceId: string): Promise<LatestTelemetry> {
    return this.request("GET", `/devices/${deviceId}/telemetry/latest`);
  }

  /**
   * Physical devices connected locally (not directly to Nexalware) behind
   * this one, if it's acting as an orchestrator ("master"). Empty until
   * the master's own firmware actually reports one.
   * @param deviceId - The **master** device's id, not a sub-device id.
   * @returns Each sub-device's `subDeviceId`, `externalId`, `name`,
   * `state`, `capabilities`, `isOnline`, `lastSeen`.
   */
  listSubDevices(deviceId: string): Promise<SubDevice[]> {
    return this.request("GET", `/devices/${deviceId}/sub-devices`);
  }

  /**
   * One sub-device's current state and capabilities, a single-item version of `listSubDevices`.
   * @param deviceId - The master device's id.
   * @param subDeviceId - One entry's `subDeviceId` from a prior `listSubDevices(deviceId)` call.
   */
  getSubDevice(deviceId: string, subDeviceId: string): Promise<SubDevice> {
    return this.request("GET", `/devices/${deviceId}/sub-devices/${subDeviceId}`);
  }

  /**
   * Same idea as `getTelemetry`, scoped to one sub-device instead of the master itself.
   * @param deviceId - The master device's id.
   * @param subDeviceId - Which sub-device's history to read.
   * @param query - Same `metric`/`limit`/`since` fields as `getTelemetry`'s `query`.
   */
  getSubDeviceTelemetry(
    deviceId: string,
    subDeviceId: string,
    query?: TelemetryQuery
  ): Promise<TelemetryReading[]> {
    return this.request("GET", `/devices/${deviceId}/sub-devices/${subDeviceId}/telemetry`, { query });
  }

  /**
   * The clear-named way to command one sub-device behind a master (same
   * as `sendCommand(deviceId, cmd, params, subDeviceId)`, prefer this,
   * the argument order reads better). Not validated against a catalog
   * server-side, Nexalware relays it to the master opaquely.
   *
   * @param deviceId - The master device's id.
   * @param subDeviceId - Which sub-device to target, from `listSubDevices`.
   * @param cmd - Whatever command name the sub-device's own declared
   * `capabilities.commands` says it accepts (check `getSubDevice`), this
   * is the sub-device's own vocabulary, not a Nexalware-defined catalog.
   * @param params - Arguments for that command, if it needs any.
   */
  sendSubDeviceCommand(
    deviceId: string,
    subDeviceId: string,
    cmd: string,
    params?: Record<string, unknown>
  ): Promise<SendCommandResult> {
    return this.sendCommand(deviceId, cmd, params, subDeviceId);
  }

  /**
   * A device's active schedules, meaning `PENDING` (not fired yet) or `ACTIVE` (currently running).
   * @param deviceId - The device whose schedules to list.
   */
  listSchedules(deviceId: string): Promise<Schedule[]> {
    return this.request("GET", `/devices/${deviceId}/schedules`);
  }

  /**
   * The commands available to schedule for this device, same catalog as `getCommands`.
   * @param deviceId - The device to check.
   */
  getScheduleContext(deviceId: string): Promise<{ commands: CommandDefinition[] }> {
    return this.request("GET", `/devices/${deviceId}/schedules/context`);
  }

  /**
   * Create or replace one of a device's 5 schedule slots, firing
   * `onCommand` at `onTs` and `offCommand` at `offTs`. Calling this again
   * with the same `slot` overwrites what was there, it isn't additive.
   * Rejected with a `NexalwareApiError` (403) if the calling key lacks
   * permission for either command, the same gate `sendCommand` applies.
   *
   * @param deviceId - The device to schedule.
   * @param input - See `CreateScheduleInput` for each field's meaning (slot, onTs, offTs, label, enabled, onCommand, offCommand).
   */
  createSchedule(deviceId: string, input: CreateScheduleInput): Promise<Schedule> {
    return this.request("POST", `/devices/${deviceId}/schedules`, { body: input });
  }

  /**
   * Update an existing schedule slot, only the fields present in `input` are changed.
   * @param deviceId - The device whose schedule to update.
   * @param slot - Which slot (0-4) to update, must already exist (created via `createSchedule`).
   * @param input - Same fields as `createSchedule`'s `input` minus `slot`, all optional, include only what's changing.
   */
  updateSchedule(deviceId: string, slot: number, input: UpdateScheduleInput): Promise<Schedule> {
    return this.request("PUT", `/devices/${deviceId}/schedules/${slot}`, { body: input });
  }

  /**
   * Cancel a schedule slot, freeing it up for a future `createSchedule` call.
   * @param deviceId - The device whose schedule to cancel.
   * @param slot - Which slot (0-4) to cancel.
   */
  deleteSchedule(deviceId: string, slot: number): Promise<{ ok: true }> {
    return this.request("DELETE", `/devices/${deviceId}/schedules/${slot}`);
  }

  /**
   * A device's completed or cancelled schedules, most recent first, for auditing what actually ran.
   * @param deviceId - The device to check.
   */
  getScheduleHistory(deviceId: string): Promise<Schedule[]> {
    return this.request("GET", `/devices/${deviceId}/schedules/history`);
  }
}
