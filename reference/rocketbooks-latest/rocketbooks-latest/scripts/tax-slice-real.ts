// REAL vertical slice: download the actual IRS Form 1040 (2023), learn a FormSpec, fill
// it, save it. Proves end-to-end acquisition now that we send browser headers (the earlier
// 403 was a missing User-Agent/Referer, not a hard block).
//
// Cleans up the knowledge-layer rows + storage object it creates, so a proof run doesn't
// leave an unreviewed `learned` spec in the shared prod knowledge tables. Pass KEEP=1 to
// retain them (to actually seed the catalog with a real 1040 spec).
//
//   npx tsx scripts/tax-slice-real.ts          (proof: acquire->comprehend->fill->cleanup)
//   KEEP=1 npx tsx scripts/tax-slice-real.ts   (seed: keep the 1040/2023 spec)

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

loadEnv({ path: resolve(process.cwd(), ".env.local") });

async function main() {
	const keep = process.env.KEEP === "1";
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
		const sources = await db.select({ id: taxFormSources.id }).from(taxFormSources).where(eq(taxFormSources.catalogId, catalogId));
		for (const s of sources) await db.delete(taxFormSpecs).where(eq(taxFormSpecs.sourceId, s.id));
		await db.delete(taxFormSources).where(eq(taxFormSources.catalogId, catalogId));
		await db.delete(taxFormCatalog).where(eq(taxFormCatalog.id, catalogId));
		await removePdfs([blankPath]);
	};

	// Real provider: default resolver hits irs.gov, default IRS browser headers.
	const provider = new PdfFillProvider({
		comprehender: openAiComprehender({ model: "gpt-4o-mini" }),
	});

	const ref: FormRef = { jurisdiction: "US", formCode: "1040", taxYear: 2023 };
	const inputs = {
		"taxpayer.first_name": "Jordan",
		"taxpayer.last_name": "Sample",
		"taxpayer.ssn": "123-45-6789",
		"taxpayer.address": "100 Test St, Austin, TX 78701",
		"taxpayer.filing_status": "single",
		"w2.box1": 85_000,
		"w2.box2": 9_200,
		"deductions.use_standard": true,
	};

	console.log(`Downloading REAL IRS ${ref.formCode} (${ref.taxYear}) and running the loop...\n`);
	const r = await acquireComprehendFill({ ref, inputs, provider, database: db });

	console.log("catalogId      :", r.catalogId);
	console.log("sourceId       :", r.sourceId, r.reusedSource ? "(reused)" : "(archived)");
	console.log("specId         :", r.specId, r.reusedSpec ? "(reused)" : "(learned)");
	console.log("blank archived :", r.blankPath);
	console.log("spec confidence:", r.spec.confidence);
	console.log("spec stats     :", `${r.spec.fields.length} fields, ${r.spec.lines.length} lines, ${r.spec.dependencies.length} deps`);
	console.log("dependencies   :", r.spec.dependencies.map((d) => `${d.formCode}(${d.relationship}${d.condition ? " if " + d.condition : ""})`).join(", ") || "(none)");
	console.log("filled size    :", r.filledBytes.length, "bytes");
	console.log("unmapped keys  :", r.unmappedKeys.length ? r.unmappedKeys.join(", ") : "(none)");
	console.log("missing keys   :", r.missingKeys.length ? r.missingKeys.join(", ") : "(none)");

	const out = resolve(process.cwd(), "tmp-real-1040.pdf");
	writeFileSync(out, Buffer.from(r.filledBytes));
	console.log("\nwrote filled PDF ->", out);

	// Read back any field we believe we mapped, to confirm values landed.
	const check = await PDFDocument.load(r.filledBytes, { ignoreEncryption: true });
	const mappedAcro = new Set(r.spec.fields.map((f) => f.acroField));
	const landed = check.getForm().getFields()
		.filter((f) => mappedAcro.has(f.getName()))
		.map((f) => {
			const anyf = f as unknown as { getText?: () => string | undefined; isChecked?: () => boolean };
			const v = anyf.getText ? anyf.getText() : anyf.isChecked ? String(anyf.isChecked()) : "";
			return `${f.getName()} = ${v ?? ""}`;
		})
		.filter((s) => !s.endsWith("= ") && !s.endsWith("= false"));
	console.log("\nnon-empty mapped fields in filled PDF (" + landed.length + "):\n  " + landed.join("\n  "));

	if (keep) {
		console.log("\nKEEP=1 — leaving 1040/2023 knowledge rows in place (real seeded spec).");
	} else {
		await cleanup(r.catalogId, r.blankPath);
		console.log("\ncleaned up 1040/2023 knowledge rows + storage object (proof run).");
	}
	await client.end({ timeout: 3 });
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error("\nREAL SLICE FAILED:\n", e);
		process.exit(1);
	});
