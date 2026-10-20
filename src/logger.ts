type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function configuredLevel(): Level {
  const value = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return value === "debug" || value === "warn" || value === "error"
    ? value
    : "info";
}

function log(level: Level, message: string, extra?: unknown): void {
  if (order[level] < order[configuredLevel()]) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
  if (extra === undefined) {
    console.log(line);
  } else {
    console.log(line, extra);
  }
}

export const logger = {
  debug: (message: string, extra?: unknown) => log("debug", message, extra),
  info: (message: string, extra?: unknown) => log("info", message, extra),
  warn: (message: string, extra?: unknown) => log("warn", message, extra),
  error: (message: string, extra?: unknown) => log("error", message, extra),
};
