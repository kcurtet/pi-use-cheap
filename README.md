# pi-use-cheap

Prefix a prompt with `_` and that turn runs on a cheap model. The `_` is
stripped before the model sees it; the session's model is restored when the
turn ends.

```text
❯ _summarize the last commit
```

## Configuring the model

First match wins:

1. `/cheap <model>` during the session
2. `--cheap-model <provider/model-id | model-id>` CLI flag
3. `PI_USE_CHEAP_MODEL` env var (same format)
4. Default: `glm-5.3-flash`

A plain model-id is searched across all providers (auth-configured ones
preferred). If it can't be resolved, the prompt runs unmodified on the current
model and a notification says so.

```bash
pi --cheap-model glm-5.3-flash
PI_USE_CHEAP_MODEL=ollama/gemma4:latest pi
```

## Details

- `_summarize the diff` is marked; `__init__.py fails` (double underscore) and
  a lone `_` are not.
- Mid-turn prompts keep the current model (they fold into the running turn).
- After the turn, the session's model is restored.

## Install

```bash
pi install git:https://github.com/kcurtet/pi-use-cheap
```

## How it works

- `input` event: detects the leading `_`, strips it, marks the turn.
- `agent_start`: saves the current model and switches to the cheap model.
- `agent_end`: restores the previous model.

Inspired by [midudev/better-claude](https://github.com/midudev/better-claude)
(`use-haiku` plugin).

MIT © kcurtet
