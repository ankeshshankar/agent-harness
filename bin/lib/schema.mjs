// A small JSON Schema (draft 07) checker for agents.config.schema.json. No dependencies.
// Supports: type, required, properties, additionalProperties (boolean or schema), items, enum,
// minimum, maximum, minLength, pattern, oneOf, propertyNames (enum), and local $ref to #/definitions.
// validate(schema, value) returns a list of error strings; an empty list means valid.

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

export function validate(schema, value) {
  const errors = [];
  const resolve = (s) => {
    if (!s || !s.$ref) return s;
    const path = s.$ref.replace(/^#\//, '').split('/');
    return path.reduce((o, k) => o?.[k], schema);
  };
  const walk = (s, v, at) => {
    s = resolve(s);
    if (!s || s === true) return;
    if (s.oneOf) {
      const ok = s.oneOf.some((sub) => {
        const before = errors.length;
        walk(sub, v, at);
        const failed = errors.length > before;
        errors.length = before;
        return !failed;
      });
      if (!ok) errors.push(`${at}: does not match any allowed form`);
      return;
    }
    if (s.type) {
      const t = typeOf(v);
      const okType = s.type === 'integer' ? Number.isInteger(v) : s.type === 'number' ? t === 'number' : t === s.type;
      if (!okType) return void errors.push(`${at}: expected ${s.type}, got ${t}`);
    }
    if (s.enum && !s.enum.includes(v)) errors.push(`${at}: must be one of ${s.enum.join(', ')}`);
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) errors.push(`${at}: must be at least ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) errors.push(`${at}: must be at most ${s.maximum}`);
    }
    if (typeof v === 'string') {
      if (s.minLength !== undefined && v.length < s.minLength) errors.push(`${at}: must not be empty`);
      if (s.pattern && !new RegExp(s.pattern).test(v)) errors.push(`${at}: "${v}" does not match ${s.pattern}`);
    }
    if (Array.isArray(v) && s.items) v.forEach((item, i) => walk(s.items, item, `${at}[${i}]`));
    if (typeOf(v) === 'object') {
      for (const k of s.required ?? []) if (!(k in v)) errors.push(`${at}: missing "${k}"`);
      for (const [k, item] of Object.entries(v)) {
        const here = at === '$' ? k : `${at}.${k}`;
        if (s.propertyNames?.enum && !s.propertyNames.enum.includes(k)) errors.push(`${here}: unknown name`);
        if (s.properties && k in s.properties) walk(s.properties[k], item, here);
        else if (s.additionalProperties === false) errors.push(`${here}: unknown key`);
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') walk(s.additionalProperties, item, here);
      }
    }
  };
  walk(schema, value, '$');
  return errors;
}
