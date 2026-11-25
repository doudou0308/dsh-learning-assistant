"use strict";

/**
 * Shared, environment-free core of the term guide.
 *
 * Both halves load this file: the host through `createRequire` (it owns the
 * memory file) and the browser bundle through its inlined module registry (it
 * renders what the host stored). Keeping normalization and merge rules here
 * means a term the host accepted is a term the panel can render, and a rule
 * proved in a Node test holds in the page.
 *
 * Nothing here touches `node:`, the DOM, or globals.
 */

/** User levels, ordered from least to most specialized. */
const LEVELS = ["beginner", "intermediate", "expert"];

/** Human labels for the panel and the prompt. */
const LEVEL_LABELS = {
	beginner: "初学者（非技术背景，术语几乎都需要解释）",
	intermediate: "中级（懂编程与通用概念，但不是当前领域的专家）",
	expert: "专家（需要解释的只有跨领域的生僻词）"
};

/** Short chips for the UI. */
const LEVEL_CHIPS = { beginner: "初学者", intermediate: "中级", expert: "专家" };

/** Strictness is one integer 0–100; 50 is the neutral default. */
const STRICTNESS_MIN = 0;
const STRICTNESS_MAX = 100;

/** Most terms a single explain_terms call may carry (matches the prompt and schema). */
const MAX_TERMS = 4;

/** Longest explanation the panel will render as a single sentence. */
const MAX_EXPLANATION_CHARS = 120;

/** Longest known-term summary fed to the prompt. */
const MEMORY_SUMMARY_MAX = 24;

/** Cap on remembered terms; the oldest are dropped first. */
const MAX_REMEMBERED_TERMS = 200;

/**
 * Clamp an unknown number into [min, max].
 * @param value - candidate.
 * @param min - lower bound.
 * @param max - upper bound.
 * @param fallback - used when the candidate is not finite.
 * @returns a finite integer.
 */
function clampInt(value, min, max, fallback) {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
	return Math.min(max, Math.max(min, n));
}

/**
 * Normalize a level, falling back to `intermediate`.
 * @param level - candidate string.
 * @returns one of {@link LEVELS}.
 */
function normalizeLevel(level) {
	return LEVELS.includes(level) ? level : "intermediate";
}

/**
 * Trim one string, collapsing whitespace and enforcing a length ceiling.
 * @param value - candidate.
 * @param max - character ceiling.
 * @returns the cleaned text, or "" when the input is not a usable string.
 */
function cleanText(value, max) {
	if (typeof value !== "string") return "";
	const text = value.replace(/\s+/g, " ").trim();
	if (text === "") return "";
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Normalize one tree node recursively.
 * @param node - candidate node.
 * @param depth - current depth, guarding runaway nesting.
 * @returns a normalized node, or null when unusable.
 */
function normalizeNode(node, depth) {
	if (node === null || typeof node !== "object" || depth > 4) return null;
	const label = cleanText(node.label, 60);
	if (label === "") return null;
	const out = { label };
	const note = cleanText(node.note, 140);
	if (note !== "") out.note = note;
	if (Array.isArray(node.children)) {
		const children = node.children.map((child) => normalizeNode(child, depth + 1)).filter((child) => child !== null);
		if (children.length > 0) out.children = children;
	}
	return out;
}

/**
 * Normalize the exploration tree: a short, shallow forest.
 * @param tree - candidate array.
 * @returns at most 8 root nodes.
 */
function normalizeTree(tree) {
	if (!Array.isArray(tree)) return [];
	return tree.map((node) => normalizeNode(node, 0)).filter((node) => node !== null).slice(0, 8);
}

/**
 * Search templates. Every term gets at least a Wikipedia and a web-search link,
 * so a node the model left bare is still explorable.
 */
const SEARCH_TEMPLATES = [
	{ label: "维基百科", build: (term) => `https://zh.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(term)}` },
	{ label: "Google", build: (term) => `https://www.google.com/search?q=${encodeURIComponent(`${term} 是什么`)}` },
	{ label: "Bing", build: (term) => `https://www.bing.com/search?q=${encodeURIComponent(`${term} 是什么`)}` }
];

/**
 * Build the link list for a term: model-provided links first, then templates.
 * @param term - the term text.
 * @param links - candidate links from the model.
 * @returns a de-duplicated link list.
 */
function buildLinks(term, links) {
	const out = [];
	const seen = new Set();
	const push = (label, url) => {
		if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
		if (seen.has(url)) return;
		seen.add(url);
		out.push({ label, url });
	};
	if (Array.isArray(links)) {
		for (const link of links.slice(0, 6)) {
			if (link === null || typeof link !== "object") continue;
			push(cleanText(link.label, 30) || "参考", link.url);
		}
	}
	for (const template of SEARCH_TEMPLATES) push(template.label, template.build(term));
	return out.slice(0, 6);
}

/**
 * Normalize one term as the model reported it.
 * @param raw - candidate term object.
 * @returns a term record, or null when it has no usable name.
 */
function normalizeTerm(raw) {
	if (raw === null || typeof raw !== "object") return null;
	const term = cleanText(raw.term, 60);
	if (term === "") return null;
	const record = {
		term,
		explanation: cleanText(raw.explanation, MAX_EXPLANATION_CHARS),
		tree: normalizeTree(raw.tree),
		links: buildLinks(term, raw.links)
	};
	const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : null;
	if (confidence !== null) record.confidence = confidence;
	const category = cleanText(raw.category, 24);
	if (category !== "") record.category = category;
	// Provenance: what this term derives FROM, and what sits beside it. These
	// drive the knowledge tree; a term with neither is a root.
	const parent = cleanText(raw.parent, 60);
	if (parent !== "" && parent !== term) record.parent = parent;
	if (Array.isArray(raw.related)) {
		const related = [];
		for (const item of raw.related.slice(0, 8)) {
			const name = cleanText(item, 60);
			if (name !== "" && name !== term && !related.includes(name)) related.push(name);
		}
		if (related.length > 0) record.related = related;
	}
	return record;
}

/**
 * Normalize a whole explain_terms call.
 * @param input - candidate object with a `terms` array.
 * @returns an array of at most {@link MAX_TERMS} records.
 */
function normalizeTerms(input) {
	if (input === null || typeof input !== "object" || !Array.isArray(input.terms)) return [];
	return input.terms
		.map((raw) => normalizeTerm(raw))
		.filter((record) => record !== null)
		.slice(0, MAX_TERMS);
}

/**
 * Create empty memory.
 * @param level - initial level.
 * @param strictness - initial strictness.
 * @returns a memory object.
 */
function emptyMemory(level, strictness) {
	return {
		version: 1,
		level: normalizeLevel(level),
		strictness: clampInt(strictness, STRICTNESS_MIN, STRICTNESS_MAX, 50),
		updatedAt: new Date(0).toISOString(),
		terms: [],
		signals: []
	};
}

/**
 * Merge reported terms into memory.
 *
 * A repeated term keeps its latest explanation and tree (the model rewrote it
 * for a new context) while its `count` accumulates, which is the evidence the
 * prompt uses to decide that a term is now familiar.
 *
 * @param memory - current memory (may be undefined).
 * @param records - normalized terms.
 * @param options - `{ now, level, strictnessAdjust, reason }`.
 * @returns a NEW memory object; the input is not mutated.
 */
function mergeTerms(memory, records, options) {
	const base = memory !== null && typeof memory === "object" ? memory : emptyMemory();
	const now = options?.now instanceof Date ? options.now : new Date();
	const stamp = now.toISOString();

	const byName = new Map();
	const order = [];
	for (const existing of Array.isArray(base.terms) ? base.terms : []) {
		if (!existing || typeof existing.term !== "string") continue;
		if (!byName.has(existing.term)) order.push(existing.term);
		byName.set(existing.term, existing);
	}

	for (const record of records) {
		const previous = byName.get(record.term);
		if (previous === undefined) {
			order.push(record.term);
			byName.set(record.term, {
				...record,
				firstSeen: stamp,
				lastSeen: stamp,
				count: 1
			});
			continue;
		}
		byName.set(record.term, {
			...previous,
			explanation: record.explanation || previous.explanation,
			tree: record.tree.length > 0 ? record.tree : previous.tree,
			links: record.links.length > 0 ? record.links : previous.links,
			confidence: record.confidence ?? previous.confidence,
			category: record.category ?? previous.category,
			parent: record.parent ?? previous.parent,
			related: record.related ?? previous.related,
			lastSeen: stamp,
			count: (Number.isFinite(previous.count) ? previous.count : 1) + 1
		});
	}

	// Newest first, capped.
	const terms = order
		.map((name) => byName.get(name))
		.sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
		.slice(0, MAX_REMEMBERED_TERMS);

	const adjust = clampInt(options?.strictnessAdjust, -20, 20, 0);
	const strictness = clampInt((base.strictness ?? 50) + adjust, STRICTNESS_MIN, STRICTNESS_MAX, 50);

	const signals = Array.isArray(base.signals) ? base.signals.slice(-40) : [];
	const reason = cleanText(options?.reason, 120);
	if (reason !== "") signals.push({ at: stamp, reason, terms: records.map((r) => r.term) });

	return {
		version: 1,
		level: normalizeLevel(options?.level ?? base.level),
		strictness,
		updatedAt: stamp,
		terms,
		signals
	};
}

/**
 * Render the memory as a short prompt-facing list.
 *
 * Only names and repeat counts are shown: the model needs to know what the
 * user has already met, not re-read old explanations.
 *
 * @param memory - memory object.
 * @returns one line, or "" when nothing is remembered.
 */
function summarizeMemory(memory) {
	const terms = Array.isArray(memory?.terms) ? memory.terms : [];
	if (terms.length === 0) return "";
	return terms
		.slice(0, MEMORY_SUMMARY_MAX)
		.map((item) => (item.count > 1 ? `${item.term}×${item.count}` : item.term))
		.join("、");
}


/**
 * Resolve once a scroll container stops moving.
 *
 * Smooth scrolling has no reliable duration, so a fixed `setTimeout` either
 * pulses too early (the word is still off-screen) or too late. `scrollend` is
 * used when available, with a quiet-period poll as the fallback and a hard cap
 * so a stuck scroll can never hang the caller.
 *
 * @param element - the scrolling element.
 * @param options - `{ timeoutMs, quietMs }`.
 * @returns a promise settled when the scroll stops or the cap is reached.
 */
function waitForScrollSettle(element, options) {
	const timeoutMs = typeof options?.timeoutMs === "number" ? options.timeoutMs : 1400;
	const quietMs = typeof options?.quietMs === "number" ? options.quietMs : 90;
	return new Promise((resolve) => {
		if (element === null || element === undefined) {
			resolve();
			return;
		}
		let settled = false;
		let quiet = 0;
		let last = element.scrollTop;
		let poll = null;
		let cap = null;
		const finish = () => {
			if (settled) return;
			settled = true;
			try {
				element.removeEventListener("scrollend", finish);
			} catch (error) {
				void error;
			}
			if (poll !== null) clearInterval(poll);
			if (cap !== null) clearTimeout(cap);
			resolve();
		};
		try {
			element.addEventListener("scrollend", finish, { once: true });
		} catch (error) {
			void error;
		}
		poll = setInterval(() => {
			const now = element.scrollTop;
			quiet = Math.abs(now - last) < 1 ? quiet + 1 : 0;
			last = now;
			if (quiet * 60 >= quietMs) finish();
		}, 60);
		cap = setTimeout(finish, timeoutMs);
	});
}


/**
 * Build the knowledge forest the panel renders.
 *
 * Each term names the term it derives from (`parent`). A term whose parent is
 * absent from the set is a ROOT with `orphanParent` recorded, so the panel can
 * say "隶属 X（未收录）" instead of silently hiding the relationship. Cycles are
 * cut by tracking the path, and a term is attached at most once.
 *
 * @param terms - term records.
 * @returns an array of `{ term, children, orphanParent }` roots.
 */
function buildKnowledgeTree(terms) {
	const list = (Array.isArray(terms) ? terms : []).filter((item) => item && typeof item.term === "string" && item.term !== "");
	const byName = new Map();
	for (const item of list) if (!byName.has(item.term)) byName.set(item.term, item);

	const children = new Map();
	const roots = [];
	for (const item of list) {
		const parent = typeof item.parent === "string" ? item.parent : "";
		if (parent !== "" && parent !== item.term && byName.has(parent)) {
			const bucket = children.get(parent);
			if (bucket === undefined) children.set(parent, [item]);
			else bucket.push(item);
		} else {
			roots.push({ term: item, orphanParent: parent !== "" && parent !== item.term ? parent : null });
		}
	}

	const seen = new Set();
	/** @param entry - `{ term, orphanParent }` */
	const build = (entry, depth, path) => {
		const node = { term: entry.term, orphanParent: entry.orphanParent ?? null, children: [] };
		if (depth > 8 || path.has(entry.term.term)) return node;
		seen.add(entry.term.term);
		path.add(entry.term.term);
		for (const child of children.get(entry.term.term) ?? []) {
			if (path.has(child.term)) continue;
			node.children.push(build({ term: child, orphanParent: null }, depth + 1, path));
		}
		path.delete(entry.term.term);
		return node;
	};

	const forest = roots.map((entry) => build(entry, 0, new Set()));
	// A term reachable only through a cycle never became a root; surface it so
	// nothing disappears from the view.
	for (const item of list) {
		if (seen.has(item.term)) continue;
		forest.push({ term: item, orphanParent: typeof item.parent === "string" ? item.parent : null, children: [] });
	}
	return forest;
}


/**
 * Acronyms that are common knowledge and must never be "supplemented".
 *
 * Only entries that a Chinese-speaking developer already reads without effort
 * belong here; a missing entry costs one unwanted explanation, an extra entry
 * costs a click.
 */
const ACRONYM_STOPWORDS = new Set([
	"AI", "API", "CPU", "GPU", "RAM", "ROM", "OS", "UI", "UX", "SDK", "CLI", "ID", "OK", "PC", "MAC",
	"URL", "URI", "JSON", "YAML", "XML", "HTML", "CSS", "HTTP", "HTTPS", "TCP", "UDP", "IP", "DNS", "SSH", "SSL", "TLS",
	"SQL", "REST", "CSV", "PDF", "JPG", "PNG", "GIF", "MP4", "DOM", "NPM", "GB", "MB", "KB", "TB", "MS", "NS",
	"PR", "CI", "CD", "FAQ", "CEO", "CTO", "CFO", "ROI", "KPI", "MVP", "SLA", "SLO", "UUID", "JWT", "CVE", "MIT", "BSD",
	"LLM", "GPT", "HTML5", "CSS3", "VUE", "NODE"
]);

/**
 * Find acronym-shaped terms in one answer that the memory does not cover yet.
 *
 * Deterministic on purpose: the supplement path must not depend on the model
 * remembering to call a tool. Ordering favours the acronym that appears most
 * often, then the earliest one.
 *
 * @param text - the assistant answer.
 * @param known - term names already recorded (any casing).
 * @param limit - how many candidates to return.
 * @returns candidate acronyms, most relevant first.
 */
function extractCandidates(text, known, limit) {
	const source = typeof text === "string" ? text : "";
	const knownLower = new Set((Array.isArray(known) ? known : []).map((name) => String(name).toLowerCase()));
	const seen = new Map();
	// At least three characters: two-letter runs are usually fragments of a
	// hyphenated name (`RT-2` → `RT`), not terms a reader needs explained.
	const pattern = /(?<![A-Za-z0-9_])[A-Z][A-Z0-9]{2,5}(?![A-Za-z0-9_])/g;
	let match;
	while ((match = pattern.exec(source)) !== null) {
		const word = match[0];
		if (ACRONYM_STOPWORDS.has(word)) continue;
		if (/^[0-9]+$/.test(word)) continue;
		if (knownLower.has(word.toLowerCase())) continue;
		const entry = seen.get(word);
		if (entry === undefined) seen.set(word, { word, count: 1, first: match.index });
		else entry.count += 1;
	}
	const max = typeof limit === "number" && limit > 0 ? limit : 2;
	return [...seen.values()]
		.sort((a, b) => (b.count === a.count ? a.first - b.first : b.count - a.count))
		.slice(0, max)
		.map((item) => item.word);
}


/**
 * Match a term literally and keep ASCII word characters at its edges from
 * joining a larger identifier. This still matches "使用API接口".
 * @param name - a nonempty term name.
 * @returns a regular expression pattern shared by the sidebar and highlighter.
 */
function termPattern(name) {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const left = /^[A-Za-z0-9_]/.test(name) ? "(?<![A-Za-z0-9_])" : "";
	const right = /[A-Za-z0-9_]$/.test(name) ? "(?![A-Za-z0-9_])" : "";
	return left + escaped + right;
}

/**
 * Keep only the terms that actually appear in one conversation's text.
 *
 * The memory file is global by design (a term learned in one thread should not
 * be re-explained in the next), but the panel must describe only the thread on
 * screen. Matching is case-insensitive and uses the highlighter's term boundaries.
 *
 * @param terms - term records from memory.
 * @param text - the conversation transcript (may be empty).
 * @returns the subset present in `text`; an empty array when `text` is empty.
 */
function filterTermsForText(terms, text) {
	const list = Array.isArray(terms) ? terms : [];
	if (typeof text !== "string" || text.trim() === "") return [];
	return list.filter((item) => {
		const name = typeof item?.term === "string" ? item.term.trim() : "";
		return name !== "" && new RegExp(termPattern(name), "i").test(text);
	});
}

/** Exported for the host half and the browser bundle alike. */
module.exports = {
	LEVELS,
	LEVEL_LABELS,
	LEVEL_CHIPS,
	STRICTNESS_MIN,
	STRICTNESS_MAX,
	MAX_TERMS,
	MAX_REMEMBERED_TERMS,
	SEARCH_TEMPLATES,
	clampInt,
	normalizeLevel,
	cleanText,
	normalizeTree,
	buildLinks,
	normalizeTerms,
	emptyMemory,
	mergeTerms,
	summarizeMemory,
	waitForScrollSettle,
	buildKnowledgeTree,
	ACRONYM_STOPWORDS,
	extractCandidates,
	termPattern,
	filterTermsForText
};
