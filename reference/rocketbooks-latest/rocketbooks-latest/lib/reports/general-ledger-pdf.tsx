import 'server-only';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { GeneralLedgerData, GeneralLedgerSection } from './general-ledger-data';

const COLORS = {
  ink: '#0f172a',
  body: '#1f2937',
  muted: '#64748b',
  divider: '#cbd5e1',
  rule: '#0f172a',
  band: '#f1f5f9',
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingBottom: 56,
    paddingHorizontal: 36,
    fontFamily: 'Helvetica',
    fontSize: 9,
    color: COLORS.body,
  },
  header: {
    textAlign: 'center',
    marginBottom: 18,
  },
  org: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 15,
    color: COLORS.ink,
  },
  title: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 11,
    letterSpacing: 2,
    color: COLORS.ink,
    marginTop: 4,
  },
  period: {
    fontSize: 9,
    color: COLORS.muted,
    marginTop: 4,
  },
  topRule: {
    borderBottomWidth: 1.25,
    borderBottomColor: COLORS.rule,
    marginBottom: 12,
  },
  // Per-account section
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 5,
    paddingHorizontal: 4,
    backgroundColor: COLORS.ink,
    marginTop: 12,
  },
  sectionHeaderText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 10,
    color: '#ffffff',
  },
  sectionHeaderMeta: {
    fontFamily: 'Helvetica',
    fontSize: 8.5,
    color: '#cbd5e1',
  },
  columnHeaderRow: {
    flexDirection: 'row',
    paddingVertical: 4,
    paddingHorizontal: 4,
    backgroundColor: COLORS.band,
    borderBottomWidth: 0.75,
    borderBottomColor: COLORS.divider,
  },
  columnHeaderText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 8,
    letterSpacing: 0.5,
    color: COLORS.ink,
  },
  row: {
    flexDirection: 'row',
    paddingVertical: 3,
    paddingHorizontal: 4,
    alignItems: 'flex-start',
  },
  zebra: { backgroundColor: '#fafafa' },
  // Column widths sum to ~540pt (LETTER usable width is 540 at 36pt margins)
  date: { width: 56, color: COLORS.muted, fontSize: 8.5 },
  memo: { flex: 1, paddingRight: 6 },
  contact: { width: 100, paddingRight: 6, fontSize: 8.5 },
  source: { width: 56, color: COLORS.muted, fontSize: 8 },
  amount: { width: 70, textAlign: 'right' },
  balance: { width: 80, textAlign: 'right' },
  totalRow: {
    flexDirection: 'row',
    paddingVertical: 5,
    paddingHorizontal: 4,
    marginTop: 2,
    borderTopWidth: 0.75,
    borderTopColor: COLORS.ink,
  },
  totalLabel: {
    flex: 1,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
  },
  totalAmount: {
    width: 70,
    textAlign: 'right',
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
  },
  totalBalance: {
    width: 80,
    textAlign: 'right',
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
  },
  emptyRow: {
    paddingVertical: 6,
    paddingHorizontal: 4,
    color: COLORS.muted,
    fontStyle: 'italic',
    fontSize: 9,
  },
  cappedNote: {
    paddingTop: 4,
    paddingHorizontal: 4,
    color: '#b45309',
    fontStyle: 'italic',
    fontSize: 8,
  },
  grandTotalRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    paddingHorizontal: 4,
    marginTop: 14,
    borderTopWidth: 1.25,
    borderTopColor: COLORS.ink,
    borderBottomWidth: 3,
    borderBottomColor: COLORS.ink,
  },
  grandTotalLabel: {
    flex: 1,
    fontFamily: 'Helvetica-Bold',
    fontSize: 11,
    letterSpacing: 1,
    color: COLORS.ink,
  },
  grandTotalAmount: {
    width: 70,
    textAlign: 'right',
    fontFamily: 'Helvetica-Bold',
    fontSize: 11,
    color: COLORS.ink,
  },
  empty: {
    paddingVertical: 24,
    textAlign: 'center',
    color: COLORS.muted,
    fontStyle: 'italic',
  },
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 36,
    right: 36,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 8,
    color: COLORS.muted,
  },
});

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

const formatLong = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
};

function sourceLabel(sourceType: string | null): string {
  if (!sourceType) return '';
  return sourceType.charAt(0).toUpperCase() + sourceType.slice(1);
}

function Section({ section }: { section: GeneralLedgerSection }) {
  return (
    <View>
      <View style={styles.sectionHeader} wrap={false}>
        <Text style={styles.sectionHeaderText}>
          {section.accountNumber ? `${section.accountNumber} · ` : ''}{section.accountName}
        </Text>
        {section.gaapType && (
          <Text style={styles.sectionHeaderMeta}>{section.gaapType}</Text>
        )}
      </View>

      <View style={styles.columnHeaderRow} wrap={false}>
        <Text style={[styles.columnHeaderText, styles.date]}>DATE</Text>
        <Text style={[styles.columnHeaderText, styles.memo]}>MEMO</Text>
        <Text style={[styles.columnHeaderText, styles.contact]}>CONTACT</Text>
        <Text style={[styles.columnHeaderText, styles.source]}>SOURCE</Text>
        <Text style={[styles.columnHeaderText, styles.amount]}>DEBIT</Text>
        <Text style={[styles.columnHeaderText, styles.amount]}>CREDIT</Text>
        <Text style={[styles.columnHeaderText, styles.balance]}>BALANCE</Text>
      </View>

      {section.entries.length === 0 ? (
        <Text style={styles.emptyRow}>No entries.</Text>
      ) : (
        section.entries.map((e, i) => (
          <View key={e.id} style={[styles.row, i % 2 === 1 ? styles.zebra : {}]} wrap={false}>
            <Text style={styles.date}>{e.date}</Text>
            <Text style={styles.memo}>{e.memo ?? e.jeMemo ?? '—'}</Text>
            <Text style={styles.contact}>{e.contactName ?? ''}</Text>
            <Text style={styles.source}>{sourceLabel(e.sourceType)}</Text>
            <Text style={styles.amount}>{e.debit > 0 ? fmt(e.debit) : ''}</Text>
            <Text style={styles.amount}>{e.credit > 0 ? fmt(e.credit) : ''}</Text>
            <Text style={styles.balance}>{fmt(e.runningBalance)}</Text>
          </View>
        ))
      )}

      {section.capped && (
        <Text style={styles.cappedNote}>
          Truncated — narrow the date range to see all entries for this account.
        </Text>
      )}

      <View style={styles.totalRow} wrap={false}>
        <Text style={styles.totalLabel}>Total · ending balance</Text>
        <Text style={styles.totalAmount}>{fmt(section.totalDebit)}</Text>
        <Text style={styles.totalAmount}>{fmt(section.totalCredit)}</Text>
        <Text style={styles.totalBalance}>{fmt(section.endingBalance)}</Text>
      </View>
    </View>
  );
}

export function GeneralLedgerPdf(props: GeneralLedgerData) {
  const { organizationName, fromDate, toDate, sections, totalDebit, totalCredit } = props;

  const generatedAt = new Date().toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <Document
      title={`General Ledger ${fromDate} to ${toDate}`}
      author={organizationName}
      subject="General Ledger"
    >
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.org}>{organizationName}</Text>
          <Text style={styles.title}>GENERAL LEDGER</Text>
          <Text style={styles.period}>
            {formatLong(fromDate)} — {formatLong(toDate)}
          </Text>
        </View>
        <View style={styles.topRule} />

        {sections.length === 0 ? (
          <Text style={styles.empty}>No journal-entry activity in this period.</Text>
        ) : (
          sections.map((s) => <Section key={s.accountId} section={s} />)
        )}

        {sections.length > 0 && (
          <View style={styles.grandTotalRow} wrap={false}>
            <Text style={styles.grandTotalLabel}>GRAND TOTALS</Text>
            <Text style={styles.grandTotalAmount}>{fmt(totalDebit)}</Text>
            <Text style={styles.grandTotalAmount}>{fmt(totalCredit)}</Text>
            <Text style={[styles.grandTotalAmount, { width: 80 }]}> </Text>
          </View>
        )}

        <View style={styles.footer} fixed>
          <Text>Generated {generatedAt}</Text>
          <Text
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  );
}
