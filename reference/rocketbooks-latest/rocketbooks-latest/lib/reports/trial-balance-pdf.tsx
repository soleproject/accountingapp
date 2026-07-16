import 'server-only';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TrialBalanceData } from './trial-balance-data';

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
    paddingTop: 48,
    paddingBottom: 56,
    paddingHorizontal: 56,
    fontFamily: 'Helvetica',
    fontSize: 10,
    color: COLORS.body,
  },
  header: {
    textAlign: 'center',
    marginBottom: 24,
  },
  org: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 16,
    color: COLORS.ink,
  },
  title: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 12,
    letterSpacing: 2,
    color: COLORS.ink,
    marginTop: 4,
  },
  period: {
    fontSize: 9.5,
    color: COLORS.muted,
    marginTop: 4,
  },
  topRule: {
    borderBottomWidth: 1.25,
    borderBottomColor: COLORS.rule,
    marginBottom: 14,
  },
  columnHeaderRow: {
    flexDirection: 'row',
    paddingVertical: 5,
    paddingHorizontal: 4,
    backgroundColor: COLORS.band,
    borderBottomWidth: 0.75,
    borderBottomColor: COLORS.divider,
  },
  columnHeaderText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 9,
    letterSpacing: 1,
    color: COLORS.ink,
  },
  row: {
    flexDirection: 'row',
    paddingVertical: 3.5,
    paddingHorizontal: 4,
    alignItems: 'center',
  },
  zebra: { backgroundColor: '#fafafa' },
  acctNum: { width: 56, color: COLORS.muted, fontSize: 9 },
  acctName: { flex: 1, paddingRight: 8 },
  gaap: { width: 110, color: COLORS.muted, fontSize: 9 },
  amount: { width: 96, textAlign: 'right' },
  totalRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    paddingHorizontal: 4,
    marginTop: 6,
    borderTopWidth: 1.25,
    borderTopColor: COLORS.ink,
    borderBottomWidth: 3,
    borderBottomColor: COLORS.ink,
  },
  totalLabel: {
    flex: 1,
    fontFamily: 'Helvetica-Bold',
    fontSize: 11,
    letterSpacing: 1,
    color: COLORS.ink,
  },
  totalAmount: {
    width: 96,
    textAlign: 'right',
    fontFamily: 'Helvetica-Bold',
    fontSize: 11,
    color: COLORS.ink,
  },
  emptyRow: {
    paddingVertical: 12,
    paddingHorizontal: 4,
    color: COLORS.muted,
    fontStyle: 'italic',
    fontSize: 9,
    textAlign: 'center',
  },
  imbalance: {
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: '#fee2e2',
    color: '#991b1b',
    fontFamily: 'Helvetica-Bold',
    fontSize: 10,
  },
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 56,
    right: 56,
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

export function TrialBalancePdf(props: TrialBalanceData) {
  const { organizationName, asOfDate, rows, totalDebit, totalCredit, balanced } = props;

  const generatedAt = new Date().toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <Document
      title={`Trial Balance ${asOfDate}`}
      author={organizationName}
      subject="Trial Balance"
    >
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.org}>{organizationName}</Text>
          <Text style={styles.title}>TRIAL BALANCE</Text>
          <Text style={styles.period}>As of {formatLong(asOfDate)}</Text>
        </View>
        <View style={styles.topRule} />

        <View style={styles.columnHeaderRow}>
          <Text style={[styles.columnHeaderText, styles.acctNum]}>#</Text>
          <Text style={[styles.columnHeaderText, styles.acctName]}>ACCOUNT</Text>
          <Text style={[styles.columnHeaderText, styles.gaap]}>GAAP</Text>
          <Text style={[styles.columnHeaderText, styles.amount]}>DEBIT</Text>
          <Text style={[styles.columnHeaderText, styles.amount]}>CREDIT</Text>
        </View>

        {rows.length === 0 ? (
          <Text style={styles.emptyRow}>No balances as of {asOfDate}.</Text>
        ) : (
          rows.map((r, i) => (
            <View
              key={r.accountId}
              style={[styles.row, i % 2 === 1 ? styles.zebra : {}]}
            >
              <Text style={styles.acctNum}>{r.accountNumber ?? ''}</Text>
              <Text style={styles.acctName}>{r.accountName}</Text>
              <Text style={styles.gaap}>{r.gaapType ?? ''}</Text>
              <Text style={styles.amount}>{r.netDebit > 0 ? fmt(r.netDebit) : ''}</Text>
              <Text style={styles.amount}>{r.netCredit > 0 ? fmt(r.netCredit) : ''}</Text>
            </View>
          ))
        )}

        <View style={styles.totalRow} wrap={false}>
          <Text style={styles.totalLabel}>
            TOTALS · {balanced ? '✓ Balanced' : `Diff: ${fmt(Math.abs(totalDebit - totalCredit))}`}
          </Text>
          <Text style={styles.totalAmount}>{fmt(totalDebit)}</Text>
          <Text style={styles.totalAmount}>{fmt(totalCredit)}</Text>
        </View>

        {!balanced && (
          <View style={styles.imbalance}>
            <Text>
              Trial balance is out of balance — debits and credits do not match.
            </Text>
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
