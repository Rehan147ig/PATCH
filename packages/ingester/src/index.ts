export { diffOpenApi, derefSchema } from './openapi-diff.js';
export type { OpenApiDocument, ContractDiff, PathItem, Operation, Parameter, Schema } from './openapi-diff.js';
export { compileManifest, compileManifestFromSpecs, flattenDiff, classifyChange } from './manifest-generator.js';
export type { ManifestCompileOptions, DiffEntry } from './manifest-generator.js';
