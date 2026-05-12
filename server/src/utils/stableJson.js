/**
 * Deterministic JSON serialization with sorted keys.
 * Used for all cryptographic hash computations so that key-ordering differences
 * never produce different hashes for logically identical objects.
 */
const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
};

module.exports = { stableJson };
