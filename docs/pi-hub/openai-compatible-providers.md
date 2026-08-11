# Adding an OpenAI-Compatible Provider

Any endpoint that speaks `/v1/chat/completions` can be added as a model provider
without changing Pi Hub or patching the SDK. Hetzner's inference API is used as the
worked example throughout.

## Where the Configuration Lives

Providers go in Pi's own config, outside the repository and outside
`node_modules`:

```text
~/.pi/agent/models.json
```

Updating `@earendil-works/pi-*` replaces the package and never touches this file, so
a provider added here survives upgrades. That is the reason to configure a provider
rather than patch one in.

```json
{
  "providers": {
    "hetzner": {
      "name": "Hetzner",
      "baseUrl": "https://inference.hetzner.com/api/v1",
      "apiKey": "$HETZNER_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "DeepSeek-V4-Flash-0731",
          "name": "DeepSeek V4 Flash 0731",
          "reasoning": true,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 512000,
          "maxTokens": 16384,
          "thinkingLevelMap": { "off": "none", "xhigh": "xhigh", "max": "max" }
        }
      ]
    }
  }
}
```

Reference the key as `$ENV_NAME` rather than pasting it in. Put the value in the
app's `.env.local` (see `always-on-server.md`) so every start method picks it up.
The `Authorization: Bearer` header is added by the OpenAI client the SDK constructs,
so do **not** set `authHeader: true` — that would duplicate it.

## `models` Creates, `modelOverrides` Adjusts

The two keys are not interchangeable.

Use `models[]` for a model the SDK does not know. The entry is built from your
definition alone, so every field you omit takes a default rather than the built-in
model's value: `contextWindow` 128000, `maxTokens` 16384, `reasoning` false, `input`
`["text"]`, and cost zero. `thinkingLevelMap` is whatever you supply — nothing is
inherited — and `compat` is only your entry merged with the provider's.

Use `modelOverrides[id]` to change a model the SDK already ships. It is applied by
`applyModelOverride`, which spreads the existing model and replaces only the keys
you supply. Putting an override in `models[]` instead silently resets everything you
did not restate — including compat flags that reasoning depends on.

When clearing an override, prune the containers it empties. A provider entry must
specify at least one of `baseUrl`, `headers`, `compat`, `modelOverrides`, `models`,
`apiKey`, `oauth`, or `authHeader`, and the SDK throws otherwise:

```text
Provider <id>: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".
```

So an abandoned `modelOverrides: {}` left behind after clearing the last setting can
make the whole file invalid and take every model down with it.

## Verify the Model IDs

Ask the endpoint rather than trusting a documentation table:

```bash
curl -s https://inference.hetzner.com/api/v1/models -H "Authorization: Bearer $HETZNER_API_KEY"
```

IDs are frequently inconsistent within one provider — Hetzner serves
`DeepSeek-V4-Flash-0731` and `GLM-5.2-NVFP4` unnamespaced but
`Qwen/Qwen3.6-35B-A3B-FP8` with a prefix. A wrong ID produces a provider that
appears in the picker and fails every request. Many endpoints also return
`max_model_len`, which is the authoritative context window.

## Check Capabilities Before Trusting Them

Docs routinely omit what matters for an agent. Probe it:

- **Tool calling.** The decisive one. Send a request with a `tools` array and
  confirm `tool_calls` comes back. A chat-only endpoint cannot drive Pi Hub, and
  OpenRouter-style gateways may expose individual upstream providers that reject
  tools while their siblings accept them.
- **Streaming.** Send `stream: true` and confirm `text/event-stream` with delta
  chunks and a `[DONE]` sentinel.
- **Reasoning.** Send `reasoning_effort` and look for `reasoning`,
  `reasoning_content`, or `reasoning_text` on the message. The SDK reads all three,
  so no `thinkingFormat` compat is needed for a plain OpenAI-shaped endpoint.

Probe with generous `max_tokens`. A cap below what the model wants makes every level
finish at the same length and produce a meaningless comparison — check
`finish_reason` is `stop`, not `length`, before believing any measurement.

## Thinking Levels

With `reasoning: true` and no `thinkingLevelMap`, a model offers
`off, minimal, low, medium, high`. `xhigh` and `max` are **opt-in**:

```js
if (level === "xhigh" || level === "max") return mapped !== undefined;
return true;   // every other level shows unless mapped to null
```

So those two appear only when the map names them, and any level can be hidden by
mapping it to `null`. This is why the same underlying model can offer different
levels through different providers — one entry defines `max`, another sets it to
`null`.

Map `off` explicitly when the endpoint reasons by default. Pi omits
`reasoning_effort` for `off`, and an endpoint that thinks when the parameter is
absent will keep thinking — selecting "off" then costs tokens and latency while
appearing to be disabled. Sending `"none"` is what actually stops it.

Only map levels the endpoint accepts. A validating endpoint returns 400 and names
the set it allows, which is the cheapest way to learn it:

```text
Input should be 'none', 'minimal', 'low', 'medium', 'high', 'xhigh' or 'max'
```

## Visibility and Credentials

A provider appears only when its credentials resolve. `/api/models` lists
`modelRuntime.getAvailable()`, so a provider whose `$ENV_NAME` is unset is filtered
out silently — no error, just absent. Environment variables are read at process
start, so a newly exported value needs a server restart.

`/api/models` is cached per working directory for 60 seconds. After editing
`models.json`, wait out the TTL before concluding the config is wrong.

## Troubleshooting

**The provider does not appear at all.**
Its API key did not resolve. Confirm the variable is set in the environment the
server actually started with, then restart. Check for a stale 60-second cache
before changing anything else.

**Every request 404s.**
The model IDs do not match the endpoint. List them from `/v1/models` and compare
exactly, including any namespace prefix.

**Reasoning levels are missing.**
`xhigh` and `max` need explicit `thinkingLevelMap` entries. Others are hidden only
if mapped to `null`.

**Selecting "off" still produces thinking.**
Map `off` to the endpoint's own disable value, usually `"none"`.

**A model loses its context window or reasoning support.**
It was defined under `models[]` when it should have been an entry in
`modelOverrides`.
