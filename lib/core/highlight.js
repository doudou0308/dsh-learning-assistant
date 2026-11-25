"use strict";

/**
 * The annotation layer: marks the terms that have an entry in the sidebar
 * wherever they appear in the transcript.
 *
 * Why CSS Custom Highlight and not wrapped text
 * ---------------------------------------------
 * Marking by wrapping words in `<span>`s writes into the host's message tree.
 * React owns that tree: the next render (and a streaming reply re-renders
 * constantly) discards the wrappers. The Custom Highlight API paints `Range`
 * objects through the style layer instead, so the DOM the renderer owns is
 * never touched and nothing is left behind on unload.
 *
 * This layer is purely visual: no tooltip, no popover, no element of its own in
 * the transcript. A click on a marked word may switch to the sidebar entry, and
 * that is the only interaction it carries.
 *
 * Everything degrades to a no-op without the API: `start()` returns, and the
 * panel keeps working.
 */

const { termPattern, waitForScrollSettle } = require("./guide.js");

/** Resolve after `ms` milliseconds. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The highlight registry key. One page-level layer, one name. */
const HIGHLIGHT_NAME = "learning-assistant";

/** The transient layer used to pulse one term when its card is double-clicked. */
const FLASH_NAME = "learning-assistant-flash";

/** Cap on painted ranges; a pathological transcript must not stall the frame. */
const MAX_RANGES = 800;

/** Debounce for re-highlighting after a DOM mutation. */
const REFRESH_DEBOUNCE_MS = 180;

/** Tags whose text is not prose and must not be marked. */
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "CODE", "PRE", "KBD", "SAMP", "BUTTON"]);

/** The stylesheet the highlight rule lives in; `::highlight()` only exists in CSS. */
const STYLE_TEXT = `
::highlight(${HIGHLIGHT_NAME}) {
  background-color: rgba(88, 166, 255, 0.16);
  text-decoration: underline dotted rgba(88, 166, 255, 0.75);
  text-underline-offset: 2px;
}
::highlight(${FLASH_NAME}) {
  background-color: rgba(255, 196, 0, 0.55);
  text-decoration: underline solid rgba(255, 150, 0, 0.95);
  text-underline-offset: 2px;
}
`;

/**
 * Build one alternation matcher for every known term.
 *
 * Latin-edged terms get ASCII lookarounds so `RL` does not match inside `URL`;
 * CJK terms match directly. Longest first, so `KV Cache` wins over `KV`.
 *
 * @param terms - term records.
 * @returns a global RegExp, or null when there is nothing to match.
 */
function buildMatcher(terms) {
	const names = (Array.isArray(terms) ? terms : [])
		.map((item) => (item && typeof item.term === "string" ? item.term.trim() : ""))
		.filter((name) => name.length > 1)
		.sort((a, b) => b.length - a.length);
	if (names.length === 0) return null;
	try {
		return new RegExp(names.map(termPattern).join("|"), "gi");
	} catch {
		return null;
	}
}

/**
 * Create the highlighter.
 *
 * @param options - `{ document, getTerms, onOpen, logger }`.
 *   `getTerms` returns the current term records; `onOpen(term)` runs when a
 *   marked word is clicked.
 * @returns `{ start, stop, refresh, buildMatcher }`.
 */
function createHighlighter(options) {
	const doc = options?.document ?? null;
	const getTerms = options?.getTerms ?? (() => []);
	const onOpen = options?.onOpen ?? (() => {});
	const log = options?.logger ?? console;

	/** Per-text-node hit records: `[{ start, end, term }]`. */
	const perNode = new Map();
	/** Per-term occurrences, for `flash()`: `Map<lowercased term, [{ node, start, end }]>`. */
	const perTerm = new Map();

	let root = null;
	let observer = null;
	let refreshTimer = null;
	let started = false;
	let styleEl = null;
	let onClick = null;
	/** Bumped per flash so a newer request cancels the older one. */
	let flashRun = 0;

	/**
	 * Whether the platform can paint highlights at all.
	 * @returns true when `CSS.highlights` and `Highlight` exist.
	 */
	function supported() {
		const css = typeof globalThis === "object" ? globalThis.CSS : undefined;
		return doc !== null && typeof css === "object" && css !== null && css.highlights !== undefined && typeof globalThis.Highlight === "function";
	}

	/** Inject the highlight stylesheet once. */
	function ensureStyle() {
		if (styleEl !== null || doc === null) return;
		styleEl = doc.createElement("style");
		styleEl.setAttribute("data-learning-assistant", "");
		styleEl.textContent = STYLE_TEXT;
		(doc.head ?? doc.documentElement).appendChild(styleEl);
	}

	/**
	 * Whether an element's text should be marked.
	 * @param element - the text node's parent.
	 * @returns true for prose inside the current conversation.
	 */
	function isProse(element) {
		if (element === null || element === undefined) return false;
		if (SKIP_TAGS.has(element.tagName)) return false;
		if (typeof element.closest !== "function") return false;
		// Only the transcript, never the sidebar, our panel, or our own UI.
		if (element.closest("[data-conversation-scroll]") === null) return false;
		if (element.closest("[data-learning-assistant-ui]") !== null) return false;
		return true;
	}

	/** Clear every painted range and the hit records. */
	function clear() {
		perNode.clear();
		perTerm.clear();
		if (supported()) {
			try {
				globalThis.CSS.highlights.delete(HIGHLIGHT_NAME);
			} catch (error) {
				void error;
			}
		}
	}

	/**
	 * Re-scan the transcript and repaint.
	 *
	 * The scroll container is resolved on every pass: switching sessions replaces
	 * it, so holding a node reference would silently stop working.
	 */
	function refresh() {
		if (doc === null) return;
		clear();
		if (!supported()) return;

		const root = doc.querySelector("[data-conversation-scroll]");
		if (root === null) return;

		const terms = Array.isArray(getTerms()) ? getTerms() : [];
		const matcher = buildMatcher(terms);
		if (matcher === null) return;

		const ranges = [];
		let node = null;
		try {
			const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, {
				acceptNode(candidate) {
					if (candidate.nodeValue === null || candidate.nodeValue.trim() === "") {
						return 2; /* FILTER_REJECT */
					}
					return isProse(candidate.parentElement) ? 1 /* FILTER_ACCEPT */ : 2;
				}
			});
			while ((node = walker.nextNode()) !== null) {
				const text = node.nodeValue;
				matcher.lastIndex = 0;
				let match;
				while ((match = matcher.exec(text)) !== null) {
					if (match[0].length === 0) {
						matcher.lastIndex += 1;
						continue;
					}
					const range = doc.createRange();
					range.setStart(node, match.index);
					range.setEnd(node, match.index + match[0].length);
					ranges.push(range);
					const record = { start: match.index, end: match.index + match[0].length, term: match[0] };
					const hits = perNode.get(node);
					if (hits === undefined) perNode.set(node, [record]);
					else hits.push(record);
					const key = match[0].toLowerCase();
					const occurrences = perTerm.get(key);
					const occurrence = { node, start: match.index, end: match.index + match[0].length };
					if (occurrences === undefined) perTerm.set(key, [occurrence]);
					else occurrences.push(occurrence);
					if (ranges.length >= MAX_RANGES) break;
				}
				if (ranges.length >= MAX_RANGES) break;
			}
		} catch (error) {
			log.warn("[learning-assistant] highlight scan failed:", error);
			return;
		}

		if (ranges.length === 0) return;
		try {
			globalThis.CSS.highlights.set(HIGHLIGHT_NAME, new globalThis.Highlight(...ranges));
		} catch (error) {
			log.warn("[learning-assistant] highlight paint failed:", error);
		}
	}

	/** Coalesce refresh calls. */
	function scheduleRefresh() {
		if (refreshTimer !== null) return;
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			refresh();
		}, REFRESH_DEBOUNCE_MS);
	}

	/**
	 * The term under a viewport point.
	 * @param x - client X.
	 * @param y - client Y.
	 * @returns the recorded term text, or null.
	 */
	function termAtPoint(x, y) {
		if (doc === null) return null;
		let range = null;
		try {
			if (typeof doc.caretRangeFromPoint === "function") {
				range = doc.caretRangeFromPoint(x, y);
			} else if (typeof doc.caretPositionFromPoint === "function") {
				const position = doc.caretPositionFromPoint(x, y);
				if (position !== null) {
					range = doc.createRange();
					range.setStart(position.offsetNode, position.offset);
					range.collapse(true);
				}
			}
		} catch (error) {
			void error;
			return null;
		}
		if (range === null) return null;
		const start = range.startContainer;
		if (start === null || start.nodeType !== 3) return null;
		const hits = perNode.get(start);
		if (hits === undefined) return null;
		const offset = range.startOffset;
		for (const hit of hits) {
			if (offset >= hit.start && offset < hit.end) return hit.term;
		}
		return null;
	}

	/**
	 * Pulse every occurrence of one term in the transcript and, when it is
	 * off-screen, bring the first one into view FIRST and only pulse once the
	 * scroll has settled. Pulsing during a long smooth scroll meant the three
	 * flashes were spent before the word arrived.
	 * @param term - the term text.
	 * @returns true when at least one occurrence was found.
	 */
	async function flash(term) {
		if (doc === null || !supported()) return false;
		const occurrences = perTerm.get(String(term).toLowerCase());
		if (occurrences === undefined || occurrences.length === 0) return false;

		const run = (flashRun += 1);
		const ranges = [];
		for (const item of occurrences) {
			try {
				const range = doc.createRange();
				range.setStart(item.node, item.start);
				range.setEnd(item.node, item.end);
				ranges.push(range);
			} catch (error) {
				void error;
			}
		}
		if (ranges.length === 0) return false;

		// A newer flash supersedes this one; start from a clean layer.
		try {
			globalThis.CSS.highlights.delete(FLASH_NAME);
		} catch (error) {
			void error;
		}

		// Scroll first, then wait: the pulse must not run while the word is still
		// travelling into view.
		const scroller = doc.querySelector("[data-conversation-scroll]");
		if (scroller !== null) {
			const rect = ranges[0].getBoundingClientRect();
			const box = scroller.getBoundingClientRect();
			const offscreen = rect.top < box.top + 8 || rect.bottom > box.bottom - 8;
			if (offscreen) {
				const delta = rect.top - box.top - scroller.clientHeight / 2 + rect.height / 2;
				const target = Math.max(0, Math.min(scroller.scrollTop + delta, scroller.scrollHeight - scroller.clientHeight));
				try {
					scroller.scrollTo({ top: target, behavior: "smooth" });
				} catch (error) {
					scroller.scrollTop = target;
					void error;
				}
				await waitForScrollSettle(scroller, { timeoutMs: 1600 });
				if (run !== flashRun) return true;
				// The smooth scroll may have stopped short; finish the centring.
				const after = ranges[0].getBoundingClientRect();
				const afterBox = scroller.getBoundingClientRect();
				const drift = after.top - afterBox.top - (scroller.clientHeight - after.height) / 2;
				if (Math.abs(drift) > 16) scroller.scrollTop += drift;
			}
		}

		// Three pulses of 260 ms on / 180 ms off.
		for (let index = 0; index < 3; index += 1) {
			if (run !== flashRun) return true;
			try {
				globalThis.CSS.highlights.set(FLASH_NAME, new globalThis.Highlight(...ranges));
			} catch (error) {
				void error;
				return true;
			}
			await sleep(260);
			if (run !== flashRun) return true;
			try {
				globalThis.CSS.highlights.delete(FLASH_NAME);
			} catch (error) {
				void error;
			}
			if (index < 2) await sleep(180);
		}
		return true;
	}

	/** Bind the click handler that opens the sidebar entry. */
	function bind() {
		onClick = (event) => {
			// A real text selection means the user is selecting, not navigating.
			const selection = typeof globalThis.getSelection === "function" ? globalThis.getSelection() : null;
			if (selection !== null && typeof selection.toString === "function" && selection.toString().length > 0) return;
			const term = termAtPoint(event.clientX, event.clientY);
			if (term !== null) onOpen(term);
		};
		doc.addEventListener("click", onClick, true);
	}

	/** Resolve the transcript root, retrying while the chat mounts. */
	function resolveRoot() {
		if (doc === null) return null;
		return doc.querySelector("[data-conversation-scroll]") ?? null;
	}

	/**
	 * Start highlighting. Safe to call twice.
	 *
	 * The observer watches `document.body`, not the scroll container: switching
	 * sessions replaces that container, and an observer bound to the old node
	 * would go quiet. `refresh()` re-resolves the container on every pass.
	 */
	function start() {
		if (started || doc === null) return;
		started = true;
		ensureStyle();
		bind();

		const host = doc.body ?? doc.documentElement;
		if (host !== null && host !== undefined) {
			observer = new doc.defaultView.MutationObserver(scheduleRefresh);
			observer.observe(host, { childList: true, subtree: true, characterData: true });
		}
		root = resolveRoot();
		refresh();
	}

	/** Stop highlighting and remove every trace. */
	function stop() {
		started = false;
		if (observer !== null) {
			observer.disconnect();
			observer = null;
		}
		if (refreshTimer !== null) {
			clearTimeout(refreshTimer);
			refreshTimer = null;
		}
		if (doc !== null && onClick !== null) doc.removeEventListener("click", onClick, true);
		onClick = null;
		clear();
		try {
			globalThis.CSS?.highlights?.delete(FLASH_NAME);
		} catch (error) {
			void error;
		}
		if (styleEl !== null) {
			styleEl.remove();
			styleEl = null;
		}
		root = null;
	}

	return { start, stop, refresh, flash, buildMatcher };
}

module.exports = { createHighlighter, buildMatcher, HIGHLIGHT_NAME, FLASH_NAME };
