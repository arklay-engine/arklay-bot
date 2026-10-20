import { z } from "zod";
import { emptySlots } from "../types.js";

const slotValue = z
  .union([z.string(), z.number(), z.boolean(), z.null()])
  .optional()
  .transform((value) => (value == null ? "" : String(value)));

export const SlotsSchema = z.object({
  report_type: slotValue,
  area: slotValue,
  summary: slotValue,
  game: slotValue,
  release: slotValue,
  version: slotValue,
  os: slotValue,
  gpu: slotValue,
  renderer: slotValue,
  mods: slotValue,
  steps: slotValue,
  expected: slotValue,
  actual: slotValue,
  frequency: slotValue,
  logs: slotValue,
  screenshots: slotValue,
  save_file: slotValue,
  diagnostics: slotValue,
  attachments: slotValue,
  notes: slotValue,
});

export const LlmTurnSchema = z.object({
  reply: z.string().default(""),
  slots: SlotsSchema.default(() => emptySlots()),
  missing: z.array(z.string()).default([]),
  ready: z.boolean().default(false),
  title: z.string().default(""),
});

export const DedupeMatchSchema = z.object({
  number: z.coerce.number().int().positive(),
  confidence: z.coerce.number().min(0).max(1).catch(0.5),
  same_bug: z
    .union([z.boolean(), z.string()])
    .transform((value) =>
      typeof value === "boolean"
        ? value
        : ["true", "yes", "1"].includes(value.toLowerCase()),
    ),
  reason: z.string().default(""),
});

export const DedupeResultSchema = z.object({
  matches: z.array(DedupeMatchSchema).default([]),
});
