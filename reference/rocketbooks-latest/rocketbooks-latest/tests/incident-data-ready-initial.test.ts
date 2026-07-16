import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dashboardPage = readFileSync('app/(app)/dashboard/page.tsx', 'utf8');
const dashboardClient = readFileSync('app/(app)/dashboard/_components/DashboardSummaryClient.tsx', 'utf8');
const transactionsPage = readFileSync('app/(app)/transactions/page.tsx', 'utf8');
const transactionsClient = readFileSync('app/(app)/transactions/_components/TransactionsLandingClient.tsx', 'utf8');
const transactionsRoute = readFileSync('app/api/transactions/landing/route.ts', 'utf8');
const orgSwitcher = readFileSync('components/layout/OrgSwitcher.tsx', 'utf8');
const switchBusinessButton = readFileSync('app/(app)/businesses/_components/SwitchBusinessButton.tsx', 'utf8');
const orgSwitchClient = readFileSync('lib/auth/org-switch-client.ts', 'utf8');

assert.match(dashboardPage, /loadDashboardSummary\(organizationId\)/, 'dashboard page request should reuse its authoritative organization for the summary read');
assert.match(dashboardPage, /<DashboardSummaryClient key=\{initial!\.organizationId\} initialSummary=\{initial!\.summary\}/, 'dashboard should remount initial data at the organization boundary');
assert.match(dashboardClient, /initialSummary\?: DashboardSummary \| null/, 'dashboard client should accept server-provided initial data');
assert.match(dashboardClient, /const summary = initialSummary \?\? fallbackSummary/, 'refreshed dashboard props should be authoritative over API fallback state');
assert.match(dashboardClient, /if \(initialSummary !== null\) return;/, 'dashboard client must treat server-provided data as authoritative');
assert.match(dashboardPage, /const insights = [\s\S]*const summaryPromise = insights[\s\S]*\? null[\s\S]*: getCurrentOrgId\(\)/, 'Insights view must not start a discarded dashboard summary query');

assert.match(transactionsPage, /loadTransactionsLanding\(organizationId\)/, 'default transactions page should reuse its authoritative organization for visible rows');
assert.match(transactionsPage, /<TransactionsLandingShell organizationId=\{organizationId\} initialRows=\{initialRows\}/, 'transactions shell should receive scoped initial rows');
assert.match(transactionsPage, /<TransactionsLandingClient key=\{organizationId\} initialRows=\{initialRows\}/, 'transactions fallback state should remount when the organization changes');
assert.match(transactionsClient, /initialRows\?: TransactionLandingRow\[\] \| null/, 'transactions client should accept server-provided rows');
assert.match(transactionsClient, /const rows = initialRows \?\? fallbackRows/, 'refreshed transaction props, including empty arrays, should override API fallback state');
assert.match(transactionsClient, /if \(initialRows !== null\) return;/, 'transactions client must not repeat the landing API request when initial rows, including an empty array, exist');
assert.match(transactionsRoute, /loadTransactionsLanding\(\)/, 'transactions API should reuse the authorized loader as fallback');

assert.match(orgSwitcher, /blockDocumentForOrganizationSwitch\(\)[\s\S]*fetch\('\/api\/orgs\/switch'[\s\S]*replaceDocumentAfterOrganizationSwitch\(\)/, 'organization switcher must block the old document before changing data scope');
assert.doesNotMatch(orgSwitcher, /fetch\('\/api\/orgs\/switch'[\s\S]*router\.refresh\(\)/, 'organization switcher must not rely on soft refresh for data-scope isolation');
assert.match(switchBusinessButton, /blockDocumentForOrganizationSwitch\(\)[\s\S]*fetch\('\/api\/orgs\/switch'[\s\S]*replaceDocumentAfterOrganizationSwitch\(\)/, 'business switch button must block the old document before changing data scope');
assert.match(orgSwitchClient, /child\.inert = true[\s\S]*reload this page to continue safely/, 'organization switch must make the previous app inert and show recovery guidance');
assert.match(orgSwitchClient, /window\.location\.replace\(window\.location\.href\)/, 'successful organization switch must replace the old document');
assert.match(orgSwitcher, /catch \{[\s\S]*unblockDocumentAfterOrganizationSwitchFailure\(\)/, 'failed switch must restore the original document');

console.log('incident-data-ready-initial: first-visible dashboard and transaction data share the authorized page request; API fallback remains');
