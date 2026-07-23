declare module '@narada2/site-operating-loop/site-loop-store' {
  export const DEFAULT_SITE_OPERATING_LOOP_ID: string;
  export const DEFAULT_SITE_OPERATING_LOOP_OWNER_ID: string;
  export function ensureSiteLoopTables(db: any): any;
  export function getSiteOperatingLoopRuntimeHost(store: any, loopId?: string): any;
  export function claimSiteOperatingLoopRuntimeHost(store: any, options?: any): any;
  export function assertSiteOperatingLoopRuntimeHostAuthority(store: any, options?: any): any;
  export function heartbeatSiteOperatingLoopRuntimeHost(store: any, options?: any): any;
  export function transitionSiteOperatingLoopRuntimeHost(store: any, options?: any): any;
}
