import 'server-only';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';

export interface IncomeStatementLine {
  accountId: string;
  accountNumber: string;
  accountName: string;
  balance: number;
}

export interface IncomeStatementPdfProps {
  organizationName: string;
  fromDate: string;
  toDate: string;
  revenue: IncomeStatementLine[];
  cogs: IncomeStatementLine[];
  operatingExpenses: IncomeStatementLine[];
  otherIncome: IncomeStatementLine[];
  otherExpenses: IncomeStatementLine[];
}

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
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 5,
    paddingHorizontal: 4,
    backgroundColor: COLORS.band,
    marginTop: 10,
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
  zebra: {
    backgroundColor: '#fafafa',
  },
  acctNum: {
    width: 56,
    color: COLORS.muted,
    fontSize: 9,
  },
  acctName: {
    flex: 1,
    paddingRight: 8,
  },
  amount: {
    width: 96,
    textAlign: 'right',
  },
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
  intermediateRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    paddingHorizontal: 4,
    marginTop: 6,
    borderTopWidth: 0.75,
    borderTopColor: COLORS.ink,
    borderBottomWidth: 0.75,
    borderBottomColor: COLORS.ink,
  },
  intermediateLabel: {
    flex: 1,
    fontFamily: 'Helvetica-Bold',
    fontSize: 10.5,
    color: COLORS.ink,
  },
  intermediateAmount: {
    width: 96,
    textAlign: 'right',
    fontFamily: 'Helvetica-Bold',
    fontSize: 10.5,
    color: COLORS.ink,
  },
  netRow: {
    flexDirection: 'row',
    paddingVertical: 10,
    paddingHorizontal: 4,
    marginTop: 14,
    borderTopWidth: 1.25,
    borderTopColor: COLORS.ink,
    borderBottomWidth: 3,
    borderBottomColor: COLORS.ink,
  },
  netLabel: {
    flex: 1,
    fontFamily: 'Helvetica-Bold',
    fontSize: 12,
    letterSpacing: 1,
    color: COLORS.ink,
  },
  netAmount: {
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

const sumOf = (lines: IncomeStatementLine[]) => lines.reduce((s, l) => s + l.balance, 0);

interface SectionProps {
  title: string;
  lines: IncomeStatementLine[];
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
        <Text style={styles.emptyRow}>No activity in this period.</Text>
      ) : (
        lines.map((line, i) => (
          <View key={line.accountNumber + line.accountName} style={[styles.row, i % 2 === 1 ? styles.zebra : {}]}>
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

interface SummaryRowProps {
  label: string;
  amount: number;
}

function IntermediateRow({ label, amount }: SummaryRowProps) {
  return (
    <View style={styles.intermediateRow} wrap={false}>
      <Text style={styles.intermediateLabel}>{label}</Text>
      <Text style={styles.intermediateAmount}>{fmt(amount)}</Text>
    </View>
  );
}

export function IncomeStatementPdf(props: IncomeStatementPdfProps) {
  const {
    organizationName,
    fromDate,
    toDate,
    revenue,
    cogs,
    operatingExpenses,
    otherIncome,
    otherExpenses,
  } = props;

  const totalRevenue = sumOf(revenue);
  const totalCogs = sumOf(cogs);
  const grossProfit = totalRevenue - totalCogs;
  const totalOpEx = sumOf(operatingExpenses);
  const operatingIncome = grossProfit - totalOpEx;
  const totalOtherIncome = sumOf(otherIncome);
  const totalOtherExpenses = sumOf(otherExpenses);
  const netIncome = operatingIncome + totalOtherIncome - totalOtherExpenses;

  const showCogs = cogs.length > 0;
  const generatedAt = new Date().toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <Document
      title={`Income Statement ${fromDate} to ${toDate}`}
      author={organizationName}
      subject="Profit & Loss Statement"
    >
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.org}>{organizationName}</Text>
          <Text style={styles.title}>INCOME STATEMENT</Text>
          <Text style={styles.period}>
            For the period from {formatLong(fromDate)} to {formatLong(toDate)}
          </Text>
        </View>
        <View style={styles.topRule} />

        <Section title="Revenue" lines={revenue} total={totalRevenue} totalLabel="Total Revenue" />

        {showCogs && (
          <Section
            title="Cost of Goods Sold"
            lines={cogs}
            total={totalCogs}
            totalLabel="Total Cost of Goods Sold"
          />
        )}

        {showCogs && <IntermediateRow label="Gross Profit" amount={grossProfit} />}

        <Section
          title="Operating Expenses"
          lines={operatingExpenses}
          total={totalOpEx}
          totalLabel="Total Operating Expenses"
        />

        <IntermediateRow
          label={showCogs ? 'Operating Income' : 'Income from Operations'}
          amount={operatingIncome}
        />

        {otherIncome.length > 0 && (
          <Section
            title="Other Income"
            lines={otherIncome}
            total={totalOtherIncome}
            totalLabel="Total Other Income"
          />
        )}

        {otherExpenses.length > 0 && (
          <Section
            title="Other Expenses"
            lines={otherExpenses}
            total={totalOtherExpenses}
            totalLabel="Total Other Expenses"
          />
        )}

        <View style={styles.netRow} wrap={false}>
          <Text style={styles.netLabel}>NET INCOME</Text>
          <Text style={styles.netAmount}>{fmt(netIncome)}</Text>
        </View>

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
