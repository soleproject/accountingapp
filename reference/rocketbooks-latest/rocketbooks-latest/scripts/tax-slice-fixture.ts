// Vertical-slice proof using a LOCAL fixture form (no IRS egress).
//
// Direct IRS PDF downloads are blocked by Akamai bot protection (403 for automated /
// datacenter fetches) — a real production constraint that means we'll need a stored
// mirror or a licensed forms source, not direct scraping. To prove the rest of the loop,
// this generates a small fillable PDF in-memory and runs it through the REAL provider via
// a fetchImpl override, so acquire -> comprehend(OpenAI) -> fill all execute for real.
//
// Uses form code TEST_1040 so the global knowledge tables aren't polluted with a fake
// "1040"; cleans up the rows + storage object it creates at the end.
//
//   npx tsx scripts/tax-slice-fixture.ts

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// Load env before any dynamic import below evaluates app modules that read process.env.
loadEnv({ path: resolve(process.cwd(), ".env.local") });

// Build a tiny fillable PDF whose AcroForm fields stand in for a real form's fields.
async function buildFixtureForm(): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const page = doc.addPage([612, 792]); // US Letter
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const form = doc.getForm();

	const rows: Array<[string, string]> = [
		["topmostSubform[0].Page1[0].f1_name[0]", "Name (first, last)"],
		["topmostSubform[0].Page1[0].f1_ssn[0]", "Social security number"],
		["topmostSubform[0].Page1[0].f1_address[0]", "Home address"],
		["topmostSubform[0].Page1[0].f1_wages[0]", "Line 1a - Wages (W-2 box 1)"],
		["topmostSubform[0].Page1[0].f1_withholding[0]", "Line 25a - Federal tax withheld (W-2 box 2)"],
	];
	let y = 720;
	for (const [fieldName, label] of rows) {
		page.drawText(label, { x: 40, y: y + 4, size: 9, font });
		const tf = form.createTextField(fieldName);
		tf.addToPage(page, { x: 320, y, width: 240, height: 16 });
		y -= 40;
	}
	page.drawText("Standard deduction?", { x: 40, y: y + 4, size: 9, font });
	const cb = form.createCheckBox("topmostSubform[0].Page1[0].c1_std[0]");
	cb.addToPage(page, { x: 320, y, width: 14, height: 14 });

	return doc.save();
}

async function main() {
	// Our OWN db (like scripts/import-users.ts): direct NON_POOLING connection, max:1.
	// The Supabase transaction pooler (6543) trips postgres.js's SASL handshake on a 2nd
	// connection, so we never import @/db/client. Dynamic imports keep schema / runner /
	// providers evaluating only after env + db are ready (and avoid top-level await).
	const dbUrl = process.env.POSTGRES_URL_NON_POOLING;
	if (!dbUrl) throw new Error("POSTGRES_URL_NON_POOLING is required");
	const client = postgres(dbUrl, { prepare: false, max: 1, connect_timeout: 8 });

	const schema = await import("@/db/schema");
	const db = drizzle(client, { schema });
	const { taxFormCatalog, taxFormSources, taxFormSpecs } = schema;
	const { PdfFillProvider } = await import("@/lib/tax/provider");
	type FormRef = import("@/lib/tax/provider").FormRef;
	const { openAiComprehender } = await import("@/lib/tax/comprehend");
	const { acquireComprehendFill } = await import("@/lib/tax/runner");
	const { removePdfs } = await import("@/lib/tax/storage");

	const cleanup = async (catalogId: string, blankPath: string) => {
		// specs -> sources -> catalog (FK order); then the storage object.
		const sources = await db.select({ id: taxFormSources.id }).from(taxFormSources).where(eq(taxFormSources.catalogId, catalogId));
		for (const s of sources) {
			await db.delete(taxFormSpecs).where(eq(taxFormSpecs.sourceId, s.id));
		}
		await db.delete(taxFormSources).where(eq(taxFormSources.catalogId, catalogId));
		await db.delete(taxFormCatalog).where(eq(taxFormCatalog.id, catalogId));
		await removePdfs([blankPath]);
	};

	const fixture = await buildFixtureForm();
	const ref: FormRef = { jurisdiction: "US", formCode: "TEST_1040", taxYear: 2023 };

	// Provider whose acquire() reads our in-memory fixture instead of the network.
	const provider = new PdfFillProvider({
		comprehender: openAiComprehender({ model: "gpt-4o-mini" }),
		resolveUrl: () => "memory://fixture/TEST_1040",
		fetchImpl: (async () =>
			new Response(fixture, { status: 200, headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch,
	});

	const inputs = {
		"taxpayer.first_name": "Jordan",
		"taxpayer.last_name": "Sample",
		"taxpayer.ssn": "123-45-6789",
		"taxpayer.address": "100 Test St, Austin, TX 78701",
		"w2.box1": 85_000,
		"w2.box2": 9_200,
		"deductions.use_standard": true,
	};

	console.log("Running TEST_1040 fixture slice (acquire -> comprehend -> fill)...\n");
	let r;
	try {
		r = await acquireComprehendFill({ ref, inputs, provider, database: db });
	} finally {
		// nothing yet
	}

	console.log("catalogId      :", r.catalogId);
	console.log("sourceId       :", r.sourceId, r.reusedSource ? "(reused)" : "(archived)");
	console.log("specId         :", r.specId, r.reusedSpec ? "(reused)" : "(learned)");
	console.log("blank archived :", r.blankPath);
	console.log("spec confidence:", r.spec.confidence);
	console.log("spec stats     :", `${r.spec.fields.length} fields, ${r.spec.lines.length} lines, ${r.spec.dependencies.length} deps`);
	console.log("field map      :\n  " + r.spec.fields.map((f) => `${f.key} -> ${f.acroField}`).join("\n  "));
	console.log("unmapped keys  :", r.unmappedKeys.length ? r.unmappedKeys.join(", ") : "(none)");
	console.log("missing keys   :", r.missingKeys.length ? r.missingKeys.join(", ") : "(none)");
	console.log("filled size    :", r.filledBytes.length, "bytes (blank was", fixture.length, "bytes)");

	const out = resolve(process.cwd(), "tmp-test1040-filled.pdf");
	writeFileSync(out, Buffer.from(r.filledBytes));
	console.log("\nwrote filled PDF ->", out);

	// Verify the values actually landed in the PDF.
	const check = await PDFDocument.load(r.filledBytes, { ignoreEncryption: true });
	const readBack = check.getForm().getFields().map((f) => {
		const anyf = f as unknown as { getText?: () => string | undefined; isChecked?: () => boolean };
		const v = anyf.getText ? anyf.getText() : anyf.isChecked ? String(anyf.isChecked()) : "";
		return `${f.getName()} = ${v ?? ""}`;
	});
	console.log("\nread-back from filled PDF:\n  " + readBack.join("\n  "));

	await cleanup(r.catalogId, r.blankPath);
	console.log("\ncleaned up TEST_1040 knowledge rows + storage object.");
	await client.end({ timeout: 3 });
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error("\nFIXTURE SLICE FAILED:\n", e);
		process.exit(1);
	});
