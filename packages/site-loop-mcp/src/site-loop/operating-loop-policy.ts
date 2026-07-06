import {
  DEFAULT_SITE_OPERATING_LOOP_POLICY,
  currentQuietHoursState,
  loadSiteOperatingLoopPolicy,
  mergeSiteOperatingLoopPolicy,
  operatingLoopPolicyPath,
  validateSiteOperatingLoopPolicy,
} from '../site-operating-loop/policy.js';
import { DEFAULT_SITE_LOOP_CONFIG, requireSiteLoopConfig, type SiteLoopConfig } from './site-loop-config.js';

export { currentQuietHoursState, operatingLoopPolicyPath };

export const DEFAULT_SITE_LOOP_OPERATING_POLICY = siteLoopOperatingPolicy(DEFAULT_SITE_LOOP_CONFIG);

type SiteLoopPolicyValidationContext = { cwd?: string; config?: SiteLoopConfig };

function siteLoopOperatingPolicy(config) {
  return mergeSiteOperatingLoopPolicy(DEFAULT_SITE_OPERATING_LOOP_POLICY, {
    schema: config.policy.schema,
    loop_id: config.loop_id,
    carrier: {
      preferred: config.policy.allowed_preferred_carriers[0] ?? config.resident_runtime.preferred_preference,
      fallback: config.policy.allowed_fallback_carriers[0] ?? config.resident_runtime.fallback_runtime,
    },
    attention: config.policy.attention,
  });
}

function validationForSiteLoopConfig(config: SiteLoopConfig) {
  const defaults = siteLoopOperatingPolicy(config);
  return {
    expectedSchema: defaults.schema,
    expectedLoopId: defaults.loop_id,
    allowedPreferredCarriers: config.policy.allowed_preferred_carriers,
    allowedFallbackCarriers: config.policy.allowed_fallback_carriers,
  };
}

function siteLoopConfigFromValidationContext(context: SiteLoopPolicyValidationContext = {}) {
  if (context.config) return context.config;
  if (context.cwd) return requireSiteLoopConfig(context.cwd);
  return DEFAULT_SITE_LOOP_CONFIG;
}

export function loadSiteLoopOperatingPolicy(cwd) {
  const loopConfig = requireSiteLoopConfig(cwd);
  const defaults = siteLoopOperatingPolicy(loopConfig);
  const loaded = loadSiteOperatingLoopPolicy(cwd, {
    defaults,
    validation: validationForSiteLoopConfig(loopConfig),
  });
  return {
    ...loaded,
    schema: 'narada.site_loop.operating_policy_load.v1',
    validation: {
      ...loaded.validation,
      schema: 'narada.site_loop.operating_policy_validation.v1',
    },
  };
}

export function validateSiteLoopOperatingPolicy(policy, context: SiteLoopPolicyValidationContext = {}) {
  const validation = validateSiteOperatingLoopPolicy(policy, validationForSiteLoopConfig(siteLoopConfigFromValidationContext(context)));
  return {
    ...validation,
    schema: 'narada.site_loop.operating_policy_validation.v1',
  };
}

