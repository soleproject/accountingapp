import { relations } from "drizzle-orm/relations";
import { users, adminAuditLog, aiRecommendations, contacts, chartOfAccounts, organizations, transactions, coaHygieneSweeps, coaHygieneSweepItems, contactProfiles, dashboardSnapshots, documentRecords, documentVersions, enterpriseClients, enterpriseStaff, exportJobs, columnPresets, documentAuditEvents, importedTransactions, imports, plaidAccounts, invoices, journalEntries, generalLedger, journalEntryLines, orgSyncStatus, organizationSupportUsers, organizationUserInvites, payrollSchedules, payrollRuns, payrollBenefitEnrollments, payrollEmployees, payrollTaxInfo, payrollContractors, payrollLineItems, plaidRawTransactions, plaidSyncBatches, qboMigrationJobs, qboAccountStaging, qboCustomerStaging, qboInvoiceStaging, qboMappingOverrides, qboMappingResults, qboMigrationLogs, qboBillStaging, qboMigrationSummaries, qboMirroringJobs, qboOauthStates, qboPaymentStaging, qboConnections, resolutionPacketExports, resolutionPackets, permissions, rolePermissions, roles, scheduledExports, qboVendorStaging, transactionProcessorSourceMappings, transactionSplits, userPermissionOverrides, statementLines, reconciliationPeriods, permissionSets, userPermissionSets, userRoles, tasks, goals, goalProgress, openingBalanceBatches, openingBalanceLines, permissionSetPermissions, reconciliationMatches } from "./schema";

export const adminAuditLogRelations = relations(adminAuditLog, ({one}) => ({
	user: one(users, {
		fields: [adminAuditLog.adminUserId],
		references: [users.id]
	}),
}));

export const usersRelations = relations(users, ({many}) => ({
	adminAuditLogs: many(adminAuditLog),
	aiRecommendations_appliedByUserId: many(aiRecommendations, {
		relationName: "aiRecommendations_appliedByUserId_users_id"
	}),
	aiRecommendations_revertedByUserId: many(aiRecommendations, {
		relationName: "aiRecommendations_revertedByUserId_users_id"
	}),
	enterpriseClients: many(enterpriseClients),
	enterpriseStaffs: many(enterpriseStaff),
	exportJobs: many(exportJobs),
	columnPresets: many(columnPresets),
	organizationSupportUsers: many(organizationSupportUsers),
	organizationUserInvites: many(organizationUserInvites),
	organizations_clientId: many(organizations, {
		relationName: "organizations_clientId_users_id"
	}),
	organizations_ownerUserId: many(organizations, {
		relationName: "organizations_ownerUserId_users_id"
	}),
	plaidAccounts: many(plaidAccounts),
	qboMappingOverrides: many(qboMappingOverrides),
	qboMirroringJobs: many(qboMirroringJobs),
	qboOauthStates: many(qboOauthStates),
	qboMigrationJobs: many(qboMigrationJobs),
	qboConnections: many(qboConnections),
	resolutionPacketExports: many(resolutionPacketExports),
	resolutionPackets: many(resolutionPackets),
	scheduledExports: many(scheduledExports),
	transactionProcessorSourceMappings: many(transactionProcessorSourceMappings),
	userPermissionOverrides: many(userPermissionOverrides),
	userPermissionSets: many(userPermissionSets),
	userRoles: many(userRoles),
}));

export const aiRecommendationsRelations = relations(aiRecommendations, ({one}) => ({
	user_appliedByUserId: one(users, {
		fields: [aiRecommendations.appliedByUserId],
		references: [users.id],
		relationName: "aiRecommendations_appliedByUserId_users_id"
	}),
	contact_contactId: one(contacts, {
		fields: [aiRecommendations.contactId],
		references: [contacts.id],
		relationName: "aiRecommendations_contactId_contacts_id"
	}),
	chartOfAccount_currentCategoryAccountId: one(chartOfAccounts, {
		fields: [aiRecommendations.currentCategoryAccountId],
		references: [chartOfAccounts.id],
		relationName: "aiRecommendations_currentCategoryAccountId_chartOfAccounts_id"
	}),
	chartOfAccount_currentCoaAccountId: one(chartOfAccounts, {
		fields: [aiRecommendations.currentCoaAccountId],
		references: [chartOfAccounts.id],
		relationName: "aiRecommendations_currentCoaAccountId_chartOfAccounts_id"
	}),
	contact_currentContactId: one(contacts, {
		fields: [aiRecommendations.currentContactId],
		references: [contacts.id],
		relationName: "aiRecommendations_currentContactId_contacts_id"
	}),
	organization: one(organizations, {
		fields: [aiRecommendations.organizationId],
		references: [organizations.id]
	}),
	user_revertedByUserId: one(users, {
		fields: [aiRecommendations.revertedByUserId],
		references: [users.id],
		relationName: "aiRecommendations_revertedByUserId_users_id"
	}),
	chartOfAccount_suggestedCategoryAccountId: one(chartOfAccounts, {
		fields: [aiRecommendations.suggestedCategoryAccountId],
		references: [chartOfAccounts.id],
		relationName: "aiRecommendations_suggestedCategoryAccountId_chartOfAccounts_id"
	}),
	chartOfAccount_suggestedCoaAccountId: one(chartOfAccounts, {
		fields: [aiRecommendations.suggestedCoaAccountId],
		references: [chartOfAccounts.id],
		relationName: "aiRecommendations_suggestedCoaAccountId_chartOfAccounts_id"
	}),
	contact_suggestedContactId: one(contacts, {
		fields: [aiRecommendations.suggestedContactId],
		references: [contacts.id],
		relationName: "aiRecommendations_suggestedContactId_contacts_id"
	}),
	transaction: one(transactions, {
		fields: [aiRecommendations.transactionId],
		references: [transactions.id]
	}),
}));

export const contactsRelations = relations(contacts, ({many}) => ({
	aiRecommendations_contactId: many(aiRecommendations, {
		relationName: "aiRecommendations_contactId_contacts_id"
	}),
	aiRecommendations_currentContactId: many(aiRecommendations, {
		relationName: "aiRecommendations_currentContactId_contacts_id"
	}),
	aiRecommendations_suggestedContactId: many(aiRecommendations, {
		relationName: "aiRecommendations_suggestedContactId_contacts_id"
	}),
	contactProfiles: many(contactProfiles),
	generalLedgers: many(generalLedger),
	journalEntryLines: many(journalEntryLines),
	transactions: many(transactions),
}));

export const chartOfAccountsRelations = relations(chartOfAccounts, ({one, many}) => ({
	aiRecommendations_currentCategoryAccountId: many(aiRecommendations, {
		relationName: "aiRecommendations_currentCategoryAccountId_chartOfAccounts_id"
	}),
	aiRecommendations_currentCoaAccountId: many(aiRecommendations, {
		relationName: "aiRecommendations_currentCoaAccountId_chartOfAccounts_id"
	}),
	aiRecommendations_suggestedCategoryAccountId: many(aiRecommendations, {
		relationName: "aiRecommendations_suggestedCategoryAccountId_chartOfAccounts_id"
	}),
	aiRecommendations_suggestedCoaAccountId: many(aiRecommendations, {
		relationName: "aiRecommendations_suggestedCoaAccountId_chartOfAccounts_id"
	}),
	organization: one(organizations, {
		fields: [chartOfAccounts.organizationId],
		references: [organizations.id]
	}),
	chartOfAccount_parentAccountId: one(chartOfAccounts, {
		fields: [chartOfAccounts.parentAccountId],
		references: [chartOfAccounts.id],
		relationName: "chartOfAccounts_parentAccountId_chartOfAccounts_id"
	}),
	chartOfAccounts_parentAccountId: many(chartOfAccounts, {
		relationName: "chartOfAccounts_parentAccountId_chartOfAccounts_id"
	}),
	chartOfAccount_suggestedMatchCoaId: one(chartOfAccounts, {
		fields: [chartOfAccounts.suggestedMatchCoaId],
		references: [chartOfAccounts.id],
		relationName: "chartOfAccounts_suggestedMatchCoaId_chartOfAccounts_id"
	}),
	chartOfAccounts_suggestedMatchCoaId: many(chartOfAccounts, {
		relationName: "chartOfAccounts_suggestedMatchCoaId_chartOfAccounts_id"
	}),
	importedTransactions: many(importedTransactions),
	imports: many(imports),
	invoices: many(invoices),
	journalEntryLines: many(journalEntryLines),
	plaidAccounts: many(plaidAccounts),
	transactions: many(transactions),
}));

export const organizationsRelations = relations(organizations, ({one, many}) => ({
	aiRecommendations: many(aiRecommendations),
	chartOfAccounts: many(chartOfAccounts),
	dashboardSnapshots: many(dashboardSnapshots),
	enterpriseClients: many(enterpriseClients),
	enterpriseStaffs: many(enterpriseStaff),
	exportJobs: many(exportJobs),
	columnPresets: many(columnPresets),
	importedTransactions: many(importedTransactions),
	imports: many(imports),
	orgSyncStatuses: many(orgSyncStatus),
	organizationSupportUsers: many(organizationSupportUsers),
	organizationUserInvites: many(organizationUserInvites),
	journalEntries: many(journalEntries),
	user_clientId: one(users, {
		fields: [organizations.clientId],
		references: [users.id],
		relationName: "organizations_clientId_users_id"
	}),
	user_ownerUserId: one(users, {
		fields: [organizations.ownerUserId],
		references: [users.id],
		relationName: "organizations_ownerUserId_users_id"
	}),
	plaidAccounts: many(plaidAccounts),
	qboMirroringJobs: many(qboMirroringJobs),
	qboOauthStates: many(qboOauthStates),
	qboMigrationJobs: many(qboMigrationJobs),
	qboConnections: many(qboConnections),
	resolutionPacketExports: many(resolutionPacketExports),
	resolutionPackets: many(resolutionPackets),
	scheduledExports: many(scheduledExports),
	tasks: many(tasks),
}));

export const transactionsRelations = relations(transactions, ({one, many}) => ({
	aiRecommendations: many(aiRecommendations),
	transactionSplits: many(transactionSplits),
	statementLines: many(statementLines),
	chartOfAccount: one(chartOfAccounts, {
		fields: [transactions.categoryAccountId],
		references: [chartOfAccounts.id]
	}),
	contact: one(contacts, {
		fields: [transactions.contactId],
		references: [contacts.id]
	}),
	import: one(imports, {
		fields: [transactions.importId],
		references: [imports.id]
	}),
	reconciliationMatches: many(reconciliationMatches),
}));

export const coaHygieneSweepItemsRelations = relations(coaHygieneSweepItems, ({one}) => ({
	coaHygieneSweep: one(coaHygieneSweeps, {
		fields: [coaHygieneSweepItems.sweepId],
		references: [coaHygieneSweeps.id]
	}),
}));

export const coaHygieneSweepsRelations = relations(coaHygieneSweeps, ({many}) => ({
	coaHygieneSweepItems: many(coaHygieneSweepItems),
}));

export const contactProfilesRelations = relations(contactProfiles, ({one}) => ({
	contact: one(contacts, {
		fields: [contactProfiles.contactId],
		references: [contacts.id]
	}),
}));

export const dashboardSnapshotsRelations = relations(dashboardSnapshots, ({one}) => ({
	organization: one(organizations, {
		fields: [dashboardSnapshots.orgId],
		references: [organizations.id]
	}),
}));

export const documentVersionsRelations = relations(documentVersions, ({one}) => ({
	documentRecord: one(documentRecords, {
		fields: [documentVersions.documentRecordId],
		references: [documentRecords.id]
	}),
}));

export const documentRecordsRelations = relations(documentRecords, ({many}) => ({
	documentVersions: many(documentVersions),
	documentAuditEvents: many(documentAuditEvents),
}));

export const enterpriseClientsRelations = relations(enterpriseClients, ({one}) => ({
	user: one(users, {
		fields: [enterpriseClients.clientUserId],
		references: [users.id]
	}),
	organization: one(organizations, {
		fields: [enterpriseClients.enterpriseId],
		references: [organizations.id]
	}),
}));

export const enterpriseStaffRelations = relations(enterpriseStaff, ({one}) => ({
	organization: one(organizations, {
		fields: [enterpriseStaff.enterpriseId],
		references: [organizations.id]
	}),
	user: one(users, {
		fields: [enterpriseStaff.staffUserId],
		references: [users.id]
	}),
}));

export const exportJobsRelations = relations(exportJobs, ({one}) => ({
	organization: one(organizations, {
		fields: [exportJobs.organizationId],
		references: [organizations.id]
	}),
	user: one(users, {
		fields: [exportJobs.userId],
		references: [users.id]
	}),
	columnPreset: one(columnPresets, {
		fields: [exportJobs.columnPresetId],
		references: [columnPresets.id]
	}),
}));

export const columnPresetsRelations = relations(columnPresets, ({one, many}) => ({
	exportJobs: many(exportJobs),
	organization: one(organizations, {
		fields: [columnPresets.organizationId],
		references: [organizations.id]
	}),
	user: one(users, {
		fields: [columnPresets.userId],
		references: [users.id]
	}),
	scheduledExports: many(scheduledExports),
}));

export const documentAuditEventsRelations = relations(documentAuditEvents, ({one}) => ({
	documentRecord: one(documentRecords, {
		fields: [documentAuditEvents.documentRecordId],
		references: [documentRecords.id]
	}),
}));

export const importedTransactionsRelations = relations(importedTransactions, ({one}) => ({
	chartOfAccount: one(chartOfAccounts, {
		fields: [importedTransactions.accountId],
		references: [chartOfAccounts.id]
	}),
	import: one(imports, {
		fields: [importedTransactions.importId],
		references: [imports.id]
	}),
	organization: one(organizations, {
		fields: [importedTransactions.organizationId],
		references: [organizations.id]
	}),
	plaidAccount: one(plaidAccounts, {
		fields: [importedTransactions.plaidAccountId],
		references: [plaidAccounts.id]
	}),
}));

export const importsRelations = relations(imports, ({one, many}) => ({
	importedTransactions: many(importedTransactions),
	chartOfAccount: one(chartOfAccounts, {
		fields: [imports.accountId],
		references: [chartOfAccounts.id]
	}),
	organization: one(organizations, {
		fields: [imports.organizationId],
		references: [organizations.id]
	}),
	transactions: many(transactions),
}));

export const plaidAccountsRelations = relations(plaidAccounts, ({one, many}) => ({
	importedTransactions: many(importedTransactions),
	plaidRawTransactions: many(plaidRawTransactions),
	plaidSyncBatches: many(plaidSyncBatches),
	chartOfAccount: one(chartOfAccounts, {
		fields: [plaidAccounts.chartOfAccountId],
		references: [chartOfAccounts.id]
	}),
	organization: one(organizations, {
		fields: [plaidAccounts.linkedOrganizationId],
		references: [organizations.id]
	}),
	user: one(users, {
		fields: [plaidAccounts.userId],
		references: [users.id]
	}),
}));

export const invoicesRelations = relations(invoices, ({one}) => ({
	chartOfAccount: one(chartOfAccounts, {
		fields: [invoices.arAccountId],
		references: [chartOfAccounts.id]
	}),
	journalEntry: one(journalEntries, {
		fields: [invoices.journalEntryId],
		references: [journalEntries.id]
	}),
}));

export const journalEntriesRelations = relations(journalEntries, ({one, many}) => ({
	invoices: many(invoices),
	generalLedgers: many(generalLedger),
	organization: one(organizations, {
		fields: [journalEntries.organizationId],
		references: [organizations.id]
	}),
	journalEntryLines: many(journalEntryLines),
}));

export const generalLedgerRelations = relations(generalLedger, ({one}) => ({
	contact: one(contacts, {
		fields: [generalLedger.contactId],
		references: [contacts.id]
	}),
	journalEntry: one(journalEntries, {
		fields: [generalLedger.journalEntryId],
		references: [journalEntries.id]
	}),
	journalEntryLine: one(journalEntryLines, {
		fields: [generalLedger.journalEntryLineId],
		references: [journalEntryLines.id]
	}),
}));

export const journalEntryLinesRelations = relations(journalEntryLines, ({one, many}) => ({
	generalLedgers: many(generalLedger),
	chartOfAccount: one(chartOfAccounts, {
		fields: [journalEntryLines.accountId],
		references: [chartOfAccounts.id]
	}),
	contact: one(contacts, {
		fields: [journalEntryLines.contactId],
		references: [contacts.id]
	}),
	journalEntry: one(journalEntries, {
		fields: [journalEntryLines.journalEntryId],
		references: [journalEntries.id]
	}),
}));

export const orgSyncStatusRelations = relations(orgSyncStatus, ({one}) => ({
	organization: one(organizations, {
		fields: [orgSyncStatus.orgId],
		references: [organizations.id]
	}),
}));

export const organizationSupportUsersRelations = relations(organizationSupportUsers, ({one}) => ({
	organization: one(organizations, {
		fields: [organizationSupportUsers.organizationId],
		references: [organizations.id]
	}),
	user: one(users, {
		fields: [organizationSupportUsers.supportUserId],
		references: [users.id]
	}),
}));

export const organizationUserInvitesRelations = relations(organizationUserInvites, ({one}) => ({
	user: one(users, {
		fields: [organizationUserInvites.inviterId],
		references: [users.id]
	}),
	organization: one(organizations, {
		fields: [organizationUserInvites.orgId],
		references: [organizations.id]
	}),
}));

export const payrollRunsRelations = relations(payrollRuns, ({one, many}) => ({
	payrollSchedule: one(payrollSchedules, {
		fields: [payrollRuns.payScheduleId],
		references: [payrollSchedules.id]
	}),
	payrollLineItems: many(payrollLineItems),
}));

export const payrollSchedulesRelations = relations(payrollSchedules, ({many}) => ({
	payrollRuns: many(payrollRuns),
}));

export const payrollEmployeesRelations = relations(payrollEmployees, ({one, many}) => ({
	payrollBenefitEnrollment: one(payrollBenefitEnrollments, {
		fields: [payrollEmployees.benefitsEnrollmentId],
		references: [payrollBenefitEnrollments.id],
		relationName: "payrollEmployees_benefitsEnrollmentId_payrollBenefitEnrollments_id"
	}),
	payrollTaxInfo: one(payrollTaxInfo, {
		fields: [payrollEmployees.taxInfoId],
		references: [payrollTaxInfo.id],
		relationName: "payrollEmployees_taxInfoId_payrollTaxInfo_id"
	}),
	payrollLineItems: many(payrollLineItems),
	payrollTaxInfos: many(payrollTaxInfo, {
		relationName: "payrollTaxInfo_employeeId_payrollEmployees_id"
	}),
	payrollBenefitEnrollments: many(payrollBenefitEnrollments, {
		relationName: "payrollBenefitEnrollments_employeeId_payrollEmployees_id"
	}),
}));

export const payrollBenefitEnrollmentsRelations = relations(payrollBenefitEnrollments, ({one, many}) => ({
	payrollEmployees: many(payrollEmployees, {
		relationName: "payrollEmployees_benefitsEnrollmentId_payrollBenefitEnrollments_id"
	}),
	payrollEmployee: one(payrollEmployees, {
		fields: [payrollBenefitEnrollments.employeeId],
		references: [payrollEmployees.id],
		relationName: "payrollBenefitEnrollments_employeeId_payrollEmployees_id"
	}),
}));

export const payrollTaxInfoRelations = relations(payrollTaxInfo, ({one, many}) => ({
	payrollEmployees: many(payrollEmployees, {
		relationName: "payrollEmployees_taxInfoId_payrollTaxInfo_id"
	}),
	payrollEmployee: one(payrollEmployees, {
		fields: [payrollTaxInfo.employeeId],
		references: [payrollEmployees.id],
		relationName: "payrollTaxInfo_employeeId_payrollEmployees_id"
	}),
}));

export const payrollLineItemsRelations = relations(payrollLineItems, ({one}) => ({
	payrollContractor: one(payrollContractors, {
		fields: [payrollLineItems.contractorId],
		references: [payrollContractors.id]
	}),
	payrollEmployee: one(payrollEmployees, {
		fields: [payrollLineItems.employeeId],
		references: [payrollEmployees.id]
	}),
	payrollRun: one(payrollRuns, {
		fields: [payrollLineItems.payrollRunId],
		references: [payrollRuns.id]
	}),
}));

export const payrollContractorsRelations = relations(payrollContractors, ({many}) => ({
	payrollLineItems: many(payrollLineItems),
}));

export const plaidRawTransactionsRelations = relations(plaidRawTransactions, ({one}) => ({
	plaidAccount: one(plaidAccounts, {
		fields: [plaidRawTransactions.plaidAccountId],
		references: [plaidAccounts.id]
	}),
}));

export const plaidSyncBatchesRelations = relations(plaidSyncBatches, ({one}) => ({
	plaidAccount: one(plaidAccounts, {
		fields: [plaidSyncBatches.plaidAccountId],
		references: [plaidAccounts.id]
	}),
}));

export const qboAccountStagingRelations = relations(qboAccountStaging, ({one}) => ({
	qboMigrationJob: one(qboMigrationJobs, {
		fields: [qboAccountStaging.migrationJobId],
		references: [qboMigrationJobs.id]
	}),
}));

export const qboMigrationJobsRelations = relations(qboMigrationJobs, ({one, many}) => ({
	qboAccountStagings: many(qboAccountStaging),
	qboCustomerStagings: many(qboCustomerStaging),
	qboInvoiceStagings: many(qboInvoiceStaging),
	qboMappingOverrides: many(qboMappingOverrides),
	qboMappingResults: many(qboMappingResults),
	qboMigrationLogs: many(qboMigrationLogs),
	qboBillStagings: many(qboBillStaging),
	qboMigrationSummaries: many(qboMigrationSummaries),
	qboPaymentStagings: many(qboPaymentStaging),
	organization: one(organizations, {
		fields: [qboMigrationJobs.orgId],
		references: [organizations.id]
	}),
	user: one(users, {
		fields: [qboMigrationJobs.userId],
		references: [users.id]
	}),
	qboVendorStagings: many(qboVendorStaging),
}));

export const qboCustomerStagingRelations = relations(qboCustomerStaging, ({one}) => ({
	qboMigrationJob: one(qboMigrationJobs, {
		fields: [qboCustomerStaging.migrationJobId],
		references: [qboMigrationJobs.id]
	}),
}));

export const qboInvoiceStagingRelations = relations(qboInvoiceStaging, ({one}) => ({
	qboMigrationJob: one(qboMigrationJobs, {
		fields: [qboInvoiceStaging.migrationJobId],
		references: [qboMigrationJobs.id]
	}),
}));

export const qboMappingOverridesRelations = relations(qboMappingOverrides, ({one}) => ({
	user: one(users, {
		fields: [qboMappingOverrides.createdByUserId],
		references: [users.id]
	}),
	qboMigrationJob: one(qboMigrationJobs, {
		fields: [qboMappingOverrides.migrationJobId],
		references: [qboMigrationJobs.id]
	}),
}));

export const qboMappingResultsRelations = relations(qboMappingResults, ({one}) => ({
	qboMigrationJob: one(qboMigrationJobs, {
		fields: [qboMappingResults.migrationJobId],
		references: [qboMigrationJobs.id]
	}),
}));

export const qboMigrationLogsRelations = relations(qboMigrationLogs, ({one}) => ({
	qboMigrationJob: one(qboMigrationJobs, {
		fields: [qboMigrationLogs.jobId],
		references: [qboMigrationJobs.id]
	}),
}));

export const qboBillStagingRelations = relations(qboBillStaging, ({one}) => ({
	qboMigrationJob: one(qboMigrationJobs, {
		fields: [qboBillStaging.migrationJobId],
		references: [qboMigrationJobs.id]
	}),
}));

export const qboMigrationSummariesRelations = relations(qboMigrationSummaries, ({one}) => ({
	qboMigrationJob: one(qboMigrationJobs, {
		fields: [qboMigrationSummaries.migrationJobId],
		references: [qboMigrationJobs.id]
	}),
}));

export const qboMirroringJobsRelations = relations(qboMirroringJobs, ({one}) => ({
	organization: one(organizations, {
		fields: [qboMirroringJobs.orgId],
		references: [organizations.id]
	}),
	user: one(users, {
		fields: [qboMirroringJobs.userId],
		references: [users.id]
	}),
}));

export const qboOauthStatesRelations = relations(qboOauthStates, ({one}) => ({
	organization: one(organizations, {
		fields: [qboOauthStates.orgId],
		references: [organizations.id]
	}),
	user: one(users, {
		fields: [qboOauthStates.userId],
		references: [users.id]
	}),
}));

export const qboPaymentStagingRelations = relations(qboPaymentStaging, ({one}) => ({
	qboMigrationJob: one(qboMigrationJobs, {
		fields: [qboPaymentStaging.migrationJobId],
		references: [qboMigrationJobs.id]
	}),
}));

export const qboConnectionsRelations = relations(qboConnections, ({one}) => ({
	organization: one(organizations, {
		fields: [qboConnections.orgId],
		references: [organizations.id]
	}),
	user: one(users, {
		fields: [qboConnections.userId],
		references: [users.id]
	}),
}));

export const resolutionPacketExportsRelations = relations(resolutionPacketExports, ({one}) => ({
	organization: one(organizations, {
		fields: [resolutionPacketExports.organizationId],
		references: [organizations.id]
	}),
	user: one(users, {
		fields: [resolutionPacketExports.userId],
		references: [users.id]
	}),
}));

export const resolutionPacketsRelations = relations(resolutionPackets, ({one}) => ({
	organization: one(organizations, {
		fields: [resolutionPackets.organizationId],
		references: [organizations.id]
	}),
	user: one(users, {
		fields: [resolutionPackets.userId],
		references: [users.id]
	}),
}));

export const rolePermissionsRelations = relations(rolePermissions, ({one}) => ({
	permission: one(permissions, {
		fields: [rolePermissions.permissionId],
		references: [permissions.id]
	}),
	role: one(roles, {
		fields: [rolePermissions.roleId],
		references: [roles.id]
	}),
}));

export const permissionsRelations = relations(permissions, ({many}) => ({
	rolePermissions: many(rolePermissions),
	userPermissionOverrides: many(userPermissionOverrides),
	permissionSetPermissions: many(permissionSetPermissions),
}));

export const rolesRelations = relations(roles, ({many}) => ({
	rolePermissions: many(rolePermissions),
	userRoles: many(userRoles),
}));

export const scheduledExportsRelations = relations(scheduledExports, ({one}) => ({
	columnPreset: one(columnPresets, {
		fields: [scheduledExports.columnPresetId],
		references: [columnPresets.id]
	}),
	organization: one(organizations, {
		fields: [scheduledExports.organizationId],
		references: [organizations.id]
	}),
	user: one(users, {
		fields: [scheduledExports.userId],
		references: [users.id]
	}),
}));

export const qboVendorStagingRelations = relations(qboVendorStaging, ({one}) => ({
	qboMigrationJob: one(qboMigrationJobs, {
		fields: [qboVendorStaging.migrationJobId],
		references: [qboMigrationJobs.id]
	}),
}));

export const transactionProcessorSourceMappingsRelations = relations(transactionProcessorSourceMappings, ({one}) => ({
	user: one(users, {
		fields: [transactionProcessorSourceMappings.updatedByUserId],
		references: [users.id]
	}),
}));

export const transactionSplitsRelations = relations(transactionSplits, ({one}) => ({
	transaction: one(transactions, {
		fields: [transactionSplits.transactionId],
		references: [transactions.id]
	}),
}));

export const userPermissionOverridesRelations = relations(userPermissionOverrides, ({one}) => ({
	permission: one(permissions, {
		fields: [userPermissionOverrides.permissionId],
		references: [permissions.id]
	}),
	user: one(users, {
		fields: [userPermissionOverrides.userId],
		references: [users.id]
	}),
}));

export const statementLinesRelations = relations(statementLines, ({one, many}) => ({
	transaction: one(transactions, {
		fields: [statementLines.matchedTransactionId],
		references: [transactions.id]
	}),
	reconciliationPeriod: one(reconciliationPeriods, {
		fields: [statementLines.reconciliationPeriodId],
		references: [reconciliationPeriods.id]
	}),
	reconciliationMatches: many(reconciliationMatches),
}));

export const reconciliationPeriodsRelations = relations(reconciliationPeriods, ({many}) => ({
	statementLines: many(statementLines),
	reconciliationMatches: many(reconciliationMatches),
}));

export const userPermissionSetsRelations = relations(userPermissionSets, ({one}) => ({
	permissionSet: one(permissionSets, {
		fields: [userPermissionSets.permissionSetId],
		references: [permissionSets.id]
	}),
	user: one(users, {
		fields: [userPermissionSets.userId],
		references: [users.id]
	}),
}));

export const permissionSetsRelations = relations(permissionSets, ({many}) => ({
	userPermissionSets: many(userPermissionSets),
	permissionSetPermissions: many(permissionSetPermissions),
}));

export const userRolesRelations = relations(userRoles, ({one}) => ({
	role: one(roles, {
		fields: [userRoles.roleId],
		references: [roles.id]
	}),
	user: one(users, {
		fields: [userRoles.userId],
		references: [users.id]
	}),
}));

export const tasksRelations = relations(tasks, ({one}) => ({
	organization: one(organizations, {
		fields: [tasks.organizationId],
		references: [organizations.id]
	}),
}));

export const goalProgressRelations = relations(goalProgress, ({one}) => ({
	goal: one(goals, {
		fields: [goalProgress.goalId],
		references: [goals.id]
	}),
}));

export const goalsRelations = relations(goals, ({many}) => ({
	goalProgresses: many(goalProgress),
}));

export const openingBalanceLinesRelations = relations(openingBalanceLines, ({one}) => ({
	openingBalanceBatch: one(openingBalanceBatches, {
		fields: [openingBalanceLines.batchId],
		references: [openingBalanceBatches.id]
	}),
}));

export const openingBalanceBatchesRelations = relations(openingBalanceBatches, ({many}) => ({
	openingBalanceLines: many(openingBalanceLines),
}));

export const permissionSetPermissionsRelations = relations(permissionSetPermissions, ({one}) => ({
	permission: one(permissions, {
		fields: [permissionSetPermissions.permissionId],
		references: [permissions.id]
	}),
	permissionSet: one(permissionSets, {
		fields: [permissionSetPermissions.permissionSetId],
		references: [permissionSets.id]
	}),
}));

export const reconciliationMatchesRelations = relations(reconciliationMatches, ({one}) => ({
	reconciliationPeriod: one(reconciliationPeriods, {
		fields: [reconciliationMatches.reconciliationPeriodId],
		references: [reconciliationPeriods.id]
	}),
	statementLine: one(statementLines, {
		fields: [reconciliationMatches.statementLineId],
		references: [statementLines.id]
	}),
	transaction: one(transactions, {
		fields: [reconciliationMatches.transactionId],
		references: [transactions.id]
	}),
}));