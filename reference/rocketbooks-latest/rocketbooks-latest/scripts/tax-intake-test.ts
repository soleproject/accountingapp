// End-to-end intake-tool proof: exercises the exact dispatcher path the AI chat uses
// (executeTaxIntakeTool) — classify → list_tax_facts → record_tax_facts → run_tax_return →
// get_tax_return_status — then cleans up filing + knowledge rows. No HTTP/LLM-chat layer;
// this validates the tools themselves (run_tax_return still does real IRS download + OpenAI).
//
//   npx tsx scripts/tax-intake-test.ts

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

loadEnv({ path: resolve(process.cwd(), ".env.local") });

const ORG_ID = "eddf39ae-aa6c-448d-a5bf-cdc806836db1"; // RocketBooks test org

async function main() {
	const dbUrl = process.env.POSTGRES_URL_NON_POOLING;
	if (!dbUrl) throw new Error("POSTGRES_URL_NON_POOLING is required");
	const client = postgres(dbUrl, { prepare: false, max: 1, connect_timeout: 8 });

	const schema = await import("@/db/schema");
	const db = drizzle(client, { schema });
	const { taxReturns, taxReturnForms, taxReturnInputs, taxFormCrawlJobs, taxFormCatalog, taxFormSources, taxFormSpecs } = schema;

	// The intake tools use the shared singleton db (@/db/client) which reads POSTGRES_URL.
	// Point that at the non-pooling URL BEFORE importing the tools (avoids the SASL pooler race).
	process.env.POSTGRES_URL = dbUrl;
	const { executeTaxIntakeTool, isTaxIntakeToolName } = await import("@/lib/tax/intake-tools");
	const { removePdfs } = await import("@/lib/tax/storage");

	// Resolve a real user in the org (no request scope here → inject userId explicitly).
	const { users } = schema;
	const userId = (await db.select({ id: users.id }).from(users).where(eq(users.email, "michael@bigsaas.ai")).limit(1))[0]?.id
		?? (await db.select({ id: users.id }).from(users).limit(1))[0].id;
	const ctx = { organizationId: ORG_ID, userId };
	const call = (name: string, args: Record<string, unknown>) => executeTaxIntakeTool(ctx, name, args);

	let pass = 0, fail = 0;
	const check = (label: string, ok: boolean, extra = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`); ok ? pass++ : fail++; };

	console.log("intake tools registered:", ["classify_tax_return", "list_tax_facts", "record_tax_facts", "run_tax_return", "get_tax_return_status"].every(isTaxIntakeToolName), "\n");

	// 1. classify
	const cls = (await call("classify_tax_return", { return_type: "personal", tax_year: 2023 })) as any;
	console.log("classify:", JSON.stringify(cls));
	check("classify created a return", cls?.ok && typeof cls.returnId === "string");
	check("seed form is 1040", cls?.seedFormCode === "1040");
	const returnId = cls.returnId as string;

	// 2. list_tax_facts (filtered)
	const facts = (await call("list_tax_facts", { group: "w2" })) as any;
	check("list_tax_facts returns w2 refs", facts?.count > 0 && facts.refs.every((r: any) => r.ref.startsWith("w2")));

	// 3. record_tax_facts — shared + a per-entity business + a bad ref
	const rec = (await call("record_tax_facts", {
		return_id: returnId,
		facts: [
			{ ref: "taxpayer.first_name", value: "Jordan" },
			{ ref: "taxpayer.last_name", value: "Sample" },
			{ ref: "taxpayer.filing_status", value: "single" },
			{ ref: "taxpayer.state", value: "TX" },
			{ ref: "taxpayer.address", value: "100 Test St, Austin, TX 78701" },
			{ ref: "deductions.use_standard", value: true },
			{ ref: "w2.box1", value: 85000, entity_key: "Acme Corp" },
			{ ref: "w2.box2", value: 9200, entity_key: "Acme Corp" },
			{ ref: "not.a.real.ref", value: 1 },
		],
	})) as any;
	console.log("record:", JSON.stringify(rec));
	check("record saved the valid facts", rec?.savedCount === 8);
	check("record rejected the bad ref", rec?.rejected?.length === 1 && rec.rejected[0].ref === "not.a.real.ref");

	// 3b. upsert: re-record one ref with a new value → still 1 row for it
	await call("record_tax_facts", { return_id: returnId, facts: [{ ref: "taxpayer.first_name", value: "Jordan-Updated" }] });
	const fnameRows = await db.select().from(taxReturnInputs).where(eq(taxReturnInputs.returnId, returnId));
	const fnameCount = fnameRows.filter((r) => r.ref === "taxpayer.first_name").length;
	check("re-recording a ref upserts (no duplicate)", fnameCount === 1, `value=${JSON.stringify(fnameRows.find((r) => r.ref === "taxpayer.first_name")?.value)}`);

	// 4. run
	const run = (await call("run_tax_return", { return_id: returnId })) as any;
	console.log("run:", JSON.stringify({ returnStatus: run.returnStatus, jobsRun: run.jobsRun, forms: run.forms }));
	check("run produced a 1040 node", run?.ok && run.forms.some((f: any) => f.formCode === "1040"));
	check("run reported a return status", typeof run?.returnStatus === "string");

	// 5. status
	const status = (await call("get_tax_return_status", { return_id: returnId })) as any;
	console.log("status:", JSON.stringify(status));
	check("status returns the form tree", Array.isArray(status?.forms) && status.forms.length >= 1);
	check("filled forms are flagged draft", status.forms.filter((f: any) => f.status === "filled").every((f: any) => f.isDraft === true));

	// org-scope guard
	const denied = (await call("get_tax_return_status", { return_id: "00000000-0000-0000-0000-000000000000" })) as any;
	check("cross-id is rejected", denied?.error === "return not found");

	// ---- cleanup ----
	const nodes = await db.select().from(taxReturnForms).where(eq(taxReturnForms.returnId, returnId));
	const nodeIds = nodes.map((n) => n.id);
	const pdfPaths = nodes.map((n) => n.filledPdfPath).filter((p): p is string => Boolean(p));
	if (nodeIds.length) await db.delete(taxFormCrawlJobs).where(inArray(taxFormCrawlJobs.returnFormId, nodeIds));
	await db.delete(taxReturnForms).where(eq(taxReturnForms.returnId, returnId));
	await db.delete(taxReturnInputs).where(eq(taxReturnInputs.returnId, returnId));
	await db.delete(taxReturns).where(eq(taxReturns.id, returnId));
	if (pdfPaths.length) await removePdfs(pdfPaths);
	const learned = [...new Set(nodes.map((n) => n.formCode))];
	const cats = await db.select({ id: taxFormCatalog.id }).from(taxFormCatalog).where(inArray(taxFormCatalog.formCode, learned));
	const catIds = cats.map((c) => c.id);
	if (catIds.length) {
		const srcs = await db.select({ id: taxFormSources.id, path: taxFormSources.formPdfPath }).from(taxFormSources).where(inArray(taxFormSources.catalogId, catIds));
		if (srcs.length) await db.delete(taxFormSpecs).where(inArray(taxFormSpecs.sourceId, srcs.map((s) => s.id)));
		await db.delete(taxFormSources).where(inArray(taxFormSources.catalogId, catIds));
		await db.delete(taxFormCatalog).where(inArray(taxFormCatalog.id, catIds));
		await removePdfs(srcs.map((s) => s.path));
	}
	console.log(`\ncleaned up filing rows + ${catIds.length} knowledge forms + ${pdfPaths.length} filled PDFs.`);

	console.log(`\n${pass} passed, ${fail} failed`);
	await client.end({ timeout: 3 });
	process.exitCode = fail === 0 ? 0 : 2;
}

main().catch((e) => { console.error("\nINTAKE TEST FAILED:\n", e); process.exit(1); });
