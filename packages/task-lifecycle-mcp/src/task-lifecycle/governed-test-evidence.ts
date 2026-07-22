export type GovernedTestEvidenceValidation = {
  schema: 'narada.task.mcp.governed_test_evidence.v1';
  status: 'not_provided' | 'admissible' | 'diagnostic_only' | 'rejected';
  execution_refs: string[];
  diagnostic_refs: string[];
  rejected_refs: Array<{ ref: string; reason: string }>;
  verification_eligible: boolean;
  remediation: string;
};

const STRUCTURED_COMMAND_EXECUTION_REF = /^structured_command_execution:[A-Za-z0-9._:-]+$/;
const TEST_MCP_ARTIFACT_REF = /^test_mcp_artifact:[A-Za-z0-9._:-]+$/;
const MCP_OUTPUT_REF = /^mcp_output:[A-Za-z0-9._:-]+$/;
const TRANSIENT_PATH = /(^|[\\/])\.ai[\\/](?:tmp|temp)(?:[\\/]|$)/i;
const UNGOVERNED_ARTIFACT = /(?:\.(?:log|exit|cmd|bat)|\bwrapper\b)/i;

export function validateGovernedTestEvidenceRefs(refs: readonly string[] | undefined): GovernedTestEvidenceValidation {
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

  const status = rejectedRefs.length > 0
    ? 'rejected'
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
    verification_eligible: executionRefs.length > 0,
    remediation: status === 'rejected'
      ? 'Use structured_command_start or the owning Test MCP and pass its structured_command_execution:<execution_ref> or test_mcp_artifact:<artifact_id>. Do not pass .log/.exit files, .cmd/.bat wrappers, .ai/tmp paths, or untyped narrative refs. mcp_output:<id> is diagnostic material only and does not prove execution.'
      : status === 'diagnostic_only'
      ? 'mcp_output refs are diagnostic material only. Attach a structured_command_execution or test_mcp_artifact ref for governed execution evidence.'
      : 'Governed execution evidence is typed and can be independently read back.'
  };
}
