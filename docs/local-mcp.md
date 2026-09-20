# Local OpenWhispr MCP adapter

`scripts/openwhispr-mcp.js` is a local, read-only MCP server for a running OpenWhispr desktop app. It uses the existing CLI bridge at `127.0.0.1:8200-8219`; it does not create an HTTP listener, call the cloud API, or require an OpenWhispr account.

Start the desktop app first. It creates `~/.openwhispr/cli-bridge.json` with a fresh bearer token and mode `0600`.

The installed app carries the adapter at its absolute `resources/bin/openwhispr-mcp.js` path. Node.js is a prerequisite: the MCP host must have an existing Node 24+ `node` executable on `PATH`. For example, a standard macOS installation uses:

```json
{
  "mcpServers": {
    "openwhispr-local": {
      "command": "node",
      "args": ["/Applications/OpenWhispr.app/Contents/Resources/bin/openwhispr-mcp.js"]
    }
  }
}
```

On Windows and Linux, use the corresponding absolute `<OpenWhispr install>/resources/bin/openwhispr-mcp.js` path. The adapter is copied as a passive package resource; OpenWhispr does not launch it itself.

For a source checkout, use `node /absolute/path/to/openwhispr/scripts/openwhispr-mcp.js`. If an MCP host must launch the package script, use `npm --silent run mcp:notes`; plain `npm run mcp:notes` can print npm lifecycle banners to standard output and corrupt the newline-delimited JSON-RPC stream. Standard output is reserved for MCP messages; diagnostic messages never include the bearer token.

The adapter supports current MCP `2026-07-28` clients with `server/discover` and per-request metadata. It also supports the earlier `initialize` / `notifications/initialized` lifecycle requested by hosts that negotiate `2025-11-25` or `2025-06-18`.

It exposes exactly two read-only tools:

- `openwhispr_search_notes(query, limit?)`: requires a query and returns at most 10 short note excerpts.
- `openwhispr_get_note(id)`: returns one note by numeric ID, capped at 32 KiB of note content. When that selected note has an attached meeting transcript, it returns the supplied `transcript` field with its own source reference, capped at 32 KiB.

Every result includes an `openwhispr://…` source reference. The adapter never exposes API keys, the bridge token, standalone dictation-transcription history, the `raw_text` transcription field, audio, dictionary entries, or list/history endpoints. Each newline-delimited input frame and serialized output frame is capped at 64 KiB, query strings at 512 characters, bridge responses at 1 MiB, at most four bridge requests run concurrently, and each bridge request has a five-second timeout.

Note metadata is returned only through the adapter's fixed record shape. It is never interpreted as MCP server instructions, tool definitions, or protocol metadata.

If the desktop app is closed, the bridge file is missing, the bridge has restarted, or the credential file is not mode `0600` on Unix, tool calls return a bounded error telling the user to start or restart OpenWhispr. No credential is printed.

CI verification:

```bash
node --import tsx --test test/helpers/openwhisprMcp.test.js
```
