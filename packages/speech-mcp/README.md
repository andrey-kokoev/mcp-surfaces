# @narada2/speech-mcp

Host-level speech MCP surface for text-to-speech, bounded microphone capture, transcript-returning remote transcription, prompt-response workflows, and bounded local listen sessions.

## Tools

- `speech_speak` speaks text through Windows SAPI or OpenAI TTS.
- `speech_voices` lists available SAPI voices or known OpenAI voices.
- `speech_capture_transcribe` captures bounded microphone audio or reads an input WAV and returns a first-class transcript result. Its capture provider is `remote_transcription` only.
- `speech_prompt_capture_response` speaks a prompt, captures a bounded spoken response, and returns a transcript or `no_response`.
- `speech_listen_status` reports adapter readiness, policy, audio cue posture, and active listen sessions.
- `speech_listen_start` starts a bounded local voice-intent listen session. Providers are `local_sapi` by default or `remote_transcription` when policy admits remote audio egress.
- `speech_listen_stop` stops one active listen session or all active listen sessions.

## Provider Contract

TTS providers are `sapi` and `openai_api`. The default TTS provider is `openai_api`, with OpenAI model `tts-1` and voice `nova`.

`speech_speak` can also retain generated speech as a WAV file for NARS artifact projection. Pass `output_path` to choose the retained file path, or `retain_audio: true` to retain to a temporary WAV path. Explicit `output_path` values are admitted only under the OS temp directory, `NARADA_SITE_ROOT`, `NARADA_WORKSPACE_ROOT`, or `NARADA_SPEECH_OUTPUT_ROOT`. Retention is additive: the tool still performs host-side audible playback, and the returned `retained_audio.path` can be registered as a NARS `audio` artifact by the caller.

Listen-session providers are `local_sapi` and `remote_transcription`. `local_sapi` is for local voice-intent monitoring through the host adapter. It is not a transcript-returning capture provider.

Transcript-returning capture uses `remote_transcription`. The schema for `speech_capture_transcribe` intentionally exposes only `remote_transcription` so callers do not treat `local_sapi` as valid for first-class transcript capture.

## Policy And Credentials

Remote transcription sends bounded microphone audio to OpenAI and is blocked unless remote audio egress is explicitly admitted with `--allow-remote-audio-egress`, `NARADA_SPEECH_ALLOW_REMOTE_AUDIO_EGRESS=true`, or equivalent server options.

OpenAI credentials resolve in this order:

1. Tool argument `api_key`.
2. `OPENAI_API_KEY` from the MCP server environment.
3. Admitted provider secret lookup, unless `NARADA_PROVIDER_SECRET_STORE=disabled`.

The default transcription model is `gpt-4o-transcribe`; it can be overridden with `--openai-transcription-model` or `NARADA_SPEECH_OPENAI_TRANSCRIPTION_MODEL`.

## Adapter Requirements

Capture and listen behavior depends on the local voice adapter script, usually `Start-VoiceIntentLocalMonitor.ps1`. Configure it with `--listen-adapter-path` or `NARADA_SPEECH_LISTEN_ADAPTER_PATH` when the default repo-relative path is not valid for the host.

For live capture, the adapter receives bounded duration, device selection, calibration, retention, and debug-audio-cue flags. `speech_capture_transcribe` also supports `input_wav` and `self_test_synthetic` for deterministic tests.

## Audio Cues And Concurrency

Audible output is serialized through a host-wide lock. This includes `speech_speak` playback and listen start/end audio cues. Multiple carrier-launched `speech-mcp` processes on the same host should not speak over each other when they use the same default lock path.

Capture and transcription are not routed through the audible-output lock. Separate carrier processes may capture/transcribe concurrently when policy admits the requested provider. A prompt-response workflow serializes the prompt playback first, then performs its capture/transcription step independently.

Listen start/end audio cues are enabled by default and can be disabled with `--no-listen-audio-cues`, `NARADA_SPEECH_LISTEN_AUDIO_CUES=false`, or equivalent server options. `speech_listen_status` reports the active cue posture as `policy.audio_cues`.

The default host lock path is under the OS temp directory as `speech-mcp-audible-output.lock`. Stale locks are cleared after the configured stale interval.

## Speaker Announcements

`speech_speak` and prompt-response prompting announce the sending agent by default when an identity is available. The identity comes from `speaker_agent_id` on the tool call, then `NARADA_AGENT_ID`, then `NARADA_AGENT_NAME`. The spoken prefix is `<agent> here:` before the requested text.

Disable the default with `--no-announce-speaker`, `NARADA_SPEECH_ANNOUNCE_SPEAKER=false`, or per call with `announce_speaker: false`. `speech_listen_status` reports the effective default as `policy.announce_speaker_default`.

Announcement audio is cached as WAV files and reused by cache key. The key includes provider, prefix text, and the same voice settings used for the message: SAPI voice/rate or OpenAI voice/model/speed. Override the cache root with `--announcement-cache-dir` or `NARADA_SPEECH_ANNOUNCEMENT_CACHE_DIR`.
