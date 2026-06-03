import {
  DEFAULT_SITE_OPERATING_LOOP_POLICY,
  currentQuietHoursState,
  loadSiteOperatingLoopPolicy,
  mergeSiteOperatingLoopPolicy,
  operatingLoopPolicyPath,
  validateSiteOperatingLoopPolicy,
} from '../site-operating-loop/policy.js';

export { currentQuietHoursState, operatingLoopPolicyPath };

export const DEFAULT_SONAR_EMAIL_RESIDENT_POLICY = mergeSiteOperatingLoopPolicy(DEFAULT_SITE_OPERATING_LOOP_POLICY, {
  schema: 'narada.sonar.operating_loop_policy.v1',
  loop_id: 'sonar.email-resident',
  attention: {
    no_carrier: 'warning',
    stale_delivery_lease: 'error',
    stale_action: 'error',
    stale_busy_carrier: 'error',
    policy_drift: 'error',
    repeated_loop_failure: 'critical',
    db_integrity_failure: 'critical',
    no_new_mailbox_work: 'info',
    duplicates_only: 'info',
  },
});

const SONAR_POLICY_VALIDATION = {
  expectedSchema: DEFAULT_SONAR_EMAIL_RESIDENT_POLICY.schema,
  expectedLoopId: DEFAULT_SONAR_EMAIL_RESIDENT_POLICY.loop_id,
  allowedPreferredCarriers: ['interactive_agent_cli'],
  allowedFallbackCarriers: ['agent-runtime-server'],
};

export function loadSonarEmailResidentOperatingPolicy(cwd) {
  const loaded = loadSiteOperatingLoopPolicy(cwd, {
    defaults: DEFAULT_SONAR_EMAIL_RESIDENT_POLICY,
    validation: SONAR_POLICY_VALIDATION,
  });
  return {
    ...loaded,
    schema: 'narada.sonar.operating_loop_policy_load.v1',
    validation: {
      ...loaded.validation,
      schema: 'narada.sonar.operating_loop_policy_validation.v1',
    },
  };
}

export function validateSonarEmailResidentOperatingPolicy(policy) {
  const validation = validateSiteOperatingLoopPolicy(policy, SONAR_POLICY_VALIDATION);
  return {
    ...validation,
    schema: 'narada.sonar.operating_loop_policy_validation.v1',
  };
}
