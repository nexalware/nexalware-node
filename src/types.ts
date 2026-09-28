export interface Device {
  /** Use this everywhere else a method asks for `deviceId`. */
  deviceId: string;
  /** Whatever the human named it on the dashboard, e.g. `"Garage Light"`. */
  name: string;
  /** Free text set at registration, e.g. `"esp32"`. */
  boardType: string;
  /** Free text set at registration, e.g. `"Industrial Automation"`. */
  appType: string;
  /** `PENDING` means credentials were never generated, it will never come
   * online. `DISABLED` means someone turned it off from the dashboard. */
  deviceStatus: "PENDING" | "ACTIVE" | "DISABLED" | "REVOKED";
  /** `true` only when `deviceStatus` is `ACTIVE`. */
  enabled: boolean;
  deviceTypeId: string | null;
  /** `"ON"`/`"OFF"`-equivalent state for a plain relay-style device. */
  relayState: boolean | null;
  /** Live connection state, not the same as `enabled` - a disabled
   * device is never online, but an enabled one can still be offline. */
  isOnline: boolean;
  /** ISO timestamp of its last MQTT activity, `null` if it's never connected. */
  lastSeen: string | null;
  createdAt: string;
  /** `null` if it was never assigned to a project. */
  project: { name: string; projectId: string } | null;
}

export interface CommandDefinition {
  commandId?: string;
  /** Command name, use this exact string as `cmd` in `sendCommand`. */
  name: string;
  /** Human-readable label, show this in a UI instead of the raw `name`. */
  label: string;
  description?: string;
  /** Whether it changes device state or just reads it. */
  kind: "ACTION" | "QUERY";
  /** JSON Schema describing what `params` this command expects. `null`
   * means it takes no params at all, don't pass any. */
  paramsSchema: Record<string, unknown> | null;
  shape?: Record<string, unknown> | null;
  /** If `true`, sending this command still succeeds (HTTP-wise) but
   * queues for manual approval instead of executing immediately. */
  requiresApproval?: boolean;
}

export interface SendCommandResult {
  ok: true;
  /** If `true`, the command has *not* run yet, it's queued waiting for
   * an Owner/Admin to approve it from the dashboard. */
  approvalRequired?: boolean;
  /** Identifies the pending approval request when `approvalRequired` is `true`. */
  approvalId?: string;
}

export interface TelemetryReading {
  id: string;
  deviceId: string;
  accountId: string;
  subDeviceId: string | null;
  /** Which metric this reading is for, e.g. `"power_draw"`. */
  metric: string;
  /** Numeric reading, e.g. `4.2`. Exactly one of `value`/`valueText` is set. */
  value: number | null;
  /** Non-numeric reading, e.g. a status string. Exactly one of `value`/`valueText` is set. */
  valueText: string | null;
  /** Whatever unit the device declared, e.g. `"watts"`. */
  unit: string | null;
  raw: unknown;
  /** ISO timestamp of when the device reported it. */
  recordedAt: string;
}

export interface LatestTelemetry {
  /** Free-form JSON the device itself reports, shape varies per device. */
  state: Record<string, unknown> | null;
  /** `"ON"`/`"OFF"` for a plain relay-style device specifically. */
  relayState: "ON" | "OFF" | null;
  /** One entry per metric, all "latest". */
  telemetry: TelemetryReading[];
}

export interface SubDeviceCapabilities {
  commands?: { name: string; params_schema?: Record<string, unknown> }[];
  telemetry_metrics?: string[];
  verifiable?: boolean;
}

export interface SubDevice {
  /** Use this wherever a method asks for `subDeviceId`. */
  subDeviceId: string;
  /** Whatever id the master itself uses for it, opaque to Nexalware. */
  externalId: string;
  name: string;
  state: Record<string, unknown> | null;
  /** Its own command catalog, if it declared one, `null` otherwise. */
  capabilities: SubDeviceCapabilities | null;
  verifiable: boolean;
  enabled: boolean;
  isOnline: boolean;
  lastSeen: string | null;
  createdAt: string;
}

export interface TelemetryQuery {
  /** Only return readings for this one metric name, e.g. `"power_draw"`.
   * Metric names are whatever the device itself reports, there's no
   * fixed list - if you don't know one, call without `metric` first and
   * see what comes back. */
  metric?: string;
  /** Max rows to return, 1-1000, defaults to 100. */
  limit?: number;
  /** Unix **milliseconds**, only return readings recorded at or after
   * this instant. For "the last hour": `Date.now() - 60 * 60 * 1000`. */
  since?: number;
  [key: string]: unknown;
}

export interface Action {
  /** A command name from that device's catalog, e.g. "ON" or "SET_BRIGHTNESS". */
  command: string;
  /** Arguments for that command, only if its catalog entry declares a `paramsSchema`. */
  params?: Record<string, unknown>;
}

export interface Schedule {
  scheduleId: string;
  deviceId: string;
  /** Which of the device's 5 fixed schedule slots (0-4) this is. */
  slot: number;
  /** Unix seconds this schedule fires `onCommand`. */
  onTs: number;
  /** Unix seconds this schedule fires `offCommand`. */
  offTs: number;
  label: string;
  enabled: boolean;
  status: "PENDING" | "ACTIVE" | "COMPLETED" | "CANCELLED";
  onCommand: Action;
  offCommand: Action;
}

export interface CreateScheduleInput {
  /** Which of the device's 5 schedule slots to use, an integer from
   * **0 to 4**. Think of these as 5 fixed "rows" a device has for
   * schedules, not an auto-incrementing list - you pick which row.
   * Calling `createSchedule` again with the same `slot` overwrites
   * whatever was there before. */
  slot: number;
  /** Unix **seconds** (not milliseconds, unlike telemetry's `since`) to
   * fire `onCommand`. To start in one hour: `Math.floor(Date.now() / 1000) + 3600`. */
  onTs: number;
  /** Unix seconds to fire `offCommand`. Must make sense relative to
   * `onTs` for your use case - the API doesn't force `offTs > onTs`
   * (an overnight schedule legitimately has `offTs` "before" `onTs" in
   * clock time). */
  offTs: number;
  /** A short label shown on the dashboard next to this schedule.
   * **Max 7 characters** - a hard limit, e.g. `"Evening"` doesn't fit but `"Eve"` does. */
  label?: string;
  /** Whether the schedule is active. Omit to default to enabled; pass
   * `false` to create it disabled (useful for staging one you're not ready to turn on). */
  enabled?: boolean;
  /** Which command fires at `onTs`. Omit entirely to default to
   * `{ command: "ON" }`. `command` must be a valid `cmd` from
   * `getCommands`, exactly like `sendCommand`. */
  onCommand?: Action;
  /** Same shape as `onCommand`, fires at `offTs`. Defaults to `{ command: "OFF" }` if omitted. */
  offCommand?: Action;
}

export interface UpdateScheduleInput {
  /** New fire time for `onCommand`, in Unix seconds. Omit to leave unchanged. */
  onTs?: number;
  /** New fire time for `offCommand`, in Unix seconds. Omit to leave unchanged. */
  offTs?: number;
  /** New label, max 7 characters. Omit to leave unchanged. */
  label?: string;
  /** Enable or disable the schedule. Omit to leave unchanged. */
  enabled?: boolean;
  /** New on-trigger command. Omit to leave unchanged. */
  onCommand?: Action;
  /** New off-trigger command. Omit to leave unchanged. */
  offCommand?: Action;
}
