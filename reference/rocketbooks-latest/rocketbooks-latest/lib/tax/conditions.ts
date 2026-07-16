// Safe three-valued evaluator for FormSpec trigger/dependency conditions.
//
// Conditions are free text the comprehender emits, e.g. "" (always), "has(w2.box1)",
// "business.net_profit > 0", "line_8 >= 1 && has(k1.ordinary_income)". They reference
// input refs and line ids, so they can only be partly known in Phase 1 (line values are
// often deferred). We therefore use THREE-valued logic: true | false | null(=unknown).
//
// No eval()/Function — a hand-written tokenizer + recursive-descent parser. On any parse
// error the caller treats the result as unknown and applies a conservative policy.

export type Tri = true | false | null; // null === unknown

export interface CondContext {
	/** Resolve a ref/line id to a concrete value, or undefined if not known yet. */
	resolve(token: string): number | string | boolean | undefined;
	/** Whether an input ref has any value on the return. */
	has(ref: string): boolean;
}

type Tok = { t: string; v?: string };

// A "term" is a number, an identifier, or a dotted ref — including refs that START WITH A
// DIGIT (e.g. 1099nec.box1, 1099div.box1a). We capture the whole `[\w.]+` run as one term
// and classify it in parseValue (pure-numeric → number, else → identifier/ref). This is
// why number and identifier share one token class: otherwise the number rule would grab
// the leading "1099" of "1099nec.box1" and the rest would fail to parse.
const NUMERIC_RE = /^\d+(?:\.\d+)?$/;

function tokenize(s: string): Tok[] {
	const toks: Tok[] = [];
	const re = /(\s+)|(&&|\|\||==|!=|>=|<=|[<>!()])|('[^']*'|"[^"]*")|([A-Za-z0-9_][\w.]*)/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s)) !== null) {
		if (m.index !== last) throw new Error(`unexpected char at ${last}`);
		last = re.lastIndex;
		if (m[1]) continue; // whitespace
		if (m[2]) toks.push({ t: m[2] });
		else if (m[3]) toks.push({ t: "str", v: m[3].slice(1, -1) });
		else if (m[4]) toks.push({ t: NUMERIC_RE.test(m[4]) ? "num" : "id", v: m[4] });
	}
	if (last !== s.length) throw new Error("trailing characters");
	return toks;
}

type Val =
	| { kind: "num"; num: number }
	| { kind: "str"; str: string }
	| { kind: "bool"; bool: boolean }
	| { kind: "unknown" };

function valToTri(v: Val): Tri {
	switch (v.kind) {
		case "num": return v.num !== 0;
		case "str": return v.str.length > 0;
		case "bool": return v.bool;
		case "unknown": return null;
	}
}

function compare(op: string, a: Val, b: Val): Tri {
	if (a.kind === "unknown" || b.kind === "unknown") return null;
	if (a.kind === "num" && b.kind === "num") {
		switch (op) {
			case ">": return a.num > b.num;
			case "<": return a.num < b.num;
			case ">=": return a.num >= b.num;
			case "<=": return a.num <= b.num;
			case "==": return a.num === b.num;
			case "!=": return a.num !== b.num;
		}
	}
	// Non-numeric: only equality is meaningful; ordering is unknown.
	const sa = a.kind === "str" ? a.str : String((a as { num?: number; bool?: boolean }).num ?? (a as { bool?: boolean }).bool);
	const sb = b.kind === "str" ? b.str : String((b as { num?: number; bool?: boolean }).num ?? (b as { bool?: boolean }).bool);
	if (op === "==") return sa === sb;
	if (op === "!=") return sa !== sb;
	return null;
}

class Parser {
	private pos = 0;
	constructor(private toks: Tok[], private ctx: CondContext) {}

	private peek(): Tok | undefined { return this.toks[this.pos]; }
	private next(): Tok | undefined { return this.toks[this.pos++]; }
	private expect(t: string) {
		const tok = this.next();
		if (!tok || tok.t !== t) throw new Error(`expected '${t}'`);
	}

	parse(): Tri {
		const r = this.parseOr();
		if (this.pos !== this.toks.length) throw new Error("unconsumed input");
		return r;
	}

	private parseOr(): Tri {
		let left = this.parseAnd();
		while (this.peek()?.t === "||") {
			this.next();
			const right = this.parseAnd();
			// a || b: true if either true; false only if both false; else unknown.
			if (left === true || right === true) left = true;
			else if (left === false && right === false) left = false;
			else left = null;
		}
		return left;
	}

	private parseAnd(): Tri {
		let left = this.parseNot();
		while (this.peek()?.t === "&&") {
			this.next();
			const right = this.parseNot();
			// a && b: false if either false; true only if both true; else unknown.
			if (left === false || right === false) left = false;
			else if (left === true && right === true) left = true;
			else left = null;
		}
		return left;
	}

	private parseNot(): Tri {
		if (this.peek()?.t === "!") {
			this.next();
			const r = this.parseNot();
			return r === null ? null : !r;
		}
		return this.parseCompare();
	}

	private parseCompare(): Tri {
		// Parenthesised boolean group.
		if (this.peek()?.t === "(") {
			this.next();
			const r = this.parseOr();
			this.expect(")");
			return r;
		}
		const left = this.parseValue();
		const op = this.peek()?.t;
		if (op && [">", "<", ">=", "<=", "==", "!="].includes(op)) {
			this.next();
			const right = this.parseValue();
			return compare(op, left, right);
		}
		// No operator → treat the value as a boolean.
		return valToTri(left);
	}

	private parseValue(): Val {
		const tok = this.next();
		if (!tok) throw new Error("unexpected end");
		if (tok.t === "num") return { kind: "num", num: Number(tok.v) };
		if (tok.t === "str") return { kind: "str", str: tok.v! };
		if (tok.t === "id") {
			const id = tok.v!;
			if (id === "true") return { kind: "bool", bool: true };
			if (id === "false") return { kind: "bool", bool: false };
			if (id === "has") {
				this.expect("(");
				const arg = this.next();
				if (!arg || arg.t !== "id") throw new Error("has() needs a ref");
				this.expect(")");
				return { kind: "bool", bool: this.ctx.has(arg.v!) };
			}
			const resolved = this.ctx.resolve(id);
			if (resolved === undefined) return { kind: "unknown" };
			if (typeof resolved === "number") return { kind: "num", num: resolved };
			if (typeof resolved === "boolean") return { kind: "bool", bool: resolved };
			// Numeric-looking strings compare as numbers.
			const n = Number(resolved);
			if (resolved !== "" && !Number.isNaN(n)) return { kind: "num", num: n };
			return { kind: "str", str: resolved };
		}
		throw new Error(`unexpected token '${tok.t}'`);
	}
}

/**
 * Evaluate a condition to true/false/unknown. An empty condition is `true` (always).
 * Parse errors return `null` (unknown) so callers can apply a conservative policy rather
 * than crash.
 */
export function evalCondition(expr: string | null | undefined, ctx: CondContext): Tri {
	const s = (expr ?? "").trim();
	if (s === "") return true;
	try {
		return new Parser(tokenize(s), ctx).parse();
	} catch {
		return null;
	}
}
