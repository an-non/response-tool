# Yuki Relay memory architecture v2

## Authority boundaries

- `yuki-relay/results/<trace_id>/`: immutable request/response originals and execution metadata.
- `yuki-relay/state/<profile>/current.json`: authoritative current relationship and consent context.
- `yuki-relay/memory/<profile>/<session>/`: derived conversational continuity and recall indexes.
- Derived memory never grants, extends, or revokes current consent.

## Primary keys and relations

- Session PK: `<profile_id>:<session_id>` in `session.json`.
- Turn PK: `<profile_id>:<session_id>:turn:<000001>` in `turns/<000001>.json`.
- Trace index: `traces/<trace_id>.json` maps an execution trace to one turn.
- Memory block PK: `<profile_id>:<session_id>:block:<000001>`.
- Active client mapping: `clients/<client_id>/active.json` stores the session id and only a hash of the client key.

The turn row stores references to the original `results/<trace_id>/request.txt`, `response.txt`, and `metadata.json`. Originals are not duplicated into the memory block.

## Three-turn compression

Every completed group of three turns is compressed into:

`memory/<profile>/<session>/v2/blocks/<start>-<end>.json`

The block contains weighted fields for:

- identity facts
- important topics
- observed/requested approval context
- conversation flow
- relationship and extensibility
- current status
- exact recall keys
- unresolved items

Weights are future recall importance from 0 to 1, not truth probability or permission strength. Every weighted item includes source turn numbers.

`v2/index.json` contains compact searchable block metadata. `v2/current.json` is the merged continuity state through the latest ready block.

## Runtime read path

A normal relay request reads `session.json`, `v2/index.json`, and `v2/current.json` in parallel. Recent turns are stored in the session manifest, so normal continuation does not list the Blob prefix or hydrate all historical originals.

When the request indicates recall, compact block entries are ranked first. Only selected blocks are opened, then their source turns are hydrated from the original request/response files. If no ready memory block exists, explicit recall can perform a bounded original-turn fallback.

## Failure and retry

Each block has `pending`, `ready`, or `error` status, attempt count, provider status, retryability, and next retry time. Failed blocks remain indexed and are retried on later successful conversation turns. Dialogue response is returned before background compression begins.

The default compression model is `openai/gpt-oss-20b`, with strict JSON schema output. The dialogue model remains `qwen/qwen3.6-27b`. `GROQ_MEMORY_MODEL` can override the memory model.
