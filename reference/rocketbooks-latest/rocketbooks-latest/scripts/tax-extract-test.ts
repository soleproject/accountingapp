// Generates a synthetic W-2 PDF, runs the real extractor (pdf.js text + OpenAI), and
// verifies: doc-type detection, box→ref mapping with correct values, entity label, and
// that facts record UNCONFIRMED. Then a 1099-NEC for good measure. Cleans up.
//
//   npx tsx scripts/tax-extract-test.ts

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
const ORG_ID = "eddf39ae-aa6c-448d-a5bf-cdc806836db1";

// Build a synthetic W-2: a flat (non-AcroForm) PDF whose printed text mimics a real W-2's
// boxes, so the pdf.js text extractor + LLM have realistic content to read.
async function buildW2(): Promise<Uint8Array> {
	const { PDFDocument, StandardFonts } = await import("pdf-lib");
	const doc = await PDFDocument.create();
	const page = doc.addPage([612, 792]);
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const bold = await doc.embedFont(StandardFonts.HelveticaBold);
	const t = (s: string, x: number, y: number, size = 9, f = font) => page.drawText(s, { x, y, size, font: f });

	t("Form W-2  Wage and Tax Statement", 40, 750, 13, bold);
	t("2023", 480, 750, 13, bold);
	t("c  Employer's name, address, and ZIP code", 40, 710, 8);
	t("Globex Corporation", 50, 696, 11);
	t("500 Industrial Way, Springfield, IL 62704", 50, 684, 9);
	t("a  Employee's social security number", 40, 655, 8);
	t("123-45-6789", 50, 641, 11);
	t("e  Employee's name", 40, 612, 8);
	t("Jordan Sample", 50, 598, 11);
	// Boxes
	t("1  Wages, tips, other compensation", 40, 560, 8);
	t("85,000.00", 250, 560, 11, bold);
	t("2  Federal income tax withheld", 40, 540, 8);
	t("9,200.00", 250, 540, 11, bold);
	t("3  Social security wages", 40, 520, 8);
	t("85,000.00", 250, 520, 10);
	t("16  State wages, tips, etc.", 40, 500, 8);
	t("85,000.00", 250, 500, 10);
	t("17  State income tax", 40, 480, 8);
	t("3,910.00", 250, 480, 11, bold);
	return doc.save();
}

async function build1099NEC(): Promise<Uint8Array> {
	const { PDFDocument, StandardFonts } = await import("pdf-lib");
	const doc = await PDFDocument.create();
	const page = doc.addPage([612, 792]);
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const bold = await doc.embedFont(StandardFonts.HelveticaBold);
	const t = (s: string, x: number, y: number, size = 9, f = font) => page.drawText(s, { x, y, size, font: f });
	t("Form 1099-NEC  Nonemployee Compensation", 40, 750, 13, bold);
	t("2023", 480, 750, 13, bold);
	t("PAYER'S name", 40, 700, 8);
	t("Initech LLC", 50, 686, 11);
	t("1  Nonemployee compensation", 40, 600, 8);
	t("20,000.00", 250, 600, 11, bold);
	return doc.save();
}

async function main() {
	const dbUrl = process.env.POSTGRES_URL_NON_POOLING!;
	process.env.POSTGRES_URL = dbUrl;
	const client = postgres(dbUrl, { prepare: false, max: 1, connect_timeout: 8 });
	const schema = await import("@/db/schema");
	const db = drizzle(client, { schema });
	const { taxReturns, taxReturnInputs, users } = schema;
	const { extractTaxDocument } = await import("@/lib/tax/extract");
	const { executeTaxIntakeTool } = await import("@/lib/tax/intake-tools");
	const { uploadPdf, removePdfs, blankFormPath } = await import("@/lib/tax/storage");
	const { randomUUID, createHash } = await import("node:crypto");

	let pass = 0, fail = 0;
	const check = (l: string, ok: boolean, x = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${x ? "  " + x : ""}`); ok ? pass++ : fail++; };

	// --- 1) direct extractor on the synthetic W-2 ---
	const w2 = await buildW2();
	const r = await extractTaxDocument(w2);
	console.log("W-2 extraction:", JSON.stringify({ docType: r.docType, entityLabel: r.entityLabel, facts: r.facts }, null, 0));
	check("detected W-2", r.docType === "W-2");
	check("entity label = employer", r.entityLabel === "Globex Corporation", `got ${JSON.stringify(r.entityLabel)}`);
	const box1 = r.facts.find((f) => f.ref === "w2.box1");
	const box2 = r.facts.find((f) => f.ref === "w2.box2");
	const box17 = r.facts.find((f) => f.ref === "w2.box17");
	check("box1 wages = 85000", box1?.value === 85000, `got ${JSON.stringify(box1?.value)}`);
	check("box2 withheld = 9200", box2?.value === 9200, `got ${JSON.stringify(box2?.value)}`);
	check("box17 state tax = 3910", box17?.value === 3910, `got ${JSON.stringify(box17?.value)}`);
	check("no fabricated off-vocab refs", r.facts.every((f) => f.ref.startsWith("w2.")));

	// --- 2) end-to-end via the intake tool: upload → extract_tax_document → unconfirmed facts ---
	const userId = (await db.select({ id: users.id }).from(users).limit(1))[0].id;
	const returnId = randomUUID();
	await db.insert(taxReturns).values({
		id: returnId, organizationId: ORG_ID, taxYear: 2023, returnType: "personal",
		jurisdictions: ["US"], seedFormCode: "1040", status: "collecting", createdByUserId: userId,
	});
	const sha = createHash("sha256").update(w2).digest("hex");
	const path = blankFormPath("UPLOAD", 2023, "W2", sha); // reuse the bucket; arbitrary path
	await uploadPdf(path, w2);

	const toolRes = (await executeTaxIntakeTool({ organizationId: ORG_ID, userId }, "extract_tax_document", { return_id: returnId, storage_path: path })) as any;
	console.log("tool result:", JSON.stringify({ docType: toolRes.docType, entityLabel: toolRes.entityLabel, extracted: toolRes.extracted }));
	check("tool extracted ≥3 facts", toolRes.ok && toolRes.extracted >= 3);

	const recorded = await db.select().from(taxReturnInputs).where(eq(taxReturnInputs.returnId, returnId));
	check("facts recorded on the return", recorded.length >= 3);
	check("ALL extracted facts are UNCONFIRMED", recorded.every((x) => x.confirmedByUser === false));
	check("grouped under employer entity_key", recorded.every((x) => x.entityKey === "Globex Corporation"));

	// --- 3) doc-type detection on a different form ---
	const nec = await build1099NEC();
	const r2 = await extractTaxDocument(nec);
	check("detected 1099-NEC", r2.docType === "1099-NEC", `got ${r2.docType}`);
	const necBox1 = r2.facts.find((f) => f.ref === "1099nec.box1");
	check("1099-NEC box1 = 20000", necBox1?.value === 20000, `got ${JSON.stringify(necBox1?.value)}`);

	// --- 4) verification: clean doc → high confidence, no flags ---
	check("clean W-2: box1 high confidence (passes agreed)", (box1?.confidence ?? 0) >= 0.9, `conf=${box1?.confidence}`);
	check("clean W-2: nothing flagged needsReview", r.facts.every((f) => !f.needsReview));

	// --- 5) deterministic cross-check fires: withholding > wages is impossible ---
	const { PDFDocument, StandardFonts } = await import("pdf-lib");
	const badDoc = await PDFDocument.create();
	const bp = badDoc.addPage([612, 792]);
	const bf = await badDoc.embedFont(StandardFonts.HelveticaBold);
	bp.drawText("Form W-2  Wage and Tax Statement  2023", 40, 750, { size: 12, font: bf });
	bp.drawText("Employer: Globex Corporation", 40, 700, { size: 10, font: bf });
	bp.drawText("1  Wages, tips, other compensation   5,000.00", 40, 560, { size: 10, font: bf });
	bp.drawText("2  Federal income tax withheld   40,000.00", 40, 540, { size: 10, font: bf });
	const badBytes = await badDoc.save();
	const rb = await extractTaxDocument(badBytes);
	const badWithheld = rb.facts.find((f) => f.ref === "w2.box2");
	check("cross-check flags withholding > wages", badWithheld?.needsReview === true, `reason=${badWithheld?.reviewReason ?? "(none)"}`);
	check("cross-check recorded a finding", rb.checks.length >= 1, rb.checks.join(" | "));

	// cleanup
	await db.delete(taxReturnInputs).where(eq(taxReturnInputs.returnId, returnId));
	await db.delete(taxReturns).where(eq(taxReturns.id, returnId));
	await removePdfs([path]);
	console.log("\ncleaned up.");
	console.log(`\n${pass} passed, ${fail} failed`);
	await client.end({ timeout: 3 });
	process.exitCode = fail === 0 ? 0 : 2;
}
main().catch((e) => { console.error("EXTRACT TEST FAILED:\n", e); process.exit(1); });
