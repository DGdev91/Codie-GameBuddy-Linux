// Early checks against clt01's external tool catalog rules
// (DEVICE_TOOL_SYSTEM_PLAN.md §4.6). The device validates the full JSON
// Schema subset; this catches the common mistakes with a clear message.

const NAME = /^[a-z][a-z0-9_]{0,23}$/;
const VERSION = /^[A-Za-z0-9_.-]{1,32}$/;
const RISKS = new Set(['read', 'reversible', 'consequential']);
// `async`: success only means accepted, so clt01 ends its tool stage there.
const COMPLETIONS = new Set(['async']);
export const MAX_TOOLS = 16;

const isObjectSchema = s => s && typeof s === 'object' && s.type === 'object';
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// clt01 schema.go ValidateSchema: every object closes extra fields and lists
// its properties, `required` is a list of distinct property names (null is
// refused with 400), and every array declares its items.
function checkSchemaShape(schema, at) {
  if (schema.type === 'array') {
    if (!isPlainObject(schema.items)) throw new Error(`${at} must declare items`);
    checkSchemaShape(schema.items, `${at}.items`);
    return;
  }
  if (schema.type !== 'object') return;
  if (!isPlainObject(schema.properties)) throw new Error(`${at} must declare properties`);
  if (schema.additionalProperties !== false) throw new Error(`${at} must set additionalProperties: false`);
  for (const [key, sub] of Object.entries(schema.properties)) {
    if (!isPlainObject(sub)) throw new Error(`${at}.properties.${key} must be a schema object`);
    checkSchemaShape(sub, `${at}.properties.${key}`);
  }
  if (!('required' in schema)) return;
  if (!Array.isArray(schema.required)) throw new Error(`${at}.required must be a list`);
  const seen = new Set();
  for (const key of schema.required) {
    if (seen.has(key)) throw new Error(`${at}.required repeats ${key}`);
    if (typeof key !== 'string' || !Object.hasOwn(schema.properties, key)) {
      throw new Error(`${at}.required names ${key}, which is not in properties`);
    }
    seen.add(key);
  }
}

export function validateTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) throw new Error('tools must be a non-empty list');
  if (tools.length > MAX_TOOLS) throw new Error(`at most ${MAX_TOOLS} tools per client`);
  const seen = new Set();
  return tools.map((t, i) => {
    const at = `tools[${i}]`;
    if (!t || typeof t !== 'object') throw new Error(`${at} must be an object`);
    if (!NAME.test(t.name ?? '')) throw new Error(`${at}.name must match ${NAME}`);
    if (seen.has(t.name)) throw new Error(`${at}.name ${t.name} is repeated`);
    seen.add(t.name);
    if (!VERSION.test(t.version ?? '')) throw new Error(`${at}.version is invalid`);
    const description = typeof t.description === 'string' ? t.description.trim() : '';
    if (!description || [...description].length > 512) throw new Error(`${at}.description must be 1-512 characters`);
    if (!isObjectSchema(t.parameters)) throw new Error(`${at}.parameters must be an object schema`);
    if (!isObjectSchema(t.result_schema)) throw new Error(`${at}.result_schema must be an object schema`);
    checkSchemaShape(t.parameters, `${at}.parameters`);
    checkSchemaShape(t.result_schema, `${at}.result_schema`);
    if (!RISKS.has(t.risk)) throw new Error(`${at}.risk must be read, reversible or consequential`);
    if (typeof t.idempotent !== 'boolean' || typeof t.confirmation_required !== 'boolean') {
      throw new Error(`${at}.idempotent and confirmation_required must be booleans`);
    }
    const timeout = t.timeout_ms ?? 5000;
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 20000) throw new Error(`${at}.timeout_ms must be 100-20000`);
    if (t.completion !== undefined && !COMPLETIONS.has(t.completion)) throw new Error(`${at}.completion must be async`);
    return {
      name: t.name,
      version: t.version,
      description,
      parameters: t.parameters,
      result_schema: t.result_schema,
      risk: t.risk,
      idempotent: t.idempotent,
      confirmation_required: t.confirmation_required,
      timeout_ms: timeout,
      ...(t.completion ? { completion: t.completion } : {}),
    };
  });
}

// `completion` came with catalog protocol v2.
export const catalogProtocol = tools => (tools.some(t => t.completion) ? 'v2' : 'v1');
