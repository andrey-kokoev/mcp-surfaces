export type GovernedTestEvidenceValidation = {
  schema: 'narada.task.mcp.governed_test_evidence.v1';
  status: 'not_provided' | 'admissible' | 'diagnostic_only' | 'rejected' | 'unverified';
  execution_refs: string[];
  diagnostic_refs: string[];
  rejected_refs: Array<{ ref: string; reason: string }>;
  verified_refs: string[];
  unverified_refs: Array<{ ref: string; reason: string; details?: Record<string, unknown> }>;
  verification_results: Array<{ ref: string; status: 'verified' | 'unverified'; reason: string; details?: Record<string, unknown> }>;
  verification_eligible: boolean;
  remediation: string;
};

export type GovernedTestEvidenceResolution = {
  status: 'verified' | 'unverified';
  reason: string;
  details?: Record<string, unknown>;
};

export type GovernedTestEvidenceValidationOptions = {
  resolve?: (ref: string) => GovernedTestEvidenceResolution;
};

const STRUCTURED_COMMAND_EXECUTION_REF = /^structured_command_execution:[A-Za-z0-9._:-]+$/;
const TEST_MCP_ARTIFACT_REF = /^test_mcp_artifact:[A-Za-z0-9._:-]+$/;
const MCP_OUTPUT_REF = /^mcp_output:[A-Za-z0-9._:-]+$/;
const TRANSIENT_PATH = /(^|[\\/])\.ai[\\/](?:tmp|temp)(?:[\\/]|$)/i;
const UNGOVERNED_ARTIFACT = /(?:\.(?:log|exit|cmd|bat)|\bwrapper\b)/i;

export function validateGovernedTestEvidenceRefs(refs: readonly string[] | undefined, options: GovernedTestEvidenceValidationOptions = {}): GovernedTestEvidenceValidation {
  const normalized = (refs ?? []).map((ref) => String(ref).trim()).filter(Boolean);
  const executionRefs: string[] = [];
  const diagnosticRefs: string[] = [];
  const rejectedRefs: Array<{ ref: string; reason: string }> = [];

  for (const ref of normalized) {
    if (STRUCTURED_COMMAND_EXECUTION_REF.test(ref) || TEST_MCP_ARTIFACT_REF.test(ref)) {
      executionRefs.push(ref);
      continue;
    }
    if (MCP_OUTPUT_REF.test(ref)) {
      diagnosticRefs.push(ref);
      continue;
    }
    const reason = TRANSIENT_PATH.test(ref)
      ? 'transient_path_not_admissible'
      : UNGOVERNED_ARTIFACT.test(ref)
      ? 'copied_or_wrapper_artifact_not_admissible'
      : 'unrecognized_evidence_ref_format';
    rejectedRefs.push({ ref, reason });
  }

  const verificationResults: GovernedTestEvidenceValidation['verification_results'] = [];
  const verifiedRefs: string[] = [];
  const unverifiedRefs: GovernedTestEvidenceValidation['unverified_refs'] = [];
  for (const ref of executionRefs) {
    let resolution: GovernedTestEvidenceResolution;
    try {
      resolution = options.resolve?.(ref) ?? {
        status: 'unverified',
        reason: 'evidence_ref_not_dereferenced',
      };
    } catch (error) {
      resolution = {
        status: 'unverified',
        reason: 'evidence_ref_resolution_failed',
        details: { error: error instanceof Error ? error.message : String(error) },
      };
    }
    const result = { ref, ...resolution };
    verificationResults.push(result);
    if (resolution.status === 'verified') verifiedRefs.push(ref);
    else unverifiedRefs.push({ ref, reason: resolution.reason, ...(resolution.details ? { details: resolution.details } : {}) });
  }

  const status = rejectedRefs.length > 0
    ? 'rejected'
    : executionRefs.length > 0 && unverifiedRefs.length > 0
    ? 'unverified'
    : executionRefs.length > 0
    ? 'admissible'
    : diagnosticRefs.length > 0
    ? 'diagnostic_only'
    : 'not_provided';

  return {
    schema: 'narada.task.mcp.governed_test_evidence.v1',
    status,
    execution_refs: executionRefs,
    diagnostic_refs: diagnosticRefs,
    rejected_refs: rejectedRefs,
    verified_refs: verifiedRefs,
    unverified_refs: unverifiedRefs,
    verification_results: verificationResults,
    verification_eligible: executionRefs.length > 0 && unverifiedRefs.length === 0 && rejectedRefs.length === 0,
    remediation: status === 'rejected'
      ? 'Use structured_command_start or the owning Test MCP and pass its structured_command_execution:<execution_ref> or test_mcp_artifact:<artifact_id>. Do not pass .log/.exit files, .cmd/.bat wrappers, .ai/tmp paths, or untyped narrative refs. mcp_output:<id> is diagnostic material only and does not prove execution.'
      : status === 'unverified'
      ? 'The typed evidence ref could not be independently verified as a successful governed run. Read it back through the owning surface, then retry with the same structured_command_execution or test_mcp_artifact ref only after it reports success.'
      : status === 'diagnostic_only'
      ? 'mcp_output refs are diagnostic material only. Attach a structured_command_execution or test_mcp_artifact ref for governed execution evidence.'
      : 'Governed execution evidence is typed, independently dereferenced, and must report a successful run before it can support closure.'
  };
}
