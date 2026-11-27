// Functional self-check for the learning-assistant plugin, both halves.
import vm from "node:vm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const ok = (label, cond, extra = "") => {
	console.log(`${cond ? "✓" : "✗"} ${label}${extra ? " — " + extra : ""}`);
	if (!cond) failures += 1;
};

// ---------- 1. Browser bundle ----------
console.log("\n== 1) 浏览器 bundle ==");
const code = fs.readFileSync(path.join(pluginDir, "lib/client.js"), "utf8");
const captured = {};
const sandbox = {
	window: { __ModuleLoader__: { load: (descriptor) => (captured.descriptor = descriptor) } },
	console,
	// The bundle schedules a poll at activation; keep the timers from holding the
	// process open, and leave `fetch`/`document` absent to exercise the guards.
	setInterval: (fn, ms) => {
		const timer = setInterval(fn, ms);
		timer.unref?.();
		return timer;
	},
	clearInterval,
	setTimeout: (fn, ms) => {
		const timer = setTimeout(fn, ms);
		timer.unref?.();
		return timer;
	},
	clearTimeout
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
ok("bundle 调用了 __ModuleLoader__.load", captured.descriptor !== undefined);
ok("bundle id 正确", captured.descriptor?.id === "dsh-learning-assistant", captured.descriptor?.id);

const React = {
	// Render function components the way React does, so the assertions below
	// exercise the component bodies rather than just serializing their props.
	createElement: (type, props, ...children) => {
		if (typeof type === "function") return type({ ...(props ?? {}), children });
		return { type, props: props ?? {}, children };
	},
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
	useEffect: () => {},
	useLayoutEffect: () => {}
};
const registered = [];
const tabTypes = [];
const openedTabs = [];
const disposersClient = [];
const ctxClient = {
	slots: {
		inject: (_name, factory) => factory(),
		register: (definition, component) => {
			registered.push({ definition, component });
			return () => {};
		}
	},
	sidebarRightTabs: {
		register: (definition) => {
			tabTypes.push(definition);
			return () => {};
		}
	},
	sidebarRight: {
		openTab: (kind) => {
			openedTabs.push(kind);
			return "tab-1";
		}
	},
	effect: (fn) => {
		disposersClient.push(fn());
		return () => {};
	}
};
const mod = captured.descriptor.factory((spec) => {
	if (spec === "react") return React;
	throw new Error(`unexpected require: ${spec}`);
});
ok("exports.apply 存在", typeof mod.apply === "function");
ok("exports.inject 正确", Array.isArray(mod.inject) && mod.inject.includes("slots"), JSON.stringify(mod.inject));
mod.apply(ctxClient);
const names = registered.map((r) => `${r.definition.name}:${r.definition.id ?? r.definition.key}`);
ok("注册了右侧栏标签类型", tabTypes.length === 1 && tabTypes[0].kind === "learning-assistant", JSON.stringify(tabTypes));
ok("标签有标题", typeof tabTypes[0]?.title === "function" && tabTypes[0].title() === "术语");
ok("注册了标签主体", names.includes("sidebar.right.pane.tab:dsh-learning-assistant/tab"), names.join(", "));
ok("不再占用中间主区域（不会盖住对话）", !names.some((n) => n.startsWith("main:") || n.startsWith("sidebar.panellist:")));
ok("面板组件是函数", typeof registered.find((r) => r.definition.name === "sidebar.right.pane.tab")?.component === "function");
ok("注册了常驻入口（对话头部按钮）", names.includes("conversation.session.header.actions:learning-assistant-entry"), names.join(", "));

// Render the panel with seeded state to prove the tree renders.
const panel = registered.find((r) => r.definition.name === "sidebar.right.pane.tab").component;
const panelProps = { store: mod.panelContext.store, api: mod.panelContext.api };
const seeded = {
	terms: [
		{
			term: "KV Cache",
			explanation: "把算过的注意力键值存起来复用，避免每步重算。",
			category: "机器学习",
			count: 2,
			tree: [
				{ label: "Transformer 自注意力", note: "每个 token 都要和前面所有 token 算相关性。", children: [{ label: "Q/K/V 三个投影" }] },
				{ label: "推理时逐步生成", note: "每生成一个 token 都要重算前面的注意力。" },
				{ label: "KV Cache", note: "把 K、V 缓存下来，只算新增部分。" }
			],
			links: [
				{ label: "维基百科", url: "https://zh.wikipedia.org/wiki/Special:Search?search=KV%20Cache" },
				{ label: "Google", url: "https://www.google.com/search?q=KV+Cache" }
			]
		}
	],
	level: "intermediate",
	strictness: 55,
	error: null
};
let panelTree;
try {
	// Seed the store before render, the way a poll would.
	const store = panelProps.store;
	store.set(seeded);
	panelTree = panel({ ...panelProps, store });
	ok("面板渲染无异常", panelTree !== undefined && panelTree !== null);
	const text = JSON.stringify(panelTree);
	ok("渲染包含词条名", text.includes("KV Cache"));
	ok("渲染包含解释", text.includes("注意力键值"));
	ok("渲染包含树节点", text.includes("Transformer 自注意力"));
	ok("外链带 noopener", text.includes("noopener noreferrer"));
} catch (error) {
	ok("面板渲染无异常", false, error.message);
}

// Empty state
try {
	const store = panelProps.store;
	store.set({ terms: [], level: "intermediate", strictness: 50, error: null });
	const emptyTree = panel({ ...panelProps, store });
	const emptyText = JSON.stringify(emptyTree);
	ok("空状态渲染", /还没有术语|还没有词条/.test(emptyText), emptyText.slice(0, 80));
} catch (error) {
	ok("空状态渲染", false, error.message);
}

// ---------- 2. Host half ----------
console.log("\n== 2) Host 半 ==");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tg-home-"));
process.env.DSH_HOME = home;
const host = await import(path.join(pluginDir, "lib/index.js"));
ok("host name", host.name === "learning-assistant", host.name);
ok("host inject 含 tools/webServer", host.inject.includes("tools") && host.inject.includes("webServer"), JSON.stringify(host.inject));

let toolDef;
let routeRegistration;
let promptSection;
const disposers = [];
const eventHandlers = [];
const ctxHost = {
	on: (name, handler) => {
		eventHandlers.push({ name, handler });
		return () => {};
	},
	tools: { register: (def) => { toolDef = def; return () => {}; } },
	webServer: { register: (opts) => { routeRegistration = opts; return () => {}; } },
	effect: (fn) => { disposers.push(fn()); return () => {}; },
	inject: (_names, cb) => {
		cb({
			effect: (fn) => { disposers.push(fn()); return () => {}; },
			systemPrompt: { section: (section) => { promptSection = section; return () => {}; } }
		});
	}
};
host.apply(ctxHost, { level: "intermediate", strictness: 50 });
ok("注册了 explain_terms 工具", toolDef?.name === "explain_terms", toolDef?.name);
ok("注册了 /learning-assistant 路由", routeRegistration?.path === "/learning-assistant", routeRegistration?.path);
ok("注册了系统提示段", promptSection?.name === "learning-assistant");

const result = await toolDef.execute({
	terms: [
		{ term: "A2A 协议", explanation: "让不同厂商的 AI 代理互相通信的开放协议。", category: "智能体", confidence: 0.8, tree: [{ label: "单个 Agent" }, { label: "多 Agent 协作", children: [{ label: "A2A 协议" }] }] },
		{ term: "KV Cache", explanation: "缓存注意力的键值，避免重复计算。", category: "机器学习" }
	],
	reason: "回答涉及智能体协作与推理优化",
	strictnessAdjust: 10
});
ok("工具返回 saved=2", result.saved === 2, JSON.stringify(result));
ok("严格度自适应 +10", result.strictness === 60, String(result.strictness));
const memoryFile = path.join(home, "dsh-learning-assistant", "terms.json");
ok("记忆文件已写入", fs.existsSync(memoryFile));
const memory = JSON.parse(fs.readFileSync(memoryFile, "utf8"));
ok("记忆含 2 个词条", memory.terms.length === 2, String(memory.terms.length));
ok("自动补了搜索外链", memory.terms.every((t) => Array.isArray(t.links) && t.links.length >= 2));
ok("系统提示含记忆摘要", (promptSection.text() ?? "").includes("KV Cache"));
const promptText = promptSection.text();
ok("系统提示含水平说明", promptText.includes("用户水平"));
ok("系统提示含严格度", promptText.includes("60/100"));

// HTTP surface: GET /state through the registered handler
const { Readable } = await import("node:stream");
const fakeRes = {
	status: 0,
	headers: null,
	body: "",
	writeHead(status, headers) { this.status = status; this.headers = headers; },
	end(text) { this.body = text; }
};
await routeRegistration.handler(Object.assign(Readable.from([]), { method: "GET", url: "/learning-assistant/state" }), fakeRes);
ok("GET /state 200", fakeRes.status === 200, String(fakeRes.status));
const state = JSON.parse(fakeRes.body);
ok("state 含词条", state.terms.length === 2);
ok("state 含 level", state.level === "intermediate");

// POST /level
const res2 = { status: 0, body: "", writeHead(s) { this.status = s; }, end(t) { this.body = t; } };
await routeRegistration.handler(Object.assign(Readable.from([Buffer.from(JSON.stringify({ level: "expert" }))]), { method: "POST", url: "/learning-assistant/level" }), res2);
ok("POST /level 生效", JSON.parse(res2.body).level === "expert", res2.body);

// POST /forget
const res3 = { status: 0, body: "", writeHead(s) { this.status = s; }, end(t) { this.body = t; } };
await routeRegistration.handler(Object.assign(Readable.from([Buffer.from(JSON.stringify({ term: "KV Cache" }))]), { method: "POST", url: "/learning-assistant/forget" }), res3);
ok("POST /forget 生效", JSON.parse(res3.body).terms.length === 1, res3.body);

// ---------- 3. Inline highlighting ----------
console.log("\n== 3) 正文高亮 ==");
const { createRequire } = await import("node:module");
const req = createRequire(path.join(pluginDir, "lib/index.js"));
const highlight = req("./core/highlight.js");
const guide = req("./core/guide.js");

const matcher = highlight.buildMatcher([{ term: "KV Cache" }, { term: "RL" }, { term: "A2A 协议" }]);
ok("匹配器已构建", matcher instanceof RegExp);
matcher.lastIndex = 0;
ok("命中 KV Cache", matcher.test("KV Cache 让推理更快"), "KV Cache 让推理更快");
matcher.lastIndex = 0;
ok("命中中文混合词", matcher.test("聊聊 A2A 协议"), "聊聊 A2A 协议");
matcher.lastIndex = 0;
ok("不把 URL 里的 RL 当词", !matcher.test("访问 URL 即可"), "访问 URL 即可");
matcher.lastIndex = 0;
ok("独立的 RL 能命中", matcher.test("用 RL 训练"), "用 RL 训练");
matcher.lastIndex = 0;
ok("长词优先（KV Cache 不被 KV 抢）", (() => {
	const onlyKV = highlight.buildMatcher([{ term: "KV" }, { term: "KV Cache" }]);
	onlyKV.lastIndex = 0;
	const m = onlyKV.exec("KV Cache 与 KV 都出现");
	return m !== null && m[0] === "KV Cache";
})());

// No-DOM degrade: start/refresh/stop must be safe no-ops.
const noDom = highlight.createHighlighter({ document: null, getTerms: () => [], onOpen: () => {} });
let noDomThrew = "";
try {
	noDom.start();
	noDom.refresh();
	noDom.stop();
} catch (error) {
	noDomThrew = error.message;
}
ok("无 DOM 环境下安全降级", noDomThrew === "", noDomThrew);
const bundleText = fs.readFileSync(path.join(pluginDir, "lib/client.js"), "utf8");
ok("bundle 里内联了高亮模块", bundleText.includes("CSS.highlights"));
ok("只保留高亮：已移除悬停气泡", !bundleText.includes("点击查看完整学习路径") && !bundleText.includes("role\", \"tooltip"));
ok("高亮器暴露 flash()", typeof noDom.flash === "function");
ok("卡片带稳定锚点与双击", bundleText.includes("data-learning-assistant-card") && bundleText.includes("onDoubleClick"));
ok("有独立的闪烁高亮层", bundleText.includes("learning-assistant-flash"));
ok("高亮范围限定在对话区", bundleText.includes("data-conversation-scroll"));

// ---------- 4. Knowledge tree ----------
console.log("\n== 4) 知识树 ==");
const tree = guide.buildKnowledgeTree([
	{ term: "RTOS" },
	{ term: "抢占式优先级调度", parent: "RTOS" },
	{ term: "优先级反转", parent: "抢占式优先级调度" },
	{ term: "优先级继承", parent: "优先级反转" },
	{ term: "裸机程序" },
	{ term: "孤儿词", parent: "不存在的词" }
]);
const rootNames = tree.map((n) => n.term.term);
ok("根节点正确", rootNames.includes("RTOS") && rootNames.includes("裸机程序"), rootNames.join(","));
const rtos = tree.find((n) => n.term.term === "RTOS");
ok("一级延伸挂载", rtos?.children?.[0]?.term?.term === "抢占式优先级调度", JSON.stringify(rtos?.children?.map((c) => c.term.term)));
const level2 = rtos?.children?.[0]?.children?.[0];
ok("二级延伸挂载", level2?.term?.term === "优先级反转", JSON.stringify(level2?.term?.term));
const orphan = tree.find((n) => n.term.term === "孤儿词");
ok("缺失父级标记", orphan?.orphanParent === "不存在的词", String(orphan?.orphanParent));
const cyclic = guide.buildKnowledgeTree([{ term: "A", parent: "B" }, { term: "B", parent: "A" }]);
ok("环形关系不会死循环", cyclic.length === 2 && cyclic.every((n) => n.children.length === 0), JSON.stringify(cyclic.map((n) => n.term.term)));

// ---------- 5. Deterministic candidate extraction ----------
console.log("\n== 5) 自动补充的候选抽取 ==");
const answer = "VLA 是视觉-语言-动作模型。常见框架有 OpenVLA、π0、GR00T。VLA 与 RT-2 一脉相承，部署时常用 ROS2 和 CUDA，系统使用 RTOS 调度。";
const picked = guide.extractCandidates(answer, ["RTOS", "KV Cache"], 3);
ok("抽出未收录的缩写", picked.includes("VLA"), picked.join(","));
ok("已在记忆的词不重复", !picked.includes("RTOS"), picked.join(","));
const stopwordCandidates = guide.extractCandidates("API 与 CUDA", [], 5);
ok("停用表中的 API 被过滤", !stopwordCandidates.includes("API"), stopwordCandidates.join(","));
ok("未列入停用表的 CUDA 保留为候选", stopwordCandidates.includes("CUDA"), stopwordCandidates.join(","));
ok("数量受 limit 限制", guide.extractCandidates(answer, [], 2).length === 2);
ok("按出现次数排序（VLA 出现两次在前）", picked[0] === "VLA", picked.join(","));
ok("空文本返回空数组", guide.extractCandidates("", ["x"], 2).length === 0);

// ---------- 6. Per-conversation scope ----------
console.log("\n== 6) 展示按对话过滤 ==");
const allTerms = [{ term: "RTOS" }, { term: "VLA" }, { term: "KV Cache" }];
const scoped = guide.filterTermsForText(allTerms, "本对话在讲 VLA 与机器人");
ok("只保留对话里出现的词", scoped.length === 1 && scoped[0].term === "VLA", scoped.map((t) => t.term).join(","));
ok("大小写不敏感", guide.filterTermsForText([{ term: "vla" }], "VLA 是模型").length === 1);
ok("空对话返回空", guide.filterTermsForText(allTerms, "").length === 0);
ok("无关对话返回空", guide.filterTermsForText(allTerms, "今天天气不错").length === 0);

console.log(`\n${failures === 0 ? "全部通过 ✅" : `${failures} 项失败 ❌`}`);
process.exit(failures === 0 ? 0 : 1);
