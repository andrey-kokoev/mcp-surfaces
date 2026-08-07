use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::env;
use std::io::{self, Read, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

type JsonObject = Map<String, Value>;

const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "mcp-loader-native";
const SERVER_VERSION: &str = "0.1.0";
const DEFAULT_ATTACH_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_TOOL_CALL_TIMEOUT_MS: u64 = 120_000;
const DEFAULT_TOOL_TIMEOUT_GRACE_MS: u64 = 1_000;
const MAX_TOOL_TIMEOUT_MS: u64 = 900_000;
const STDERR_TAIL_LIMIT: usize = 8_000;

static ID_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
struct Options {
    child_command: Option<String>,
    child_entrypoint: Option<String>,
    child_args: Vec<String>,
    attach_timeout_ms: u64,
    tool_call_timeout_ms: u64,
    tool_timeout_grace_ms: u64,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            child_command: None,
            child_entrypoint: None,
            child_args: Vec::new(),
            attach_timeout_ms: DEFAULT_ATTACH_TIMEOUT_MS,
            tool_call_timeout_ms: DEFAULT_TOOL_CALL_TIMEOUT_MS,
            tool_timeout_grace_ms: DEFAULT_TOOL_TIMEOUT_GRACE_MS,
        }
    }
}

#[derive(Clone, Debug)]
struct Diagnostic {
    code: String,
    message: String,
    details: Value,
}

impl Diagnostic {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: json!({}),
        }
    }

    fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }

    fn value(&self) -> Value {
        json!({
            "schema": "narada.mcp_loader.error.v1",
            "code": self.code,
            "message": self.message,
            "details": self.details,
        })
    }
}

#[derive(Clone, Debug)]
struct ChildSpec {
    command: String,
    args: Vec<String>,
    entrypoint: String,
}

struct ChildSession {
    spec: ChildSpec,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, Diagnostic>>>>>,
    next_id: AtomicU64,
    closed: Arc<AtomicBool>,
    stderr_tail: Arc<Mutex<String>>,
    pid: u32,
}

struct Connection {
    session: ChildSession,
    connection_id: String,
    logical_connection_id: String,
    generation_id: String,
    site_root: Option<String>,
    surface_id: String,
    server_info: Value,
    tools: Vec<Value>,
    attached_at: String,
}

struct LoaderState {
    options: Options,
    initialized: bool,
    connection: Option<Connection>,
}

struct WireReader<R> {
    reader: R,
    buffer: Vec<u8>,
    eof: bool,
}

impl<R: Read> WireReader<R> {
    fn new(reader: R) -> Self {
        Self {
            reader,
            buffer: Vec::new(),
            eof: false,
        }
    }

    fn next(&mut self) -> io::Result<Option<(Value, bool)>> {
        loop {
            if let Some(message) = try_parse_wire(&mut self.buffer)? {
                return Ok(Some(message));
            }
            if self.eof {
                if self.buffer.iter().all(|byte| byte.is_ascii_whitespace()) {
                    self.buffer.clear();
                    return Ok(None);
                }
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "incomplete MCP message",
                ));
            }
            let mut chunk = [0_u8; 8192];
            let read = self.reader.read(&mut chunk)?;
            if read == 0 {
                self.eof = true;
            } else {
                self.buffer.extend_from_slice(&chunk[..read]);
            }
        }
    }
}

fn try_parse_wire(buffer: &mut Vec<u8>) -> io::Result<Option<(Value, bool)>> {
    while matches!(buffer.first(), Some(b'\r' | b'\n')) {
        buffer.remove(0);
    }
    if buffer.is_empty() {
        return Ok(None);
    }

    if buffer.len() >= 15 && buffer[..15].eq_ignore_ascii_case(b"content-length:") {
        let (header_end, separator_len) = match find_header_end(buffer) {
            Some(found) => found,
            None => return Ok(None),
        };
        let header = String::from_utf8_lossy(&buffer[..header_end]);
        let length = header
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.trim().eq_ignore_ascii_case("content-length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing Content-Length"))?;
        let body_start = header_end + separator_len;
        let body_end = body_start.saturating_add(length);
        if buffer.len() < body_end {
            return Ok(None);
        }
        let value = serde_json::from_slice::<Value>(&buffer[body_start..body_end])
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
        buffer.drain(..body_end);
        return Ok(Some((value, true)));
    }

    let newline = match buffer.iter().position(|byte| *byte == b'\n') {
        Some(position) => position,
        None => return Ok(None),
    };
    let mut line = buffer.drain(..=newline).collect::<Vec<_>>();
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    if line.iter().all(|byte| byte.is_ascii_whitespace()) {
        return Ok(None);
    }
    let value = serde_json::from_slice::<Value>(&line)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
    Ok(Some((value, false)))
}

fn find_header_end(buffer: &[u8]) -> Option<(usize, usize)> {
    if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
        return Some((position, 4));
    }
    buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|position| (position, 2))
}

fn write_wire<W: Write>(writer: &mut W, value: &Value, framed: bool) -> io::Result<()> {
    let body = serde_json::to_vec(value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
    if framed {
        write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
        writer.write_all(&body)?;
    } else {
        writer.write_all(&body)?;
        writer.write_all(b"\n")?;
    }
    writer.flush()
}

impl ChildSession {
    fn spawn(spec: ChildSpec) -> Result<Self, Diagnostic> {
        let mut command = Command::new(&spec.command);
        command
            .args(&spec.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.spawn().map_err(|error| {
            Diagnostic::new(
                "child_spawn_failed",
                format!("child_spawn_failed:{}", error),
            )
            .with_details(json!({ "command": &spec.command, "args": &spec.args }))
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| Diagnostic::new("child_stdin_unavailable", "child_stdin_unavailable"))?;
        let stdout = child.stdout.take().ok_or_else(|| {
            Diagnostic::new("child_stdout_unavailable", "child_stdout_unavailable")
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            Diagnostic::new("child_stderr_unavailable", "child_stderr_unavailable")
        })?;
        let pid = child.id();
        let child = Arc::new(Mutex::new(child));
        let stdin = Arc::new(Mutex::new(stdin));
        let pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, Diagnostic>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(AtomicBool::new(false));
        let stderr_tail = Arc::new(Mutex::new(String::new()));

        let reader_pending = Arc::clone(&pending);
        let reader_closed = Arc::clone(&closed);
        thread::spawn(move || {
            let mut reader = WireReader::new(stdout);
            loop {
                match reader.next() {
                    Ok(Some((message, _framed))) => {
                        let object = match message.as_object() {
                            Some(object) => object,
                            None => continue,
                        };
                        let id = object.get("id").and_then(value_u64);
                        let Some(id) = id else { continue };
                        let sender = reader_pending
                            .lock()
                            .ok()
                            .and_then(|mut pending| pending.remove(&id));
                        let Some(sender) = sender else { continue };
                        let result = if let Some(error) = object.get("error") {
                            Err(Diagnostic::new(
                                "child_error",
                                format!("child_error:{}", error),
                            ))
                        } else {
                            Ok(object.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = sender.send(result);
                    }
                    Ok(None) | Err(_) => break,
                }
            }
            reader_closed.store(true, Ordering::SeqCst);
            let pending = reader_pending
                .lock()
                .ok()
                .map(|mut pending| {
                    pending
                        .drain()
                        .map(|(_, sender)| sender)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            for sender in pending {
                let _ = sender.send(Err(Diagnostic::new("child_exited", "child_exited")));
            }
        });

        let tail = Arc::clone(&stderr_tail);
        thread::spawn(move || {
            let mut reader = io::BufReader::new(stderr);
            let mut chunk = [0_u8; 2048];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        if let Ok(mut value) = tail.lock() {
                            value.push_str(&String::from_utf8_lossy(&chunk[..count]));
                            if value.len() > STDERR_TAIL_LIMIT {
                                let start = value.len() - STDERR_TAIL_LIMIT;
                                *value = value[start..].to_string();
                            }
                        }
                    }
                }
            }
        });

        Ok(Self {
            spec,
            child,
            stdin,
            pending,
            next_id: AtomicU64::new(1),
            closed,
            stderr_tail,
            pid,
        })
    }

    fn request(&self, method: &str, params: Value, timeout_ms: u64) -> Result<Value, Diagnostic> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(Diagnostic::new("connection_closed", "connection_closed"));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| Diagnostic::new("pending_lock_failed", "pending_lock_failed"))?
            .insert(id, sender);
        let request = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let write_result = self
            .stdin
            .lock()
            .map_err(|_| Diagnostic::new("child_stdin_lock_failed", "child_stdin_lock_failed"))
            .and_then(|mut stdin| {
                write_wire(&mut *stdin, &request, false).map_err(|error| {
                    Diagnostic::new(
                        "child_write_failed",
                        format!("child_write_failed:{}", error),
                    )
                })
            });
        if let Err(error) = write_result {
            let _ = self.pending.lock().map(|mut pending| pending.remove(&id));
            return Err(error);
        }
        match receiver.recv_timeout(Duration::from_millis(timeout_ms)) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let _ = self.pending.lock().map(|mut pending| pending.remove(&id));
                Err(Diagnostic::new(
                    "child_timeout",
                    format!("child_timeout:{}:{}ms", method, timeout_ms),
                ))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err(Diagnostic::new("child_exited", "child_exited"))
            }
        }
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), Diagnostic> {
        if self.closed.load(Ordering::SeqCst) {
            return Ok(());
        }
        let request = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        self.stdin
            .lock()
            .map_err(|_| Diagnostic::new("child_stdin_lock_failed", "child_stdin_lock_failed"))
            .and_then(|mut stdin| {
                write_wire(&mut *stdin, &request, false).map_err(|error| {
                    Diagnostic::new(
                        "child_write_failed",
                        format!("child_write_failed:{}", error),
                    )
                })
            })
    }

    fn alive(&self) -> bool {
        if self.closed.load(Ordering::SeqCst) {
            return false;
        }
        let alive = self
            .child
            .lock()
            .ok()
            .and_then(|mut child| child.try_wait().ok())
            .is_some_and(|status| status.is_none());
        if !alive {
            self.closed.store(true, Ordering::SeqCst);
        }
        alive
    }

    fn terminate(&self) -> Value {
        self.closed.store(true, Ordering::SeqCst);
        let mut child = match self.child.lock() {
            Ok(child) => child,
            Err(_) => return json!({ "status": "termination_lock_failed" }),
        };
        if let Ok(Some(status)) = child.try_wait() {
            return json!({ "status": "already_exited", "exit_code": status.code() });
        }
        let killed = child.kill().is_ok();
        let waited = child.wait().ok();
        json!({ "status": if killed { "terminated" } else { "termination_failed" }, "exit_code": waited.and_then(|status| status.code()), "forced": killed })
    }

    fn stderr_tail(&self) -> String {
        self.stderr_tail
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }
}

fn main() {
    let options = match parse_options(env::args().skip(1).collect()) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{}", error.message);
            std::process::exit(2);
        }
    };
    if let Err(error) = run_server(options) {
        eprintln!("{}", error.message);
        std::process::exit(1);
    }
}

fn parse_options(args: Vec<String>) -> Result<Options, Diagnostic> {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        match arg.as_str() {
            "--child-command" => options.child_command = Some(next_arg(&args, &mut index, arg)?),
            "--child-entrypoint" => {
                options.child_entrypoint = Some(next_arg(&args, &mut index, arg)?)
            }
            "--child-arg" => options.child_args.push(next_arg(&args, &mut index, arg)?),
            "--attach-timeout-ms" => {
                options.attach_timeout_ms = positive_u64(&next_arg(&args, &mut index, arg)?, arg)?
            }
            "--tool-call-timeout-ms" => {
                options.tool_call_timeout_ms =
                    positive_u64(&next_arg(&args, &mut index, arg)?, arg)?
            }
            "--tool-timeout-grace-ms" => {
                options.tool_timeout_grace_ms =
                    nonnegative_u64(&next_arg(&args, &mut index, arg)?, arg)?
            }
            "--" => {
                options.child_args.extend(args[index + 1..].iter().cloned());
                break;
            }
            _ => {
                return Err(Diagnostic::new(
                    "unknown_argument",
                    format!("unknown_argument:{}", arg),
                ))
            }
        }
        index += 1;
    }
    Ok(options)
}

fn next_arg(args: &[String], index: &mut usize, flag: &str) -> Result<String, Diagnostic> {
    *index += 1;
    args.get(*index)
        .cloned()
        .ok_or_else(|| Diagnostic::new("argument_required", format!("argument_required:{}", flag)))
}

fn positive_u64(value: &str, flag: &str) -> Result<u64, Diagnostic> {
    let parsed = value
        .parse::<u64>()
        .map_err(|_| Diagnostic::new("invalid_argument", format!("invalid_argument:{}", flag)))?;
    if parsed == 0 {
        return Err(Diagnostic::new(
            "invalid_argument",
            format!("invalid_argument:{}", flag),
        ));
    }
    Ok(parsed)
}

fn nonnegative_u64(value: &str, flag: &str) -> Result<u64, Diagnostic> {
    value
        .parse::<u64>()
        .map_err(|_| Diagnostic::new("invalid_argument", format!("invalid_argument:{}", flag)))
}

fn run_server(options: Options) -> Result<(), Diagnostic> {
    let stdin = io::stdin();
    let mut reader = WireReader::new(stdin.lock());
    let stdout = io::stdout();
    let mut writer = stdout.lock();
    let mut state = LoaderState {
        options,
        initialized: false,
        connection: None,
    };
    while let Some((request, framed)) = reader.next().map_err(|error| {
        Diagnostic::new(
            "parent_read_failed",
            format!("parent_read_failed:{}", error),
        )
    })? {
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let notification = request.get("id").is_none() && method.starts_with("notifications/");
        if notification {
            continue;
        }
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let response = match dispatch(&request, &mut state) {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(error) => {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": error.message, "data": error.value() } })
            }
        };
        write_wire(&mut writer, &response, framed).map_err(|error| {
            Diagnostic::new(
                "parent_write_failed",
                format!("parent_write_failed:{}", error),
            )
        })?;
    }
    if let Some(connection) = state.connection.take() {
        connection.session.terminate();
    }
    Ok(())
}

fn dispatch(request: &Value, state: &mut LoaderState) -> Result<Value, Diagnostic> {
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    match method {
        "initialize" => {
            state.initialized = true;
            Ok(
                json!({ "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL_VERSION), "capabilities": { "tools": {} }, "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION } }),
            )
        }
        "notifications/initialized" => Ok(json!({})),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": list_tools() })),
        "tools/call" => {
            let params = params
                .as_object()
                .ok_or_else(|| Diagnostic::new("invalid_tool_call", "invalid_tool_call"))?;
            let name = required_string(params, "name", "missing_tool_name")?;
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let result = call_tool(&name, arguments, state)?;
            Ok(tool_result(result))
        }
        _ => Err(Diagnostic::new(
            "unsupported_mcp_method",
            format!("unsupported_mcp_method:{}", method),
        )),
    }
}

fn list_tools() -> Vec<Value> {
    vec![
        tool("mcp_loader_attach_surface", "Attach one explicitly configured stdio MCP child. Native slice: site-fabric resolution and policy remain owned by the Bun loader.", json!({
            "entrypoint": { "type": "string" },
            "child_command": { "type": "string" },
            "args": { "type": "array", "items": { "type": "string" } },
            "site_root": { "type": ["string", "null"] },
            "surface_id": { "type": "string" }
        }), vec![]),
        tool("mcp_loader_connection_inventory", "Inspect the single native child-session connection.", json!({}), vec![]),
        tool("mcp_loader_list_tools", "List tools exposed by the attached child.", json!({ "connection_id": { "type": "string" } }), vec!["connection_id"]),
        tool("mcp_loader_surface_status", "Inspect native child-session liveness.", json!({ "connection_id": { "type": "string" } }), vec!["connection_id"]),
        tool("mcp_loader_call_tool", "Call a tool on the attached child with bounded timeout semantics.", json!({
            "connection_id": { "type": "string" },
            "tool_name": { "type": "string" },
            "arguments": { "type": "object" }
        }), vec!["connection_id", "tool_name"]),
        tool("mcp_loader_detach", "Terminate the attached child.", json!({ "connection_id": { "type": "string" } }), vec!["connection_id"]),
        tool("mcp_loader_surface_restart", "Replace the attached child with a fresh generation using the same command.", json!({ "connection_id": { "type": "string" }, "reason": { "type": "string" } }), vec!["connection_id"]),
    ]
}

fn tool(name: &str, description: &str, properties: Value, required: Vec<&str>) -> Value {
    json!({ "name": name, "description": description, "inputSchema": { "type": "object", "properties": properties, "required": required } })
}

fn call_tool(name: &str, arguments: Value, state: &mut LoaderState) -> Result<Value, Diagnostic> {
    let arguments = arguments.as_object().cloned().unwrap_or_default();
    match name {
        "mcp_loader_attach_surface" => attach(arguments, state),
        "mcp_loader_connection_inventory" => inventory(state),
        "mcp_loader_list_tools" => list_attached(arguments, state),
        "mcp_loader_surface_status" => status(arguments, state),
        "mcp_loader_call_tool" => call_child(arguments, state),
        "mcp_loader_detach" => detach(arguments, state),
        "mcp_loader_surface_restart" => restart(arguments, state),
        _ => Err(Diagnostic::new(
            "unknown_tool",
            format!("unknown_tool:{}", name),
        )),
    }
}

fn attach(arguments: JsonObject, state: &mut LoaderState) -> Result<Value, Diagnostic> {
    if state.connection.is_some() {
        return Err(Diagnostic::new("connection_exists", "connection_exists"));
    }
    let entrypoint = arguments
        .get("entrypoint")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| state.options.child_entrypoint.clone())
        .ok_or_else(|| Diagnostic::new("missing_entrypoint", "missing_entrypoint"))?;
    let command = arguments
        .get("child_command")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| state.options.child_command.clone())
        .unwrap_or_else(|| "node".to_string());
    let mut child_args =
        value_strings(arguments.get("args"))?.unwrap_or_else(|| state.options.child_args.clone());
    child_args.insert(0, entrypoint.clone());
    let spec = ChildSpec {
        command,
        args: child_args,
        entrypoint: entrypoint.clone(),
    };
    let connection = start_connection(
        spec,
        &state.options,
        arguments
            .get("site_root")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        arguments
            .get("surface_id")
            .and_then(Value::as_str)
            .unwrap_or("native-loader-child")
            .to_string(),
    )?;
    let mut response = connection_status(&connection);
    if let Some(object) = response.as_object_mut() {
        object.insert(
            "schema".to_string(),
            json!("narada.mcp_loader.surface_attached.v1"),
        );
    }
    state.connection = Some(connection);
    Ok(response)
}

fn start_connection(
    spec: ChildSpec,
    options: &Options,
    site_root: Option<String>,
    surface_id: String,
) -> Result<Connection, Diagnostic> {
    let session = ChildSession::spawn(spec)?;
    let init = match session.request("initialize", json!({ "protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": { "name": SERVER_NAME, "version": SERVER_VERSION } }), options.attach_timeout_ms) {
        Ok(result) => result,
        Err(error) => { session.terminate(); return Err(error); }
    };
    if let Err(error) = session.notify("notifications/initialized", json!({})) {
        session.terminate();
        return Err(error);
    }
    let tools_result = match session.request("tools/list", json!({}), options.attach_timeout_ms) {
        Ok(result) => result,
        Err(error) => {
            session.terminate();
            return Err(error);
        }
    };
    let tools = tools_result
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let now = now_iso();
    let connection_id = new_id("msh");
    let connection = Connection {
        session,
        logical_connection_id: connection_id.clone(),
        generation_id: new_id("generation"),
        connection_id,
        site_root,
        surface_id,
        server_info: init.get("serverInfo").cloned().unwrap_or_else(|| json!({})),
        tools,
        attached_at: now,
    };
    Ok(connection)
}

fn list_attached(arguments: JsonObject, state: &mut LoaderState) -> Result<Value, Diagnostic> {
    let connection = get_connection(
        arguments.get("connection_id").and_then(Value::as_str),
        state,
    )?;
    Ok(
        json!({ "schema": "narada.mcp_loader.tools.v1", "connection_id": connection.connection_id, "surface_id": connection.surface_id, "tools": connection.tools }),
    )
}

fn status(arguments: JsonObject, state: &mut LoaderState) -> Result<Value, Diagnostic> {
    let connection = get_connection(
        arguments.get("connection_id").and_then(Value::as_str),
        state,
    )?;
    Ok(
        json!({ "schema": "narada.mcp_loader.surface_status.v1", "connection_id": connection.connection_id, "surface_id": connection.surface_id, "generation_id": connection.generation_id, "status": if connection.session.alive() { "live" } else { "closed" }, "pid": connection.session.pid, "entrypoint": connection.session.spec.entrypoint, "stderr_tail": connection.session.stderr_tail() }),
    )
}

fn inventory(state: &mut LoaderState) -> Result<Value, Diagnostic> {
    let Some(connection) = state.connection.as_ref() else {
        return Ok(
            json!({ "schema": "narada.mcp_loader.connection_inventory.v1", "connection_count": 0, "connections": [] }),
        );
    };
    Ok(
        json!({ "schema": "narada.mcp_loader.connection_inventory.v1", "connection_count": 1, "connections": [connection_status(connection)] }),
    )
}

fn call_child(arguments: JsonObject, state: &mut LoaderState) -> Result<Value, Diagnostic> {
    let connection_id = arguments.get("connection_id").and_then(Value::as_str);
    let tool_name = arguments
        .get("tool_name")
        .and_then(Value::as_str)
        .ok_or_else(|| Diagnostic::new("missing_tool_name", "missing_tool_name"))?
        .to_string();
    let tool_arguments = arguments
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let timeout = resolve_timeout(&tool_arguments, &state.options)?;
    let connection = get_connection(connection_id, state)?;
    let child_result = connection.session.request(
        "tools/call",
        json!({ "name": tool_name, "arguments": tool_arguments }),
        timeout,
    )?;
    Ok(
        json!({ "schema": "narada.mcp_loader.tool_result.v1", "connection_id": connection.connection_id, "surface_id": connection.surface_id, "result": child_result, "result_bounded": false }),
    )
}

fn detach(arguments: JsonObject, state: &mut LoaderState) -> Result<Value, Diagnostic> {
    let connection_id = arguments.get("connection_id").and_then(Value::as_str);
    let connection = state
        .connection
        .take()
        .ok_or_else(|| Diagnostic::new("connection_not_found", "connection_not_found"))?;
    if Some(connection.connection_id.as_str()) != connection_id {
        state.connection = Some(connection);
        return Err(Diagnostic::new(
            "connection_not_found",
            "connection_not_found",
        ));
    }
    let termination = connection.session.terminate();
    Ok(
        json!({ "schema": "narada.mcp_loader.detached.v1", "connection_id": connection.connection_id, "surface_id": connection.surface_id, "status": "detached", "termination": termination }),
    )
}

fn restart(arguments: JsonObject, state: &mut LoaderState) -> Result<Value, Diagnostic> {
    let connection_id = arguments.get("connection_id").and_then(Value::as_str);
    let previous = state
        .connection
        .take()
        .ok_or_else(|| Diagnostic::new("connection_not_found", "connection_not_found"))?;
    if Some(previous.connection_id.as_str()) != connection_id {
        state.connection = Some(previous);
        return Err(Diagnostic::new(
            "connection_not_found",
            "connection_not_found",
        ));
    }
    let previous_status = connection_status(&previous);
    let spec = previous.session.spec.clone();
    let site_root = previous.site_root.clone();
    let surface_id = previous.surface_id.clone();
    previous.session.terminate();
    let replacement = start_connection(spec, &state.options, site_root, surface_id)?;
    let response = json!({ "schema": "narada.mcp_loader.surface_restarted.v1", "status": "restarted", "previous_connection": previous_status, "replacement_connection": connection_status(&replacement), "connection_id": replacement.connection_id, "surface_id": replacement.surface_id, "reason": arguments.get("reason").cloned().unwrap_or(Value::Null) });
    state.connection = Some(replacement);
    Ok(response)
}

fn get_connection<'a>(
    id: Option<&str>,
    state: &'a mut LoaderState,
) -> Result<&'a mut Connection, Diagnostic> {
    let connection = state
        .connection
        .as_mut()
        .ok_or_else(|| Diagnostic::new("connection_not_found", "connection_not_found"))?;
    if id != Some(connection.connection_id.as_str()) {
        return Err(Diagnostic::new(
            "connection_not_found",
            "connection_not_found",
        ));
    }
    Ok(connection)
}

fn connection_status(connection: &Connection) -> Value {
    json!({ "connection_id": connection.connection_id, "logical_connection_id": connection.logical_connection_id, "generation_id": connection.generation_id, "site_root": connection.site_root, "surface_id": connection.surface_id, "entrypoint": connection.session.spec.entrypoint, "args": connection.session.spec.args, "server_info": connection.server_info, "tools": connection.tools, "status": if connection.session.alive() { "live" } else { "closed" }, "pid": connection.session.pid, "attached_at": connection.attached_at })
}

fn tool_result(result: Value) -> Value {
    let text = result
        .get("schema")
        .and_then(Value::as_str)
        .unwrap_or("narada.mcp_loader.result");
    json!({ "content": [{ "type": "text", "text": text, "annotations": { "audience": ["assistant"] } }], "structuredContent": result })
}

fn resolve_timeout(arguments: &Value, options: &Options) -> Result<u64, Diagnostic> {
    let requested = arguments.get("timeout_ms").and_then(Value::as_u64);
    let Some(requested) = requested else {
        return Ok(options.tool_call_timeout_ms);
    };
    if requested == 0 || requested > MAX_TOOL_TIMEOUT_MS {
        return Err(Diagnostic::new(
            "tool_call_timeout_exceeds_loader_max",
            format!("tool_call_timeout_exceeds_loader_max:{}", requested),
        )
        .with_details(
            json!({ "requested_timeout_ms": requested, "max_timeout_ms": MAX_TOOL_TIMEOUT_MS }),
        ));
    }
    Ok(requested.saturating_add(options.tool_timeout_grace_ms))
}

fn required_string(object: &JsonObject, key: &str, code: &str) -> Result<String, Diagnostic> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| Diagnostic::new(code, code))
}

fn value_strings(value: Option<&Value>) -> Result<Option<Vec<String>>, Diagnostic> {
    let Some(value) = value else {
        return Ok(None);
    };
    let array = value
        .as_array()
        .ok_or_else(|| Diagnostic::new("invalid_child_args", "invalid_child_args"))?;
    let mut result = Vec::with_capacity(array.len());
    for item in array {
        result.push(
            item.as_str()
                .ok_or_else(|| Diagnostic::new("invalid_child_args", "invalid_child_args"))?
                .to_string(),
        );
    }
    Ok(Some(result))
}

fn value_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|value| value.parse::<u64>().ok()))
}

fn new_id(prefix: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let counter = ID_COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("{}-{}-{}", prefix, millis, counter)
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn parses_json_lines_and_content_length_frames() {
        let mut reader = WireReader::new(Cursor::new(b"{\"jsonrpc\":\"2.0\",\"id\":1}\nContent-Length: 24\r\n\r\n{\"jsonrpc\":\"2.0\",\"id\":2}".to_vec()));
        let first = reader.next().unwrap().unwrap();
        assert!(!first.1);
        assert_eq!(first.0["id"], 1);
        let second = reader.next().unwrap().unwrap();
        assert!(second.1);
        assert_eq!(second.0["id"], 2);
        assert!(reader.next().unwrap().is_none());
    }

    #[test]
    fn rejects_timeout_above_loader_max() {
        let error = resolve_timeout(
            &json!({ "timeout_ms": MAX_TOOL_TIMEOUT_MS + 1 }),
            &Options::default(),
        )
        .unwrap_err();
        assert_eq!(error.code, "tool_call_timeout_exceeds_loader_max");
    }

    #[test]
    fn adds_grace_only_to_explicit_tool_timeout() {
        let options = Options {
            tool_call_timeout_ms: 120_000,
            tool_timeout_grace_ms: 1_000,
            ..Options::default()
        };
        assert_eq!(resolve_timeout(&json!({}), &options).unwrap(), 120_000);
        assert_eq!(
            resolve_timeout(&json!({ "timeout_ms": 100 }), &options).unwrap(),
            1_100
        );
    }
}
