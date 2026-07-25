export function normalizeToolName(name: any, aliases: Record<string, unknown> = {}) {
  return aliases[name] ?? name;
}

export function tool(name: any, description: any, inputSchema: any) {
  return { name, description, inputSchema, annotations: toolAnnotations(name), outputSchema: genericToolOutputSchema() };
}

function toolAnnotations(name: any) {
  const writes: any = /create|claim|handoff|finish|accept|reject|close|defer|reopen|review|submit|bridge|target|assign|update|admit|derive/.test(String(name));
  return {
    title: String(name),
    readOnlyHint: !writes,
    destructiveHint: /reject|close|defer/.test(String(name)),
    idempotentHint: /status|show|inspect|list|workboard|doctor|search|next/.test(String(name)),
    openWorldHint: false,
  };
}

function genericToolOutputSchema() {
  return { type: 'object', additionalProperties: true };
}

export function objectSchema(properties: any, required : any= [], options: Record<string, unknown> = {}) {
  const schemaProperties: any = options.payloadRef === true
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

export function stringSchema(description: any) {
  return { type: 'string', description };
}

export function nullableStringSchema(description: any) {
  return { type: 'string', nullable: true, description };
}

export function numberSchema(description: any) {
  return { type: 'number', description };
}

export function enumStringSchema(values: any, description: any) {
  return { type: 'string', enum: values, description };
}

export function arraySchema(items: any, description: any) {
  return { type: 'array', items, description };
}

export function authorityBasisSchema(description: any) {
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

export function validateArgs(toolName: any, args: any, schema: any) {
  const errors: any[] = [];
  validateValue('', args, schema, errors);
  return errors.length > 0 ? errors : null;
}

function validateValue(path: any, value: any, schema: any, errors: any) {
  if (!schema || typeof schema !== 'object') return;
  const field: any = path || '<root>';
  const expectedType: any = schema.type;

  if (value === null && schema.nullable === true) return;

  if (expectedType === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push({ field, expected: 'object', received: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value, message: `Field ${field} must be an object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}` });
      return;
    }
    const record: any = value;
    const props: any = schema.properties ?? {};
    const required: any = schema.required ?? [];
    for (const key of required) {
      if (!(key in record) || record[key] === undefined || record[key] === null) {
        const childPath: any = path ? `${path}.${key}` : key;
        errors.push({ field: childPath, expected: props[key]?.type ?? 'unknown', received: 'missing', message: `Missing required field: ${childPath}` });
      }
    }
    for (const [key, childValue] of Object.entries(record)) {
      const childSchema: any = props[key];
      const childPath: any = path ? `${path}.${key}` : key;
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
      value.forEach((item: any, index: any) => validateValue(`${field}[${index}]`, item, schema.items, errors));
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

export function validationErrorResult(validationErrors: any) {
  return {
    status: 'error',
    schema: 'narada.task.mcp.validation_error.v0',
    validation_errors: validationErrors,
    accepted_payload_shapes: buildAcceptedPayloadShapeHints(validationErrors),
  };
}

function buildAcceptedPayloadShapeHints(validationErrors: any) {
  const hints: any[] = [];
  if (validationErrors.some((error: any) => String(error.field).startsWith('findings'))) {
    hints.push({
      field: 'findings',
      accepted_shape: [{ severity: 'note|blocking', description: '<finding text>', location: '<optional location>' }],
      payload_ref_retry_shape: { findings: [{ severity: 'note', description: '<short finding text>' }] },
      rule: 'findings must be an array of finding objects, not an object keyed by index and not an array of strings.',
    });
  }
  return hints;
}
