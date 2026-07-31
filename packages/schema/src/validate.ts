import { readFileSync } from "node:fs";
import { Ajv, type ValidateFunction } from "ajv";
import type { ChangeManifest } from "./types.js";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

/**
 * The JSON Schema in spec/ is the published contract; this module loads it
 * relative to the package so src (tests) and dist (build) both resolve it.
 */
const schemaUrl = new URL(
  "../../../spec/change-manifest.schema.json",
  import.meta.url
);
const changeManifestSchema: object = JSON.parse(
  readFileSync(schemaUrl, "utf8")
);

const ajv = new Ajv({ allErrors: true });
const compiledChangeManifest: ValidateFunction =
  ajv.compile(changeManifestSchema);

/** Major spec versions this validator understands. */
const SUPPORTED_SPEC_MAJOR = 0;

function formatErrors(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).map(
    (e) => `${e.instancePath === "" ? "/" : e.instancePath} ${e.message ?? "is invalid"}`
  );
}

export function validateChangeManifest(
  input: unknown
): ValidationResult<ChangeManifest> {
  if (!compiledChangeManifest(input)) {
    return { ok: false, errors: formatErrors(compiledChangeManifest) };
  }
  const manifest = input as ChangeManifest;
  const major = Number(manifest.specVersion.split(".")[0]);
  if (major !== SUPPORTED_SPEC_MAJOR) {
    return {
      ok: false,
      errors: [
        `/specVersion unsupported major version "${manifest.specVersion}" (this validator understands ${SUPPORTED_SPEC_MAJOR}.x)`
      ]
    };
  }
  return { ok: true, value: manifest };
}
