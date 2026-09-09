/** Stable wire error codes; messages are descriptive, never authorization inputs. */
export class RuntimeError extends Error {
  constructor(code, message, status = 400) {
    super(message); this.name = 'RuntimeError'; this.code = code; this.status = status;
  }
}

export function jsonClone(value) {
  const seen = new Set();
  function check(item, depth = 0) {
    if (depth > 64) throw new RuntimeError('INVALID_JSON', 'JSON nesting exceeds 64 levels');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) || seen.has(item)) throw new RuntimeError('INVALID_JSON', 'Expected acyclic, lossless JSON data');
    seen.add(item);
    if (Object.getOwnPropertySymbols(item).length) throw new RuntimeError('INVALID_JSON', 'Symbol fields are not supported');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Array.isArray(item)) {
      if (Object.keys(descriptors).length !== item.length + 1) throw new RuntimeError('INVALID_JSON', 'Sparse arrays are not supported');
      delete descriptors.length;
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key) || !descriptor.enumerable || !('value' in descriptor)) throw new RuntimeError('INVALID_JSON', 'Unsafe or non-data JSON property');
      check(descriptor.value, depth + 1);
    }
    seen.delete(item);
  }
  check(value);
  return JSON.parse(JSON.stringify(value));
}

export function canonicalJson(value) {
  const canonical = item => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return JSON.stringify(canonical(jsonClone(value)));
}
