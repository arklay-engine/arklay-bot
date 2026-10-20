import { describe, expect, it } from "vitest";
import {
  codeBlock,
  extractJsonObject,
  parseQuickCommand,
  stripCodeFences,
  titleFromSummary,
} from "../src/util/text.js";

describe("text helpers", () => {
  it("extracts JSON from a fenced response", () => {
    expect(
      extractJsonObject('```json\n{"reply":"hi","ready":false}\n```'),
    ).toEqual({ reply: "hi", ready: false });
  });

  it("extracts the outermost object", () => {
    expect(extractJsonObject('prefix {"a":1} suffix')).toEqual({ a: 1 });
  });

  it("strips fences", () => {
    expect(stripCodeFences("```json\n{}\n```")).toBe("{}");
  });

  it("uses a longer fence when the log contains backticks", () => {
    const result = codeBlock("a ``` b");
    expect(result.startsWith("````")).toBe(true);
  });

  it("cleans issue titles", () => {
    expect(titleFromSummary("[Bug] Game crashes on room entry.")).toBe(
      "Game crashes on room entry",
    );
  });

  it("parses the quick command", () => {
    expect(parseQuickCommand("\\quick No sound plays in a file")).toBe(
      "No sound plays in a file",
    );
    expect(parseQuickCommand("\\Quick line one\nline two")).toBe(
      "line one\nline two",
    );
    expect(parseQuickCommand("\\quick")).toBe("");
    expect(parseQuickCommand("\\quickly no")).toBeNull();
    expect(parseQuickCommand("normal message")).toBeNull();
  });
});
