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
 *     openQuestions, storyDiagram; plus optional confidence on either;
 *     response-level: architectureDiagram, projectSummary, chapters);
 *   - concept diagrams arrive as structured data (clusters/nodes/edges),
 *     never raw Mermaid — markup injection is impossible by construction.
 *     Architecture diagrams cap at 20 nodes / 6 clusters, story diagrams at
 *     7 nodes, and every node "file" must exist in the manifest's evidence
 *     index (fabricated paths are rejected with actionable errors);
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
  ChapterNarration,
  ConceptDiagram,
  DiagramCluster,
  DiagramEdge,
  DiagramNode,
  DiagramTone,
  Entity,
  NarratedChapterId,
  ValidationResult
} from "@gitiviz/schema";
import { DIAGRAM_TONES, NARRATED_CHAPTER_IDS } from "@gitiviz/schema";
import type { StoryProjection } from "./storyProjection.js";
import { buildOverviewStory, buildUnitStory } from "./storyProjection.js";

/** Defensive cap on any single narration string (hostile/agent output). */
const MAX_NARRATION_LENGTH = 4000;
/** Defensive cap on openQuestions entries per change unit. */
const MAX_OPEN_QUESTIONS = 50;
/** How many known ids to list in an unknown-id error before truncating. */
const MAX_IDS_IN_ERROR = 10;

/** Hard cap on nodes in a proposed architecture diagram. */
export const MAX_ARCHITECTURE_DIAGRAM_NODES = 20;
/** Hard cap on clusters in a proposed concept diagram. */
export const MAX_DIAGRAM_CLUSTERS = 6;
/** Hard cap on nodes in a proposed per-change-unit story diagram. */
export const MAX_STORY_DIAGRAM_NODES = 7;
/** Hard cap on keyPoints per narrated book chapter. */
export const MAX_CHAPTER_KEY_POINTS = 5;
/** Cap on short diagram strings (ids, labels, roles, titles, verbs). */
const MAX_DIAGRAM_LABEL_LENGTH = 200;
/** Cap on a diagram node's repo-relative file path. */
const MAX_DIAGRAM_FILE_LENGTH = 500;
/** Defensive multiplier: a diagram may have at most 3 edges per allowed node. */
const EDGES_PER_NODE = 3;

/** Every evidence path referenced anywhere in the manifest, de-duplicated. */
function collectEvidenceFiles(manifest: ChangeManifest): Set<string> {
  const files = new Set<string>();
  const records: { evidence?: { path: string }[] }[] = [
    ...manifest.entities,
    ...manifest.relationships,
    ...manifest.changeUnits
  ];
  for (const record of records) {
    for (const anchor of record.evidence ?? []) files.add(anchor.path);
  }
  return files;
}

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
  /**
   * Derived system rollup for this unit — the real anchors a proposed
   * storyDiagram should be built from.
   */
  storyRollup: StoryProjection;
}

/** The caps a proposed diagram must respect, stated in the request. */
export interface NarrationDiagramLimits {
  architecture: { maxNodes: number; maxClusters: number };
  story: { maxNodes: number };
  /** The only tones a cluster may use. */
  tones: DiagramTone[];
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
  /**
   * Every evidence file path in the manifest, sorted. A diagram node's
   * "file" must come from this list — anything else is rejected.
   */
  evidenceFiles: string[];
  /** Derived whole-range system rollup: real anchors for the architecture diagram. */
  systemRollup: StoryProjection;
  /** Diagram caps and tone vocabulary the narrator must respect. */
  diagramLimits: NarrationDiagramLimits;
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
      entities: unit.entities ?? [],
      storyRollup: buildUnitStory(unit, manifest.entities, manifest.relationships)
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
    analysisLimitations: manifest.analysisLimitations.map((l) => ({ ...l })),
    evidenceFiles: [...collectEvidenceFiles(manifest)].sort(),
    systemRollup: buildOverviewStory(manifest.entities, manifest.relationships),
    diagramLimits: {
      architecture: {
        maxNodes: MAX_ARCHITECTURE_DIAGRAM_NODES,
        maxClusters: MAX_DIAGRAM_CLUSTERS
      },
      story: { maxNodes: MAX_STORY_DIAGRAM_NODES },
      tones: [...DIAGRAM_TONES]
    }
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

/**
 * A concept diagram as the narrator proposes it: pure structured data.
 * Raw Mermaid (or any other markup) is structurally impossible here — the
 * renderer alone turns validated nodes/edges into diagram source.
 */
export interface NarrationDiagram {
  clusters?: DiagramCluster[];
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export interface ChangeUnitNarration {
  id: string;
  humanTitle?: string;
  summary?: string;
  beforeDescription?: string;
  afterDescription?: string;
  userImpact?: string;
  openQuestions?: string[];
  /** Proposed story diagram for this unit (max 7 nodes, clusters optional). */
  storyDiagram?: NarrationDiagram;
  confidence?: number;
}

/** Proposed narration for one narratable book chapter. */
export interface ChapterNarrationProposal {
  summary: string;
  /** At most 5 key points. */
  keyPoints?: string[];
}

export interface NarrationResponse {
  entities?: EntityNarration[];
  changeUnits?: ChangeUnitNarration[];
  /** Proposed whole-range concept diagram (max 20 nodes / 6 clusters). */
  architectureDiagram?: NarrationDiagram;
  /** Project-level summary (what this repository is, in one breath). */
  projectSummary?: string;
  /** Narration for the narratable book chapters (purpose, systems, flows). */
  chapters?: Partial<Record<NarratedChapterId, ChapterNarrationProposal>>;
}

const ENTITY_SLOTS = new Set(["humanLabel"]);
const CHANGE_UNIT_SLOTS = new Set([
  "humanTitle",
  "summary",
  "beforeDescription",
  "afterDescription",
  "userImpact",
  "openQuestions",
  "storyDiagram"
]);
const RESPONSE_KEYS = new Set([
  "entities",
  "changeUnits",
  "architectureDiagram",
  "projectSummary",
  "chapters"
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

/** Push an error unless value is a non-empty string within maxLength. */
function checkDiagramString(
  value: unknown,
  where: string,
  errors: string[],
  maxLength: number = MAX_DIAGRAM_LABEL_LENGTH
): void {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${where} must be a non-empty string`);
  } else if (value.length > maxLength) {
    errors.push(`${where} is ${value.length} chars — cap is ${maxLength}`);
  }
}

/** A validated diagram before the provenance stamp is applied. */
type SanitizedDiagram = Pick<ConceptDiagram, "clusters" | "nodes" | "edges">;

interface DiagramCaps {
  maxNodes: number;
  maxClusters: number;
}

const DIAGRAM_KEYS = new Set(["clusters", "nodes", "edges"]);
const CLUSTER_KEYS = new Set(["id", "title", "tone"]);
const NODE_KEYS = new Set(["id", "cluster", "humanLabel", "role", "file"]);
const EDGE_KEYS = new Set(["from", "to", "verb"]);
const TONE_SET = new Set<string>(DIAGRAM_TONES);

function checkUnknownKeys(
  raw: Record<string, unknown>,
  where: string,
  allowed: Set<string>,
  whatItHas: string,
  errors: string[]
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push(
        `${where}.${key.slice(0, 100)} is not recognised — ${whatItHas}` +
          (key === "provenance"
            ? '. Provenance is stamped by the validator; narrated diagrams are always "inferred".'
            : "")
      );
    }
  }
}

/**
 * Validate a proposed concept diagram. Pushes actionable errors; returns a
 * normalized copy (never the raw input) only when the diagram is fully valid.
 * Every node "file" must exist in the manifest's evidence index — the
 * narrator cannot anchor a diagram to a fabricated path.
 */
function checkDiagram(
  raw: unknown,
  where: string,
  caps: DiagramCaps,
  evidenceFiles: Set<string>,
  errors: string[]
): SanitizedDiagram | null {
  const before = errors.length;
  if (!isPlainObject(raw)) {
    errors.push(
      `${where} must be a structured diagram object like ` +
        `{"clusters": [...], "nodes": [...], "edges": [...]} — raw Mermaid text is never accepted`
    );
    return null;
  }
  checkUnknownKeys(raw, where, DIAGRAM_KEYS, "a diagram has only clusters, nodes and edges", errors);

  // ---- Clusters -----------------------------------------------------------
  const clusterIds = new Set<string>();
  const rawClusters = raw["clusters"] ?? [];
  if (!Array.isArray(rawClusters)) {
    errors.push(`${where}.clusters must be an array of {id, title, tone} objects`);
  } else {
    if (rawClusters.length > caps.maxClusters) {
      errors.push(
        `${where} declares ${rawClusters.length} clusters — cap is ${caps.maxClusters}`
      );
    }
    rawClusters.forEach((cluster, index) => {
      const at = `${where}.clusters[${index}]`;
      if (!isPlainObject(cluster)) {
        errors.push(`${at} must be an object with id, title and tone`);
        return;
      }
      checkUnknownKeys(cluster, at, CLUSTER_KEYS, "clusters have only id, title and tone", errors);
      checkDiagramString(cluster["id"], `${at}.id`, errors);
      checkDiagramString(cluster["title"], `${at}.title`, errors);
      const tone = cluster["tone"];
      if (typeof tone !== "string" || !TONE_SET.has(tone)) {
        errors.push(
          `${at}.tone must be one of: ${DIAGRAM_TONES.join(", ")}` +
            ` — got ${JSON.stringify(tone).slice(0, 100)}`
        );
      }
      const id = cluster["id"];
      if (typeof id === "string" && id.length > 0) {
        if (clusterIds.has(id)) {
          errors.push(`${at} duplicates cluster id "${id.slice(0, 100)}"`);
        } else {
          clusterIds.add(id);
        }
      }
    });
  }

  // ---- Nodes ---------------------------------------------------------------
  const nodeIds = new Set<string>();
  const rawNodes = raw["nodes"];
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    errors.push(`${where}.nodes must be a non-empty array of {id, humanLabel, role} objects`);
  } else {
    if (rawNodes.length > caps.maxNodes) {
      errors.push(`${where} has ${rawNodes.length} nodes — cap is ${caps.maxNodes}`);
    }
    rawNodes.forEach((node, index) => {
      const at = `${where}.nodes[${index}]`;
      if (!isPlainObject(node)) {
        errors.push(`${at} must be an object with id, humanLabel and role`);
        return;
      }
      checkUnknownKeys(
        node,
        at,
        NODE_KEYS,
        "nodes have only id, cluster, humanLabel, role and file",
        errors
      );
      checkDiagramString(node["id"], `${at}.id`, errors);
      checkDiagramString(node["humanLabel"], `${at}.humanLabel`, errors);
      checkDiagramString(node["role"], `${at}.role`, errors);
      const id = node["id"];
      if (typeof id === "string" && id.length > 0) {
        if (nodeIds.has(id)) {
          errors.push(`${at} duplicates node id "${id.slice(0, 100)}"`);
        } else {
          nodeIds.add(id);
        }
      }
      const cluster = node["cluster"];
      if (cluster !== undefined) {
        if (typeof cluster !== "string" || !clusterIds.has(cluster)) {
          errors.push(
            `${at}.cluster references undeclared cluster ` +
              `${JSON.stringify(cluster).slice(0, 100)} — declare it in ${where}.clusters first`
          );
        }
      }
      const file = node["file"];
      if (file !== undefined) {
        if (typeof file !== "string" || file.length === 0 || file.length > MAX_DIAGRAM_FILE_LENGTH) {
          errors.push(
            `${at}.file must be a repo-relative path string (≤ ${MAX_DIAGRAM_FILE_LENGTH} chars)`
          );
        } else if (!evidenceFiles.has(file)) {
          errors.push(
            `${at}.file "${file.slice(0, 200)}" is not an evidence file in this manifest — ` +
              `pick a path from the request's evidenceFiles list or omit "file"`
          );
        }
      }
    });
  }

  // ---- Edges ---------------------------------------------------------------
  const rawEdges = raw["edges"] ?? [];
  if (!Array.isArray(rawEdges)) {
    errors.push(`${where}.edges must be an array of {from, to, verb} objects`);
  } else {
    const edgeCap = caps.maxNodes * EDGES_PER_NODE;
    if (rawEdges.length > edgeCap) {
      errors.push(`${where} has ${rawEdges.length} edges — cap is ${edgeCap}`);
    }
    rawEdges.forEach((edge, index) => {
      const at = `${where}.edges[${index}]`;
      if (!isPlainObject(edge)) {
        errors.push(`${at} must be an object with from, to and verb`);
        return;
      }
      checkUnknownKeys(edge, at, EDGE_KEYS, "edges have only from, to and verb", errors);
      checkDiagramString(edge["verb"], `${at}.verb`, errors);
      for (const end of ["from", "to"] as const) {
        const ref = edge[end];
        if (typeof ref !== "string" || !nodeIds.has(ref)) {
          errors.push(
            `${at}.${end} references undeclared node ` +
              `${JSON.stringify(ref).slice(0, 100)} — edges may only connect declared nodes`
          );
        }
      }
    });
  }

  if (errors.length !== before) return null;

  // ---- Normalized copy (never the raw input) -------------------------------
  const clusters = (rawClusters as Record<string, unknown>[]).map(
    (cluster): DiagramCluster => ({
      id: cluster["id"] as string,
      title: cluster["title"] as string,
      tone: cluster["tone"] as DiagramTone
    })
  );
  const nodes = (rawNodes as Record<string, unknown>[]).map((node): DiagramNode => {
    const clean: DiagramNode = {
      id: node["id"] as string,
      humanLabel: node["humanLabel"] as string,
      role: node["role"] as string
    };
    if (node["cluster"] !== undefined) clean.cluster = node["cluster"] as string;
    if (node["file"] !== undefined) clean.file = node["file"] as string;
    return clean;
  });
  const edges = (rawEdges as Record<string, unknown>[]).map(
    (edge): DiagramEdge => ({
      from: edge["from"] as string,
      to: edge["to"] as string,
      verb: edge["verb"] as string
    })
  );
  const diagram: SanitizedDiagram = { nodes, edges };
  if (clusters.length > 0) diagram.clusters = clusters;
  return diagram;
}

/** Out-of-band channel for storyDiagrams validated inside checkRecord. */
interface DiagramContext {
  evidenceFiles: Set<string>;
  sanitized: Map<Record<string, unknown>, SanitizedDiagram>;
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
  errors: string[],
  diagramContext?: DiagramContext
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
    if (key === "storyDiagram") {
      if (diagramContext === undefined) {
        errors.push(`${where}.storyDiagram is not accepted here`);
        continue;
      }
      const diagram = checkDiagram(
        value,
        `${where}.storyDiagram`,
        { maxNodes: MAX_STORY_DIAGRAM_NODES, maxClusters: MAX_DIAGRAM_CLUSTERS },
        diagramContext.evidenceFiles,
        errors
      );
      if (diagram === null) continue;
      diagramContext.sanitized.set(raw, diagram);
      hasSlot = true;
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
    if (!RESPONSE_KEYS.has(key)) {
      errors.push(
        `response.${key.slice(0, 100)} is not recognised — accepted keys: ${[...RESPONSE_KEYS].join(", ")}`
      );
    }
  }

  const entityIds = new Set(manifest.entities.map((e) => e.id));
  const unitIds = new Set(manifest.changeUnits.map((u) => u.id));
  const validEntities: Record<string, unknown>[] = [];
  const validUnits: Record<string, unknown>[] = [];
  const diagramContext: DiagramContext = {
    evidenceFiles: collectEvidenceFiles(manifest),
    sanitized: new Map()
  };

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
        errors,
        diagramContext
      );
      if (record !== null) validUnits.push(record);
    });
  }

  // ---- Architecture diagram ------------------------------------------------
  let architectureDiagram: SanitizedDiagram | null = null;
  if (response["architectureDiagram"] !== undefined) {
    architectureDiagram = checkDiagram(
      response["architectureDiagram"],
      "architectureDiagram",
      { maxNodes: MAX_ARCHITECTURE_DIAGRAM_NODES, maxClusters: MAX_DIAGRAM_CLUSTERS },
      diagramContext.evidenceFiles,
      errors
    );
  }

  // ---- Project summary -------------------------------------------------------
  let projectSummary: string | null = null;
  const rawProjectSummary = response["projectSummary"];
  if (rawProjectSummary !== undefined) {
    if (typeof rawProjectSummary !== "string" || rawProjectSummary.length === 0) {
      errors.push("projectSummary must be a non-empty string");
    } else if (rawProjectSummary.length > MAX_NARRATION_LENGTH) {
      errors.push(
        `projectSummary is ${rawProjectSummary.length} chars — cap is ${MAX_NARRATION_LENGTH}`
      );
    } else {
      projectSummary = rawProjectSummary;
    }
  }

  // ---- Chapter narrations ----------------------------------------------------
  const chapterNarrations = new Map<NarratedChapterId, ChapterNarrationProposal>();
  const rawChapters = response["chapters"];
  if (rawChapters !== undefined) {
    if (!isPlainObject(rawChapters)) {
      errors.push(
        'response.chapters must be an object keyed by chapter id, e.g. {"purpose": {"summary": "…"}}'
      );
    } else {
      const narratable = new Set<string>(NARRATED_CHAPTER_IDS);
      for (const [chapterId, rawChapter] of Object.entries(rawChapters)) {
        const at = `chapters.${chapterId.slice(0, 50)}`;
        if (!narratable.has(chapterId)) {
          errors.push(
            `${at} is not a narratable chapter — narratable chapters: ${NARRATED_CHAPTER_IDS.join(", ")}`
          );
          continue;
        }
        if (!isPlainObject(rawChapter)) {
          errors.push(`${at} must be an object with a "summary" and optional "keyPoints"`);
          continue;
        }
        const before = errors.length;
        for (const key of Object.keys(rawChapter)) {
          if (key !== "summary" && key !== "keyPoints") {
            errors.push(
              `${at}.${key.slice(0, 100)} is not recognised — chapter narration has only summary and keyPoints` +
                (key === "provenance"
                  ? '. Provenance is stamped by the validator; narration is always "inferred".'
                  : "")
            );
          }
        }
        const summary = rawChapter["summary"];
        if (typeof summary !== "string" || summary.length === 0) {
          errors.push(`${at}.summary must be a non-empty string`);
        } else if (summary.length > MAX_NARRATION_LENGTH) {
          errors.push(`${at}.summary is ${summary.length} chars — cap is ${MAX_NARRATION_LENGTH}`);
        }
        const keyPoints = rawChapter["keyPoints"];
        if (
          keyPoints !== undefined &&
          (!Array.isArray(keyPoints) ||
            keyPoints.length > MAX_CHAPTER_KEY_POINTS ||
            !keyPoints.every(
              (p) => typeof p === "string" && p.length > 0 && p.length <= MAX_NARRATION_LENGTH
            ))
        ) {
          errors.push(
            `${at}.keyPoints must be an array of at most ${MAX_CHAPTER_KEY_POINTS} ` +
              `non-empty strings (each ≤ ${MAX_NARRATION_LENGTH} chars)`
          );
        }
        if (errors.length === before) {
          const proposal: ChapterNarrationProposal = { summary: summary as string };
          if (keyPoints !== undefined) proposal.keyPoints = [...(keyPoints as string[])];
          chapterNarrations.set(chapterId as NarratedChapterId, proposal);
        }
      }
    }
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
      if (slot === "storyDiagram") {
        const diagram = diagramContext.sanitized.get(record);
        if (diagram !== undefined) {
          unit.storyDiagram = { ...diagram, provenance: "inferred" };
        }
      } else if (slot === "openQuestions") {
        unit.openQuestions = value as string[];
      } else {
        unit[slot as "humanTitle" | "summary" | "beforeDescription" | "afterDescription" | "userImpact"] =
          value as string;
      }
    }
    stampInferred(unit, record["confidence"]);
  }

  if (architectureDiagram !== null) {
    merged.architectureDiagram = { ...architectureDiagram, provenance: "inferred" };
  }
  if (projectSummary !== null) {
    merged.projectNarration = { summary: projectSummary, provenance: "inferred" };
  }
  if (chapterNarrations.size > 0) {
    const target = merged.chapterNarrations ?? {};
    for (const [chapterId, proposal] of chapterNarrations) {
      const narration: ChapterNarration = {
        summary: proposal.summary,
        provenance: "inferred"
      };
      if (proposal.keyPoints !== undefined) narration.keyPoints = proposal.keyPoints;
      target[chapterId] = narration;
    }
    merged.chapterNarrations = target;
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

/**
 * No-agent mode: merge the deterministic template narration and keep
 * provenance "derived". The template restates derived facts verbatim — there
 * is no AI judgement to flag, so the ◇ AI-interpretation marker must not
 * appear on template output. Agent responses never come through here; they
 * go through `applyNarration` directly and are always stamped "inferred".
 */
export function applyTemplateNarration(manifest: ChangeManifest): ChangeManifest {
  const response = templateNarrator(buildNarrationRequest(manifest));
  const merged = applyNarration(manifest, response);
  if (!merged.ok) {
    throw new Error(
      `template narration rejected (gitiviz bug):\n  - ${merged.errors.join("\n  - ")}`
    );
  }
  // applyNarration defensively stamps everything it merges "inferred";
  // restore the truth for the units the deterministic template filled.
  const templatedIds = new Set((response.changeUnits ?? []).map((unit) => unit.id));
  for (const unit of merged.value.changeUnits) {
    if (templatedIds.has(unit.id)) {
      unit.provenance = "derived";
      delete unit.confidence;
    }
  }
  return merged.value;
}
