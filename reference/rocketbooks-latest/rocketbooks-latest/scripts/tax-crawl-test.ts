// End-to-end crawler proof: create a personal return for the RocketBooks test org, seed
// inputs, run the full crawl (seed root → drain queue → expand dependencies), print the
// resulting form tree, then clean up everything it created.
//
// Uses real IRS forms (1040 + whatever the 1040 spec's dependencies point to). Knowledge-
// layer rows (catalog/sources/specs) are SHARED and reused, so by default we DON'T delete
// them — pass WIPE_KNOWLEDGE=1 to also remove the learned specs created during this run.
//
//   npx tsx scripts/tax-crawl-test.ts
//   WIPE_KNOWLEDGE=1 npx tsx scripts/tax-crawl-test.ts

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

loadEnv({ path: resolve(process.cwd(), ".env.local") });

const ORG_ID = "eddf39ae-aa6c-448d-a5bf-cdc806836db1"; // RocketBooks test org
const TAX_YEAR = 2023;

async function main() {
	const dbUrl = process.env.POSTGRES_URL_NON_POOLING;
	if (!dbUrl) throw new Error("POSTGRES_URL_NON_POOLING is required");
	const client = postgres(dbUrl, { prepare: false, max: 1, connect_timeout: 8 });

	const schema = await import("@/db/schema");
	const db = drizzle(client, { schema });
	const {
		taxReturns, taxReturnForms, taxReturnInputs, taxFormCrawlJobs,
		taxFormCatalog, taxFormSources, taxFormSpecs, users,
	} = schema;
	const { PdfFillProvider } = await import("@/lib/tax/provider");
	const { openAiComprehender } = await import("@/lib/tax/comprehend");
	const { crawlReturn } = await import("@/lib/tax/crawler");
	const { removePdfs } = await import("@/lib/tax/storage");
	const { randomUUID } = await import("node:crypto");

	const userId = (await db.select({ id: users.id }).from(users).where(eq(users.email, "michael@bigsaas.ai")).limit(1))[0]?.id
		?? (await db.select({ id: users.id }).from(users).limit(1))[0].id;

	const returnId = randomUUID();
	await db.insert(taxReturns).values({
		id: returnId,
		organizationId: ORG_ID,
		taxYear: TAX_YEAR,
		returnType: "personal",
		jurisdictions: ["US"],
		seedFormCode: "1040",
		status: "collecting",
		createdByUserId: userId,
	});

	// Seed collected facts (shared, no entity key).
	const facts: Array<[string, string | number | boolean]> = [
		["taxpayer.first_name", "Jordan"],
		["taxpayer.last_name", "Sample"],
		["taxpayer.ssn", "123-45-6789"],
		["taxpayer.filing_status", "single"],
		["taxpayer.address", "100 Test St, Austin, TX 78701"],
		["taxpayer.state", "TX"],
		["taxpayer.dependents_count", 0],
		["w2.box1", 85_000],
		["w2.box2", 9_200],
		["deductions.use_standard", true],
	];
	for (const [ref, value] of facts) {
		await db.insert(taxReturnInputs).values({
			id: randomUUID(),
			returnId,
			organizationId: ORG_ID,
			ref,
			value,
			confirmedByUser: true,
		});
	}

	const provider = new PdfFillProvider({ comprehender: openAiComprehender({ model: "gpt-4o-mini" }) });

	console.log(`Crawling personal 1040 return ${returnId.slice(0, 8)} (TY ${TAX_YEAR})...\n`);
	const summary = await crawlReturn(returnId, { provider, db, maxJobs: 40 });

	console.log(`jobs run       : ${summary.jobsRun}`);
	console.log(`return status  : ${summary.returnStatus}\n`);
	console.log("form tree (depth · form · jurisdiction · status):");
	for (const n of summary.nodes) {
		const indent = "  ".repeat(n.depth);
		const copy = n.copyIndex > 0 ? `#${n.copyIndex}` : "";
		console.log(`  ${indent}${n.formCode}${copy} [${n.jurisdiction}] -> ${n.status}`);
	}

	// Per-node detail: which got filled, which need input, which were skipped.
	const detail = await db.select().from(taxReturnForms).where(eq(taxReturnForms.returnId, returnId));
	console.log("\nnode detail:");
	for (const d of detail) {
		console.log(`  ${d.formCode}: ${d.status}${d.filledPdfPath ? " pdf=" + d.filledPdfPath : ""}${d.error ? " err=" + d.error : ""}${d.isDraft ? " [draft]" : ""}`);
	}

	// ---- cleanup ----
	const nodeIds = detail.map((d) => d.id);
	const pdfPaths = detail.map((d) => d.filledPdfPath).filter((p): p is string => Boolean(p));
	if (nodeIds.length) await db.delete(taxFormCrawlJobs).where(inArray(taxFormCrawlJobs.returnFormId, nodeIds));
	await db.delete(taxReturnForms).where(eq(taxReturnForms.returnId, returnId));
	await db.delete(taxReturnInputs).where(eq(taxReturnInputs.returnId, returnId));
	await db.delete(taxReturns).where(eq(taxReturns.id, returnId));
	if (pdfPaths.length) await removePdfs(pdfPaths);
	console.log(`\ncleaned up filing-layer rows + ${pdfPaths.length} filled PDFs.`);

	if (process.env.WIPE_KNOWLEDGE === "1") {
		const cats = await db.select({ id: taxFormCatalog.id, blank: taxFormSources.formPdfPath })
			.from(taxFormCatalog)
			.leftJoin(taxFormSources, eq(taxFormSources.catalogId, taxFormCatalog.id));
		const catIds = [...new Set(cats.map((c) => c.id))];
		const blanks = cats.map((c) => c.blank).filter((p): p is string => Boolean(p));
		if (catIds.length) {
			const srcIds = (await db.select({ id: taxFormSources.id }).from(taxFormSources).where(inArray(taxFormSources.catalogId, catIds))).map((s) => s.id);
			if (srcIds.length) await db.delete(taxFormSpecs).where(inArray(taxFormSpecs.sourceId, srcIds));
			await db.delete(taxFormSources).where(inArray(taxFormSources.catalogId, catIds));
			await db.delete(taxFormCatalog).where(inArray(taxFormCatalog.id, catIds));
			if (blanks.length) await removePdfs(blanks);
			console.log(`WIPE_KNOWLEDGE=1 — removed ${catIds.length} catalog forms + ${blanks.length} archived blanks.`);
		}
	} else {
		console.log("(kept knowledge-layer specs — pass WIPE_KNOWLEDGE=1 to remove)");
	}

	await client.end({ timeout: 3 });
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error("\nCRAWL TEST FAILED:\n", e);
		process.exit(1);
	});
