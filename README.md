# @nexalware/sdk

Typed client for the [Nexalware](https://nexalware.com) API, control physical devices and read their telemetry from any Node/TypeScript agent or app. No MCP, no subprocess, no extra runtime, just `fetch` under the hood, so it works inside any Node/TypeScript agent loop, script, or backend, whatever LLM or framework is driving it, or none at all.

Writing in Python instead? See [`nexalware`](https://pypi.org/project/nexalware/) on PyPI. Want an MCP-aware host to discover these as tools automatically instead of calling them from code? See [`@nexalware/mcp`](https://www.npmjs.com/package/@nexalware/mcp).

## Install

```bash
npm install @nexalware/sdk
```

## Quickstart

```ts
import { NexalwareClient } from "@nexalware/sdk";

const client = new NexalwareClient({
  apiKey: process.env.NEXALWARE_API_KEY!,
});

await client.turnOn("dev_a1b2c3");

const latest = await client.getLatestTelemetry("dev_a1b2c3");
console.log(latest.state, latest.telemetry);
```

Get an API key from the [dashboard](https://nexalware.com) (API Keys), and make sure it has a DeviceGrant covering the device(s) and command(s) you call, an ungranted key authenticates fine but every call is rejected with a 403.

> **Server-side only.** This client sends your API key as a plain header on every request. Never import it into frontend/browser code, anyone opening dev tools or reading the shipped JS bundle would see the key. Call it from a backend, script, or agent process, and if a browser needs to trigger a device action, put your own authenticated endpoint in between.

## `new NexalwareClient(options)`

| Option | Type | Required | Meaning |
|---|---|---|---|
| `apiKey` | string | yes | A secret key from the dashboard. |
| `baseUrl` | string | no | Override for a self-hosted or staging deployment. Defaults to `https://api.nexalware.com`. |
| `timeoutMs` | number | no | Abort a request after this many milliseconds. Defaults to `30000`. |

## Errors

Every method throws `NexalwareApiError` on a non-2xx response, it never resolves with a "silent" error object.

| Field | Type | Meaning |
|---|---|---|
| `status` | number | HTTP status code. |
| `error` | string | Short machine-readable code, e.g. `"FORBIDDEN"`, `"NOT_FOUND"`. |
| `message` | string | Human-readable reason, same text a dashboard user would see. |
| `details` | array | Only present on a 400 validation failure. |

```ts
import { NexalwareApiError } from "@nexalware/sdk";

try {
  await client.sendCommand("dev_a1b2c3", "SET_BRIGHTNESS", { level: 60 });
} catch (err) {
  if (err instanceof NexalwareApiError) {
    console.error(err.status, err.error, err.message);
  }
}
```

## Methods

Every method below is documented the same way: what each parameter actually means and how to fill it in, then a real example, then the return shape. If you've never touched this platform before, read `listDevices` and `sendCommand` first, almost everything else is a variation on those two.

### `listDevices(query?)`

The devices this key can actually act on, only what its own [DeviceGrant](https://docs.nexalware.com/docs/concepts/authentication-and-access)(s) cover, never the rest of the account. This is the right first call when you don't already know a `deviceId`, don't guess one or ask the user to dig it out of the dashboard, just ask the API.

**Parameters**

- **`query`** (object, optional) — Omit this entirely to list every device the key can reach.
  - **`projectId`** (string, optional) — Pass this only if you want to narrow the list to one project (Nexalware's grouping mechanism for devices, e.g. "Warehouse A" vs "Warehouse B"). Get a valid value by first calling `listDevices()` with no filter and reading the `project.projectId` field off whatever comes back, there's no separate "list projects" call, projects only ever show up as a field on a device.

**Example**

```ts
// Every device this key can see
const devices = await client.listDevices();
for (const d of devices) {
  console.log(d.deviceId, d.name, d.isOnline ? "online" : "offline");
}

// Only devices in one project
const warehouseDevices = await client.listDevices({ projectId: "proj_a1b2c3" });
```

**Returns** `Promise<Device[]>`

| Field | Type | Meaning |
|---|---|---|
| `deviceId` | string | Use this everywhere else a method asks for `deviceId`. |
| `name` | string | Whatever the human named it on the dashboard, e.g. `"Garage Light"`. |
| `boardType` | string | Free text set at registration, e.g. `"esp32"`. |
| `appType` | string | Free text set at registration, e.g. `"Industrial Automation"`. |
| `deviceStatus` | `"PENDING"` \| `"ACTIVE"` \| `"DISABLED"` \| `"REVOKED"` | `PENDING` means credentials were never generated, it will never come online. `DISABLED` means someone turned it off from the dashboard. |
| `enabled` | boolean | `true` only when `deviceStatus` is `ACTIVE`. |
| `isOnline` | boolean | Live connection state, not the same as `enabled`, a disabled device is never online but an enabled one can still be offline. |
| `lastSeen` | string \| null | ISO timestamp of its last MQTT activity, `null` if it's never connected. |
| `project` | `{ name, projectId } \| null` | `null` if it was never assigned to a project. |

### `getCommands(deviceId)`

The command catalog this device accepts, name/label/params-schema per command. Call this before `sendCommand` so you know what `cmd` values are actually valid, sending an unrecognized `cmd` gets rejected.

**Parameters**

- **`deviceId`** (string, required) — A device's public id, always shaped like `dev_` followed by a short alphanumeric string, e.g. `"dev_a1b2c3"`. Get one from `listDevices()`, never make one up.

**Example**

```ts
const commands = await client.getCommands("dev_a1b2c3");
// [{ name: "ON", label: "Turn on", kind: "ACTION", paramsSchema: null, requiresApproval: false }, ...]
```

**Returns** `Promise<CommandDefinition[]>`

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Command name, use this exact string as `cmd` in `sendCommand`. |
| `label` | string | Human-readable label, e.g. show this in a UI instead of the raw `name`. |
| `kind` | `"ACTION"` \| `"QUERY"` | Whether it changes device state or just reads it. |
| `paramsSchema` | object \| null | JSON Schema describing what `params` this command expects. `null` means it takes no params at all, don't pass any. |
| `requiresApproval` | boolean | If `true`, calling `sendCommand` with this `cmd` still succeeds (HTTP-wise) but queues for manual approval instead of executing immediately, see `sendCommand`'s return shape below. |

A device with no custom catalog (nothing configured beyond the basics) returns the legacy set: `ON`, `OFF`, `TOGGLE`, `STATUS`, none of which take params.

### `sendCommand(deviceId, cmd, params?, target?)`

The general-purpose way to actually make a device do something.

**Parameters**

- **`deviceId`** (string, required) — The device to command, from `listDevices()`.
- **`cmd`** (string, required) — Must exactly match a `name` from `getCommands(deviceId)`. Case-sensitive, `"on"` is not the same as `"ON"`.
- **`params`** (object, optional) — Only include this if the command's catalog entry has a non-`null` `paramsSchema`. For a plain `ON`/`OFF`-style command, omit `params` entirely rather than passing `{}`. Shape depends entirely on that specific command, e.g. `SET_BRIGHTNESS` might expect `{ level: 60 }`, read the device's own `paramsSchema` to know what keys it wants.
- **`target`** (string, optional) — Only set this if `deviceId` is a "master" orchestrating sub-devices and you want to aim the command at one specific sub-device instead of the master itself. If you're doing that, prefer `sendSubDeviceCommand` below instead, it's the exact same call with clearer argument names, this `target` parameter exists mainly so `sendSubDeviceCommand` has something to delegate to.

**Example**

```ts
// No params
await client.sendCommand("dev_a1b2c3", "ON");

// With params
await client.sendCommand("dev_a1b2c3", "SET_BRIGHTNESS", { level: 60 });

// Aimed at a sub-device behind a master (prefer sendSubDeviceCommand for this)
await client.sendCommand("dev_master1", "OPEN", undefined, "sub_x1y2z3");
```

**Returns** `Promise<{ ok: true, approvalRequired?: boolean, approvalId?: string }>` — if `approvalRequired` is `true`, the command has *not* run yet, it's sitting in a queue waiting for an Owner/Admin to approve it from the dashboard; `approvalId` identifies that pending request.

### `turnOn(deviceId)` / `turnOff(deviceId)`

Shorthand for `sendCommand(deviceId, "ON")` / `sendCommand(deviceId, "OFF")`, for the common case of a plain relay-style device.

**Parameters**

- **`deviceId`** (string, required) — The device to turn on/off.

**Example**

```ts
await client.turnOn("dev_a1b2c3");
await client.turnOff("dev_a1b2c3");
```

**Returns** `Promise<{ ok: true }>`

### `getTelemetry(deviceId, query?)`

Historical sensor/telemetry readings a device has reported, newest first.

**Parameters**

- **`deviceId`** (string, required) — The device whose history you want.
- **`query`** (object, optional) — Omit entirely to get the last 100 readings across every metric.
  - **`metric`** (string, optional) — Only return readings for this one metric name, e.g. `"power_draw"`. Metric names are whatever the device itself reports, there's no fixed list, if you don't know one, call this once without `metric` and look at what comes back.
  - **`limit`** (number, optional) — How many rows to return, from 1 to 1000. Defaults to 100 if omitted.
  - **`since`** (number, optional) — Unix **milliseconds**. Only readings recorded at or after this instant. To get "the last hour," pass `Date.now() - 60 * 60 * 1000`.

**Example**

```ts
// Last 100 readings, any metric
const recent = await client.getTelemetry("dev_a1b2c3");

// Last hour of just power_draw
const power = await client.getTelemetry("dev_a1b2c3", {
  metric: "power_draw",
  since: Date.now() - 60 * 60 * 1000,
});
```

**Returns** `Promise<TelemetryReading[]>`

| Field | Type | Meaning |
|---|---|---|
| `metric` | string | Which metric this reading is for. |
| `value` | number \| null | Numeric reading, e.g. `4.2`. |
| `valueText` | string \| null | Non-numeric reading instead, e.g. a status string. Exactly one of `value`/`valueText` is set. |
| `unit` | string \| null | Whatever unit the device declared, e.g. `"watts"`. |
| `recordedAt` | string | ISO timestamp of when the device reported it. |

### `getLatestTelemetry(deviceId)`

The device's current state snapshot plus the most recent reading for every metric it reports, in one call, instead of calling `getTelemetry` per metric and picking off the newest row yourself.

**Parameters**

- **`deviceId`** (string, required) — The device to snapshot.

**Example**

```ts
const latest = await client.getLatestTelemetry("dev_a1b2c3");
console.log(latest.relayState);   // "ON" | "OFF" | null
console.log(latest.state);        // whatever free-form state this device reports
console.log(latest.telemetry);    // TelemetryReading[], one per metric, all "latest"
```

**Returns** `Promise<{ state, relayState, telemetry: TelemetryReading[] }>` — `state` is free-form JSON the device itself reports (shape varies per device), `relayState` is `"ON"`/`"OFF"`/`null` for a plain relay-style device specifically.

### `listSubDevices(deviceId)`

Physical devices connected locally (not directly to Nexalware) behind this one, if it's acting as a master orchestrating them. Returns an empty array until the master's own firmware actually reports one, this is never populated automatically and never includes software agents, only physical sub-devices the master itself describes.

**Parameters**

- **`deviceId`** (string, required) — The **master** device's id, not a sub-device id.

**Example**

```ts
const subs = await client.listSubDevices("dev_master1");
// [] until the master's firmware calls its own "report sub-device" step
```

**Returns** `Promise<SubDevice[]>`, each with `subDeviceId`, `externalId` (whatever id the master itself uses for it), `name`, `state`, `capabilities` (its own command catalog, if it declared one), `isOnline`, `lastSeen`.

### `getSubDevice(deviceId, subDeviceId)`

One sub-device's current state and capabilities, a single-item version of `listSubDevices`.

**Parameters**

- **`deviceId`** (string, required) — The master device's id.
- **`subDeviceId`** (string, required) — One entry's `subDeviceId` from a prior `listSubDevices(deviceId)` call, shaped like `"sub_x1y2z3"`.

**Example**

```ts
const sub = await client.getSubDevice("dev_master1", "sub_x1y2z3");
```

**Returns** `Promise<SubDevice>` — same shape as one entry from `listSubDevices`.

### `getSubDeviceTelemetry(deviceId, subDeviceId, query?)`

Same idea as `getTelemetry`, scoped to one sub-device instead of the master itself.

**Parameters**

- **`deviceId`** (string, required) — The master device's id.
- **`subDeviceId`** (string, required) — Which sub-device's history to read.
- **`query`** (object, optional) — Same three fields as `getTelemetry`'s `query`: `metric`, `limit`, `since`, identical meaning.

**Example**

```ts
const readings = await client.getSubDeviceTelemetry("dev_master1", "sub_x1y2z3", { limit: 50 });
```

**Returns** `Promise<TelemetryReading[]>` — same shape as `getTelemetry`'s return.

### `sendSubDeviceCommand(deviceId, subDeviceId, cmd, params?)`

The clear-named way to command one sub-device behind a master (equivalent to calling `sendCommand(deviceId, cmd, params, subDeviceId)`, use this instead, the argument order reads better). Not validated against a catalog server-side the way `sendCommand` is for a top-level device, Nexalware relays it to the master opaquely, and the master and sub-device interpret the command between themselves.

**Parameters**

- **`deviceId`** (string, required) — The master device's id.
- **`subDeviceId`** (string, required) — Which sub-device to target, from `listSubDevices`.
- **`cmd`** (string, required) — Whatever command name the sub-device's own declared `capabilities.commands` says it accepts (check `getSubDevice`'s result), this is the master/sub-device's own vocabulary, not a Nexalware-defined catalog.
- **`params`** (object, optional) — Arguments for that command, if it needs any, shape is whatever the sub-device itself expects.

**Example**

```ts
await client.sendSubDeviceCommand("dev_master1", "sub_x1y2z3", "OPEN");
await client.sendSubDeviceCommand("dev_master1", "sub_x1y2z3", "SET_POSITION", { angle: 45 });
```

**Returns** `Promise<{ ok: true }>`

### `listSchedules(deviceId)`

A device's active schedules, meaning `PENDING` (not fired yet) or `ACTIVE` (currently running between its on/off times).

**Parameters**

- **`deviceId`** (string, required) — The device whose schedules to list.

**Example**

```ts
const schedules = await client.listSchedules("dev_a1b2c3");
```

**Returns** `Promise<Schedule[]>`, each with `scheduleId`, `slot`, `onTs`, `offTs`, `label`, `enabled`, `status`, `onCommand`, `offCommand`.

### `getScheduleContext(deviceId)`

The commands available to schedule for this device, exactly the same catalog `getCommands` returns, this exists so schedule-building UI code doesn't need to call two different endpoints for the same information.

**Parameters**

- **`deviceId`** (string, required) — The device to check.

**Example**

```ts
const { commands } = await client.getScheduleContext("dev_a1b2c3");
```

**Returns** `Promise<{ commands: CommandDefinition[] }>` — same `CommandDefinition` shape documented under `getCommands`.

### `createSchedule(deviceId, input)`

Create or replace one of a device's 5 schedule slots, firing `onCommand` at `onTs` and `offCommand` at `offTs`. "Replace" means calling this again with the same `slot` overwrites whatever was there before, it isn't additive.

**Parameters**

- **`deviceId`** (string, required) — The device to schedule.
- **`input`** (object, required) — All the fields below go inside this one object.
  - **`slot`** (number, required) — Which of the device's 5 schedule slots to use, an integer from **0 to 4**. Think of these as 5 fixed "rows" a device has for schedules, not an auto-incrementing list, you pick which row.
  - **`onTs`** (number, required) — Unix **seconds** (not milliseconds, unlike telemetry's `since`) for when to fire `onCommand`. To schedule something starting in one hour: `Math.floor(Date.now() / 1000) + 3600`.
  - **`offTs`** (number, required) — Unix seconds for when to fire `offCommand`. Must make sense relative to `onTs` for your use case, the API doesn't force `offTs > onTs` (an overnight schedule legitimately has `offTs` "before" `onTs` in clock time).
  - **`label`** (string, optional) — A short label shown on the dashboard next to this schedule. **Max 7 characters** - this is a hard limit, e.g. `"Evening"` doesn't fit but `"Eve"` does.
  - **`enabled`** (boolean, optional) — Whether the schedule is active. Omit to default to enabled; pass `false` to create it disabled (useful for staging a schedule you're not ready to turn on yet).
  - **`onCommand`** (object, optional) — Shape: `{ command: string, params?: object }`. Which command fires at `onTs`. Omit entirely to default to `{ command: "ON" }`. `command` must be a valid `cmd` from `getCommands`, exactly like `sendCommand`.
  - **`offCommand`** (object, optional) — Same shape as `onCommand`, fires at `offTs`. Defaults to `{ command: "OFF" }` if omitted.

**Example**

```ts
// Simplest case: plain ON at 7am, OFF at 10pm, using the defaults
await client.createSchedule("dev_a1b2c3", {
  slot: 0,
  onTs: Math.floor(new Date("2026-01-01T07:00:00Z").getTime() / 1000),
  offTs: Math.floor(new Date("2026-01-01T22:00:00Z").getTime() / 1000),
  label: "Day",
});

// Custom commands instead of plain ON/OFF
await client.createSchedule("dev_a1b2c3", {
  slot: 1,
  onTs: Math.floor(Date.now() / 1000) + 3600,
  offTs: Math.floor(Date.now() / 1000) + 7200,
  onCommand: { command: "SET_BRIGHTNESS", params: { level: 80 } },
  offCommand: { command: "OFF" },
});
```

**Returns** `Promise<Schedule>`. Rejected with a `NexalwareApiError` (status 403) if the calling key lacks permission for either command, this is the exact same DeviceGrant check `sendCommand` applies, a schedule is just that same action, deferred to a later time.

### `updateSchedule(deviceId, slot, input)`

Update an existing schedule slot, only the fields you actually pass in `input` are changed, everything else stays as it was.

**Parameters**

- **`deviceId`** (string, required) — The device whose schedule to update.
- **`slot`** (number, required) — Which slot (0-4) to update, must already exist (created via `createSchedule`).
- **`input`** (object, required) — Same fields as `createSchedule`'s `input`, minus `slot` (that's a separate argument here), and every field is optional, include only what you're changing.

**Example**

```ts
// Only change the off-time, leave everything else as-is
await client.updateSchedule("dev_a1b2c3", 0, { offTs: Math.floor(Date.now() / 1000) + 3600 });

// Disable it without deleting it
await client.updateSchedule("dev_a1b2c3", 0, { enabled: false });
```

**Returns** `Promise<Schedule>`

### `deleteSchedule(deviceId, slot)`

Cancel a schedule slot, freeing it up for a future `createSchedule` call.

**Parameters**

- **`deviceId`** (string, required) — The device whose schedule to cancel.
- **`slot`** (number, required) — Which slot (0-4) to cancel.

**Example**

```ts
await client.deleteSchedule("dev_a1b2c3", 0);
```

**Returns** `Promise<{ ok: true }>`

### `getScheduleHistory(deviceId)`

A device's completed or cancelled schedules, most recent first, for auditing what actually ran.

**Parameters**

- **`deviceId`** (string, required) — The device to check.

**Example**

```ts
const history = await client.getScheduleHistory("dev_a1b2c3");
```

**Returns** `Promise<Schedule[]>` — same `Schedule` shape as `listSchedules`, but for slots that are `COMPLETED` or `CANCELLED` rather than still pending/active.

Full reference with every return type spelled out: **[SDK Reference](https://docs.nexalware.com/docs/sdk/sdk)**.

## Links

- [Docs](https://docs.nexalware.com)
- [Device Orchestration](https://docs.nexalware.com/docs/device-orchestration) - sub-devices, and the contract a master implements to report them.
- [Authentication & Access](https://docs.nexalware.com/docs/concepts/authentication-and-access) - API keys and DeviceGrants.

## License

MIT
