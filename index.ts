/**
 * pi-use-cheap — run one prompt on a cheap model.
 *
 * Start a prompt with `_` and that turn runs on the configured cheap model.
 * The `_` is stripped before the model sees it; the session's model is
 * restored when the turn ends.
 *
 *   ❯ _summarize the last commit
 *
 * Model resolution (first match wins):
 *   1. `--cheap-model <provider/model-id | model-id>` CLI flag
 *   2. `PI_USE_CHEAP_MODEL` env var (same format)
 *   3. Default: glm-5.3-flash
 *
 * A plain model-id is searched across all providers with configured auth.
 * If the model can't be resolved, the prompt runs unmodified on the current
 * model and a notification says so.
 *
 * Inspired by midudev/better-claude (plugins/use-haiku).
 */
import type { ExtensionAPI, Model } from "@earendil-works/pi-coding-agent";

const MARK = "_";
const DEFAULT_MODEL = "glm-5.3-flash";

let runtimeModelSpec: string | undefined; // set by /cheap during a session

function modelSpec(pi: ExtensionAPI): string {
	if (runtimeModelSpec) return runtimeModelSpec;
	const flag = pi.getFlag("cheap-model");
	if (typeof flag === "string" && flag.trim()) return flag.trim();
	const env = process.env.PI_USE_CHEAP_MODEL;
	if (env && env.trim()) return env.trim();
	return DEFAULT_MODEL;
}

function resolveModel(pi: ExtensionAPI, spec: string): Model<any> | undefined {
	const registry = pi.modelRegistry;
	if (spec.includes("/")) {
		const idx = spec.indexOf("/");
		const model = registry.find(spec.slice(0, idx), spec.slice(idx + 1));
		return model;
	}
	// Plain id: prefer models whose provider has auth configured.
	const candidates = registry.getAll().filter((m) => m.id === spec);
	return (
		candidates.find((m) => registry.hasConfiguredAuth(m)) ??
		candidates[0]
	);
}

// `_summarize the diff` is marked; `__init__.py fails` and a lone `_` are not.
function isMarked(text: string): boolean {
	return text.startsWith(MARK) && !text.startsWith(MARK + MARK);
}

export default function useCheapExtension(pi: ExtensionAPI) {
	let cheapTurn = false;
	let previousModel: Model<any> | undefined;

	pi.on("input", async (event, ctx) => {
		if (!isMarked(event.text)) return;

		const text = event.text.slice(MARK.length).trimStart();
		if (!text) return; // lone `_`: don't hijack the input

		if (event.streamingBehavior !== undefined) {
			// Mid-turn: folded into the running turn, keeps the current model.
			ctx.ui.notify("Sent mid-turn: keeps the current model", "warning");
			return { action: "transform" as const, text };
		}

		const model = resolveModel(pi, modelSpec(pi));
		if (!model || !pi.modelRegistry.hasConfiguredAuth(model)) {
			ctx.ui.notify(
				`use-cheap: model "${modelSpec(pi)}" not available — running on current model`,
				"warning",
			);
			return { action: "transform" as const, text };
		}

		cheapTurn = true;
		return { action: "transform" as const, text };
	});

	pi.on("agent_start", async () => {
		if (!cheapTurn) return;
		const model = resolveModel(pi, modelSpec(pi));
		if (!model) {
			cheapTurn = false;
			return;
		}
		previousModel = pi.session.model;
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
			await pi.setModel(previousModel);
			previousModel = undefined;
			ctx.ui.notify(`⚡ Answered by ${modelSpec(pi)}`, "info");
		}
	});

	pi.registerFlag("cheap-model", {
		description: "Model used by use-cheap `_` prompts (provider/model-id or model-id)",
		type: "string",
	});

	pi.registerCommand("cheap", {
		description: "Show or set the cheap model used for `_` prompts",
		handler: async (args, ctx) => {
			const spec = args.trim();
			if (spec) {
				const model = resolveModel(pi, spec);
				if (!model || !pi.modelRegistry.hasConfiguredAuth(model)) {
					ctx.ui.notify(`Model "${spec}" not available`, "error");
					return;
				}
				runtimeModelSpec = spec;
				ctx.ui.notify(`Cheap model set to ${model.provider}/${model.id}`, "info");
			} else {
				ctx.ui.notify(`Cheap model: ${modelSpec(pi)} (_ prefix, /cheap <model> to change)`, "info");
			}
		},
	});
}
