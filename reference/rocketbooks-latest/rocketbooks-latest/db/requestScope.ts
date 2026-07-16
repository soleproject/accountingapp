const requestValues = new WeakMap<object, unknown>();

export function getRequestScopedValue<T>(requestContext: object, create: () => T): T {
  const existing = requestValues.get(requestContext) as T | undefined;
  if (existing !== undefined) return existing;

  const value = create();
  requestValues.set(requestContext, value);
  return value;
}
