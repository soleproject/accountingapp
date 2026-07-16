import 'server-only';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { BalanceSheetData, BalanceSheetLine } from './balance-sheet-data';

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
  groupHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    paddingHorizontal: 4,
    backgroundColor: COLORS.ink,
    marginTop: 12,
  },
  groupHeaderText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 10,
    letterSpacing: 1.5,
    color: '#ffffff',
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 5,
    paddingHorizontal: 4,
    backgroundColor: COLORS.band,
    marginTop: 8,
  },
  sectionHeaderText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 9.5,
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
  amount: { width: 96, textAlign: 'right' },
  subtotalRow: {
    flexDirection: 'row',
    paddingTop: 6,
    paddingBottom: 4,
    paddingHorizontal: 4,
    borderTopWidth: 0.75,
    borderTopColor: COLORS.divider,
    marginTop: 2,
  },
  subtotalLabel: {
    flex: 1,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
  },
  subtotalAmount: {
    width: 96,
    textAlign: 'right',
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
  },
  groupTotalRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    paddingHorizontal: 4,
    marginTop: 4,
    borderTopWidth: 0.75,
    borderTopColor: COLORS.ink,
    borderBottomWidth: 0.75,
    borderBottomColor: COLORS.ink,
  },
  groupTotalLabel: {
    flex: 1,
    fontFamily: 'Helvetica-Bold',
    fontSize: 10.5,
    color: COLORS.ink,
  },
  groupTotalAmount: {
    width: 96,
    textAlign: 'right',
    fontFamily: 'Helvetica-Bold',
    fontSize: 10.5,
    color: COLORS.ink,
  },
  balanceRow: {
    flexDirection: 'row',
    paddingVertical: 10,
    paddingHorizontal: 4,
    marginTop: 14,
    borderTopWidth: 1.25,
    borderTopColor: COLORS.ink,
    borderBottomWidth: 3,
    borderBottomColor: COLORS.ink,
  },
  balanceLabel: {
    flex: 1,
    fontFamily: 'Helvetica-Bold',
    fontSize: 12,
    letterSpacing: 1,
    color: COLORS.ink,
  },
  balanceAmount: {
    width: 110,
    textAlign: 'right',
    fontFamily: 'Helvetica-Bold',
    fontSize: 12,
    color: COLORS.ink,
  },
  emptyRow: {
    paddingVertical: 4,
    paddingHorizontal: 4,
    color: COLORS.muted,
    fontStyle: 'italic',
    fontSize: 9,
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

interface SectionProps {
  title: string;
  lines: BalanceSheetLine[];
  total: number;
  totalLabel: string;
}

function Section({ title, lines, total, totalLabel }: SectionProps) {
  return (
    <View wrap={false}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionHeaderText}>{title.toUpperCase()}</Text>
      </View>
      {lines.length === 0 ? (
        <Text style={styles.emptyRow}>No activity in this section.</Text>
      ) : (
        lines.map((line, i) => (
          <View
            key={line.accountId}
            style={[styles.row, i % 2 === 1 ? styles.zebra : {}]}
          >
            <Text style={styles.acctNum}>{line.accountNumber}</Text>
            <Text style={styles.acctName}>{line.accountName}</Text>
            <Text style={styles.amount}>{fmt(line.balance)}</Text>
          </View>
        ))
      )}
      <View style={styles.subtotalRow}>
        <Text style={styles.subtotalLabel}>{totalLabel}</Text>
        <Text style={styles.subtotalAmount}>{fmt(total)}</Text>
      </View>
    </View>
  );
}

function GroupHeader({ children }: { children: string }) {
  return (
    <View style={styles.groupHeader}>
      <Text style={styles.groupHeaderText}>{children.toUpperCase()}</Text>
    </View>
  );
}

function GroupTotal({ label, amount }: { label: string; amount: number }) {
  return (
    <View style={styles.groupTotalRow} wrap={false}>
      <Text style={styles.groupTotalLabel}>{label}</Text>
      <Text style={styles.groupTotalAmount}>{fmt(amount)}</Text>
    </View>
  );
}

export function BalanceSheetPdf(props: BalanceSheetData) {
  const {
    organizationName,
    asOfDate,
    currentAssets,
    fixedAssets,
    otherAssets,
    currentLiabilities,
    longTermLiabilities,
    otherLiabilities,
    equity,
    totals,
    balanced,
  } = props;

  const generatedAt = new Date().toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <Document
      title={`Balance Sheet ${asOfDate}`}
      author={organizationName}
      subject="Balance Sheet"
    >
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.org}>{organizationName}</Text>
          <Text style={styles.title}>BALANCE SHEET</Text>
          <Text style={styles.period}>As of {formatLong(asOfDate)}</Text>
        </View>
        <View style={styles.topRule} />

        <GroupHeader>Assets</GroupHeader>
        <Section
          title="Current Assets"
          lines={currentAssets}
          total={totals.currentAssets}
          totalLabel="Total Current Assets"
        />
        {fixedAssets.length > 0 && (
          <Section
            title="Fixed Assets"
            lines={fixedAssets}
            total={totals.fixedAssets}
            totalLabel="Total Fixed Assets"
          />
        )}
        {otherAssets.length > 0 && (
          <Section
            title="Other Assets"
            lines={otherAssets}
            total={totals.otherAssets}
            totalLabel="Total Other Assets"
          />
        )}
        <GroupTotal label="Total Assets" amount={totals.totalAssets} />

        <GroupHeader>Liabilities</GroupHeader>
        <Section
          title="Current Liabilities"
          lines={currentLiabilities}
          total={totals.currentLiabilities}
          totalLabel="Total Current Liabilities"
        />
        {longTermLiabilities.length > 0 && (
          <Section
            title="Long-Term Liabilities"
            lines={longTermLiabilities}
            total={totals.longTermLiabilities}
            totalLabel="Total Long-Term Liabilities"
          />
        )}
        {otherLiabilities.length > 0 && (
          <Section
            title="Other Liabilities"
            lines={otherLiabilities}
            total={totals.otherLiabilities}
            totalLabel="Total Other Liabilities"
          />
        )}
        <GroupTotal label="Total Liabilities" amount={totals.totalLiabilities} />

        <GroupHeader>Equity</GroupHeader>
        <Section
          title="Equity"
          lines={equity}
          total={totals.equity}
          totalLabel="Total Equity"
        />

        <View style={styles.balanceRow} wrap={false}>
          <Text style={styles.balanceLabel}>TOTAL LIABILITIES & EQUITY</Text>
          <Text style={styles.balanceAmount}>{fmt(totals.totalLiabilitiesAndEquity)}</Text>
        </View>

        {!balanced && (
          <View style={styles.imbalance}>
            <Text>
              Out of balance: {fmt(totals.totalAssets - totals.totalLiabilitiesAndEquity)}
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
