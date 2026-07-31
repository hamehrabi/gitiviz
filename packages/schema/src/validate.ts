import { readFileSync } from "node:fs";
import { Ajv, type ValidateFunction } from "ajv";
import type { BookManifest, ChangeManifest } from "./types.js";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

/**
 * The JSON Schemas in spec/ are the published contract; this module loads
 * them relative to the package so src (tests) and dist (build) both
 * resolve them.
 */
function loadSpecSchema(name: string): object {
  const url = new URL(`../../../spec/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

const ajv = new Ajv({ allErrors: true });
const compiledChangeManifest: ValidateFunction = ajv.compile(
  loadSpecSchema("change-manifest.schema.json")
);
const compiledBookManifest: ValidateFunction = ajv.compile(
  loadSpecSchema("book-manifest.schema.json")
);

/** Major spec versions this validator understands. */
const SUPPORTED_SPEC_MAJOR = 0;

function formatErrors(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).map(
    (e) => `${e.instancePath === "" ? "/" : e.instancePath} ${e.message ?? "is invalid"}`
  );
}

function specVersionError(specVersion: string): string[] | null {
  const major = Number(specVersion.split(".")[0]);
  if (major !== SUPPORTED_SPEC_MAJOR) {
    return [
      `/specVersion unsupported major version "${specVersion}" (this validator understands ${SUPPORTED_SPEC_MAJOR}.x)`
    ];
  }
  return null;
}

export function validateChangeManifest(
  input: unknown
): ValidationResult<ChangeManifest> {
  if (!compiledChangeManifest(input)) {
    return { ok: false, errors: formatErrors(compiledChangeManifest) };
  }
  const manifest = input as ChangeManifest;
  const versionErrors = specVersionError(manifest.specVersion);
  if (versionErrors) {
    return { ok: false, errors: versionErrors };
  }
  return { ok: true, value: manifest };
}

export function validateBookManifest(
  input: unknown
): ValidationResult<BookManifest> {
  if (!compiledBookManifest(input)) {
    return { ok: false, errors: formatErrors(compiledBookManifest) };
  }
  const manifest = input as BookManifest;
  const versionErrors = specVersionError(manifest.specVersion);
  if (versionErrors) {
    return { ok: false, errors: versionErrors };
  }
  return { ok: true, value: manifest };
}
