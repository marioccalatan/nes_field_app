import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { loadMaintenanceReports } from "../services/maintenanceReportsService";


function normalizeMaintenanceReportType(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.toUpperCase() === "MAINTENANCE_ORDER") return "Others";
  return raw;
}

function getClosureRateColor(rate) {
  if (rate >= 80) return "#22c55e";
  if (rate >= 50) return "#f59e0b";
  return "#ef4444";
}

function normalizeStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function getFeatureRows(payload) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  return features.map((feature) => {
    const props = feature?.properties || {};
    return {
      id: props.id,
      eventTime: props.event_time || props.eventTime || "",
      reportType: normalizeMaintenanceReportType(props.report_type || props.reportType),
      status: normalizeStatus(props.status),
    };
  });
}

function computeStats(rows) {
  const total = rows.length;
  const closed = rows.filter((row) => row.status === "CLOSED").length;
  const closureRate = total > 0 ? Math.round((closed / total) * 100) : 0;
  const now = new Date();
  const thisMonth = rows.filter((row) => {
    const date = new Date(row.eventTime);
    return !Number.isNaN(date.getTime()) && date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
  });
  const thisMonthTotal = thisMonth.length;
  const thisMonthClosed = thisMonth.filter((row) => row.status === "CLOSED").length;
  const thisMonthRate = thisMonthTotal > 0 ? Math.round((thisMonthClosed / thisMonthTotal) * 100) : 0;
  const monthLabel = now.toLocaleString("en-US", { month: "long", year: "numeric" });
  const reportTypeStats = Array.from(
    rows.reduce((acc, row) => {
      const type = normalizeMaintenanceReportType(row.reportType);
      const current = acc.get(type) || { reportType: type, total: 0, closed: 0, open: 0, closureRate: 0 };
      current.total += 1;
      if (row.status === "CLOSED") current.closed += 1;
      current.open = current.total - current.closed;
      current.closureRate = current.total > 0 ? Math.round((current.closed / current.total) * 100) : 0;
      acc.set(type, current);
      return acc;
    }, new Map()).values()
  ).sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.reportType.localeCompare(b.reportType);
  });

  return {
    total,
    closed,
    open: total - closed,
    closureRate,
    thisMonthTotal,
    thisMonthClosed,
    thisMonthRate,
    monthLabel,
    reportTypeStats,
  };
}

function StatCard({ label, value, detail, accentColor, onPress }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.statCard, pressed && styles.cardPressed]}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, accentColor ? { color: accentColor } : null]}>{value}</Text>
      <Text style={styles.statDetail}>{detail}</Text>
    </Pressable>
  );
}

function ReportTypeCard({ item, onPress }) {
  const color = getClosureRateColor(item.closureRate);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.typeCard, pressed && styles.cardPressed]}>
      <View style={styles.typeHeader}>
        <Text style={styles.typeTitle} numberOfLines={2}>{item.reportType}</Text>
        <Text style={[styles.typeRate, { color }]}>{item.closureRate}%</Text>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${item.closureRate}%`, backgroundColor: color }]} />
      </View>
      <Text style={styles.typeDetail}>{item.closed} closed / {item.total} total  -  {item.open} open</Text>
    </Pressable>
  );
}

export default function OverviewScreen({ token, onOpenJobs, onSyncStatusChange }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const stats = useMemo(() => computeStats(rows), [rows]);
  const currentMonthKey = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }, []);


  const loadReports = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const result = await loadMaintenanceReports({ token });
      setRows(getFeatureRows(result.payload));
      onSyncStatusChange?.(result);
      if (result.fromCache) setError(result.message || "Showing offline data.");
    } catch (err) {
      onSyncStatusChange?.({ online: false });
      setError(err?.message || "Unable to load overview metrics.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [onSyncStatusChange, token]);

  useEffect(() => {
    loadReports();
  }, [loadReports]);

  function handleRefresh() {
    setRefreshing(true);
    loadReports({ silent: true });
  }

  return (
    <ScrollView
      style={styles.wrap}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#38bdf8" />}
    >
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Maintenance Dashboard</Text>
        <Pressable onPress={handleRefresh} style={styles.refreshButton}>
          <Text style={styles.refreshText}>Refresh</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator color="#38bdf8" />
          <Text style={styles.loadingText}>Loading metrics...</Text>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.statsGrid}>
        <StatCard
          label="Overall Closure Rate"
          value={`${stats.closureRate}%`}
          detail={`${stats.closed} closed / ${stats.total} total - ${stats.open} open`}
          accentColor={getClosureRateColor(stats.closureRate)}
          onPress={() => onOpenJobs?.({ filter: "all", reportType: "", month: "" })}
        />
        <StatCard
          label={stats.monthLabel}
          value={String(stats.thisMonthTotal)}
          detail={`${stats.thisMonthClosed} closed - ${stats.thisMonthTotal - stats.thisMonthClosed} open - ${stats.thisMonthRate}% closure`}
          onPress={() => onOpenJobs?.({ filter: "all", reportType: "", month: currentMonthKey })}
        />
      </View>

      <View style={styles.typeSection}>
        <Text style={styles.typeSectionTitle}>Closure Rate by Report Type</Text>
        <Text style={styles.typeSectionSub}>Tap a card to filter Jobs by report type</Text>
        {stats.reportTypeStats.length > 0 ? (
          <View style={styles.typeGrid}>
            {stats.reportTypeStats.map((item) => (
              <ReportTypeCard
                key={item.reportType}
                item={item}
                onPress={() => onOpenJobs?.({ filter: "all", reportType: item.reportType, month: "" })}
              />
            ))}
          </View>
        ) : (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyText}>No report type metrics available.</Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: "#07111f" },
  content: { padding: 16, paddingBottom: 28 },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  sectionTitle: { color: "#f8fafc", fontSize: 18, fontWeight: "900", letterSpacing: 0 },
  refreshButton: { borderWidth: 1, borderColor: "#334155", borderRadius: 7, paddingHorizontal: 11, paddingVertical: 7, backgroundColor: "#0b1424" },
  refreshText: { color: "#7dd3fc", fontSize: 12, fontWeight: "900" },
  loadingBox: { flexDirection: "row", gap: 8, alignItems: "center", backgroundColor: "#0b1424", borderWidth: 1, borderColor: "#1e293b", borderRadius: 8, padding: 12, marginBottom: 12 },
  loadingText: { color: "#cbd5e1", fontSize: 13, fontWeight: "700" },
  errorBox: { backgroundColor: "#33151b", borderColor: "#7f1d1d", borderWidth: 1, borderRadius: 8, padding: 12, marginBottom: 12 },
  errorText: { color: "#fecdd3", fontSize: 13, lineHeight: 19, fontWeight: "700" },
  statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  statCard: { width: "48.5%", backgroundColor: "#101b2c", borderColor: "#243247", borderWidth: 1, borderRadius: 8, padding: 13 },
  cardPressed: { opacity: 0.72 },
  statLabel: { color: "#94a3b8", fontSize: 11, fontWeight: "900", textTransform: "uppercase", letterSpacing: 0 },
  statValue: { color: "#f8fafc", fontSize: 28, fontWeight: "900", letterSpacing: 0, marginTop: 5 },
  statDetail: { color: "#cbd5e1", fontSize: 12, lineHeight: 18, marginTop: 3 },
  typeSection: { marginTop: 18 },
  typeSectionTitle: { color: "#f8fafc", fontSize: 16, fontWeight: "900", letterSpacing: 0 },
  typeSectionSub: { color: "#94a3b8", fontSize: 12, marginTop: 3, marginBottom: 10 },
  typeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  typeCard: { width: "48.5%", backgroundColor: "#101b2c", borderColor: "#243247", borderWidth: 1, borderRadius: 8, padding: 12, marginBottom: 0 },
  typeHeader: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  typeTitle: { color: "#e2e8f0", flex: 1, fontSize: 13, fontWeight: "900", lineHeight: 18 },
  typeRate: { fontSize: 21, fontWeight: "900", letterSpacing: 0 },
  progressTrack: { height: 7, borderRadius: 999, backgroundColor: "#1e293b", overflow: "hidden", marginTop: 10, marginBottom: 8 },
  progressFill: { height: "100%", borderRadius: 999 },
  typeDetail: { color: "#94a3b8", fontSize: 12, lineHeight: 17 },
  emptyBox: { backgroundColor: "#101b2c", borderColor: "#243247", borderWidth: 1, borderRadius: 8, padding: 14 },
  emptyText: { color: "#94a3b8", fontSize: 13 },
});





