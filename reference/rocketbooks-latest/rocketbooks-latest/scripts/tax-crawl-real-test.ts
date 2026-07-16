// REAL recursion proof: crawl a 1040 with business income seeded, using the REAL provider
// (live IRS downloads + OpenAI comprehension). Proves the comprehender now emits
// dependencies AND the crawler recurses into real schedules. Each discovered form is a
// real download + LLM call, so this is bounded by maxJobs.
//
// Seeds self-employment income so the 1040's dependency conditions fire:
//   business.name + business.net_profit + 1099nec.box1  →  SCH_C, SCH_SE, SCH_1, SCH_2,
//   4562 (and SCH_3 which the model emits as always-on). use_standard=true skips SCH_A.
//
// Cleans up ALL rows it creates (filing + the learned knowledge specs for this run).
//
//   npx tsx scripts/tax-crawl-real-test.ts

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
		id: returnId, organizationId: ORG_ID, taxYear: TAX_YEAR,
		returnType: "personal", jurisdictions: ["US"], seedFormCode: "1040",
		status: "collecting", createdByUserId: userId,
	});

	// Shared facts + ONE business (entityKey) so SCH_C is per_entity with 1 copy.
	const shared: Array<[string, string | number | boolean]> = [
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
		["1099nec.box1", 20_000],
	];
	for (const [ref, value] of shared) {
		await db.insert(taxReturnInputs).values({ id: randomUUID(), returnId, organizationId: ORG_ID, ref, value, confirmedByUser: true });
	}
	// Per-entity business facts.
	for (const [ref, value] of [["business.name", "Jordan Consulting"], ["business.net_profit", 20_000], ["business.gross_receipts", 24_000]] as Array<[string, string | number]>) {
		await db.insert(taxReturnInputs).values({ id: randomUUID(), returnId, organizationId: ORG_ID, ref, value, entityKey: "Jordan Consulting", confirmedByUser: true });
	}

	const provider = new PdfFillProvider({ comprehender: openAiComprehender({ model: "gpt-4o-mini" }) });

	console.log(`Crawling REAL 1040 with business income, return ${returnId.slice(0, 8)} (TY ${TAX_YEAR})...\n`);
	const summary = await crawlReturn(returnId, { provider, db, maxJobs: 15 });

	console.log(`jobs run       : ${summary.jobsRun}`);
	console.log(`return status  : ${summary.returnStatus}\n`);
	console.log("form tree (depth · form · status):");
	for (const n of summary.nodes) {
		const indent = "  ".repeat(n.depth);
		const copy = n.copyIndex > 0 ? `#${n.copyIndex}` : "";
		console.log(`  ${indent}${n.formCode}${copy} -> ${n.status}`);
	}

	const nodes = await db.select().from(taxReturnForms).where(eq(taxReturnForms.returnId, returnId));
	const forms = nodes.map((n) => n.formCode);
	const childForms = nodes.filter((n) => n.depth > 0).map((n) => n.formCode);
	console.log("\nassertions:");
	const checks = [
		["1040 root filled", nodes.some((n) => n.formCode === "1040" && n.status === "filled")],
		["recursed into >=1 child form", childForms.length >= 1],
		["SCH_C spawned (business income)", forms.includes("SCH_C")],
		["all nodes terminal (no pending/acquiring)", nodes.every((n) => !["pending", "acquiring", "comprehending", "ready", "filling"].includes(n.status))],
	] as const;
	let allPass = true;
	for (const [label, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) allPass = false; }
	console.log(`\nchild forms discovered: ${childForms.join(", ") || "(none)"}`);

	// ---- cleanup: filing rows + the knowledge specs learned this run ----
	const nodeIds = nodes.map((n) => n.id);
	const pdfPaths = nodes.map((n) => n.filledPdfPath).filter((p): p is string => Boolean(p));
	if (nodeIds.length) await db.delete(taxFormCrawlJobs).where(inArray(taxFormCrawlJobs.returnFormId, nodeIds));
	await db.delete(taxReturnForms).where(eq(taxReturnForms.returnId, returnId));
	await db.delete(taxReturnInputs).where(eq(taxReturnInputs.returnId, returnId));
	await db.delete(taxReturns).where(eq(taxReturns.id, returnId));
	if (pdfPaths.length) await removePdfs(pdfPaths);

	// Knowledge layer: remove the specs/sources/catalog rows for the forms this run learned.
	const learnedCodes = [...new Set(forms)];
	const cats = await db.select({ id: taxFormCatalog.id }).from(taxFormCatalog).where(inArray(taxFormCatalog.formCode, learnedCodes));
	const catIds = cats.map((c) => c.id);
	if (catIds.length) {
		const srcs = await db.select({ id: taxFormSources.id, path: taxFormSources.formPdfPath }).from(taxFormSources).where(inArray(taxFormSources.catalogId, catIds));
		if (srcs.length) await db.delete(taxFormSpecs).where(inArray(taxFormSpecs.sourceId, srcs.map((s) => s.id)));
		await db.delete(taxFormSources).where(inArray(taxFormSources.catalogId, catIds));
		await db.delete(taxFormCatalog).where(inArray(taxFormCatalog.id, catIds));
		await removePdfs(srcs.map((s) => s.path));
	}
	console.log(`\ncleaned up filing rows + ${catIds.length} knowledge forms + ${pdfPaths.length} filled PDFs.`);

	await client.end({ timeout: 3 });
	process.exitCode = allPass ? 0 : 2;
}

main().catch((e) => { console.error("\nREAL CRAWL TEST FAILED:\n", e); process.exit(1); });
