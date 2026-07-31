/**
 * Narration request/response loop — the trust core.
 *
 * `buildNarrationRequest` projects a ChangeManifest into a facts-only JSON
 * payload for the narrator (Claude or the template fallback): derived facts
 * plus the allowed id lists, never pre-filled narration.
 *
 * `applyNarration` validates the narrator's response and merges it:
 *   - only existing entity / change-unit ids may be referenced;
 *   - only narration slots may be set (entity: humanLabel; change unit:
 *     humanTitle, summary, beforeDescription, afterDescription, userImpact,
 *     openQuestions; plus optional confidence on either);
 *   - everything merged is stamped `provenance: "inferred"` — a response
 *     claiming any provenance (in particular "derived") is rejected, so AI
 *     output structurally cannot masquerade as deterministic fact;
 *   - violations produce an actionable error list, never a partial merge,
 *     and malformed input never throws.
 *
 * `templateNarrator` is the deterministic no-agent fallback: it restates
 * derived facts as dry sentences. All repo-derived strings are hostile data
 * and stay inert here — escaping happens only at render time.
 */

import type {
  AnalysisLimitation,
  ChangeManifest,
  ChangeState,
  ChangeUnit,
  Entity,
  ValidationResult
} from "@gitiviz/schema";

/** Defensive cap on any single narration string (hostile/agent output). */
const MAX_NARRATION_LENGTH = 4000;
/** Defensive cap on openQuestions entries per change unit. */
const MAX_OPEN_QUESTIONS = 50;
/** How many known ids to list in an unknown-id error before truncating. */
const MAX_IDS_IN_ERROR = 10;

// ---------------------------------------------------------------------------
// Request (facts only)
// ---------------------------------------------------------------------------

export interface NarrationEntityFact {
  id: string;
  kind: string;
  /** Current (derived) label — a fact the narrator may refine. */
  humanLabel: string;
  technicalLabel?: string;
  baseState: ChangeState;
  headState: ChangeState;
  /** Repo-relative evidence paths (hostile data, inert here). */
  evidencePaths: string[];
}

export interface NarrationRelationshipFact {
  id: string;
  from: string;
  to: string;
  verb: string;
  baseState: ChangeState;
  headState: ChangeState;
}

export interface NarrationChangeUnitFact {
  id: string;
  technicalTitle: string;
  type?: string;
  commits: string[];
  /** Ids of entities this unit touched. */
  entities: string[];
  grouped?: boolean;
  groupedReason?: string;
}

export interface NarrationRequest {
  specVersion: string;
  repository: { name: string };
  baseRevision: string;
  headRevision: string;
  /** The only entity ids a response may reference. */
  allowedEntityIds: string[];
  /** The only change-unit ids a response may reference. */
  allowedChangeUnitIds: string[];
  entities: NarrationEntityFact[];
  relationships: NarrationRelationshipFact[];
  changeUnits: NarrationChangeUnitFact[];
  analysisLimitations: AnalysisLimitation[];
}

/** Facts-only projection of a manifest for the narrator. */
export function buildNarrationRequest(manifest: ChangeManifest): NarrationRequest {
  const entities: NarrationEntityFact[] = manifest.entities.map((entity) => {
    const fact: NarrationEntityFact = {
      id: entity.id,
      kind: entity.kind,
      humanLabel: entity.humanLabel,
      baseState: entity.baseState,
      headState: entity.headState,
      evidencePaths: (entity.evidence ?? []).map((anchor) => anchor.path)
    };
    if (entity.technicalLabel !== undefined) fact.technicalLabel = entity.technicalLabel;
    return fact;
  });

  const relationships: NarrationRelationshipFact[] = manifest.relationships.map(
    (rel) => ({
      id: rel.id,
      from: rel.from,
      to: rel.to,
      verb: rel.verb,
      baseState: rel.baseState,
      headState: rel.headState
    })
  );

  const changeUnits: NarrationChangeUnitFact[] = manifest.changeUnits.map((unit) => {
    const fact: NarrationChangeUnitFact = {
      id: unit.id,
      technicalTitle: unit.technicalTitle,
      commits: unit.commits ?? [],
      entities: unit.entities ?? []
    };
    if (unit.type !== undefined) fact.type = unit.type;
    if (unit.grouped !== undefined) fact.grouped = unit.grouped;
    if (unit.groupedReason !== undefined) fact.groupedReason = unit.groupedReason;
    return fact;
  });

  return {
    specVersion: manifest.specVersion,
    repository: { name: manifest.repository.name },
    baseRevision: manifest.baseRevision,
    headRevision: manifest.headRevision,
    allowedEntityIds: entities.map((e) => e.id),
    allowedChangeUnitIds: changeUnits.map((u) => u.id),
    entities,
    relationships,
    changeUnits,
    analysisLimitations: manifest.analysisLimitations.map((l) => ({ ...l }))
  };
}

// ---------------------------------------------------------------------------
// Response (untrusted) + validation & merge
// ---------------------------------------------------------------------------

export interface EntityNarration {
  id: string;
  humanLabel?: string;
  confidence?: number;
}

export interface ChangeUnitNarration {
  id: string;
  humanTitle?: string;
  summary?: string;
  beforeDescription?: string;
  afterDescription?: string;
  userImpact?: string;
  openQuestions?: string[];
  confidence?: number;
}

export interface NarrationResponse {
  entities?: EntityNarration[];
  changeUnits?: ChangeUnitNarration[];
}

const ENTITY_SLOTS = new Set(["humanLabel"]);
const CHANGE_UNIT_SLOTS = new Set([
  "humanTitle",
  "summary",
  "beforeDescription",
  "afterDescription",
  "userImpact",
  "openQuestions"
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncatedIdList(ids: string[]): string {
  const shown = ids.slice(0, MAX_IDS_IN_ERROR).join(", ");
  return ids.length > MAX_IDS_IN_ERROR
    ? `${shown}, … (${ids.length} total)`
    : shown;
}

/**
 * Validate one narration record (entity or change unit). Pushes actionable
 * errors; returns the record only when it is fully valid.
 */
function checkRecord(
  raw: unknown,
  where: string,
  slots: Set<string>,
  allowedIds: Set<string>,
  seenIds: Set<string>,
  errors: string[]
): Record<string, unknown> | null {
  if (!isPlainObject(raw)) {
    errors.push(`${where} must be an object with an "id" and narration fields`);
    return null;
  }
  const before = errors.length;
  const id = raw["id"];
  if (typeof id !== "string" || id.length === 0) {
    errors.push(`${where} is missing a string "id"`);
  } else if (!allowedIds.has(id)) {
    errors.push(
      `${where} references unknown id "${id.slice(0, 200)}" — ` +
        `allowed ids: ${truncatedIdList([...allowedIds])}`
    );
  } else if (seenIds.has(id)) {
    errors.push(`${where} is a duplicate narration for id "${id}"`);
  } else {
    seenIds.add(id);
  }

  let hasSlot = false;
  for (const [key, value] of Object.entries(raw)) {
    if (key === "id") continue;
    if (key === "confidence") {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1
      ) {
        errors.push(`${where}.confidence must be a number between 0 and 1`);
      }
      continue;
    }
    if (!slots.has(key)) {
      errors.push(
        `${where} sets "${key}", which narration may not touch — ` +
          `allowed fields: id, confidence, ${[...slots].join(", ")}` +
          (key === "provenance"
            ? ". Provenance is stamped by the validator; narration is always \"inferred\"."
            : "")
      );
      continue;
    }
    if (key === "openQuestions") {
      if (
        !Array.isArray(value) ||
        value.length > MAX_OPEN_QUESTIONS ||
        !value.every(
          (q) => typeof q === "string" && q.length <= MAX_NARRATION_LENGTH
        )
      ) {
        errors.push(
          `${where}.openQuestions must be an array of at most ` +
            `${MAX_OPEN_QUESTIONS} strings (each ≤ ${MAX_NARRATION_LENGTH} chars)`
        );
        continue;
      }
    } else if (typeof value !== "string") {
      errors.push(`${where}.${key} must be a string`);
      continue;
    } else if (value.length > MAX_NARRATION_LENGTH) {
      errors.push(
        `${where}.${key} is ${value.length} chars — cap is ${MAX_NARRATION_LENGTH}`
      );
      continue;
    }
    hasSlot = true;
  }
  if (!hasSlot && errors.length === before) {
    errors.push(
      `${where} sets no narration fields — provide at least one of: ${[...slots].join(", ")}`
    );
  }
  return errors.length === before ? raw : null;
}

function stampInferred(record: Entity | ChangeUnit, confidence: unknown): void {
  record.provenance = "inferred";
  if (typeof confidence === "number") {
    record.confidence = confidence;
  } else {
    delete record.confidence;
  }
}

/**
 * Validate a narrator response against the manifest and merge it. Returns
 * a new manifest (input untouched); any violation rejects the whole
 * response with an actionable error list. Never throws on malformed input.
 */
export function applyNarration(
  manifest: ChangeManifest,
  response: unknown
): ValidationResult<ChangeManifest> {
  const errors: string[] = [];
  if (!isPlainObject(response)) {
    return {
      ok: false,
      errors: ['narration response must be a JSON object like {"entities": [...], "changeUnits": [...]}']
    };
  }
  for (const key of Object.keys(response)) {
    if (key !== "entities" && key !== "changeUnits") {
      errors.push(
        `response.${key} is not recognised — only "entities" and "changeUnits" are accepted`
      );
    }
  }

  const entityIds = new Set(manifest.entities.map((e) => e.id));
  const unitIds = new Set(manifest.changeUnits.map((u) => u.id));
  const validEntities: Record<string, unknown>[] = [];
  const validUnits: Record<string, unknown>[] = [];

  const rawEntities = response["entities"] ?? [];
  if (!Array.isArray(rawEntities)) {
    errors.push("response.entities must be an array");
  } else {
    const seen = new Set<string>();
    rawEntities.forEach((raw, index) => {
      const record = checkRecord(
        raw,
        `entities[${index}]`,
        ENTITY_SLOTS,
        entityIds,
        seen,
        errors
      );
      if (record !== null) validEntities.push(record);
    });
  }

  const rawUnits = response["changeUnits"] ?? [];
  if (!Array.isArray(rawUnits)) {
    errors.push("response.changeUnits must be an array");
  } else {
    const seen = new Set<string>();
    rawUnits.forEach((raw, index) => {
      const record = checkRecord(
        raw,
        `changeUnits[${index}]`,
        CHANGE_UNIT_SLOTS,
        unitIds,
        seen,
        errors
      );
      if (record !== null) validUnits.push(record);
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const merged = structuredClone(manifest);
  const entityById = new Map(merged.entities.map((e) => [e.id, e]));
  const unitById = new Map(merged.changeUnits.map((u) => [u.id, u]));

  for (const record of validEntities) {
    const entity = entityById.get(record["id"] as string)!;
    if (typeof record["humanLabel"] === "string") {
      entity.humanLabel = record["humanLabel"];
    }
    stampInferred(entity, record["confidence"]);
  }

  for (const record of validUnits) {
    const unit = unitById.get(record["id"] as string)!;
    for (const slot of CHANGE_UNIT_SLOTS) {
      const value = record[slot];
      if (value === undefined) continue;
      if (slot === "openQuestions") {
        unit.openQuestions = value as string[];
      } else {
        unit[slot as "humanTitle" | "summary" | "beforeDescription" | "afterDescription" | "userImpact"] =
          value as string;
      }
    }
    stampInferred(unit, record["confidence"]);
  }

  return { ok: true, value: merged };
}

// ---------------------------------------------------------------------------
// Template narrator (deterministic no-agent fallback)
// ---------------------------------------------------------------------------

/**
 * Deterministic dry narration: restates derived facts in template sentences.
 * Grouped units are skipped (they live in the timeline only). No confidence
 * is claimed — there is no judgement here to be confident about.
 */
export function templateNarrator(request: NarrationRequest): NarrationResponse {
  const changeUnits: ChangeUnitNarration[] = [];
  for (const unit of request.changeUnits) {
    if (unit.grouped === true) continue;
    const count = unit.entities.length;
    const touched =
      count === 0
        ? "It touches no tracked entities."
        : `It touches ${count} tracked ${count === 1 ? "entity" : "entities"}.`;
    changeUnits.push({
      id: unit.id,
      humanTitle: unit.technicalTitle,
      summary: `Commit-level change: ${unit.technicalTitle}. ${touched}`
    });
  }
  return { changeUnits };
}
