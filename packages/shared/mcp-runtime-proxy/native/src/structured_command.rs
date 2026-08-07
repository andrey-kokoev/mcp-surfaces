use crate::filesystem::{read_message, write_message};
use serde_json::{json, Value};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

const PROTOCOL_VERSION: &str = "2024-11-05";
const DEFAULT_MAX_TIMEOUT_MS: u64 = 900_000;
const MAX_SYNCHRONOUS_TIMEOUT_MS: u64 = 240_000;
const DEFAULT_MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 20 * 1024 * 1024;
const DEFAULT_ALLOWED_COMMANDS: &[&str] = &["railway", "wrangler"];
const DEFAULT_ALLOWED_PREFIXES: &[&[&str]] = &[
    &["pnpm", "test"],
    &["pnpm", "build"],
    &["pnpm", "typecheck"],
    &["pnpm", "--filter"],
    &["pwsh", "-file"],
    &["pwsh", "-noprofile", "-file"],
    &["pwsh", "-noprofile", "-executionpolicy", "bypass", "-file"],
];
const DEFAULT_BLOCKED_COMMANDS: &[&str] = &["cmd", "cmd.exe", "powershell", "powershell.exe", "wsl", "wsl.exe"];
const TRANSIENT_EXTENSIONS: &[&str] = &[".ps1", ".psm1", ".js", ".mjs", ".cjs", ".ts"];

#[derive(Clone)]
struct State {
    allowed_roots: Vec<PathBuf>,
    allowed_commands: Vec<String>,
    allowed_prefixes: Vec<Vec<String>>,
    blocked_commands: Vec<String>,
    max_timeout_ms: u64,
    max_output_bytes: usize,
    audit_log_dir: Option<PathBuf>,
}

#[derive(Debug)]
struct StructuredError {
    code: String,
    message: String,
    details: Value,
}

impl StructuredError {
    fn new(code: impl Into<String>, message: impl Into<String>, details: Value) -> Self {
        Self { code: code.into(), message: message.into(), details }
    }
}

pub fn run(args: &[String]) -> Result<(), String> {
    let state = parse_state(args)?;
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let stdout = io::stdout();
    let mut writer = stdout.lock();
    loop {
        let Some((request, framed)) = read_message(&mut reader).map_err(|error| error.to_string())? else { break; };
        if let Some(response) = handle_request(&state, &request) {
            write_message(&mut writer, &response, framed).map_err(|error| error.to_string())?;
            writer.flush().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn parse_state(args: &[String]) -> Result<State, String> {
    let mut roots = Vec::new();
    let mut allowed_commands = DEFAULT_ALLOWED_COMMANDS.iter().map(|value| (*value).to_string()).collect::<Vec<_>>();
    let mut allowed_prefixes = DEFAULT_ALLOWED_PREFIXES.iter().map(|prefix| prefix.iter().map(|part| (*part).to_string()).collect()).collect::<Vec<Vec<String>>>();
    let mut blocked_commands = DEFAULT_BLOCKED_COMMANDS.iter().map(|value| (*value).to_string()).collect::<Vec<_>>();
    let mut max_timeout_ms = DEFAULT_MAX_TIMEOUT_MS;
    let mut max_output_bytes = DEFAULT_MAX_OUTPUT_BYTES;
    let mut audit_log_dir = None;
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        let needs_value = |index: &mut usize, name: &str| -> Result<String, String> {
            *index += 1;
            args.get(*index).cloned().ok_or_else(|| format!("structured_command_{name}_required"))
        };
        match flag {
            "--allowed-root" => roots.push(needs_value(&mut index, "allowed_root")?),
            "--allow-command" => allowed_commands.push(needs_value(&mut index, "allow_command")?.to_ascii_lowercase()),
            "--allow-prefix" => {
                let value = needs_value(&mut index, "allow_prefix")?;
                let prefix = value.split_whitespace().map(|part| part.to_ascii_lowercase()).collect::<Vec<_>>();
                if prefix.is_empty() { return Err("structured_command_allow_prefix_must_not_be_empty".to_string()); }
                allowed_prefixes.push(prefix);
            }
            "--blocked-command" => blocked_commands.push(needs_value(&mut index, "blocked_command")?.to_ascii_lowercase()),
            "--max-timeout-ms" => max_timeout_ms = parse_bounded_u64(&needs_value(&mut index, "max_timeout_ms")?, 1, 3_600_000, DEFAULT_MAX_TIMEOUT_MS, "max_timeout_ms")?,
            "--max-output-bytes" => max_output_bytes = parse_bounded_usize(&needs_value(&mut index, "max_output_bytes")?, 1, MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES, "max_output_bytes")?,
            "--audit-log-dir" => audit_log_dir = Some(needs_value(&mut index, "audit_log_dir")?),
            "--help" => return Err("structured_command_help".to_string()),
            other => return Err(format!("structured_command_unknown_argument:{other}")),
        }
        index += 1;
    }
    if roots.is_empty() { return Err("structured_command_mcp_requires_at_least_one_allowed_root".to_string()); }
    let allowed_roots = roots.into_iter().map(|root| absolute(PathBuf::from(root))).collect::<Vec<_>>();
    Ok(State {
        allowed_roots,
        allowed_commands: dedupe(allowed_commands),
        allowed_prefixes,
        blocked_commands: dedupe(blocked_commands),
        max_timeout_ms,
        max_output_bytes,
        audit_log_dir: audit_log_dir.map(|path| absolute(PathBuf::from(path))),
    })
}

fn parse_bounded_u64(value: &str, min: u64, max: u64, fallback: u64, name: &str) -> Result<u64, String> {
    value.parse::<u64>().map(|parsed| parsed.clamp(min, max)).map_err(|_| format!("structured_command_invalid_{name}:{value}")).or(Ok(fallback))
}

fn parse_bounded_usize(value: &str, min: usize, max: usize, fallback: usize, name: &str) -> Result<usize, String> {
    value.parse::<usize>().map(|parsed| parsed.clamp(min, max)).map_err(|_| format!("structured_command_invalid_{name}:{value}")).or(Ok(fallback))
}

fn dedupe(values: Vec<String>) -> Vec<String> {
    let mut result = Vec::new();
    for value in values {
        if !result.iter().any(|existing| existing == &value) { result.push(value); }
    }
    result
}

fn handle_request(state: &State, request: &Value) -> Option<Value> {
    let method = request.get("method").and_then(Value::as_str).unwrap_or_default();
    let Some(id) = request.get("id").cloned() else { return None; };
    let params = request.get("params").unwrap_or(&Value::Null);
    let result = match method {
        "initialize" => Ok(initialize(request)),
        "tools/list" => Ok(json!({"tools": list_tools()})),
        "tools/call" => call_tool(state, params),
        "resources/list" => Ok(json!({"resources": []})),
        "resources/read" => Err(StructuredError::new("resource_not_found", "resource_not_found", json!({}))),
        "prompts/list" => Ok(json!({"prompts": [{"name": "structured_command_safe_execution", "title": "Structured Command Safe Execution", "description": "Guidance for argv-only command execution.", "arguments": []}]})),
        "prompts/get" => prompt_get(params),
        "completion/complete" => Ok(json!({"completion": {"values": [], "total": 0, "hasMore": false}})),
        "logging/setLevel" => Ok(json!({})),
        _ => Err(StructuredError::new("unsupported_mcp_method", format!("unsupported_mcp_method:{method}"), json!({"method": method}))),
    };
    Some(match result {
        Ok(value) => json!({"jsonrpc": "2.0", "id": id, "result": value}),
        Err(error) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32000, "message": error.message, "data": error_diagnostic(&error)}}),
    })
}

fn initialize(request: &Value) -> Value {
    json!({
        "protocolVersion": request.get("params").and_then(|params| params.get("protocolVersion")).cloned().unwrap_or(json!(PROTOCOL_VERSION)),
        "capabilities": {"tools": {}, "resources": {}, "prompts": {}, "completions": {}, "logging": {}},
        "serverInfo": {"name": "structured-command-native", "version": "0.1.0"}
    })
}

fn list_tools() -> Vec<Value> {
    vec![
        json!({"name": "structured_command_guidance", "description": "Guidance for argv-only structured command execution.", "inputSchema": {"type": "object", "additionalProperties": true}}),
        json!({"name": "structured_command_execution_policy_inspect", "description": "Inspect the policy governing structured command execution.", "inputSchema": {"type": "object", "additionalProperties": false}}),
        json!({"name": "structured_command_execute", "description": "Execute a structured argv command under allowed-root and command policy. Synchronous execution is bounded.", "inputSchema": {"type": "object", "properties": {"command": {"type": "string"}, "args": {"type": "array", "items": {"type": "string"}}, "working_directory": {"type": "string"}, "timeout_ms": {"type": "integer"}, "wait_for_completion": {"type": "boolean"}, "test_scope": {"type": "string"}, "expected_cost": {"type": "string"}}, "required": ["command"]}}),
    ]
}

fn prompt_get(params: &Value) -> Result<Value, StructuredError> {
    let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
    if name != "structured_command_safe_execution" { return Err(StructuredError::new("unknown_prompt", format!("unknown_prompt:{name}"), json!({"name": name}))); }
    Ok(json!({"description": "Guidance for argv-only command execution.", "messages": [{"role": "user", "content": {"type": "text", "text": "Use structured_command_execute with explicit argv arrays only. Inspect policy before relying on command availability."}}]}))
}

fn call_tool(state: &State, params: &Value) -> Result<Value, StructuredError> {
    let name = params.get("name").and_then(Value::as_str).ok_or_else(|| StructuredError::new("tools_call_requires_name", "tools_call_requires_name", json!({})))?;
    let args = params.get("arguments").unwrap_or(&Value::Null);
    let payload = match name {
        "structured_command_guidance" => guidance(args),
        "structured_command_execution_policy_inspect" => Ok(policy_payload(state)),
        "structured_command_execute" => execute(state, args),
        _ => Err(StructuredError::new("structured_command_unknown_tool", format!("structured_command_unknown_tool:{name}"), json!({"tool_name": name}))),
    }?;
    Ok(tool_result(payload))
}

fn guidance(args: &Value) -> Result<Value, StructuredError> {
    Ok(json!({"schema": "narada.mcp_surface.guidance.v0", "status": "ok", "surface_id": "structured-command", "guidance_tool": "structured_command_guidance", "purpose": "Bounded argv-only process execution under explicit command and root policy.", "requested": {"workflow": args.get("workflow"), "tool": args.get("tool")}, "safety": ["Inspect policy before execution.", "Pass command arguments as an array; no shell interpolation is performed.", "Retain structuredContent as the authoritative execution record."]}))
}

fn policy_payload(state: &State) -> Value {
    json!({
        "schema": "narada.structured_command.execution_policy.v0",
        "allowed_roots": state.allowed_roots.iter().map(|path| path.to_string_lossy().to_string()).collect::<Vec<_>>(),
        "allowed_commands": sorted_strings(&state.allowed_commands),
        "default_allowed_commands": DEFAULT_ALLOWED_COMMANDS,
        "allowed_prefixes": state.allowed_prefixes.iter().map(|prefix| prefix.join(" ")).collect::<Vec<_>>(),
        "default_allowed_prefixes": DEFAULT_ALLOWED_PREFIXES.iter().map(|prefix| prefix.join(" ")).collect::<Vec<_>>(),
        "blocked_commands": sorted_strings(&state.blocked_commands),
        "max_timeout_ms": state.max_timeout_ms,
        "max_output_bytes": state.max_output_bytes,
        "shell_interpolation": false,
    })
}

fn sorted_strings(values: &[String]) -> Vec<String> {
    let mut result = values.to_vec();
    result.sort();
    result
}

fn execute(state: &State, args: &Value) -> Result<Value, StructuredError> {
    let args_object = args.as_object().cloned().unwrap_or_default();
    let command = normalize_command(args_object.get("command").and_then(Value::as_str).unwrap_or_default());
    let command_args = args_object.get("args").and_then(Value::as_array).map(|values| values.iter().map(|value| value.as_str().unwrap_or_default().to_string()).collect::<Vec<_>>()).unwrap_or_default();
    let working_directory = args_object.get("working_directory").and_then(Value::as_str).map(|value| resolve_path(value, &state.allowed_roots[0])).unwrap_or_else(|| state.allowed_roots[0].clone());
    let timeout_ms = args_object.get("timeout_ms").and_then(Value::as_u64).unwrap_or(60_000).clamp(1, state.max_timeout_ms);
    let test_scope = args_object.get("test_scope").and_then(Value::as_str).unwrap_or("unknown");
    let expected_cost = args_object.get("expected_cost").and_then(Value::as_str).unwrap_or("unknown");
    let posture = json!({"test_scope": test_scope, "expected_cost": expected_cost});
    let decision = decide(state, &command, &command_args, &working_directory);
    if decision.get("status").and_then(Value::as_str) != Some("allowed") {
        let reasons = decision.get("reasons").cloned().unwrap_or_else(|| json!([]));
        return Ok(json!({"schema": "narada.structured_command.execution_result.v0", "status": "refused", "decision": decision, "refusal_reasons": reasons, "remediation_hints": decision.get("remediation_hints").cloned().unwrap_or_else(|| json!([])), "mcp_fallbacks": [], "command": command, "args": command_args, "working_directory": working_directory.to_string_lossy(), "execution_posture": posture, "test_scope": test_scope, "expected_cost": expected_cost, "executed": false}));
    }
    if args_object.get("wait_for_completion").and_then(Value::as_bool) == Some(false) {
        return Ok(json!({"schema": "narada.structured_command.execution_result.v0", "status": "refused", "executed": false, "decision": decision, "refusal_reasons": ["background_execution_not_implemented_in_native_slice"], "remediation_hints": ["Use the JavaScript structured-command surface for durable background execution while the native slice is expanded."], "mcp_fallbacks": [], "command": command, "args": command_args, "working_directory": working_directory.to_string_lossy(), "execution_posture": posture, "test_scope": test_scope, "expected_cost": expected_cost}));
    }
    if timeout_ms > MAX_SYNCHRONOUS_TIMEOUT_MS {
        return Ok(json!({"schema": "narada.structured_command.execution_result.v0", "status": "refused", "executed": false, "decision": decision, "refusal_reasons": ["synchronous_timeout_exceeds_reliable_bound"], "remediation_hints": [format!("Use the JavaScript structured-command surface for commands requiring more than {MAX_SYNCHRONOUS_TIMEOUT_MS}ms while the native slice is expanded.")], "mcp_fallbacks": [], "command": command, "args": command_args, "working_directory": working_directory.to_string_lossy(), "timeout_ms": timeout_ms, "max_synchronous_timeout_ms": MAX_SYNCHRONOUS_TIMEOUT_MS}));
    }
    let started_at = now_rfc3339();
    let result = run_process(&command, &command_args, &working_directory, timeout_ms, state.max_output_bytes);
    let payload = json!({
        "schema": "narada.structured_command.execution_result.v0",
        "status": if result.cancelled { "cancelled" } else if result.timed_out { "timed_out" } else if result.exit_code == Some(0) { "ok" } else { "failed" },
        "executed": true,
        "command": command,
        "args": command_args,
        "working_directory": working_directory.to_string_lossy(),
        "started_at": started_at,
        "finished_at": now_rfc3339(),
        "timeout_ms": timeout_ms,
        "execution_posture": posture,
        "test_scope": test_scope,
        "expected_cost": expected_cost,
        "execution_mode": "synchronous",
        "wait_for_completion": true,
        "pending": false,
        "exit_code": result.exit_code,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "stdout_truncated": result.stdout_truncated,
        "stderr_truncated": result.stderr_truncated,
        "timed_out": result.timed_out,
        "cancelled": result.cancelled,
        "input_ref": args_object.get("input_ref").cloned().unwrap_or(Value::Null),
    });
    audit(state, &payload);
    Ok(payload)
}

fn decide(state: &State, command: &str, args: &[String], cwd: &Path) -> Value {
    let mut reasons = Vec::<String>::new();
    if command.is_empty() { reasons.push("command_required".to_string()); }
    let command_lower = command.to_ascii_lowercase();
    if state.blocked_commands.iter().any(|value| value == &command_lower) { reasons.push(format!("blocked_command:{command}")); }
    if !inside_any_root(cwd, &state.allowed_roots) { reasons.push(format!("working_directory_outside_allowed_roots:{}", cwd.to_string_lossy())); }
    for value in std::iter::once(command).chain(args.iter().map(String::as_str)) {
        let normalized = value.replace('\\', "/");
        let extension = Path::new(&normalized).extension().and_then(|value| value.to_str()).map(|value| format!(".{value}").to_ascii_lowercase());
        if matches!(extension.as_deref(), Some(".cmd") | Some(".bat")) {
            let candidate = resolve_path(value, cwd);
            if !inside_any_root(&candidate, &state.allowed_roots) || !candidate.is_file() || transient_path(&normalized) { reasons.push(format!("wrapper_execution_disallowed:{value}")); }
        }
        if transient_path(&normalized) && extension.as_deref().is_some_and(|extension| TRANSIENT_EXTENSIONS.contains(&extension)) { reasons.push(format!("transient_wrapper_path_disallowed:{value}")); }
    }
    if !is_command_allowed(command, args, &state.allowed_commands, &state.allowed_prefixes) { reasons.push(format!("command_not_allowed:{}", std::iter::once(command).chain(args.iter().map(String::as_str)).collect::<Vec<_>>().join(" "))); }
    let status = if reasons.is_empty() { "allowed" } else { "refused" };
    let remediation_hints = reasons.iter().map(|reason| {
        if reason.starts_with("blocked_command:") { "Use an explicit argv-based allowed command; shell interpreters remain disallowed." }
        else if reason.starts_with("working_directory_outside_allowed_roots:") { "Run from an allowed root or request a policy update." }
        else if reason.starts_with("command_not_allowed:") { "Inspect policy and use an allowlisted command or prefix." }
        else { "Use the owning MCP surface or a canonical repository entrypoint." }
    }).map(String::from).collect::<Vec<_>>();
    json!({"schema": "narada.structured_command.execution_decision.v0", "status": status, "reasons": reasons, "remediation_hints": remediation_hints, "mcp_fallbacks": [], "command": command, "args": args, "working_directory": cwd.to_string_lossy(), "shell_interpolation": false})
}

fn is_command_allowed(command: &str, args: &[String], allowed_commands: &[String], allowed_prefixes: &[Vec<String>]) -> bool {
    let command_lower = command.to_ascii_lowercase();
    if allowed_commands.iter().any(|value| value == &command_lower) { return true; }
    let argv = std::iter::once(command).chain(args.iter().map(String::as_str)).map(|value| value.to_ascii_lowercase()).collect::<Vec<_>>();
    allowed_prefixes.iter().any(|prefix| {
        prefix.iter().enumerate().all(|(index, expected)| {
            let Some(actual) = argv.get(index) else { return false; };
            if index == 0 { actual == expected || (expected == "pwsh" && actual == "pwsh.exe") } else { actual == expected }
        }) && !(prefix.len() >= 2 && prefix[0] == "pnpm" && prefix[1] == "--filter" && !matches!(argv.get(3).map(String::as_str), Some("test" | "build" | "typecheck")))
    })
}

fn transient_path(value: &str) -> bool {
    let normalized = value.replace('\\', "/").to_ascii_lowercase();
    normalized.contains("/.ai/tmp/") || normalized.contains("/.ai/temp/") || normalized.starts_with(".ai/tmp/") || normalized.starts_with(".ai/temp/")
}

fn normalize_command(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().any(|character| matches!(character, '\r' | '\n' | ';' | '&' | '|' | '<' | '>')) { String::new() } else { trimmed.to_string() }
}

fn tool_result(payload: Value) -> Value {
    let text = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string());
    json!({"content": [{"type": "text", "text": text, "annotations": {"audience": ["assistant"]}}], "structuredContent": payload})
}

fn error_diagnostic(error: &StructuredError) -> Value {
    let mut details = error.details.as_object().cloned().unwrap_or_default();
    details.insert("diagnostic_owner".to_string(), json!("structured-command-mcp"));
    details.insert("diagnostic_rule".to_string(), json!("surface_policy_or_tool_validation"));
    json!({"schema": "narada.structured_command.error.v0", "code": error.code, "message": error.message, "details": details})
}

struct ProcessResult {
    exit_code: Option<i32>,
    timed_out: bool,
    cancelled: bool,
    stdout: String,
    stderr: String,
    stdout_truncated: bool,
    stderr_truncated: bool,
}

fn run_process(command: &str, args: &[String], cwd: &Path, timeout_ms: u64, max_output_bytes: usize) -> ProcessResult {
    let child_result = Command::new(command).args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn();
    let Ok(mut child) = child_result else {
        return ProcessResult { exit_code: None, timed_out: false, cancelled: false, stdout: String::new(), stderr: child_result.err().map(|error| error.to_string()).unwrap_or_else(|| "process_spawn_failed".to_string()), stdout_truncated: false, stderr_truncated: false };
    };
    let stdout_handle = child.stdout.take().map(|stream| thread::spawn(move || read_bounded(stream, max_output_bytes)));
    let stderr_handle = child.stderr.take().map(|stream| thread::spawn(move || read_bounded(stream, max_output_bytes)));
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => { timed_out = true; kill_child(&mut child); break child.wait().ok(); }
            Ok(None) => thread::sleep(Duration::from_millis(5)),
            Err(_) => break child.wait().ok(),
        }
    };
    let stdout_result = stdout_handle.and_then(|handle| handle.join().ok()).unwrap_or((Vec::new(), false));
    let stderr_result = stderr_handle.and_then(|handle| handle.join().ok()).unwrap_or((Vec::new(), false));
    ProcessResult { exit_code: status.and_then(|status| status.code()), timed_out, cancelled: false, stdout: String::from_utf8_lossy(&stdout_result.0).to_string(), stderr: String::from_utf8_lossy(&stderr_result.0).to_string(), stdout_truncated: stdout_result.1, stderr_truncated: stderr_result.1 }
}

fn read_bounded<R: Read>(mut reader: R, max: usize) -> (Vec<u8>, bool) {
    let mut output = Vec::with_capacity(max.min(8192));
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                if output.len() < max {
                    let keep = (max - output.len()).min(count);
                    output.extend_from_slice(&buffer[..keep]);
                    if keep < count { truncated = true; }
                } else { truncated = true; }
            }
            Err(_) => break,
        }
    }
    (output, truncated)
}

fn kill_child(child: &mut Child) {
    #[cfg(windows)]
    {
        let pid = child.id();
        let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    #[cfg(not(windows))]
    { let _ = child.kill(); }
}

fn audit(state: &State, payload: &Value) {
    let Some(directory) = &state.audit_log_dir else { return; };
    if fs::create_dir_all(directory).is_err() { return; }
    let path = directory.join("structured-command.jsonl");
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else { return; };
    let _ = writeln!(file, "{}", serde_json::to_string(payload).unwrap_or_else(|_| "{}".to_string()));
}

fn inside_any_root(path: &Path, roots: &[PathBuf]) -> bool {
    let candidate_key = path_key(path);
    roots.iter().any(|root| {
        let root_key = path_key(root);
        candidate_key == root_key || candidate_key.starts_with(&(root_key + "/"))
    })
}

fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    value.trim_end_matches('/').to_ascii_lowercase()
}

fn resolve_path(value: &str, base: &Path) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() { absolute(path) } else { absolute(base.join(path)) }
}

fn absolute(path: PathBuf) -> PathBuf {
    if path.is_absolute() { path } else { env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join(path) }
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
