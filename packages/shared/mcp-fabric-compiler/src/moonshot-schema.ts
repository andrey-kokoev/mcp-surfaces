export const MOONSHOT_SCHEMA_DIALECT = 'MoonshotAI/walle@v0.1.13:strict';
export const MOONSHOT_SCHEMA_SOURCE = 'https://github.com/MoonshotAI/walle';

export type MoonshotSchemaFinding = {
  path: string;
  code: string;
  message: string;
};

type JsonRecord = Record<string, unknown>;

const VALID_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object']);
const STRICT_ANY_OF_COMMON_KEYWORDS = new Set(['description', 'title']);
const MAX_ENUM_ITEMS = 1_000;
const MAX_ANY_OF_ITEMS = 500;
const MAX_SCHEMA_DEPTH = 30;
const MAX_SCHEMA_BYTES = 120_000;
const MAX_PROPERTY_KEYS = 3_000;

/**
 * Validate one MCP tool input schema against the strict Moonshot-flavoured
 * JSON Schema contract implemented by Walle. Strict is the most permissive
 * level accepted by the Moonshot API; unsupported-keyword restrictions from
 * Walle's ultra/test levels intentionally do not apply here.
 */
export function validateMoonshotToolInputSchema(schema: unknown): MoonshotSchemaFinding[] {
  const findings: MoonshotSchemaFinding[] = [];
  if (!isRecord(schema)) {
    return [{ path: 'root', code: 'schema_root_not_object', message: 'schema root must be an object' }];
  }

  const serialized = JSON.stringify(schema);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SCHEMA_BYTES) {
    add('root', 'schema_size_exceeded', `schema exceeds ${MAX_SCHEMA_BYTES} bytes`);
  }

  const root = schema;
  const rootDefs = isRecord(root.$defs) ? root.$defs : {};
  let propertyKeyCount = 0;
  const ancestry = new Set<JsonRecord>();
  visit(root, 'root', 0);
  if (propertyKeyCount > MAX_PROPERTY_KEYS) {
    add('root', 'property_key_count_exceeded', `schema contains ${propertyKeyCount} property keys; maximum is ${MAX_PROPERTY_KEYS}`);
  }
  return findings;

  function add(path: string, code: string, message: string): void {
    findings.push({ path, code, message });
  }

  function visit(node: JsonRecord, path: string, depth: number): void {
    if (depth > MAX_SCHEMA_DEPTH) {
      add(path, 'schema_depth_exceeded', `schema depth exceeds ${MAX_SCHEMA_DEPTH}`);
      return;
    }
    if (ancestry.has(node)) {
      add(path, 'schema_cycle', 'schema contains an in-memory cycle and cannot be serialized as JSON Schema');
      return;
    }
    ancestry.add(node);

    const types = validateType(node, path);
    validateStringKeyword(node, path, 'description');
    validateStringKeyword(node, path, 'title');
    validateStringKeyword(node, path, 'pattern');
    validateStringKeyword(node, path, '$id');
    validateEnum(node, path, types);
    validateRequired(node, path);
    validateRef(node, path);

    if ('properties' in node) {
      if (!isRecord(node.properties)) {
        add(`${path}.properties`, 'properties_not_object', 'properties must be an object');
      } else {
        const properties = node.properties;
        propertyKeyCount += Object.keys(properties).length;
        for (const [name, child] of Object.entries(properties)) {
          if (!isRecord(child)) {
            add(`${path}.properties.${escapePath(name)}`, 'property_schema_not_object', 'property schema must be an object');
          } else {
            visit(child, `${path}.properties.${escapePath(name)}`, depth + 1);
          }
        }
      }
    }

    if ('items' in node) {
      if (!isRecord(node.items)) {
        add(`${path}.items`, 'items_not_object', 'items must be an object schema');
      } else {
        visit(node.items, `${path}.items`, depth + 1);
      }
    }

    if ('additionalProperties' in node && typeof node.additionalProperties !== 'boolean') {
      if (!isRecord(node.additionalProperties)) {
        add(`${path}.additionalProperties`, 'additional_properties_invalid', 'additionalProperties must be a boolean or object schema');
      } else {
        visit(node.additionalProperties, `${path}.additionalProperties`, depth + 1);
      }
    }

    if ('anyOf' in node) validateAnyOf(node, path, depth);

    if ('$defs' in node) {
      if (!isRecord(node.$defs)) {
        add(`${path}.$defs`, 'defs_not_object', '$defs must be an object');
      } else {
        for (const [name, child] of Object.entries(node.$defs)) {
          if (!isRecord(child)) {
            add(`${path}.$defs.${escapePath(name)}`, 'definition_not_object', '$defs entries must be object schemas');
          } else {
            visit(child, `${path}.$defs.${escapePath(name)}`, depth + 1);
          }
        }
      }
    }

    ancestry.delete(node);
  }

  function validateType(node: JsonRecord, path: string): string[] {
    if (!('type' in node)) return [];
    if ('anyOf' in node) {
      add(path, 'type_with_any_of', 'when using anyOf, type should be defined in anyOf items instead of the parent schema');
    }
    if ('$ref' in node) {
      add(path, 'type_with_ref', 'when using $ref, type should be defined in the referenced schema instead of alongside $ref');
    }
    const raw = node.type;
    const values = typeof raw === 'string'
      ? [raw]
      : Array.isArray(raw) && raw.length > 0 && raw.every((value) => typeof value === 'string')
        ? raw as string[]
        : [];
    if (values.length === 0) {
      add(`${path}.type`, 'type_invalid', 'type must be a supported string or a non-empty array of supported strings');
      return [];
    }
    for (const value of values) {
      if (!VALID_TYPES.has(value)) add(`${path}.type`, 'type_unsupported', `unsupported type: ${value}`);
    }
    return values;
  }

  function validateEnum(node: JsonRecord, path: string, types: string[]): void {
    if (!('enum' in node)) return;
    if (!Array.isArray(node.enum) || node.enum.length === 0) {
      add(`${path}.enum`, 'enum_empty_or_invalid', 'enum must be a non-empty array');
      return;
    }
    if (node.enum.length > MAX_ENUM_ITEMS) {
      add(`${path}.enum`, 'enum_item_count_exceeded', `enum contains ${node.enum.length} items; maximum is ${MAX_ENUM_ITEMS}`);
    }
    if (types.length === 0) {
      add(path, 'enum_requires_type', 'enum requires a type on the same schema');
      return;
    }
    if (types.length > 1) {
      const nonNullTypes = types.filter((type) => type !== 'null');
      if (types.length !== 2 || nonNullTypes.length !== 1) {
        add(path, 'enum_multi_type_invalid', 'enum with multiple types must use exactly one value type plus null');
      } else if (!['string', 'number', 'integer', 'boolean'].includes(nonNullTypes[0])) {
        add(path, 'enum_value_type_invalid', 'enum value type must be string, number, integer, or boolean');
      }
    }
    node.enum.forEach((value, index) => {
      if (!types.some((type) => valueMatchesType(value, type))) {
        add(`${path}.enum[${index}]`, 'enum_value_type_mismatch', `enum value does not match declared type ${JSON.stringify(types)}`);
      }
    });
  }

  function validateRequired(node: JsonRecord, path: string): void {
    if (!('required' in node)) return;
    if (!Array.isArray(node.required) || !node.required.every((value) => typeof value === 'string')) {
      add(`${path}.required`, 'required_invalid', 'required must be an array of strings');
      return;
    }
    const properties = isRecord(node.properties) ? node.properties : {};
    for (const name of node.required as string[]) {
      if (!(name in properties)) {
        add(`${path}.required`, 'required_property_missing', `required property is absent from properties: ${name}`);
      }
    }
  }

  function validateAnyOf(node: JsonRecord, path: string, depth: number): void {
    const branches = node.anyOf;
    if (!Array.isArray(branches) || branches.length === 0) {
      add(`${path}.anyOf`, 'any_of_empty_or_invalid', 'anyOf must be a non-empty array of object schemas');
      return;
    }
    if (branches.length > MAX_ANY_OF_ITEMS) {
      add(`${path}.anyOf`, 'any_of_item_count_exceeded', `anyOf contains ${branches.length} items; maximum is ${MAX_ANY_OF_ITEMS}`);
    }
    const parentKeywords = new Set(Object.keys(node).filter((key) => key !== 'anyOf'));
    branches.forEach((branch, index) => {
      const branchPath = `${path}.anyOf[${index}]`;
      if (!isRecord(branch)) {
        add(branchPath, 'any_of_item_not_object', 'anyOf items must be object schemas');
        return;
      }
      for (const keyword of Object.keys(branch)) {
        if (keyword !== 'type' && parentKeywords.has(keyword) && !STRICT_ANY_OF_COMMON_KEYWORDS.has(keyword)) {
          add(branchPath, 'any_of_keyword_conflict', `keyword ${keyword} is defined both on the anyOf parent and branch`);
        }
      }
      visit(branch, branchPath, depth + 1);
    });
  }

  function validateRef(node: JsonRecord, path: string): void {
    if (!('$ref' in node)) return;
    if (typeof node.$ref !== 'string' || (node.$ref !== '#' && !node.$ref.startsWith('#/$defs/'))) {
      add(`${path}.$ref`, 'ref_invalid', '$ref must be # or #/$defs/<name>');
      return;
    }
    if (node.$ref === '#') return;
    const name = node.$ref.slice('#/$defs/'.length);
    const target = rootDefs[name];
    if (!isRecord(target)) {
      add(`${path}.$ref`, 'ref_target_missing', `referenced definition does not exist: ${node.$ref}`);
      return;
    }
    for (const keyword of Object.keys(node)) {
      if (keyword === '$ref' || keyword === '$defs' || keyword === '$id') continue;
      if (keyword in target) {
        add(path, 'ref_keyword_conflict', `keyword ${keyword} is defined both alongside $ref and in its target`);
      }
    }
  }

  function validateStringKeyword(node: JsonRecord, path: string, keyword: string): void {
    if (keyword in node && typeof node[keyword] !== 'string') {
      add(`${path}.${keyword}`, 'keyword_not_string', `${keyword} must be a string`);
    }
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function valueMatchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null': return value === null;
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'array': return Array.isArray(value);
    case 'object': return isRecord(value);
    default: return false;
  }
}

function escapePath(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(value) ? value : JSON.stringify(value);
}
