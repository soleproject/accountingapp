// Deterministic crawler proof: a STUB provider returns hand-written FormSpecs that form a
// dependency graph (1040 -> SCH_1 -> SCH_C, and 1040 -> SCH_C-per-business x2), so we can
// prove the crawler's expand/recurse/multiplicity logic WITHOUT depending on LLM output.
// (The real comprehender currently under-emits dependencies — separate prompt work.)
//
// No network, no OpenAI. Uses the real DB (RocketBooks org) and cleans up everything.
//
//   npx tsx scripts/tax-crawl-graph-test.ts

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

loadEnv({ path: resolve(process.cwd(), ".env.local") });

const ORG_ID = "eddf39ae-aa6c-448d-a5bf-cdc806836db1"; // RocketBooks test org
const TAX_YEAR = 2099; // sentinel year so we never collide with real seeded specs

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
	const { crawlReturn } = await import("@/lib/tax/crawler");
	const { removePdfs } = await import("@/lib/tax/storage");
	const { randomUUID } = await import("node:crypto");
	type FormSpec = import("@/lib/tax/spec").FormSpec;
	type TaxFormProvider = import("@/lib/tax/provider").TaxFormProvider;
	type AcquiredForm = import("@/lib/tax/provider").AcquiredForm;
	type FormRef = import("@/lib/tax/provider").FormRef;
	const { PDFDocument } = await import("pdf-lib");

	// A trivial one-field blank PDF reused for every stub form.
	const blankDoc = await PDFDocument.create();
	const page = blankDoc.addPage([612, 792]);
	blankDoc.getForm().createTextField("stub.field").addToPage(page, { x: 50, y: 700, width: 200, height: 16 });
	const blankBytes = await blankDoc.save();

	const spec = (formCode: string, deps: FormSpec["dependencies"]): FormSpec => ({
		schemaVersion: 1,
		formCode,
		jurisdiction: "US",
		taxYear: TAX_YEAR,
		title: `Stub ${formCode}`,
		fields: [{ key: "stub", acroField: "stub.field", page: 0, type: "text" }],
		lines: [],
		inputs: [],
		triggers: [],
		dependencies: deps,
		validations: [],
		provenance: { sourceId: "", sha256: "" },
		confidence: 1,
	});

	// The graph (exercises recursion, per-entity fan-out, and a DIAMOND that must dedup):
	//   STUB_1040 --attaches--> STUB_SCH1  (one, always)
	//             --attaches--> STUB_SCHC  (per_entity, when has(business.name))  → Acme, Beta
	//   STUB_SCH1 --supports--> STUB_4562  (one, always)
	//   STUB_SCHC --supports--> STUB_4562  (one, always)   ← reached from SCH1 + both SCHCs
	// STUB_4562 is referenced by 3 parents but must collapse to ONE node (diamond dedup).
	const SPECS: Record<string, FormSpec> = {
		STUB_1040: spec("STUB_1040", [
			{ formCode: "STUB_SCH1", jurisdiction: "US", relationship: "attaches", condition: "", multiplicity: "one" },
			{ formCode: "STUB_SCHC", jurisdiction: "US", relationship: "attaches", condition: "has(business.name)", multiplicity: "per_entity" },
		]),
		STUB_SCH1: spec("STUB_SCH1", [
			{ formCode: "STUB_4562", jurisdiction: "US", relationship: "supports", condition: "", multiplicity: "one" },
		]),
		STUB_SCHC: spec("STUB_SCHC", [
			{ formCode: "STUB_4562", jurisdiction: "US", relationship: "supports", condition: "", multiplicity: "one" },
		]),
		STUB_4562: spec("STUB_4562", []),
	};

	const stubProvider: TaxFormProvider = {
		name: "stub",
		async acquire(ref: FormRef): Promise<AcquiredForm> {
			return {
				ref, sourceUrl: `stub://${ref.formCode}`, sourceKind: "official",
				pdfBytes: blankBytes, sha256: `stub-${ref.formCode}`, fieldDump: [{ name: "stub.field", type: "PDFTextField" }],
			};
		},
		async comprehend(acquired: AcquiredForm): Promise<FormSpec> {
			const s = SPECS[acquired.ref.formCode];
			if (!s) throw new Error(`no stub spec for ${acquired.ref.formCode}`);
			return structuredClone(s);
		},
		fill() { throw new Error("unused — crawler calls fillPdf directly"); },
	};

	const userId = (await db.select({ id: users.id }).from(users).where(eq(users.email, "michael@bigsaas.ai")).limit(1))[0]?.id
		?? (await db.select({ id: users.id }).from(users).limit(1))[0].id;

	const returnId = randomUUID();
	await db.insert(taxReturns).values({
		id: returnId, organizationId: ORG_ID, taxYear: TAX_YEAR,
		returnType: "personal", jurisdictions: ["US"], seedFormCode: "STUB_1040",
		status: "collecting", createdByUserId: userId,
	});

	// Two businesses (per_entity fan-out) + a couple shared facts.
	const inputRows = [
		{ ref: "stub", value: "ok" as const, entityKey: null },
		{ ref: "business.name", value: "Acme LLC", entityKey: "Acme LLC" },
		{ ref: "stub", value: "ok", entityKey: "Acme LLC" },
		{ ref: "business.name", value: "Beta Co", entityKey: "Beta Co" },
		{ ref: "stub", value: "ok", entityKey: "Beta Co" },
	];
	for (const r of inputRows) {
		await db.insert(taxReturnInputs).values({
			id: randomUUID(), returnId, organizationId: ORG_ID, ref: r.ref, value: r.value, entityKey: r.entityKey ?? undefined, confirmedByUser: true,
		});
	}

	console.log(`Crawling STUB graph return ${returnId.slice(0, 8)} (TY ${TAX_YEAR})...\n`);
	const summary = await crawlReturn(returnId, { provider: stubProvider, db, maxJobs: 50 });

	console.log(`jobs run       : ${summary.jobsRun}`);
	console.log(`return status  : ${summary.returnStatus}\n`);
	console.log("form tree (depth · form · jurisdiction · status):");
	for (const n of summary.nodes) {
		const indent = "  ".repeat(n.depth);
		const copy = n.copyIndex > 0 ? `#${n.copyIndex}` : "";
		console.log(`  ${indent}${n.formCode}${copy} [${n.jurisdiction}] -> ${n.status}`);
	}

	// Assertions: STUB_SCHC must appear once per business (2 copies), not duplicated by the
	// diamond path; SCH1 once. Total distinct nodes = 1040 + SCH1 + 2x SCHC = 4.
	const nodes = await db.select().from(taxReturnForms).where(eq(taxReturnForms.returnId, returnId));
	console.log("\nraw node detail (form · copyIndex · label · parent · relationship):");
	for (const n of nodes) {
		const parentForm = nodes.find((x) => x.id === n.parentFormId)?.formCode ?? "—";
		console.log(`  ${n.formCode} copy=${n.copyIndex} label=${n.instanceLabel ?? "∅"} parent=${parentForm} rel=${n.relationship ?? "∅"}`);
	}
	const byForm = nodes.reduce<Record<string, number>>((a, n) => { a[n.formCode] = (a[n.formCode] ?? 0) + 1; return a; }, {});
	const checks = [
		["1040 present", byForm.STUB_1040 === 1],
		["SCH1 present once", byForm.STUB_SCH1 === 1],
		["SCHC fanned to 2 businesses", byForm.STUB_SCHC === 2],
		["4562 deduped to 1 (diamond from 3 parents)", byForm.STUB_4562 === 1],
		["total = 5 nodes", nodes.length === 5],
		["all filled", nodes.every((n) => n.status === "filled")],
	] as const;
	console.log("\nassertions:");
	let allPass = true;
	for (const [label, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) allPass = false; }

	// ---- cleanup (filing + the STUB knowledge rows, identified by sentinel year) ----
	const nodeIds = nodes.map((n) => n.id);
	const pdfPaths = nodes.map((n) => n.filledPdfPath).filter((p): p is string => Boolean(p));
	if (nodeIds.length) await db.delete(taxFormCrawlJobs).where(inArray(taxFormCrawlJobs.returnFormId, nodeIds));
	await db.delete(taxReturnForms).where(eq(taxReturnForms.returnId, returnId));
	await db.delete(taxReturnInputs).where(eq(taxReturnInputs.returnId, returnId));
	await db.delete(taxReturns).where(eq(taxReturns.id, returnId));
	if (pdfPaths.length) await removePdfs(pdfPaths);

	const stubCats = await db.select({ id: taxFormCatalog.id }).from(taxFormCatalog).where(inArray(taxFormCatalog.formCode, ["STUB_1040", "STUB_SCH1", "STUB_SCHC", "STUB_4562"]));
	const catIds = stubCats.map((c) => c.id);
	if (catIds.length) {
		const srcs = await db.select({ id: taxFormSources.id, path: taxFormSources.formPdfPath }).from(taxFormSources).where(inArray(taxFormSources.catalogId, catIds));
		if (srcs.length) await db.delete(taxFormSpecs).where(inArray(taxFormSpecs.sourceId, srcs.map((s) => s.id)));
		await db.delete(taxFormSources).where(inArray(taxFormSources.catalogId, catIds));
		await db.delete(taxFormCatalog).where(inArray(taxFormCatalog.id, catIds));
		await removePdfs(srcs.map((s) => s.path));
	}
	console.log(`\ncleaned up filing + stub knowledge rows (${pdfPaths.length} filled PDFs, ${catIds.length} stub forms).`);

	await client.end({ timeout: 3 });
	process.exitCode = allPass ? 0 : 2;
}

main().catch((e) => { console.error("\nGRAPH TEST FAILED:\n", e); process.exit(1); });
