export type Logger = {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
};

export const logger: Logger = {
  debug(message, meta) {
    write('debug', message, meta);
  },
  info(message, meta) {
    write('info', message, meta);
  },
  warn(message, meta) {
    write('warn', message, meta);
  },
  error(message, meta) {
    write('error', message, meta);
  },
};

function write(level: string, message: string, meta?: unknown): void {
  const line = process.env.LOG_FORMAT === 'json'
    ? formatJsonLine(level, message, meta)
    : formatTextLine(level, message, meta);

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function formatJsonLine(level: string, message: string, meta?: unknown): string {
  return JSON.stringify({
    level,
    time: new Date().toISOString(),
    message,
    ...(meta === undefined ? {} : { meta }),
  });
}

function formatTextLine(level: string, message: string, meta?: unknown): string {
  const parts = [
    new Date().toISOString(),
    level.toUpperCase().padEnd(5),
    message,
  ];
  const suffix = formatMeta(meta);
  if (suffix) {
    parts.push(suffix);
  }
  return parts.join(' ');
}

function formatMeta(meta: unknown): string {
  if (meta === undefined) {
    return '';
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return `meta=${formatValue(meta)}`;
  }

  return Object.entries(meta as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(' ');
}

function formatValue(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value.includes(' ') ? JSON.stringify(value) : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}
