import { BrowserControlError, BrowserSession, type BrowserActionIntent } from './browser.js';
import {
  actionReceipt,
  boundedResult,
  errorResult,
  requiredSession,
  resultValue,
  sessionKey,
  type BrowserControlState,
} from './state.js';
import { buildGuidanceResult } from './guidance.js';
import { outputShowAsync } from '@narada-core/mcp-transport';
import type { JsonRecord } from './tool-definitions.js';

function selectedIntent(args: JsonRecord): BrowserActionIntent {
  const value = args.intent ?? 'verify';
  if (value !== 'verify' && value !== 'login' && value !== 'submit' && value !== 'destructive') {
    throw new BrowserControlError('intent_invalid', 'intent must be verify, login, submit, or destructive.');
  }
  return value;
}

export async function dispatchTool(state: BrowserControlState, toolName: string, args: JsonRecord): Promise<JsonRecord> {
  if (toolName === 'browser_control_guidance') return resultValue('ok', buildGuidanceResult(args));
  if (toolName === 'browser_control_session_inventory') {
    return resultValue('ok', {
      site_root: state.siteRoot,
      sessions: [...state.sessions.values()].map((session) => session.info()),
      count: state.sessions.size,
    });
  }
  if (toolName === 'mcp_output_show') {
    return await outputShowAsync({ siteRoot: state.siteRoot, args }) as JsonRecord;
  }
  if (toolName === 'browser_control_attach') {
    const session = await BrowserSession.attach(args);
    const key = sessionKey(session.profileId, session.sessionId);
    if (state.sessions.has(key)) {
      session.close();
      throw new BrowserControlError('browser_session_already_attached', 'That profile/session is already attached; detach it before attaching again.');
    }
    state.sessions.set(key, session);
    return resultValue('attached', {
      session: session.info(),
      action_receipt: actionReceipt(state, 'attach', session, { allowed_origins: session.allowedOrigins }),
    });
  }

  const session = requiredSession(args, state);
  if (toolName === 'browser_control_status') return resultValue('ok', { session: await session.status() });
  if (toolName === 'browser_control_navigate') {
    const navigation = await session.navigate(args.url);
    return resultValue('ok', {
      ...navigation,
      session: session.info(),
      action_receipt: actionReceipt(state, 'navigate', session, { url: navigation.url }),
    });
  }
  if (toolName === 'browser_control_accessibility_snapshot') {
    const snapshot = await session.accessibilitySnapshot(args);
    return { ...snapshot, action_receipt: actionReceipt(state, 'accessibility_snapshot', session) };
  }
  if (toolName === 'browser_control_screenshot') {
    const screenshot = await session.screenshot(args);
    return {
      ...screenshot,
      action_receipt: actionReceipt(state, 'screenshot', session, { format: args.format ?? 'png' }),
    };
  }
  if (toolName === 'browser_control_click') {
    const clicked = await session.click({ ...args, intent: selectedIntent(args) });
    return resultValue('ok', {
      ...clicked,
      session: session.info(),
      action_receipt: actionReceipt(state, 'click', session, { selector: args.selector, intent: clicked.intent }),
    });
  }
  if (toolName === 'browser_control_fill') {
    const filled = await session.fill({ ...args, intent: selectedIntent(args) });
    return resultValue('ok', {
      ...filled,
      session: session.info(),
      action_receipt: actionReceipt(state, 'fill', session, {
        selector: args.selector,
        intent: filled.intent,
        value_length: filled.value_length,
        value_sha256: filled.value_sha256,
      }),
    });
  }
  if (toolName === 'browser_control_wait') {
    const waited = await session.wait(args);
    return resultValue('ok', {
      ...waited,
      session: session.info(),
      action_receipt: actionReceipt(state, 'wait', session, { selector: waited.selector, sleep_ms: args.sleep_ms ?? null }),
    });
  }
  if (toolName === 'browser_control_assert') {
    const assertion = await session.assert(args);
    return {
      ...assertion,
      action_receipt: actionReceipt(state, 'assert', session, { selector: args.selector, matched: assertion.matched }),
    };
  }
  if (toolName === 'browser_control_detach') {
    const key = sessionKey(session.profileId, session.sessionId);
    state.sessions.delete(key);
    session.close();
    return resultValue('detached', {
      profile_id: session.profileId,
      session_id: session.sessionId,
      action_receipt: actionReceipt(state, 'detach', session),
    });
  }
  throw new BrowserControlError('unknown_tool', `Unknown browser-control tool: ${toolName}`);
}

export async function dispatchWithError(state: BrowserControlState, toolName: string, args: JsonRecord): Promise<JsonRecord> {
  try {
    return boundedResult(state, toolName, await dispatchTool(state, toolName, args));
  } catch (error) {
    return errorResult(state, toolName, error);
  }
}
