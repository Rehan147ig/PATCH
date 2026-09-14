/**
 * OpenAPI / AsyncAPI contract diffing.
 *
 * Compares two OpenAPI 3.x (or Swagger 2) documents and classifies the
 * differences into apimigrate change kinds:
 *  - endpoint-removed       (path + method disappeared)
 *  - endpoint-deprecated    (operation marked deprecated)
 *  - removed-field          (request/response schema field removed)
 *  - changed-parameter-type (request parameter/field type changed)
 *  - renamed-parameter      (request parameter renamed)
 *  - request-field-changed  (new required request field)
 *  - response-field-changed (new/removed response field)
 */

export interface OpenApiDocument {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, PathItem>;
  components?: { schemas?: Record<string, Schema> };
}

export interface PathItem {
  get?: Operation;
  post?: Operation;
  put?: Operation;
  delete?: Operation;
  patch?: Operation;
  head?: Operation;
  options?: Operation;
  parameters?: Parameter[];
  deprecated?: boolean;
  $ref?: string;
}

export interface Operation {
  operationId?: string;
  summary?: string;
  deprecated?: boolean;
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
}

export interface Parameter {
  name?: string;
  in?: string;
  required?: boolean;
  deprecated?: boolean;
  schema?: Schema;
  /** OpenAPI 3.1 may inline the type. */
  type?: string;
}

export interface Schema {
  type?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  $ref?: string;
  deprecated?: boolean;
  enum?: unknown[];
}

export interface ContractDiff {
  /** Removed operations: `${method} ${path}`. */
  removedOperations: string[];
  /** Operations newly marked deprecated. */
  newlyDeprecated: string[];
  /** Removed request parameters. */
  removedParameters: Array<{ path: string; method: string; name: string }>;
  /** Renamed request parameters (best-effort by required-flag similarity). */
  renamedParameters: Array<{ path: string; method: string; from: string; to: string }>;
  /** Request fields removed from a schema. */
  removedRequestFields: Array<{ path: string; method: string; field: string }>;
  /** Request fields newly required. */
  newRequiredRequestFields: Array<{ path: string; method: string; field: string }>;
  /** Response fields removed from a schema. */
  removedResponseFields: Array<{ path: string; method: string; field: string }>;
  /** Parameter/field type changes. */
  typeChanges: Array<{ path: string; method: string; name: string; from: string; to: string }>;
}

const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'] as const;

function operationOf(item: PathItem | undefined, method: string): Operation | undefined {
  if (!item) return undefined;
  const op = (item as Record<string, unknown>)[method] as Operation | undefined;
  return op;
}

function methodForOp(op: Operation | undefined, item: PathItem | undefined): string | undefined {
  if (!op) return undefined;
  return METHODS.find((m) => (item as Record<string, unknown>)[m] === op);
}

function parametersOf(op: Operation | undefined, item: PathItem | undefined): Parameter[] {
  return [...(item?.parameters ?? []), ...(op?.parameters ?? [])];
}

function schemaOf(param: Parameter): Schema | undefined {
  return param.schema ?? (param.type ? { type: param.type } : undefined);
}

/** Flatten a (possibly $ref'd) schema to its property map. */
export function derefSchema(schema: Schema | undefined, components: Record<string, Schema> | undefined): Schema | undefined {
  if (!schema) return undefined;
  if (schema.$ref && components) {
    const name = schema.$ref.split('/').pop();
    if (name && components[name]) return components[name];
  }
  return schema;
}

/** Diff two OpenAPI documents and classify the changes. */
export function diffOpenApi(oldDoc: OpenApiDocument, newDoc: OpenApiDocument): ContractDiff {
  const diff: ContractDiff = {
    removedOperations: [],
    newlyDeprecated: [],
    removedParameters: [],
    renamedParameters: [],
    removedRequestFields: [],
    newRequiredRequestFields: [],
    removedResponseFields: [],
    typeChanges: [],
  };

  const oldPaths = oldDoc.paths ?? {};
  const newPaths = newDoc.paths ?? {};
  const oldComponents = oldDoc.components?.schemas;
  const newComponents = newDoc.components?.schemas;

  const allPaths = new Set([...Object.keys(oldPaths), ...Object.keys(newPaths)]);

  for (const path of allPaths) {
    const oldItem = oldPaths[path];
    const newItem = newPaths[path];

    // Removed paths (whole path gone)
    if (oldItem && !newItem) {
      for (const method of METHODS) {
        if (oldItem[method]) diff.removedOperations.push(`${method.toUpperCase()} ${path}`);
      }
      continue;
    }

    for (const method of METHODS) {
      const oldOp = operationOf(oldItem, method);
      const newOp = operationOf(newItem, method);

      if (oldOp && !newOp) {
        diff.removedOperations.push(`${method.toUpperCase()} ${path}`);
        continue;
      }
      if (!oldOp) continue;

      // Deprecation
      if (!oldOp.deprecated && newOp?.deprecated) {
        diff.newlyDeprecated.push(`${method.toUpperCase()} ${path}`);
      }

      // Parameters
      const oldParams = parametersOf(oldOp, oldItem);
      const newParams = parametersOf(newOp, newItem);
      const oldNames = new Set(oldParams.map((p) => p.name));
      const newNames = new Set(newParams.map((p) => p.name));

      for (const p of oldParams) {
        if (p.name && !newNames.has(p.name)) {
          // Removed or renamed. Heuristic rename: a new param with the same
          // `in` and required flag, similar name length.
          const renamed = newParams.find(
            (np) =>
              np.in === p.in &&
              np.required === p.required &&
              np.name &&
              np.name !== p.name &&
              np.name!.length === p.name!.length,
          );
          if (renamed?.name) {
            diff.renamedParameters.push({ path, method: method.toUpperCase(), from: p.name!, to: renamed.name });
          } else {
            diff.removedParameters.push({ path, method: method.toUpperCase(), name: p.name! });
          }
        }
      }

      // Type changes (same-name params with different schema type)
      for (const p of newParams) {
        if (!p.name) continue;
        const old = oldParams.find((op2) => op2.name === p.name);
        if (!old) continue;
        const oldType = schemaOf(old)?.type;
        const newType = schemaOf(p)?.type;
        if (oldType && newType && oldType !== newType) {
          diff.typeChanges.push({ path, method: method.toUpperCase(), name: p.name!, from: oldType, to: newType });
        }
      }

      // Request body schema fields
      const oldBodySchema = derefSchema(oldOp.requestBody?.content?.['application/json']?.schema, oldComponents);
      const newBodySchema = derefSchema(newOp?.requestBody?.content?.['application/json']?.schema, newComponents);
      diffRequestSchema(diff, path, method, oldBodySchema, newBodySchema);

      // Response schema fields (first 2xx response)
      const oldRespSchema = derefSchema(firstSuccessResponse(oldOp)?.content?.['application/json']?.schema, oldComponents);
      const newRespSchema = derefSchema(firstSuccessResponse(newOp)?.content?.['application/json']?.schema, newComponents);
      diffResponseSchema(diff, path, method, oldRespSchema, newRespSchema);
    }
  }

  return diff;
}

function firstSuccessResponse(op: Operation | undefined): { content?: Record<string, { schema?: Schema }> } | undefined {
  if (!op?.responses) return undefined;
  for (const [code, resp] of Object.entries(op.responses)) {
    if (code.startsWith('2')) return resp;
  }
  return undefined;
}

function diffRequestSchema(
  diff: ContractDiff,
  path: string,
  method: string,
  oldSchema: Schema | undefined,
  newSchema: Schema | undefined,
): void {
  if (!oldSchema || !newSchema) return;
  const oldProps = oldSchema.properties ?? {};
  const newProps = newSchema.properties ?? {};

  for (const [name, prop] of Object.entries(oldProps)) {
    if (!newProps[name]) {
      diff.removedRequestFields.push({ path, method: method.toUpperCase(), field: name });
      continue;
    }
    const oldT = prop.type ?? derefSchema(prop, undefined)?.type;
    const newT = newProps[name].type;
    if (oldT && newT && oldT !== newT) {
      diff.typeChanges.push({ path, method: method.toUpperCase(), name, from: oldT, to: newT });
    }
    if (prop.deprecated && !newProps[name].deprecated) {
      // no-op: deprecation lifted
    }
  }

  const oldRequired = new Set(oldSchema.required ?? []);
  const newRequired = new Set(newSchema.required ?? []);
  for (const name of newRequired) {
    if (!oldRequired.has(name) && newProps[name]) {
      diff.newRequiredRequestFields.push({ path, method: method.toUpperCase(), field: name });
    }
  }
}

function diffResponseSchema(
  diff: ContractDiff,
  path: string,
  method: string,
  oldSchema: Schema | undefined,
  newSchema: Schema | undefined,
): void {
  if (!oldSchema || !newSchema) return;
  const oldProps = oldSchema.properties ?? {};
  const newProps = newSchema.properties ?? {};
  for (const [name] of Object.entries(oldProps)) {
    if (!newProps[name]) {
      diff.removedResponseFields.push({ path, method: method.toUpperCase(), field: name });
    }
  }
}
