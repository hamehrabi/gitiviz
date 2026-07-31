import { Ajv, type ValidateFunction } from "ajv";
import type { BookManifest, ChangeManifest } from "./types.js";
/**
 * The JSON Schemas in spec/ are the published contract. They are imported
 * statically (not read from disk at runtime) so bundlers embed them and the
 * resulting single-file artifact works from any location.
 */
import bookManifestSchema from "../../../spec/book-manifest.schema.json" with { type: "json" };
import changeManifestSchema from "../../../spec/change-manifest.schema.json" with { type: "json" };

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

const ajv = new Ajv({ allErrors: true });
const compiledChangeManifest: ValidateFunction = ajv.compile(changeManifestSchema);
const compiledBookManifest: ValidateFunction = ajv.compile(bookManifestSchema);

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
