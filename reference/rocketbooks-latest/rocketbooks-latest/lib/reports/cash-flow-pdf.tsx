import 'server-only';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { CashFlowData, CashFlowSection } from './cash-flow-data';

const COLORS = {
  ink: '#0f172a',
  body: '#1f2937',
  muted: '#64748b',
  divider: '#cbd5e1',
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
  header: { textAlign: 'center', marginBottom: 18 },
  org: { fontFamily: 'Helvetica-Bold', fontSize: 16, color: COLORS.ink },
  title: { fontFamily: 'Helvetica-Bold', fontSize: 12, letterSpacing: 2, color: COLORS.ink, marginTop: 4 },
  period: { fontSize: 9.5, color: COLORS.muted, marginTop: 4 },
  topRule: { borderBottomWidth: 1.25, borderBottomColor: COLORS.ink, marginBottom: 14 },

  beginRow: {
    flexDirection: 'row',
    paddingVertical: 6,
    paddingHorizontal: 4,
    backgroundColor: COLORS.band,
    marginBottom: 8,
  },
  beginLabel: { flex: 1, fontFamily: 'Helvetica-Bold', color: COLORS.ink },
  beginAmount: { width: 110, textAlign: 'right', fontFamily: 'Helvetica-Bold', color: COLORS.ink },

  sectionHeader: {
    flexDirection: 'row',
    paddingVertical: 5,
    paddingHorizontal: 4,
    backgroundColor: COLORS.ink,
    marginTop: 12,
  },
  sectionHeaderText: { fontFamily: 'Helvetica-Bold', fontSize: 10, letterSpacing: 1.5, color: '#ffffff' },

  columnHeaderRow: {
    flexDirection: 'row',
    paddingVertical: 4,
    paddingHorizontal: 4,
    backgroundColor: COLORS.band,
    borderBottomWidth: 0.75,
    borderBottomColor: COLORS.divider,
  },
  columnHeaderText: { fontFamily: 'Helvetica-Bold', fontSize: 8.5, letterSpacing: 0.5, color: COLORS.ink },

  row: {
    flexDirection: 'row',
    paddingVertical: 3.5,
    paddingHorizontal: 4,
    alignItems: 'center',
  },
  zebra: { backgroundColor: '#fafafa' },
  acctNum: { width: 56, color: COLORS.muted, fontSize: 9 },
  acctName: { flex: 1, paddingRight: 6 },
  amount: { width: 88, textAlign: 'right' },
  net: { width: 88, textAlign: 'right' },

  sectionTotal: {
    flexDirection: 'row',
    paddingVertical: 6,
    paddingHorizontal: 4,
    marginTop: 4,
    borderTopWidth: 0.75,
    borderTopColor: COLORS.ink,
  },
  sectionTotalLabel: { flex: 1, fontFamily: 'Helvetica-Bold', color: COLORS.ink },
  sectionTotalAmount: {
    width: 88,
    textAlign: 'right',
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
  },

  netChangeRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    paddingHorizontal: 4,
    marginTop: 14,
    borderTopWidth: 1.25,
    borderTopColor: COLORS.ink,
    borderBottomWidth: 1.25,
    borderBottomColor: COLORS.ink,
  },
  netChangeLabel: { flex: 1, fontFamily: 'Helvetica-Bold', fontSize: 11, color: COLORS.ink },
  netChangeAmount: { width: 110, textAlign: 'right', fontFamily: 'Helvetica-Bold', fontSize: 11, color: COLORS.ink },

  endRow: {
    flexDirection: 'row',
    paddingVertical: 10,
    paddingHorizontal: 4,
    marginTop: 8,
    borderTopWidth: 1.25,
    borderTopColor: COLORS.ink,
    borderBottomWidth: 3,
    borderBottomColor: COLORS.ink,
  },
  endLabel: { flex: 1, fontFamily: 'Helvetica-Bold', fontSize: 12, letterSpacing: 1, color: COLORS.ink },
  endAmount: { width: 110, textAlign: 'right', fontFamily: 'Helvetica-Bold', fontSize: 12, color: COLORS.ink },

  empty: { paddingVertical: 24, textAlign: 'center', color: COLORS.muted, fontStyle: 'italic' },

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

function Section({ section, mode }: { section: CashFlowSection; mode: 'simple' | 'real' }) {
  return (
    <View>
      <View style={styles.sectionHeader} wrap={false}>
        <Text style={styles.sectionHeaderText}>{section.title.toUpperCase()}</Text>
      </View>
      <View style={styles.columnHeaderRow} wrap={false}>
        <Text style={[styles.columnHeaderText, styles.acctNum]}>#</Text>
        <Text style={[styles.columnHeaderText, styles.acctName]}>ACCOUNT</Text>
        <Text style={[styles.columnHeaderText, styles.amount]}>CASH IN</Text>
        <Text style={[styles.columnHeaderText, styles.amount]}>CASH OUT</Text>
        <Text style={[styles.columnHeaderText, styles.net]}>NET</Text>
      </View>
      {section.rows.map((r, i) => (
        <View key={r.accountId ?? `${section.id}-${i}`} style={[styles.row, i % 2 === 1 ? styles.zebra : {}]} wrap={false}>
          <Text style={styles.acctNum}>{r.accountNumber ?? ''}</Text>
          <Text style={styles.acctName}>{r.accountName}</Text>
          <Text style={styles.amount}>{r.inflow > 0 ? fmt(r.inflow) : ''}</Text>
          <Text style={styles.amount}>{r.outflow > 0 ? fmt(r.outflow) : ''}</Text>
          <Text style={styles.net}>{fmt(r.net)}</Text>
        </View>
      ))}
      <View style={styles.sectionTotal} wrap={false}>
        <Text style={styles.sectionTotalLabel}>
          {mode === 'real' ? `Net cash from ${section.title.toLowerCase()}` : `Total ${section.title.toLowerCase()}`}
        </Text>
        <Text style={styles.sectionTotalAmount}>{fmt(section.inflow)}</Text>
        <Text style={styles.sectionTotalAmount}>{fmt(section.outflow)}</Text>
        <Text style={styles.sectionTotalAmount}>{fmt(section.net)}</Text>
      </View>
    </View>
  );
}

export function CashFlowPdf(props: CashFlowData) {
  const { organizationName, fromDate, toDate, mode, sections, totals, beginningCash, endingCash } = props;
  const generatedAt = new Date().toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const titleText = mode === 'real' ? 'CASH FLOW STATEMENT' : 'CASH FLOW STATEMENT (SIMPLE)';

  return (
    <Document title={`Cash Flow ${fromDate} to ${toDate}`} author={organizationName} subject="Cash Flow">
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.org}>{organizationName}</Text>
          <Text style={styles.title}>{titleText}</Text>
          <Text style={styles.period}>
            {formatLong(fromDate)} — {formatLong(toDate)}
          </Text>
        </View>
        <View style={styles.topRule} />

        <View style={styles.beginRow} wrap={false}>
          <Text style={styles.beginLabel}>Cash at beginning of period</Text>
          <Text style={styles.beginAmount}>{fmt(beginningCash)}</Text>
        </View>

        {sections.length === 0 ? (
          <Text style={styles.empty}>No cash activity in this period.</Text>
        ) : (
          sections.map((s) => <Section key={s.id} section={s} mode={mode} />)
        )}

        <View style={styles.netChangeRow} wrap={false}>
          <Text style={styles.netChangeLabel}>Net change in cash</Text>
          <Text style={styles.netChangeAmount}>{fmt(totals.netChange)}</Text>
        </View>

        <View style={styles.endRow} wrap={false}>
          <Text style={styles.endLabel}>CASH AT END OF PERIOD</Text>
          <Text style={styles.endAmount}>{fmt(endingCash)}</Text>
        </View>

        <View style={styles.footer} fixed>
          <Text>Generated {generatedAt}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
