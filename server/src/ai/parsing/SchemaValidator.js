/**
 * Minimal JSON Schema validator covering the subset used in tool schemas:
 * type, required, additionalProperties, properties with type/enum/min/max constraints.
 */
class SchemaValidator {
  validate(schema, value) {
    const errors = [];
    this._validate(schema, value, '', errors);
    return { valid: errors.length === 0, errors };
  }

  _validate(schema, value, path, errors) {
    if (!schema || typeof schema !== 'object') return;

    const label = path || 'root';

    if (schema.type === 'object') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`${label}: expected object`);
        return;
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!schema.properties || !(key in schema.properties)) {
            errors.push(`${label}: unexpected property "${key}"`);
          }
        }
      }
      for (const key of (schema.required || [])) {
        if (!(key in value) || value[key] === undefined || value[key] === null) {
          errors.push(`${label}.${key}: required`);
        }
      }
      for (const [key, subSchema] of Object.entries(schema.properties || {})) {
        if (key in value && value[key] !== undefined && value[key] !== null) {
          this._validate(subSchema, value[key], `${label}.${key}`, errors);
        }
      }
      return;
    }

    if (schema.type === 'string') {
      if (typeof value !== 'string') { errors.push(`${label}: expected string`); return; }
      if (schema.minLength !== undefined && value.length < schema.minLength)
        errors.push(`${label}: minLength ${schema.minLength}`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength)
        errors.push(`${label}: maxLength ${schema.maxLength}`);
      if (schema.enum && !schema.enum.includes(value))
        errors.push(`${label}: must be one of [${schema.enum.join(', ')}]`);
      if (schema.pattern && !(new RegExp(schema.pattern).test(value)))
        errors.push(`${label}: does not match required pattern`);
      return;
    }

    if (schema.type === 'number') {
      if (typeof value !== 'number') { errors.push(`${label}: expected number`); return; }
      if (!Number.isFinite(value)) { errors.push(`${label}: expected finite number`); return; }
      if (schema.minimum !== undefined && value < schema.minimum)
        errors.push(`${label}: minimum ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum)
        errors.push(`${label}: maximum ${schema.maximum}`);
      if (schema.integer === true && !Number.isInteger(value))
        errors.push(`${label}: expected integer`);
      return;
    }

    if (schema.type === 'boolean') {
      if (typeof value !== 'boolean') errors.push(`${label}: expected boolean`);
    }
  }
}

module.exports = { SchemaValidator };
