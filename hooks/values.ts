// Readers for values that come from outside the module: the store's JSON,
// a setting, an event's loosely typed field.

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const toText = (value: unknown): string => (typeof value === 'string' ? value : '')
