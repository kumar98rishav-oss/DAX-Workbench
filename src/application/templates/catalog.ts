/**
 * APPLICATION — Template catalog
 * 30 industry templates across 5 verticals. Each carries an aesthetic
 * (light/dark + accent) and a domain schema (dimensions + measures) that a
 * generator materialises into a dataset — so one click yields a styled,
 * populated dashboard through the normal import → auto-model → auto-dashboard
 * pipeline. Framework-free (icon is a lucide name string).
 */

export type Vertical =
  | 'Medical Operations'
  | 'Hospitality'
  | 'Higher Education'
  | 'Data Engineering'
  | 'Enterprise'

/** Drives synthetic value ranges; column names are also chosen to match the
 *  KPI engine's kind heuristics (currency / quantity / ratio). */
export type GenKind = 'currency' | 'quantity' | 'ratio' | 'generic'

export interface TemplateDef {
  id: string
  name: string
  vertical: Vertical
  blurb: string
  icon: string
  mode: 'light' | 'dark'
  accent: string
  dims: { name: string; values: string[] }[]
  measures: { name: string; kind: GenKind }[]
  rows: number
}

type DimT = [string, string[]]
type MeaT = [string, GenKind]

const t = (
  id: string,
  name: string,
  vertical: Vertical,
  blurb: string,
  icon: string,
  mode: 'light' | 'dark',
  accent: string,
  dims: DimT[],
  measures: MeaT[],
): TemplateDef => ({
  id,
  name,
  vertical,
  blurb,
  icon,
  mode,
  accent,
  dims: dims.map(([dn, values]) => ({ name: dn, values })),
  measures: measures.map(([mn, kind]) => ({ name: mn, kind })),
  rows: 640,
})

export const TEMPLATES: TemplateDef[] = [
  // ─── Medical Operations & Provider Data Parsing ───
  t('01', 'Provider Data Parsing', 'Medical Operations', 'OCR pipeline efficiency & provider metrics', 'ScanText', 'dark', '#2DE1C2',
    [['Document Type', ['Referral', 'Lab Report', 'Claim', 'Intake', 'Imaging', 'Rx']], ['Provider', ['Northwell', 'Kaiser', 'Mayo', 'Cleveland', 'Ascension']], ['Pipeline Stage', ['Ingested', 'OCR', 'Validated', 'Published']]],
    [['Parse Accuracy Rate', 'ratio'], ['Manual Review Rate', 'ratio'], ['Page Volume', 'quantity'], ['Extraction Cost', 'currency']]),
  t('02', 'Clinical Throughput & Bed Flow', 'Medical Operations', 'Length of stay, occupancy & ED wait', 'HeartPulse', 'light', '#2E6BFF',
    [['Unit', ['ICU', 'ER', 'Med-Surg', 'Pediatrics', 'Oncology']], ['Shift', ['Day', 'Night']], ['Acuity', ['Low', 'Medium', 'High', 'Critical']]],
    [['Care Revenue', 'currency'], ['Discharge Volume', 'quantity'], ['Occupancy Rate', 'ratio'], ['Readmission Rate', 'ratio']]),
  t('03', 'Revenue Cycle & Claims Denial', 'Medical Operations', 'Denials, A/R days & clean-claim rate', 'ReceiptText', 'dark', '#E5487D',
    [['Payer', ['Medicare', 'Medicaid', 'Aetna', 'UHC', 'Cigna', 'BCBS']], ['Denial Reason', ['Coding', 'Eligibility', 'Auth', 'Duplicate', 'Timely']], ['Facility', ['North', 'South', 'East', 'West']]],
    [['Charge Amount', 'currency'], ['Claim Volume', 'quantity'], ['Denial Rate', 'ratio'], ['Clean Claim Rate', 'ratio']]),
  t('04', 'Referral Network & Credentialing', 'Medical Operations', 'Leakage, credentialing TAT & network', 'Share2', 'light', '#6366F1',
    [['Specialty', ['Cardiology', 'Ortho', 'Neuro', 'Primary', 'Radiology']], ['Region', ['Northeast', 'Midwest', 'South', 'West']], ['Status', ['Active', 'Pending', 'Expired']]],
    [['Network Revenue', 'currency'], ['Credentialing Volume', 'quantity'], ['Referral Leakage Rate', 'ratio'], ['Approval Rate', 'ratio']]),
  t('05', 'Telehealth Utilization', 'Medical Operations', 'Virtual mix, no-shows & session length', 'Video', 'dark', '#22D3EE',
    [['Modality', ['Video', 'Phone', 'Chat']], ['Specialty', ['Primary', 'Behavioral', 'Derm', 'Endo']], ['Region', ['NE', 'MW', 'S', 'W']]],
    [['Visit Revenue', 'currency'], ['Session Volume', 'quantity'], ['Virtual Visit Share', 'ratio'], ['No-Show Rate', 'ratio']]),

  // ─── Hospitality Revenue Management ───
  t('06', 'Hotel Revenue & Booking Velocity', 'Hospitality', 'Web conversion, booking pace & direct sales', 'Hotel', 'dark', '#E8B45A',
    [['Channel', ['Direct', 'Booking.com', 'Expedia', 'GDS', 'Wholesale']], ['Property', ['Grand Plaza', 'Seaside', 'Metro', 'Alpine', 'Harbor']], ['Room Type', ['Standard', 'Deluxe', 'Suite', 'Penthouse']]],
    [['Direct Revenue', 'currency'], ['Booking Volume', 'quantity'], ['Conversion Rate', 'ratio'], ['Cancellation Rate', 'ratio']]),
  t('07', 'RevPAR & Rate Optimization', 'Hospitality', 'ADR, RevPAR & occupancy', 'TrendingUp', 'light', '#10B981',
    [['Property', ['Grand Plaza', 'Seaside', 'Metro', 'Alpine', 'Harbor']], ['Room Type', ['Standard', 'Deluxe', 'Suite']], ['Segment', ['Corporate', 'Leisure', 'Group', 'OTA']]],
    [['Room Revenue', 'currency'], ['ADR Price', 'currency'], ['Occupancy Rate', 'ratio'], ['Length of Stay', 'generic']]),
  t('08', 'Guest Experience & Reputation', 'Hospitality', 'NPS, review score & response rate', 'Star', 'light', '#F43F6E',
    [['Source', ['Google', 'TripAdvisor', 'Booking', 'Direct']], ['Property', ['Grand Plaza', 'Seaside', 'Metro', 'Alpine']], ['Sentiment', ['Positive', 'Neutral', 'Negative']]],
    [['Recovery Cost', 'currency'], ['Review Volume', 'quantity'], ['Satisfaction Rate', 'ratio'], ['Response Rate', 'ratio']]),
  t('09', 'F&B & Event Sales', 'Hospitality', 'Covers, average check & banquet revenue', 'UtensilsCrossed', 'dark', '#C2703A',
    [['Outlet', ['Restaurant', 'Bar', 'Banquet', 'Room Service', 'Café']], ['Meal', ['Breakfast', 'Lunch', 'Dinner']], ['Property', ['Grand Plaza', 'Seaside', 'Metro']]],
    [['F&B Revenue', 'currency'], ['Avg Check Amount', 'currency'], ['Cover Volume', 'quantity'], ['Void Rate', 'ratio']]),
  t('10', 'Channel Manager — OTA vs Direct', 'Hospitality', 'Direct mix, OTA commission & CPA', 'SlidersHorizontal', 'dark', '#8B5CF6',
    [['Channel', ['Direct', 'OTA', 'GDS', 'Wholesale', 'Metasearch']], ['Property', ['Grand Plaza', 'Seaside', 'Metro', 'Alpine']], ['Device', ['Desktop', 'Mobile', 'Tablet']]],
    [['Commission Cost', 'currency'], ['Acquisition Cost', 'currency'], ['Direct Mix Rate', 'ratio'], ['Booking Volume', 'quantity']]),

  // ─── Higher Education & MBA Admissions ───
  t('11', 'MBA Admissions Funnel & Scoring', 'Higher Education', 'Yield, GMAT percentile & selectivity', 'GraduationCap', 'light', '#1E3A8A',
    [['Program', ['Full-Time', 'Part-Time', 'EMBA', 'Online']], ['Stage', ['Inquiry', 'Applied', 'Admitted', 'Enrolled']], ['Region', ['Domestic', 'Intl-Asia', 'Intl-EU', 'Intl-Other']]],
    [['Tuition Revenue', 'currency'], ['Application Volume', 'quantity'], ['Yield Rate', 'ratio'], ['Admit Rate', 'ratio']]),
  t('12', 'Enrollment & Retention', 'Higher Education', 'Enrollment, retention & time-to-degree', 'Users', 'light', '#14B8A6',
    [['College', ['Business', 'Engineering', 'Arts', 'Science', 'Law']], ['Year', ['Freshman', 'Sophomore', 'Junior', 'Senior']], ['Status', ['Enrolled', 'Withdrawn', 'Graduated']]],
    [['Tuition Revenue', 'currency'], ['Enrollment Volume', 'quantity'], ['Retention Rate', 'ratio'], ['Graduation Rate', 'ratio']]),
  t('13', 'Bursar — Tuition & Fee Tracking', 'Higher Education', 'Collections, balances & scholarships', 'Wallet', 'dark', '#84CC16',
    [['Term', ['Fall', 'Spring', 'Summer']], ['College', ['Business', 'Engineering', 'Arts', 'Science']], ['Aid Type', ['Grant', 'Loan', 'Scholarship', 'None']]],
    [['Outstanding Amount', 'currency'], ['Scholarship Amount', 'currency'], ['Collection Rate', 'ratio'], ['Payment Volume', 'quantity']]),
  t('14', 'Faculty Research & Grants', 'Higher Education', 'Grant dollars, publications & citations', 'FlaskConical', 'light', '#9333EA',
    [['Department', ['Bio', 'Chem', 'CS', 'Physics', 'Econ']], ['Funder', ['NSF', 'NIH', 'DoE', 'Private', 'Internal']], ['Status', ['Awarded', 'Pending', 'Declined']]],
    [['Grant Amount', 'currency'], ['Publication Volume', 'quantity'], ['Award Rate', 'ratio'], ['Citation Score', 'generic']]),

  // ─── Data Engineering & Pipeline Performance ───
  t('15', 'Fabric Pipeline Performance', 'Data Engineering', 'SQL/Python/Fabric load times & success', 'GitBranch', 'dark', '#3B82F6',
    [['Pipeline', ['Ingest', 'Transform', 'Load', 'Publish']], ['Engine', ['SQL', 'Python', 'Spark', 'Fabric']], ['Environment', ['Dev', 'Test', 'Prod']]],
    [['Compute Cost', 'currency'], ['Row Volume', 'quantity'], ['Success Rate', 'ratio'], ['Load Minutes', 'generic']]),
  t('16', 'Data Quality & Observability', 'Data Engineering', 'Freshness SLA, anomalies & drift', 'ShieldCheck', 'dark', '#F59E0B',
    [['Dataset', ['Orders', 'Customers', 'Events', 'Finance', 'Inventory']], ['Check Type', ['Null', 'Range', 'Schema', 'Freshness', 'Unique']], ['Severity', ['Info', 'Warning', 'Critical']]],
    [['Incident Cost', 'currency'], ['Check Volume', 'quantity'], ['Freshness SLA Rate', 'ratio'], ['Anomaly Rate', 'ratio']]),
  t('17', 'Warehouse Cost & FinOps', 'Data Engineering', 'Compute spend, cost/query & idle time', 'DollarSign', 'dark', '#22C55E',
    [['Warehouse', ['XS', 'S', 'M', 'L', 'XL']], ['Workload', ['ETL', 'BI', 'AdHoc', 'ML']], ['Team', ['Data', 'Analytics', 'Product', 'Finance']]],
    [['Compute Cost', 'currency'], ['Query Volume', 'quantity'], ['Idle Rate', 'ratio'], ['Utilization Rate', 'ratio']]),
  t('18', 'dbt Lineage & Freshness', 'Data Engineering', 'Model builds, freshness & test pass', 'Boxes', 'light', '#64748B',
    [['Layer', ['Staging', 'Intermediate', 'Marts']], ['Model', ['stg_orders', 'dim_customer', 'fct_sales', 'agg_daily']], ['Status', ['Pass', 'Fail', 'Skipped']]],
    [['Rebuild Cost', 'currency'], ['Model Volume', 'quantity'], ['Test Pass Rate', 'ratio'], ['Build Minutes', 'generic']]),
  t('19', 'Streaming Ingestion Monitor', 'Data Engineering', 'Events/sec, consumer lag & errors', 'Radio', 'dark', '#06B6D4',
    [['Topic', ['clicks', 'orders', 'sensors', 'logs']], ['Consumer', ['enrich', 'store', 'alert', 'ml']], ['Region', ['US-E', 'US-W', 'EU', 'APAC']]],
    [['Pipeline Cost', 'currency'], ['Event Volume', 'quantity'], ['Error Rate', 'ratio'], ['Throughput Rate', 'ratio']]),

  // ─── Standard Enterprise ───
  t('20', 'SaaS MRR & Churn', 'Enterprise', 'MRR, net revenue retention & churn', 'LineChart', 'dark', '#6366F1',
    [['Plan', ['Starter', 'Pro', 'Business', 'Enterprise']], ['Segment', ['SMB', 'Mid-Market', 'Enterprise']], ['Region', ['NA', 'EMEA', 'APAC', 'LATAM']]],
    [['Recurring Revenue', 'currency'], ['Customer Volume', 'quantity'], ['Churn Rate', 'ratio'], ['Retention Rate', 'ratio']]),
  t('21', 'E-Commerce Conversion', 'Enterprise', 'Conversion, AOV & cart abandonment', 'ShoppingCart', 'light', '#FB7185',
    [['Category', ['Apparel', 'Electronics', 'Home', 'Beauty', 'Sports']], ['Device', ['Desktop', 'Mobile', 'Tablet']], ['Channel', ['Organic', 'Paid', 'Email', 'Social']]],
    [['Sales Revenue', 'currency'], ['Order Volume', 'quantity'], ['Conversion Rate', 'ratio'], ['Cart Abandonment Rate', 'ratio']]),
  t('22', 'Supply Chain & Logistics', 'Enterprise', 'OTIF, inventory turns & freight cost', 'Truck', 'dark', '#0EA5A4',
    [['Lane', ['US-EU', 'US-APAC', 'Intra-US', 'EU-APAC']], ['Carrier', ['Maersk', 'DHL', 'FedEx', 'UPS']], ['Mode', ['Air', 'Sea', 'Road', 'Rail']]],
    [['Freight Cost', 'currency'], ['Shipment Volume', 'quantity'], ['OTIF Rate', 'ratio'], ['Damage Rate', 'ratio']]),
  t('23', 'HR People Analytics', 'Enterprise', 'Headcount, attrition & time-to-fill', 'UserCog', 'light', '#8B5CF6',
    [['Department', ['Eng', 'Sales', 'Marketing', 'Ops', 'G&A']], ['Level', ['Junior', 'Mid', 'Senior', 'Lead', 'Exec']], ['Location', ['HQ', 'Remote', 'Regional']]],
    [['Salary Cost', 'currency'], ['Headcount Volume', 'quantity'], ['Attrition Rate', 'ratio'], ['Offer Acceptance Rate', 'ratio']]),
  t('24', 'Executive KPI Cockpit', 'Enterprise', 'Revenue, EBITDA & cash runway', 'LayoutDashboard', 'dark', '#60A5FA',
    [['Business Unit', ['Cloud', 'Devices', 'Services', 'Media']], ['Region', ['NA', 'EMEA', 'APAC', 'LATAM']], ['Segment', ['SMB', 'Mid', 'Enterprise']]],
    [['Total Revenue', 'currency'], ['Operating Cost', 'currency'], ['Margin Rate', 'ratio'], ['Deal Volume', 'quantity']]),
  t('25', 'Financial P&L / FP&A', 'Enterprise', 'Gross margin, OpEx ratio & variance', 'Landmark', 'light', '#16A34A',
    [['Account', ['Revenue', 'COGS', 'OpEx', 'Tax']], ['Cost Center', ['Sales', 'R&D', 'G&A', 'Marketing']], ['Region', ['NA', 'EMEA', 'APAC']]],
    [['Actual Amount', 'currency'], ['Budget Amount', 'currency'], ['Variance Rate', 'ratio'], ['Margin Rate', 'ratio']]),
  t('26', 'Marketing Attribution (CAC/LTV)', 'Enterprise', 'CAC, LTV:CAC & blended ROAS', 'Megaphone', 'dark', '#EC4899',
    [['Channel', ['Search', 'Social', 'Email', 'Display', 'Affiliate']], ['Campaign', ['Brand', 'Prospecting', 'Retargeting', 'Lifecycle']], ['Region', ['NA', 'EMEA', 'APAC']]],
    [['Marketing Spend', 'currency'], ['Lead Volume', 'quantity'], ['Conversion Rate', 'ratio'], ['Acquisition Cost', 'currency']]),
  t('27', 'Sales Pipeline / CRM', 'Enterprise', 'Coverage, win rate & deal cycle', 'Target', 'light', '#2563EB',
    [['Stage', ['Prospect', 'Qualify', 'Proposal', 'Negotiate', 'Closed']], ['Rep', ['A. Chen', 'M. Diaz', 'S. Patel', 'J. Kim', 'R. Okoro']], ['Region', ['NA', 'EMEA', 'APAC']]],
    [['Pipeline Value', 'currency'], ['Deal Volume', 'quantity'], ['Win Rate', 'ratio'], ['Deal Cycle Days', 'generic']]),
  t('28', 'Inventory & Demand Planning', 'Enterprise', 'Stockouts, forecast accuracy & DOS', 'PackageSearch', 'dark', '#F97316',
    [['Warehouse', ['East', 'West', 'Central', 'South']], ['Category', ['A', 'B', 'C', 'D']], ['Status', ['In Stock', 'Low', 'Out', 'Backorder']]],
    [['Inventory Value', 'currency'], ['SKU Volume', 'quantity'], ['Stockout Rate', 'ratio'], ['Forecast Accuracy Rate', 'ratio']]),
  t('29', 'Customer Support (CSAT/SLA)', 'Enterprise', 'CSAT, first response & SLA attainment', 'Headphones', 'light', '#0EA5E9',
    [['Queue', ['Email', 'Chat', 'Phone', 'Social']], ['Priority', ['Low', 'Medium', 'High', 'Urgent']], ['Region', ['NA', 'EMEA', 'APAC']]],
    [['Handle Cost', 'currency'], ['Ticket Volume', 'quantity'], ['CSAT Rate', 'ratio'], ['SLA Attainment Rate', 'ratio']]),
  t('30', 'Manufacturing OEE / IoT', 'Enterprise', 'OEE, downtime & scrap rate', 'Factory', 'dark', '#A3E635',
    [['Line', ['L1', 'L2', 'L3', 'L4']], ['Plant', ['Detroit', 'Austin', 'Berlin', 'Osaka']], ['Shift', ['A', 'B', 'C']]],
    [['Output Value', 'currency'], ['Output Volume', 'quantity'], ['OEE Rate', 'ratio'], ['Scrap Rate', 'ratio']]),
]

export const VERTICALS: Vertical[] = [
  'Medical Operations',
  'Hospitality',
  'Higher Education',
  'Data Engineering',
  'Enterprise',
]
