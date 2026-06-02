export function normalizeToolName(name, aliases = {}) {
  return aliases[name] ?? name;
}

export function tool(name, description, inputSchema) {
  return { name, description, inputSchema };
}

export function objectSchema(properties, required = [], options = {}) {
  const schemaProperties = options.payloadRef === true
    ? {
      ...properties,
      payload_ref: stringSchema('Optional MCP payload ref carrying the complete argument object, e.g. mcp_payload:<id>@v1. Use this when an inline string/object would exceed the payload limit.'),
    }
    : properties;
  return {
    type: 'object',
    properties: schemaProperties,
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
  };
}

export function stringSchema(description) {
  return { type: 'string', description };
}

export function nullableStringSchema(description) {
  return { type: 'string', nullable: true, description };
}

export function numberSchema(description) {
  return { type: 'number', description };
}

export function enumStringSchema(values, description) {
  return { type: 'string', enum: values, description };
}

export function arraySchema(items, description) {
  return { type: 'array', items, description };
}

export function authorityBasisSchema(description) {
  return {
    type: 'object',
    description,
    properties: {
      kind: stringSchema('Authority kind: operator_direct_instruction, directed_obligation, or task_owner_handoff.'),
      summary: stringSchema('Concise authority basis summary.'),
    },
    required: ['kind', 'summary'],
    additionalProperties: false,
  };
}

export function validateArgs(toolName, args, schema) {
  const errors = [];
  validateValue('', args, schema, errors);
  return errors.length > 0 ? errors : null;
}

function validateValue(path, value, schema, errors) {
  if (!schema || typeof schema !== 'object') return;
  const field = path || '<root>';
  const expectedType = schema.type;

  if (value === null && schema.nullable === true) return;

  if (expectedType === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push({ field, expected: 'object', received: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value, message: `Field ${field} must be an object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}` });
      return;
    }
    const record = value;
    const props = schema.properties ?? {};
    const required = schema.required ?? [];
    for (const key of required) {
      if (!(key in record) || record[key] === undefined || record[key] === null) {
        const childPath = path ? `${path}.${key}` : key;
        errors.push({ field: childPath, expected: props[key]?.type ?? 'any', received: 'missing', message: `Missing required field: ${childPath}` });
      }
    }
    for (const [key, childValue] of Object.entries(record)) {
      const childSchema = props[key];
      const childPath = path ? `${path}.${key}` : key;
      if (!childSchema) {
        if (schema.additionalProperties === false) {
          errors.push({ field: childPath, expected: 'none', received: Array.isArray(childValue) ? 'array' : typeof childValue, message: `Unexpected field: ${childPath}` });
        }
        continue;
      }
      validateValue(childPath, childValue, childSchema, errors);
    }
    return;
  }

  if (expectedType === 'array') {
    if (!Array.isArray(value)) {
      errors.push({ field, expected: 'array', received: typeof value, message: `Field ${field} must be an array, got ${typeof value}` });
      return;
    }
    if (schema.items) {
      value.forEach((item, index) => validateValue(`${field}[${index}]`, item, schema.items, errors));
    }
    return;
  }

  if (expectedType === 'string' && typeof value !== 'string') {
    errors.push({ field, expected: 'string', received: typeof value, message: `Field ${field} must be a string, got ${typeof value}` });
  } else if (expectedType === 'number' && (typeof value !== 'number' || Number.isNaN(value))) {
    errors.push({ field, expected: 'number', received: typeof value, message: `Field ${field} must be a number, got ${typeof value}` });
  } else if (expectedType === 'boolean' && typeof value !== 'boolean') {
    errors.push({ field, expected: 'boolean', received: typeof value, message: `Field ${field} must be a boolean, got ${typeof value}` });
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ field, expected: `one_of:${schema.enum.join('|')}`, received: String(value), message: `Field ${field} must be one of: ${schema.enum.join(', ')}` });
  }
}

export function validationErrorResult(validationErrors) {
  return {
    status: 'error',
    schema: 'narada.task.mcp.validation_error.v0',
    validation_errors: validationErrors,
  };
}
