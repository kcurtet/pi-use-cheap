/**
 * pi-use-cheap — run one prompt on a cheap model.
 *
 * Start a prompt with `_` and that turn runs on the configured cheap model.
 * The `_` is stripped before the model sees it; the session's model is
 * restored when the turn ends.
 *
 *   ❯ _summarize the last commit
 *
 * Configuration, first match wins:
 *   1. `/use-cheap config <provider/model-id | model-id>` (persisted)
 *   2. `--cheap-model` CLI flag
 *   3. `PI_USE_CHEAP_MODEL` env var
 *   4. Default: glm-5.3-flash
 *
 * `/use-cheap` shows the current config; `/use-cheap reset` clears it.
 *
 * Inspired by midudev/better-claude (plugins/use-haiku).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, Model, ModelRegistry } from "@earendil-works/pi-coding-agent";

const MARK = "_";
const DEFAULT_MODEL = "glm-5.3-flash";

interface PersistedConfig {
	model?: string; // "provider/model-id" or "model-id"
}

function configPath(): string {
	const home = process.env.PI_HOME ?? path.join(os.homedir(), ".pi", "agent");
	return path.join(home, "extensions-config", "use-cheap.json");
}

function loadConfig(): PersistedConfig {
	try {
		return JSON.parse(fs.readFileSync(configPath(), "utf8")) as PersistedConfig;
	} catch {
		return {};
	}
}

function saveConfig(config: PersistedConfig): void {
	try {
		fs.mkdirSync(path.dirname(configPath()), { recursive: true });
		fs.writeFileSync(configPath(), JSON.stringify(config, null, "\t") + "\n");
	} catch {
		// read-only home: config stays per-session
	}
}

function resolveModel(registry: ModelRegistry, spec: string): Model<any> | undefined {
	if (spec.includes("/")) {
		const idx = spec.indexOf("/");
		return registry.find(spec.slice(0, idx), spec.slice(idx + 1));
	}
	// Plain id: prefer models whose provider has auth configured.
	const candidates = registry.getAll().filter((m) => m.id === spec);
	return (
		candidates.find((m) => registry.hasConfiguredAuth(m)) ?? candidates[0]
	);
}

// `_summarize the diff` is marked; `__init__.py fails` and a lone `_` are not.
function isMarked(text: string): boolean {
	return text.startsWith(MARK) && !text.startsWith(MARK + MARK);
}

export default function useCheapExtension(pi: ExtensionAPI) {
	let cheapTurn = false;
	let previousModel: Model<any> | undefined;

	function modelSpec(): string {
		const persisted = loadConfig().model;
		if (persisted) return persisted;
		const flag = pi.getFlag("cheap-model");
		if (typeof flag === "string" && flag.trim()) return flag.trim();
		const env = process.env.PI_USE_CHEAP_MODEL;
		if (env && env.trim()) return env.trim();
		return DEFAULT_MODEL;
	}

	pi.on("input", async (event, ctx) => {
		if (!isMarked(event.text)) return;

		const text = event.text.slice(MARK.length).trimStart();
		if (!text) return; // lone `_`: don't hijack the input

		if (event.streamingBehavior !== undefined) {
			// Mid-turn: folded into the running turn, keeps the current model.
			ctx.ui.notify("Sent mid-turn: keeps the current model", "warning");
			return { action: "transform" as const, text };
		}

		const model = resolveModel(ctx.modelRegistry, modelSpec());
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
			ctx.ui.notify(
				`use-cheap: model "${modelSpec()}" not available — running on current model`,
				"warning",
			);
			return { action: "transform" as const, text };
		}

		cheapTurn = true;
		return { action: "transform" as const, text };
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!cheapTurn) return;
		const model = resolveModel(ctx.modelRegistry, modelSpec());
		if (!model) {
			cheapTurn = false;
			return;
		}
		previousModel = ctx.model;
		const ok = await pi.setModel(model);
		if (!ok) {
			cheapTurn = false;
			previousModel = undefined;
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!cheapTurn) return;
		cheapTurn = false;
		if (previousModel !== undefined) {
			const answered = modelSpec();
			await pi.setModel(previousModel);
			previousModel = undefined;
			if (ctx.hasUI) ctx.ui.notify(`⚡ Answered by ${answered}`, "info");
		}
	});

	pi.registerFlag("cheap-model", {
		description: "Model used by use-cheap `_` prompts (provider/model-id or model-id)",
		type: "string",
	});

	pi.registerCommand("use-cheap", {
		description: "Configure `_` prompts: /use-cheap [config <model> | reset]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);

			if (parts.length === 0) {
				ctx.ui.notify(`_ prompts: ${modelSpec()}`, "info");
				return;
			}

			if (parts[0] === "reset") {
				saveConfig({});
				ctx.ui.notify(`_ prompts: config cleared (default ${DEFAULT_MODEL})`, "info");
				return;
			}

			if (parts[0] === "config" && parts[1]) {
				const model = resolveModel(ctx.modelRegistry, parts[1]);
				if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
					ctx.ui.notify(`Model "${parts[1]}" not available`, "error");
					return;
				}
				saveConfig({ model: parts[1] });
				ctx.ui.notify(`_ prompts: ${model.provider}/${model.id}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /use-cheap [config <model> | reset]", "error");
		},
	});
}
