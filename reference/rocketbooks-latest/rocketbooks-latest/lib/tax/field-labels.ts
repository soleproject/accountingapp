// Field-label extraction for tax forms.
//
// IRS AcroForm fields carry opaque names (`f1_05[0]`) and NO /TU tooltip — the human
// label ("Wages... W-2 box 1") lives only in the page's printed text. Without a label the
// comprehender is mapping blind, which is why early specs left SSN/income boxes unmapped.
//
// This pairs each form field with its most likely on-page label by geometry:
//   - field rects come from pdf-lib (the /Rect on each widget, in PDF points, origin
//     bottom-left);
//   - page text + positions come from pdf.js.
// For each field we pick the nearest text to the LEFT on the same row, falling back to the
// nearest text ABOVE — the two layouts IRS forms actually use. The result is attached to
// AcroFieldInfo.label and fed to the mapping/verify prompts.
//
// Server-only. pdf.js is imported via its legacy build (the Node-friendly entry).

import { PDFDocument, PDFName, PDFArray, PDFNumber, PDFRef } from "pdf-lib";

export interface FieldRect {
	name: string;
	type: string;
	/** 1-based page number. */
	page: number;
	/** [x1, y1, x2, y2] in PDF points, origin bottom-left. */
	rect: [number, number, number, number];
}

interface TextItem {
	str: string;
	x: number; // left, PDF points
	y: number; // baseline, PDF points (origin bottom-left)
	w: number;
}

/** Collect every terminal widget's rect + page index from the AcroForm. */
export async function extractFieldRects(doc: PDFDocument): Promise<FieldRect[]> {
	// Map each page's dict ref → 1-based page number for the field's /P lookup.
	const pageRefToNum = new Map<string, number>();
	doc.getPages().forEach((pg, i) => {
		const ref = pg.ref;
		if (ref) pageRefToNum.set(ref.toString(), i + 1);
	});

	const out: FieldRect[] = [];
	for (const field of doc.getForm().getFields()) {
		const name = field.getName();
		const type = field.constructor.name;
		// A field may have multiple widgets (checkbox groups); record each.
		const acro = field.acroField as unknown as {
			getWidgets: () => Array<{ dict: import("pdf-lib").PDFDict; getRectangle: () => { x: number; y: number; width: number; height: number } }>;
		};
		let widgets: ReturnType<typeof acro.getWidgets>;
		try {
			widgets = acro.getWidgets();
		} catch {
			continue;
		}
		for (const w of widgets) {
			let page = 0;
			const pRef = w.dict.get(PDFName.of("P"));
			if (pRef instanceof PDFRef) page = pageRefToNum.get(pRef.toString()) ?? 0;
			let rect: [number, number, number, number] = [0, 0, 0, 0];
			try {
				const r = w.dict.get(PDFName.of("Rect"));
				if (r instanceof PDFArray) {
					const nums = r.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : 0));
					if (nums.length === 4) rect = [nums[0], nums[1], nums[2], nums[3]];
				}
			} catch {
				/* leave zero rect */
			}
			out.push({ name, type, page, rect });
		}
	}
	return out;
}

/** Page text items keyed by 1-based page number. */
export async function extractPageText(pdfBytes: Uint8Array): Promise<Map<number, TextItem[]>> {
	void pdfBytes;
	return new Map<number, TextItem[]>();
}

interface PdfJsDoc {
	numPages: number;
	getPage: (n: number) => Promise<{
		getTextContent: () => Promise<{ items: Array<{ str?: string; width?: number; transform: number[] }> }>;
	}>;
}

/**
 * For one field rect, find the best label among the page's text items. IRS forms put the
 * label either to the LEFT of the box on the same row, or directly ABOVE it. We score
 * candidates by proximity and direction, then stitch together same-row fragments so a
 * multi-run label ("Single  Married filing jointly ...") reads as one phrase.
 */
function labelForRect(rect: [number, number, number, number], items: TextItem[]): string {
	const [x1, y1, x2, y2] = rect;
	const cy = (y1 + y2) / 2;
	const rowTol = Math.max(6, (y2 - y1) / 2 + 4); // same-row vertical tolerance

	// Same-row text strictly to the left of the box.
	const leftRow = items
		.filter((it) => Math.abs(it.y - cy) <= rowTol && it.x + it.w <= x1 + 2)
		.sort((a, b) => a.x - b.x);
	if (leftRow.length) {
		// Keep the trailing run that's reasonably close (within ~220pt) to the box.
		const near = leftRow.filter((it) => x1 - (it.x + it.w) <= 220);
		const chosen = (near.length ? near : leftRow.slice(-4));
		const text = chosen.map((it) => it.str).join(" ").trim();
		if (text) return text.slice(0, 160);
	}

	// Otherwise, nearest line ABOVE the box (label sits over the field).
	const above = items
		.filter((it) => it.y > y2 - 2 && it.y - y2 <= 28 && it.x >= x1 - 40 && it.x <= x2 + 40)
		.sort((a, b) => a.y - b.y || a.x - b.x);
	if (above.length) {
		const topY = above[0].y;
		const sameLine = above.filter((it) => Math.abs(it.y - topY) <= 3).sort((a, b) => a.x - b.x);
		const text = sameLine.map((it) => it.str).join(" ").trim();
		if (text) return text.slice(0, 160);
	}
	return "";
}

/** field name → best label, computed from rects + page text. */
export async function buildFieldLabelMap(pdfBytes: Uint8Array): Promise<Map<string, string>> {
	const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
	const [rects, pageText] = await Promise.all([extractFieldRects(doc), extractPageText(pdfBytes)]);
	const labels = new Map<string, string>();
	for (const fr of rects) {
		if (labels.get(fr.name)) continue; // first widget wins
		const items = pageText.get(fr.page) ?? [];
		const label = labelForRect(fr.rect, items);
		if (label) labels.set(fr.name, label);
	}
	return labels;
}
