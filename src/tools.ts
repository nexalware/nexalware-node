import { z } from "zod";
import type { NexalwareClient } from "./client.js";

const paramsSchema = z
  .record(z.unknown())
  .optional()
  .describe("Arguments for this command, only if its command definition declares a paramsSchema.");

const actionSchema = z.object({
  command: z.string().describe("A command name from the device's catalog, e.g. \"ON\" or \"SET_BRIGHTNESS\"."),
  params: z.record(z.unknown()).optional(),
});

/**
 * One entry per callable operation, each pairing a zod input schema with a
 * handler that calls the matching `NexalwareClient` method. This is the
 * single source of truth for "what can an agent do to a device", any
 * adapter (the MCP server today, an OpenAI function-calling export, a
 * LangChain toolkit later) is just a thin loop over this list, so the set
 * of capabilities can't drift between adapters.
 */
export const tools = [
  {
    name: "list_devices",
    description:
      "List the devices this API key can actually act on - only what its own DeviceGrant(s) cover, never the rest of the account. " +
      "Call this first to discover valid deviceId values instead of guessing or asking the user to paste one in.",
    inputSchema: z.object({
      projectId: z.string().optional().describe("Only list devices in this project."),
    }),
    handler: (input: { projectId?: string }, client: NexalwareClient) => client.listDevices(input),
  },
  {
    name: "get_device_commands",
    description: "List the commands a device accepts: name, label, and the params each one expects.",
    inputSchema: z.object({ deviceId: z.string().describe("The device's public id, e.g. dev_a1b2c3.") }),
    handler: (input: { deviceId: string }, client: NexalwareClient) => client.getCommands(input.deviceId),
  },
  {
    name: "send_command",
    description:
      "Send a command to a device. Check get_device_commands first for valid cmd names and expected params. " +
      "Rejected if the calling key has no permission for this device/command.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device's public id, e.g. dev_a1b2c3."),
      cmd: z.string().describe("Command name, matches one of get_device_commands' results."),
      params: paramsSchema,
    }),
    handler: (input: { deviceId: string; cmd: string; params?: Record<string, unknown> }, client: NexalwareClient) =>
      client.sendCommand(input.deviceId, input.cmd, input.params),
  },
  {
    name: "turn_device_on",
    description: "Shorthand for sending the ON command to a device.",
    inputSchema: z.object({ deviceId: z.string().describe("The device's public id, e.g. dev_a1b2c3.") }),
    handler: (input: { deviceId: string }, client: NexalwareClient) => client.turnOn(input.deviceId),
  },
  {
    name: "turn_device_off",
    description: "Shorthand for sending the OFF command to a device.",
    inputSchema: z.object({ deviceId: z.string().describe("The device's public id, e.g. dev_a1b2c3.") }),
    handler: (input: { deviceId: string }, client: NexalwareClient) => client.turnOff(input.deviceId),
  },
  {
    name: "get_device_telemetry",
    description: "Read a device's telemetry history, newest first.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device's public id, e.g. dev_a1b2c3."),
      metric: z.string().optional().describe("Only return readings for this metric."),
      limit: z.number().int().min(1).max(1000).optional().describe("Max rows to return, defaults to 100."),
      since: z.number().int().optional().describe("Unix ms, only readings recorded at or after this time."),
    }),
    handler: (
      input: { deviceId: string; metric?: string; limit?: number; since?: number },
      client: NexalwareClient
    ) => client.getTelemetry(input.deviceId, { metric: input.metric, limit: input.limit, since: input.since }),
  },
  {
    name: "get_latest_telemetry",
    description: "Read a device's current state plus the most recent reading per telemetry metric.",
    inputSchema: z.object({ deviceId: z.string().describe("The device's public id, e.g. dev_a1b2c3.") }),
    handler: (input: { deviceId: string }, client: NexalwareClient) => client.getLatestTelemetry(input.deviceId),
  },
  {
    name: "list_sub_devices",
    description:
      "List the physical sub-devices connected locally behind this device, if it's acting as a master. " +
      "Empty until the master actually reports one, this never includes software agents.",
    inputSchema: z.object({ deviceId: z.string().describe("The master device's public id.") }),
    handler: (input: { deviceId: string }, client: NexalwareClient) => client.listSubDevices(input.deviceId),
  },
  {
    name: "get_sub_device",
    description: "Read one sub-device's current state and capabilities.",
    inputSchema: z.object({
      deviceId: z.string().describe("The master device's public id."),
      subDeviceId: z.string().describe("The sub-device's public id, e.g. sub_x1y2z3."),
    }),
    handler: (input: { deviceId: string; subDeviceId: string }, client: NexalwareClient) =>
      client.getSubDevice(input.deviceId, input.subDeviceId),
  },
  {
    name: "get_sub_device_telemetry",
    description: "Read one sub-device's telemetry history, newest first.",
    inputSchema: z.object({
      deviceId: z.string().describe("The master device's public id."),
      subDeviceId: z.string().describe("The sub-device's public id, e.g. sub_x1y2z3."),
      metric: z.string().optional().describe("Only return readings for this metric."),
      limit: z.number().int().min(1).max(1000).optional().describe("Max rows to return, defaults to 100."),
      since: z.number().int().optional().describe("Unix ms, only readings recorded at or after this time."),
    }),
    handler: (
      input: { deviceId: string; subDeviceId: string; metric?: string; limit?: number; since?: number },
      client: NexalwareClient
    ) =>
      client.getSubDeviceTelemetry(input.deviceId, input.subDeviceId, {
        metric: input.metric,
        limit: input.limit,
        since: input.since,
      }),
  },
  {
    name: "send_sub_device_command",
    description:
      "Send a command to one specific sub-device behind a master, instead of the master itself. " +
      "Not validated against a catalog, Nexalware relays it opaquely, the master and sub-device interpret it.",
    inputSchema: z.object({
      deviceId: z.string().describe("The master device's public id."),
      subDeviceId: z.string().describe("The sub-device's public id, e.g. sub_x1y2z3."),
      cmd: z.string().describe("Command name, whatever the sub-device declared it accepts."),
      params: paramsSchema,
    }),
    handler: (
      input: { deviceId: string; subDeviceId: string; cmd: string; params?: Record<string, unknown> },
      client: NexalwareClient
    ) => client.sendSubDeviceCommand(input.deviceId, input.subDeviceId, input.cmd, input.params),
  },
  {
    name: "list_schedules",
    description: "List a device's active (pending or currently running) schedules.",
    inputSchema: z.object({ deviceId: z.string().describe("The device's public id, e.g. dev_a1b2c3.") }),
    handler: (input: { deviceId: string }, client: NexalwareClient) => client.listSchedules(input.deviceId),
  },
  {
    name: "get_schedule_context",
    description: "List the commands available to schedule for a device, same catalog as get_device_commands.",
    inputSchema: z.object({ deviceId: z.string().describe("The device's public id, e.g. dev_a1b2c3.") }),
    handler: (input: { deviceId: string }, client: NexalwareClient) => client.getScheduleContext(input.deviceId),
  },
  {
    name: "create_schedule",
    description:
      "Create or replace one of a device's schedule slots (0-4), firing onCommand at onTs and offCommand at offTs. " +
      "Rejected if the calling key has no permission for either command.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device's public id, e.g. dev_a1b2c3."),
      slot: z.number().int().min(0).max(4).describe("Which of the device's 5 schedule slots (0-4) to use."),
      onTs: z.number().int().describe("Unix seconds to fire onCommand."),
      offTs: z.number().int().describe("Unix seconds to fire offCommand."),
      label: z.string().max(7).optional().describe("Short label shown on the dashboard, max 7 characters."),
      enabled: z.boolean().optional(),
      onCommand: actionSchema.optional().describe('Defaults to { command: "ON" }.'),
      offCommand: actionSchema.optional().describe('Defaults to { command: "OFF" }.'),
    }),
    handler: (
      input: {
        deviceId: string;
        slot: number;
        onTs: number;
        offTs: number;
        label?: string;
        enabled?: boolean;
        onCommand?: { command: string; params?: Record<string, unknown> };
        offCommand?: { command: string; params?: Record<string, unknown> };
      },
      client: NexalwareClient
    ) => {
      const { deviceId, ...rest } = input;
      return client.createSchedule(deviceId, rest);
    },
  },
  {
    name: "update_schedule",
    description: "Update an existing schedule slot, only the fields provided are changed.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device's public id, e.g. dev_a1b2c3."),
      slot: z.number().int().min(0).max(4).describe("Which schedule slot (0-4) to update."),
      onTs: z.number().int().optional(),
      offTs: z.number().int().optional(),
      label: z.string().max(7).optional(),
      enabled: z.boolean().optional(),
      onCommand: actionSchema.optional(),
      offCommand: actionSchema.optional(),
    }),
    handler: (
      input: {
        deviceId: string;
        slot: number;
        onTs?: number;
        offTs?: number;
        label?: string;
        enabled?: boolean;
        onCommand?: { command: string; params?: Record<string, unknown> };
        offCommand?: { command: string; params?: Record<string, unknown> };
      },
      client: NexalwareClient
    ) => {
      const { deviceId, slot, ...rest } = input;
      return client.updateSchedule(deviceId, slot, rest);
    },
  },
  {
    name: "delete_schedule",
    description: "Cancel a schedule slot.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device's public id, e.g. dev_a1b2c3."),
      slot: z.number().int().min(0).max(4).describe("Which schedule slot (0-4) to cancel."),
    }),
    handler: (input: { deviceId: string; slot: number }, client: NexalwareClient) =>
      client.deleteSchedule(input.deviceId, input.slot),
  },
  {
    name: "get_schedule_history",
    description: "List a device's completed or cancelled schedules, most recent first.",
    inputSchema: z.object({ deviceId: z.string().describe("The device's public id, e.g. dev_a1b2c3.") }),
    handler: (input: { deviceId: string }, client: NexalwareClient) => client.getScheduleHistory(input.deviceId),
  },
] as const;

export type ToolName = (typeof tools)[number]["name"];
