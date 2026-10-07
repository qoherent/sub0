import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Type } from "typebox";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL(".", import.meta.url));
const node = process.execPath;
const ownFile = fileURLToPath(import.meta.url);
const outcomes = [];

async function check(name, run) {
	try {
		outcomes.push({ name, ok: true, result: await run() });
	} catch (error) {
		outcomes.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
	}
}

async function filesUnder(directory) {
	const files = [];
	for (const name of await readdir(directory)) {
		const path = join(directory, name);
		if ((await stat(path)).isDirectory()) files.push(...await filesUnder(path));
		else files.push(path);
	}
	return files;
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function sse(res, payload) {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function finishStream(res, text, model = "fake-model") {
	sse(res, { id: "probe", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
	if (text) sse(res, { id: "probe", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
	sse(res, { id: "probe", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
	res.write("data: [DONE]\n\n");
	res.end();
}

function userText(messages = []) {
	return messages.filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
}

const requests = [];
const authByMarker = new Map();
const held = new Map();
let toolMode = false;
let toolCallCount = 0;
let executedToolCount = 0;
let partialToolAbort = null;
let resumeContainsUnmatchedToolCall = false;

const server = createServer(async (req, res) => {
	if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let raw = "";
	for await (const chunk of req) raw += chunk;
	const body = JSON.parse(raw);
	const texts = userText(body.messages);
	requests.push({ url: req.url, tools: body.tools?.map((t) => t.function?.name), texts });
	if (texts.includes("previous attempt was interrupted")) {
		resumeContainsUnmatchedToolCall = body.messages.some((message) => message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.some((call) => !body.messages.some((candidate) => candidate.role === "tool" && candidate.tool_call_id === call.id)));
	}
	const marker = ["openai", "runtime-A", "runtime-B"].find((x) => texts.includes(x));
	if (marker) authByMarker.set(marker, req.headers.authorization ?? "");
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	res.flushHeaders();

	if (partialToolAbort && texts.includes("abort-partial-toolcall") && !partialToolAbort.used) {
		const item = partialToolAbort;
		item.used = true;
		res.on("close", () => item.release.resolve());
		sse(res, { id: "probe", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
		sse(res, { id: "probe", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-abort", type: "function", function: { name: "probe_echo", arguments: "{\"text\":\"must-not-execute\"}" } }] }, finish_reason: null }] });
		item.started.resolve();
		await item.release.promise;
		if (!res.destroyed) res.end();
		return;
	}

	const holdKey = [...held.entries()].find(([x, item]) => texts.includes(x) && !item.used)?.[0];
	if (holdKey) {
		const item = held.get(holdKey);
		item.used = true;
		res.on("close", () => item.release.resolve());
		sse(res, { id: "probe", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta: { role: "assistant", content: "working" }, finish_reason: null }] });
		item.started.resolve();
		await item.release.promise;
		if (!res.destroyed) finishStream(res, "released");
		return;
	}

	if (toolMode && texts.includes("call-the-custom-tool") && !body.messages.some((m) => m.role === "tool")) {
		toolCallCount++;
		sse(res, { id: "probe", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
		sse(res, { id: "probe", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-probe", type: "function", function: { name: "probe_echo", arguments: "{\"text\":\"tool-ok\"}" } }] }, finish_reason: null }] });
		sse(res, { id: "probe", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
		res.write("data: [DONE]\n\n");
		res.end();
		return;
	}

	if (texts.includes("previous attempt was interrupted")) finishStream(res, "resumed-from-checkpoint-ok");
	else if (texts.includes("after-reopen")) finishStream(res, "reopen-ok");
	else if (texts.includes("runtime-A")) finishStream(res, "runtime-A-ok");
	else if (texts.includes("runtime-B")) finishStream(res, "runtime-B-ok");
	else if (texts.includes("call-the-custom-tool")) finishStream(res, "custom-tool-ok");
	else if (texts.includes("steer-marker")) finishStream(res, "steer-ok");
	else if (texts.includes("followup-marker")) finishStream(res, "followup-ok");
	else finishStream(res, "response-ok");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const work = await mkdtemp(join(tmpdir(), "pi-sdk-qual-"));
const endpoint = `http://127.0.0.1:${port}/v1`;

async function writeModelConfig(name) {
	const dir = join(work, name);
	await mkdir(dir, { recursive: true });
	const modelsPath = join(dir, "models.json");
	await writeFile(modelsPath, JSON.stringify({ providers: { fake: { baseUrl: endpoint, api: "openai-completions", models: [{ id: "fake-model", name: "Fake Model", contextWindow: 8192, maxTokens: 512, reasoning: false, input: ["text"] }] } } }));
	const authPath = join(dir, "auth.json");
	const runtime = await ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false, refreshOnCreate: false });
	return { dir, runtime, model: runtime.getModel("fake", "fake-model") };
}

async function makeSession(name, runtime, model, options = {}) {
	const dir = join(work, name);
	await mkdir(dir, { recursive: true });
	const settingsManager = SettingsManager.inMemory({ defaultTools: [] });
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: join(dir, "agent"),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const sessionManager = options.sessionManager ?? SessionManager.inMemory(dir);
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: join(dir, "agent"),
		modelRuntime: runtime,
		model,
		settingsManager,
		resourceLoader: loader,
		sessionManager,
		tools: options.tools ?? [],
		customTools: options.customTools,
	});
	await session.bindExtensions({ mode: "json" });
	return { session, loader, sessionManager };
}

async function runReopen(file, modelsPath, authPath, endpointPort) {
	const runtime = await ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false, refreshOnCreate: false });
	await runtime.setRuntimeApiKey("fake", "test-only-memory-key");
	const model = runtime.getModel("fake", "fake-model");
	const manager = SessionManager.open(file);
	const { session } = await makeSession("resume-child", runtime, model, { sessionManager: manager });
	const before = session.messages.length;
	const result = await session.prompt("after-reopen");
	const output = session.getLastAssistantText();
	assert.match(output, /reopen-ok/);
	session.dispose();
	console.log(JSON.stringify({ mode: "reopen", endpointPort, beforeMessages: before, afterMessages: manager.getBranch().length, output }));
}

async function runResumeAborted(file, modelsPath, authPath, endpointPort, checkpointLeaf, interruptedPromptEntryId, partialToolEntryId) {
	const runtime = await ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false, refreshOnCreate: false });
	await runtime.setRuntimeApiKey("fake", "test-only-memory-key");
	const manager = SessionManager.open(file);
	const originalEntries = manager.getEntries();
	assert.ok(originalEntries.some((entry) => entry.id === interruptedPromptEntryId), "interrupted prompt remains stored");
	if (partialToolEntryId) assert.ok(originalEntries.some((entry) => entry.id === partialToolEntryId), "partial toolCall entry remains stored");
	manager.branch(checkpointLeaf);
	assert.ok(!manager.getBranch().some((entry) => entry.id === interruptedPromptEntryId), "resumed projection starts at last completed checkpoint");
	const model = runtime.getModel("fake", "fake-model");
	const { session } = await makeSession("resume-aborted-child", runtime, model, { sessionManager: manager, tools: [] });
	const notice = "The previous attempt was interrupted. Inspect the current workspace before acting; do not repeat any potentially completed action.";
	await session.prompt(notice);
	const output = session.getLastAssistantText();
	assert.match(output, /resumed-from-checkpoint-ok/);
	assert.ok(manager.getEntries().some((entry) => entry.id === interruptedPromptEntryId), "branching preserves the interrupted prompt record");
	if (partialToolEntryId) assert.ok(manager.getEntries().some((entry) => entry.id === partialToolEntryId), "branching preserves the partial toolCall record");
	assert.equal(resumeContainsUnmatchedToolCall, false, "new model request contains no unmatched toolCall");
	session.dispose();
	console.log(JSON.stringify({ mode: "resume-aborted", endpointPort, checkpointLeaf, interruptedPromptEntryId, partialToolEntryId, retainedEntryCount: originalEntries.length, branchEntryCount: manager.getBranch().length, output, noUnmatchedToolCall: !resumeContainsUnmatchedToolCall }));
}

function runChild(args) {
	return new Promise((resolve, reject) => {
		const child = spawn(node, [ownFile, ...args], { cwd: root, env: { PATH: process.env.PATH, PI_OFFLINE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
		child.stdout.setEncoding("utf8").on("data", (chunk) => stdout += chunk);
		child.stderr.setEncoding("utf8").on("data", (chunk) => stderr += chunk);
		child.once("error", reject);
		child.once("close", (status, signal) => {
			clearTimeout(timer);
			resolve({ status, signal, stdout, stderr });
		});
	});
}

if (process.argv[2] === "--reopen") {
	try {
		await runReopen(process.argv[3], process.argv[4], process.argv[5], Number(process.argv[6]));
	} finally {
		server.close();
	}
	process.exit(0);
}

if (process.argv[2] === "--resume-aborted") {
	try {
		await runResumeAborted(process.argv[3], process.argv[4], process.argv[5], Number(process.argv[6]), process.argv[7], process.argv[8], process.argv[9]);
	} finally {
		server.close();
	}
	process.exit(0);
}

const startedAt = performance.now();
const runtimeA = await writeModelConfig("runtime-A");
const runtimeB = await writeModelConfig("runtime-B");
assert.ok(runtimeA.model && runtimeB.model, "custom compatible model resolves");
await runtimeA.runtime.setRuntimeApiKey("fake", "test-only-memory-key");

const startRss = process.memoryUsage.rss();
const emptyStart = performance.now();
const seenEvents = [];
let empty;
let emptyMs = 0;
let resourceCounts = {};
await check("empty allowlist, disabled resources, endpoint, events", async () => {
	empty = await makeSession("empty-worker", runtimeA.runtime, runtimeA.model);
	emptyMs = performance.now() - emptyStart;
	assert.deepEqual(empty.session.getActiveToolNames(), []);
	resourceCounts = { extensions: empty.loader.getExtensions().extensions.length, skills: empty.loader.getSkills().skills.length, prompts: empty.loader.getPrompts().prompts.length, contextFiles: empty.loader.getAgentsFiles().agentsFiles.length };
	assert.deepEqual(resourceCounts, { extensions: 0, skills: 0, prompts: 0, contextFiles: 0 });
	empty.session.subscribe((event) => seenEvents.push(event.type));
	await empty.session.prompt("empty-worker");
	assert.match(empty.session.getLastAssistantText(), /response-ok/);
	assert.ok(seenEvents.includes("message_update"));
	assert.ok(seenEvents.includes("agent_settled"));
	return { tools: empty.session.getActiveToolNames(), resourceCounts, events: [...new Set(seenEvents)] };
});
empty?.session.dispose();

const customTool = {
	name: "probe_echo",
	label: "Probe echo",
	description: "Return the supplied probe text",
	parameters: Type.Object({ text: Type.String() }),
	execute: async (_id, params) => {
		executedToolCount++;
		return { content: [{ type: "text", text: params.text }], details: { ran: true } };
	},
};
let explicit;
let explicitActiveTools = [];
await check("exact custom-tool allowlist and tool execution", async () => {
	explicit = await makeSession("explicit-worker", runtimeA.runtime, runtimeA.model, { tools: ["probe_echo"], customTools: [customTool] });
	explicitActiveTools = explicit.session.getActiveToolNames();
	assert.deepEqual(explicitActiveTools, ["probe_echo"]);
	toolMode = true;
	try {
		await explicit.session.prompt("call-the-custom-tool");
	} finally {
		toolMode = false;
	}
	assert.match(explicit.session.getLastAssistantText(), /custom-tool-ok/);
	assert.equal(toolCallCount, 1);
	assert.ok(requests.some((r) => r.tools?.includes("probe_echo")));
	return { activeTools: explicitActiveTools, calls: toolCallCount };
});
explicit?.session.dispose();

await check("separate ModelRuntime auth and custom endpoint", async () => {
	for (const [runtime, marker] of [[runtimeA.runtime, "runtime-A"], [runtimeB.runtime, "runtime-B"]]) {
		await runtime.setRuntimeApiKey("fake", `${marker}-key`);
		const session = await makeSession(`${marker}-worker`, runtime, runtime.getModel("fake", "fake-model"));
		try {
			await session.session.prompt(marker);
			assert.match(session.session.getLastAssistantText(), new RegExp(`${marker}-ok`));
		} finally {
			session.session.dispose();
		}
	}
	assert.equal(authByMarker.get("runtime-A"), "Bearer runtime-A-key");
	assert.equal(authByMarker.get("runtime-B"), "Bearer runtime-B-key");
	assert.ok(requests.some((r) => r.url === "/v1/chat/completions"));
	return { runtimeAAuth: authByMarker.get("runtime-A") === "Bearer runtime-A-key", runtimeBAuth: authByMarker.get("runtime-B") === "Bearer runtime-B-key" };
});

async function testQueue(kind, marker) {
	const pair = deferred();
	held.set(marker, { started: pair, release: deferred() });
	const item = held.get(marker);
	const s = await makeSession(`${kind}-worker`, runtimeA.runtime, runtimeA.model);
	const prompt = s.session.prompt(marker);
	try {
		await Promise.race([item.started.promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${kind} request not observed`)), 4000))]);
		const disposition = kind === "steer" ? await s.session.steer("steer-marker") : await s.session.followUp("followup-marker");
		assert.equal(disposition, "queued");
		const pendingWhileActive = s.session.pendingMessageCount;
		item.release.resolve();
		await prompt;
		const output = s.session.getLastAssistantText();
		if (!new RegExp(kind === "steer" ? "steer-ok" : "followup-ok").test(output)) {
			throw new Error(`${kind} did not reach a second response; pendingWhileActive=${pendingWhileActive}; requests=${JSON.stringify(requests.slice(-3))}; output=${output}`);
		}
		return output;
	} finally {
		item.release.resolve();
		await prompt.catch(() => undefined);
		s.session.dispose();
		held.delete(marker);
	}
}

let steerOutput;
let followupOutput;
await check("steering queue", async () => steerOutput = await testQueue("steer", "hold-steer-request"));
await check("follow-up queue", async () => followupOutput = await testQueue("followup", "hold-followup-request"));

const abortMarker = "hold-abort-request";
const abortStarted = deferred();
held.set(abortMarker, { started: abortStarted, release: deferred() });
const abortHold = held.get(abortMarker);
let abortSession;
await check("abort and discard queued follow-up", async () => {
	abortSession = await makeSession("abort-worker", runtimeA.runtime, runtimeA.model);
	const beforeAbortRequests = requests.length;
	const running = abortSession.session.prompt(abortMarker);
	try {
		await Promise.race([abortHold.started.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("abort request not observed")), 4000))]);
		await abortSession.session.followUp("discard-on-stop");
		const discarded = abortSession.session.clearQueue();
		await abortSession.session.abort();
		await running.catch(() => undefined);
		assert.deepEqual(discarded, { steering: [], followUp: ["discard-on-stop"] });
		assert.equal(abortSession.session.pendingMessageCount, 0);
		assert.equal(requests.length, beforeAbortRequests + 1, "abort does not start queued work");
		return { discarded, pending: abortSession.session.pendingMessageCount };
	} finally {
		abortHold.release.resolve();
		await running.catch(() => undefined);
		abortSession.session.dispose();
		held.delete(abortMarker);
	}
});

const resumeDir = join(work, "persistent-session-files");
await mkdir(resumeDir, { recursive: true });
let reopenResult;
await check("persistent JSONL session reopen in a new Node process", async () => {
	const persistence = await makeSession("persist-worker", runtimeA.runtime, runtimeA.model, { sessionManager: SessionManager.create(join(work, "persist-cwd"), resumeDir) });
	try {
		await persistence.session.prompt("persist-this-turn");
		const sessionFile = persistence.session.sessionManager.getSessionFile();
		assert.ok(sessionFile);
		persistence.session.dispose();
		const child = await runChild(["--reopen", sessionFile, join(work, "runtime-A", "models.json"), join(work, "runtime-A", "auth.json"), String(port)]);
		assert.equal(child.status, 0, `reopen child failed: ${child.stderr}`);
		reopenResult = JSON.parse(child.stdout.trim().split("\n").at(-1));
		assert.equal(reopenResult.mode, "reopen");
		assert.ok(reopenResult.beforeMessages >= 2);
		return reopenResult;
	} finally {
		persistence.session.dispose();
	}
});

let abortedBranchResult;
await check("abort partial toolCall, branch to completed checkpoint, resume in new Node process", async () => {
	const sessionDir = join(work, "aborted-session-files");
	await mkdir(sessionDir, { recursive: true });
	const persisted = await makeSession("partial-abort-worker", runtimeA.runtime, runtimeA.model, {
		sessionManager: SessionManager.create(join(work, "partial-abort-cwd"), sessionDir),
		tools: ["probe_echo"],
		customTools: [customTool],
	});
	let running;
	const beforeExecutions = executedToolCount;
	try {
		await persisted.session.prompt("completed-checkpoint-turn");
		const checkpointLeaf = persisted.sessionManager.getLeafId();
		assert.ok(checkpointLeaf, "completed turn establishes a checkpoint leaf");
		const file = persisted.sessionManager.getSessionFile();
		assert.ok(file);
		const started = deferred();
		const streamedToolCallDelta = deferred();
		partialToolAbort = { started, release: deferred(), used: false };
		persisted.session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_delta" && event.assistantMessageEvent.partial.content?.some((part) => part.type === "toolCall" && part.name === "probe_echo" && JSON.stringify(part.arguments).includes("must-not-execute"))) {
				streamedToolCallDelta.resolve();
			}
		});
		running = persisted.session.prompt("abort-partial-toolcall");
		await Promise.race([started.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("partial toolCall stream not observed")), 4000))]);
		await Promise.race([streamedToolCallDelta.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("provider stream did not deliver toolcall_delta before abort")), 4000))]);
		await persisted.session.abort();
		await running.catch(() => undefined);
		partialToolAbort.release.resolve();
		await running.catch(() => undefined);
		assert.equal(executedToolCount, beforeExecutions, "aborted partial toolCall never executed");
		const entries = persisted.sessionManager.getEntries();
		const interruptedPromptEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "user" && entry.message.content?.some((part) => part.type === "text" && part.text === "abort-partial-toolcall"));
		assert.ok(interruptedPromptEntry, "interrupted prompt remains in append-only transcript");
		const partialToolEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.content?.some((part) => part.type === "toolCall" && part.name === "probe_echo"));
		persisted.session.dispose();
		const child = await runChild(["--resume-aborted", file, join(work, "runtime-A", "models.json"), join(work, "runtime-A", "auth.json"), String(port), checkpointLeaf, interruptedPromptEntry.id, partialToolEntry?.id ?? ""]);
		assert.equal(child.status, 0, `safe branch resume failed: ${child.stderr}`);
		abortedBranchResult = JSON.parse(child.stdout.trim().split("\n").at(-1));
		assert.equal(abortedBranchResult.mode, "resume-aborted");
		assert.equal(abortedBranchResult.noUnmatchedToolCall, true);
		return { ...abortedBranchResult, sawToolCallDeltaBeforeAbort: true, partialToolCallPersisted: Boolean(partialToolEntry), toolExecutionsAfterAbort: executedToolCount - beforeExecutions };
	} finally {
		partialToolAbort?.release.resolve();
		await running?.catch(() => undefined);
		persisted.session.dispose();
		partialToolAbort = null;
	}
});

await check("synthetic provider keys are memory-only", async () => {
	const sentinels = ["test-only-memory-key", "runtime-A-key", "runtime-B-key"];
	const paths = await filesUnder(work);
	const leaked = [];
	for (const path of paths) {
		const content = await readFile(path, "utf8");
		if (sentinels.some((sentinel) => content.includes(sentinel))) leaked.push(path);
	}
	assert.deepEqual(leaked, []);
	return { filesChecked: paths.length, keyMaterialPersisted: false };
});

const packageJson = JSON.parse(await readFile(join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
console.log(JSON.stringify({
	version: packageJson.version,
	license: packageJson.license,
	engines: packageJson.engines,
	endpoint,
	endpointRequests: requests.length,
	endpointAuthChecks: {
		runtimeA: authByMarker.get("runtime-A") === "Bearer runtime-A-key",
		runtimeB: authByMarker.get("runtime-B") === "Bearer runtime-B-key",
	},
	emptyTools: [],
	explicitTools: explicitActiveTools,
	customToolCalls: toolCallCount,
	resourceCounts,
	steerOutput,
	followupOutput,
	abortQueueCleared: abortSession?.session.pendingMessageCount === 0,
	resumeResult: reopenResult,
	sessionConstructMs: Math.round(emptyMs),
	rssBaselineBytes: startRss,
	rssAfterSessionsBytes: process.memoryUsage.rss(),
	checks: outcomes,
}));
await new Promise((resolve) => server.close(resolve));
if (outcomes.some((result) => !result.ok)) process.exitCode = 1;
