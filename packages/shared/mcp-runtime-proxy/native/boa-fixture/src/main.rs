use boa_engine::{js_string, Context, JsValue, Source};
use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::Path;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const HANDLER_NAME: &str = "naradaFixtureHandle";

fn main() {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("--version") | Some("-V") => {
            println!("narada-mcp-boa-fixture {VERSION}");
        }
        Some(handler_path) => {
            if let Err(error) = run(Path::new(handler_path)) {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        None => {
            eprintln!("narada_mcp_boa_fixture_handler_required");
            std::process::exit(2);
        }
    }
}

fn run(handler_path: &Path) -> Result<(), String> {
    let handler_source = fs::read_to_string(handler_path)
        .map_err(|error| format!("narada_mcp_boa_fixture_handler_read_failed:{error}"))?;
    let mut context = Context::default();
    context
        .eval(Source::from_bytes(&handler_source))
        .map_err(|error| format!("narada_mcp_boa_fixture_handler_eval_failed:{error}"))?;

    let handler = context
        .global_object()
        .get(js_string!(HANDLER_NAME), &mut context)
        .map_err(|error| format!("narada_mcp_boa_fixture_handler_lookup_failed:{error}"))?;
    if !handler.is_callable() {
        return Err(format!(
            "narada_mcp_boa_fixture_handler_missing:{HANDLER_NAME}"
        ));
    }

    let stdin = io::stdin();
    let reader = BufReader::new(stdin.lock());
    let stdout = io::stdout();
    let mut writer = BufWriter::new(stdout.lock());
    for line in reader.lines() {
        let line =
            line.map_err(|error| format!("narada_mcp_boa_fixture_stdin_read_failed:{error}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let request: serde_json::Value = serde_json::from_str(&line)
            .map_err(|error| format!("narada_mcp_boa_fixture_invalid_json:{error}"))?;
        let request_value = JsValue::from_json(&request, &mut context)
            .map_err(|error| format!("narada_mcp_boa_fixture_request_conversion_failed:{error}"))?;
        let handler = context
            .global_object()
            .get(js_string!(HANDLER_NAME), &mut context)
            .map_err(|error| format!("narada_mcp_boa_fixture_handler_lookup_failed:{error}"))?;
        let callable = handler
            .as_callable()
            .ok_or_else(|| format!("narada_mcp_boa_fixture_handler_missing:{HANDLER_NAME}"))?;
        let result = callable
            .call(&JsValue::undefined(), &[request_value], &mut context)
            .map_err(|error| format!("narada_mcp_boa_fixture_handler_call_failed:{error}"))?;
        let result_json = result
            .to_json(&mut context)
            .map_err(|error| format!("narada_mcp_boa_fixture_response_conversion_failed:{error}"))?
            .ok_or_else(|| "narada_mcp_boa_fixture_handler_returned_undefined".to_string())?;
        let response = serde_json::json!({
            "jsonrpc": "2.0",
            "id": request.get("id").cloned().unwrap_or(serde_json::Value::Null),
            "result": result_json,
        });
        serde_json::to_writer(&mut writer, &response)
            .map_err(|error| format!("narada_mcp_boa_fixture_stdout_write_failed:{error}"))?;
        writer
            .write_all(b"\n")
            .map_err(|error| format!("narada_mcp_boa_fixture_stdout_write_failed:{error}"))?;
        writer
            .flush()
            .map_err(|error| format!("narada_mcp_boa_fixture_stdout_flush_failed:{error}"))?;
    }
    Ok(())
}
