export const CATALOG_OBSERVATION_PORT_SCHEMA =
  'narada.catalog-observation.port-request.v1' as const;

export const CATALOG_OBSERVATION_SCHEMA =
  'narada.invokable-intelligence.catalog-observation.v1' as const;

export type CatalogObservationAccessMode =
  | 'public'
  | 'credentialed'
  | 'operator_attested';

export type CatalogObservationPortRequest = {
  schema: typeof CATALOG_OBSERVATION_PORT_SCHEMA;
  provider_id: string;
  observed_at: string;
  access_mode: CatalogObservationAccessMode;
};

export type CatalogObservationPortResponse = {
  schema: typeof CATALOG_OBSERVATION_SCHEMA;
  id: string;
  observed_at: string;
  inference_provider: {
    kind: 'inference-provider';
    id: string;
  };
  access_mode: CatalogObservationAccessMode | 'unavailable';
  status: 'complete' | 'partial' | 'unavailable';
  models: Array<Record<string, unknown>>;
  diagnostics: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

/**
 * Narada-owned read-only observation port. Credential material deliberately
 * does not appear in this boundary type.
 */
export interface CatalogObservationPort {
  observe(request: CatalogObservationPortRequest): Promise<CatalogObservationPortResponse>;
}
