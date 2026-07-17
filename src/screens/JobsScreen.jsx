import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Animated, Modal, PanResponder, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { loadMaintenanceReports, updateMaintenanceReport } from "../services/maintenanceReportsService";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "myTask", label: "My Task" },
  { key: "completed", label: "Completed" },
];

const ALL_REPORT_TYPES = "";
const PAGE_SIZE = 10;

function normalizeStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}

function isCompletedStatus(status) {
  const normalized = normalizeStatus(status);
  return normalized === "CLOSED" || normalized === "CLOSE";
}

function normalizeMaintenanceReportType(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.toUpperCase() === "MAINTENANCE_ORDER") return "Others";
  return raw;
}

function parseEndorsedTo(value) {
  if (Array.isArray(value)) return value;
  const raw = String(value || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No date";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getMonthKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function getFeatureRows(payload) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  return features.map((feature) => {
    const props = feature?.properties || {};
    const coordinates = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates : [];
    return {
      id: props.id,
      eventTime: props.event_time || props.eventTime || "",
      reportType: normalizeMaintenanceReportType(props.report_type || props.reportType),
      reportDesc: props.report_desc || props.reportDesc || "",
      status: normalizeStatus(props.status),
      municipality: props.municipality || "",
      barangay: props.barangay || "",
      address: props.address || "",
      feeder: props.feeder || "",
      group1: props.group1 || "",
      label: props.label || "",
      remarks: props.remarks || "",
      accomplishedDate: props.accomplished_date || props.accomplishedDate || "",
      accomplishedBy: props.accomplished_by || props.accomplishedBy || "",
      accomplishment: props.accomplishment || "",
      visibleOn: props.visible_on || props.visibleOn || "",
      endorsedTo: parseEndorsedTo(props.endorsed_to || props.endorsedTo),
      lon: Number(coordinates[0] ?? props.lon),
      lat: Number(coordinates[1] ?? props.lat),
    };
  }).sort((a, b) => {
    const left = new Date(a.eventTime).getTime() || 0;
    const right = new Date(b.eventTime).getTime() || 0;
    return right - left;
  });
}

function isEndorsedToUser(job, user) {
  const userId = String(user?.id || "").trim();
  const username = String(user?.username || "").trim().toLowerCase();
  const fullname = String(user?.fullname || user?.fullName || "").trim().toLowerCase();
  return job.endorsedTo.some((entry) => {
    const entryId = String(entry?.id ?? entry?.user_id ?? "").trim();
    const entryUsername = String(entry?.username || "").trim().toLowerCase();
    const entryFullname = String(entry?.fullname || entry?.full_name || "").trim().toLowerCase();
    return (userId && entryId === userId) || (username && entryUsername === username) || (fullname && entryFullname === fullname);
  });
}

function matchesStatusFilter(job, filter, user) {
  if (filter === "open") return job.status === "OPEN";
  if (filter === "myTask") return isEndorsedToUser(job, user);
  if (filter === "completed") return isCompletedStatus(job.status);
  return true;
}

function matchesSearch(job, query) {
  const value = normalizeSearch(query);
  if (!value) return true;
  const haystack = [
    job.id,
    job.reportType,
    job.reportDesc,
    job.status,
    job.municipality,
    job.barangay,
    job.address,
    job.feeder,
    job.group1,
    job.label,
    job.remarks,
  ].map(normalizeSearch).join(" ");
  return haystack.includes(value);
}

function statusStyle(status) {
  if (isCompletedStatus(status)) {
    return { box: styles.statusClosed, text: styles.statusClosedText, label: "CLOSED" };
  }
  return { box: styles.statusOpen, text: styles.statusOpenText, label: "OPEN" };
}

function makeClosePayload(job, user) {
  return {
    event_time: job.eventTime || new Date().toISOString(),
    lon: Number(job.lon),
    lat: Number(job.lat),
    address: job.address || "",
    municipality: job.municipality || "",
    barangay: job.barangay || "",
    feeder: job.feeder || "",
    report_type: job.reportType || "Others",
    report_desc: job.reportDesc || "",
    remarks: job.remarks || "",
    label: job.label || job.reportDesc || "",
    status: "CLOSED",
    accomplished_date: new Date().toISOString(),
    accomplished_by: user?.fullname || user?.fullName || user?.username || "mobile",
    accomplishment: "Closed from mobile app.",
  };
}

function JobCard({ job, user, onOpen, onCloseRequest }) {
  const status = statusStyle(job.status);
  const location = [job.barangay, job.municipality].filter(Boolean).join(", ");
  const meta = [job.feeder ? `Feeder ${job.feeder}` : "", job.group1].filter(Boolean).join("  -  ");
  const swipedRef = useRef(false);
  const translateX = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_event, gesture) => {
      if (isCompletedStatus(job.status)) return false;
      return gesture.dx > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.1;
    },
    onPanResponderGrant: () => {
      translateX.stopAnimation();
    },
    onPanResponderMove: (_event, gesture) => {
      if (gesture.dx <= 0) {
        translateX.setValue(0);
        return;
      }
      translateX.setValue(Math.min(gesture.dx, 118));
    },
    onPanResponderRelease: (_event, gesture) => {
      Animated.spring(translateX, {
        toValue: 0,
        useNativeDriver: true,
        tension: 80,
        friction: 10,
      }).start();
      if (gesture.dx > 72 && Math.abs(gesture.dy) < 60) {
        swipedRef.current = true;
        onCloseRequest?.(job);
        setTimeout(() => {
          swipedRef.current = false;
        }, 450);
      }
    },
    onPanResponderTerminate: () => {
      Animated.spring(translateX, {
        toValue: 0,
        useNativeDriver: true,
        tension: 80,
        friction: 10,
      }).start();
      setTimeout(() => {
        swipedRef.current = false;
      }, 150);
    },
  })).current;

  return (
    <View style={styles.swipeShell}>
      {!isCompletedStatus(job.status) ? (
        <View style={styles.closeActionPane}>
          <Text style={styles.closeActionText}>Close</Text>
        </View>
      ) : null}
      <Animated.View {...panResponder.panHandlers} style={{ transform: [{ translateX }] }}>
        <Pressable
          onPress={() => {
            if (!swipedRef.current) onOpen?.(job);
          }}
          style={({ pressed }) => [styles.jobCard, pressed && styles.jobCardPressed]}
        >
          <View style={styles.jobTopRow}>
            <Text style={styles.jobId}>#{job.id || "-"}</Text>
            <View style={[styles.statusPill, status.box]}>
              <Text style={[styles.statusText, status.text]}>{status.label}</Text>
            </View>
          </View>
          <Text style={styles.jobType}>{job.reportType}</Text>
          <Text style={styles.jobDesc} numberOfLines={2}>{job.reportDesc || job.label || "No description"}</Text>
          <Text style={styles.jobDate}>{formatDateTime(job.eventTime)}</Text>
          {location ? <Text style={styles.jobLocation}>{location}</Text> : null}
          {job.address ? <Text style={styles.jobAddress} numberOfLines={2}>{job.address}</Text> : null}
          {meta ? <Text style={styles.jobMeta}>{meta}</Text> : null}
          {job.endorsedTo.length > 0 ? (
            <View style={styles.endorsedWrap}>
              <Text style={styles.endorsedLabel}>Endorsed to</Text>
              <Text style={styles.endorsedNames} numberOfLines={2}>
                {job.endorsedTo.map((entry) => entry.alias ? `${entry.fullname || entry.username} (${entry.alias})` : entry.fullname || entry.username).filter(Boolean).join(", ")}
              </Text>
            </View>
          ) : null}
          {!isCompletedStatus(job.status) ? <Text style={styles.swipeHint}>Swipe right to close</Text> : null}
        </Pressable>
      </Animated.View>
    </View>
  );
}

export default function JobsScreen({ token, user, shortcut, onOpenJob, onSyncStatusChange }) {
  const [activeFilter, setActiveFilter] = useState("all");
  const [reportTypeFilter, setReportTypeFilter] = useState(ALL_REPORT_TYPES);
  const [searchQuery, setSearchQuery] = useState("");
  const [monthFilter, setMonthFilter] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!shortcut) return;
    setActiveFilter(shortcut.filter || "all");
    setReportTypeFilter(shortcut.reportType || ALL_REPORT_TYPES);
    setMonthFilter(shortcut.month || "");
    setDropdownOpen(false);
  }, [shortcut]);

  const reportTypeOptions = useMemo(() => {
    const unique = new Set(jobs.map((job) => job.reportType).filter(Boolean));
    return Array.from(unique).sort((a, b) => a.localeCompare(b));
  }, [jobs]);

  const filteredByReportType = useCallback((job) => {
    if (!reportTypeFilter) return true;
    return job.reportType === reportTypeFilter;
  }, [reportTypeFilter]);

  const filteredBySearch = useCallback((job) => matchesSearch(job, searchQuery), [searchQuery]);

  const filteredByMonth = useCallback((job) => {
    if (!monthFilter) return true;
    return getMonthKey(job.eventTime) === monthFilter;
  }, [monthFilter]);

  const counts = useMemo(() => {
    const scoped = jobs.filter(filteredByReportType).filter(filteredBySearch).filter(filteredByMonth);
    return {
      all: scoped.length,
      open: scoped.filter((job) => job.status === "OPEN").length,
      myTask: scoped.filter((job) => isEndorsedToUser(job, user)).length,
      completed: scoped.filter((job) => isCompletedStatus(job.status)).length,
    };
  }, [filteredByMonth, filteredByReportType, filteredBySearch, jobs, user]);

  const filteredJobs = useMemo(() => {
    return jobs
      .filter(filteredByReportType)
      .filter(filteredBySearch)
      .filter(filteredByMonth)
      .filter((job) => matchesStatusFilter(job, activeFilter, user));
  }, [activeFilter, filteredByMonth, filteredByReportType, filteredBySearch, jobs, user]);

  const totalPages = Math.max(1, Math.ceil(filteredJobs.length / PAGE_SIZE));
  const visiblePage = Math.min(currentPage, totalPages);
  const pageStart = (visiblePage - 1) * PAGE_SIZE;
  const pagedJobs = filteredJobs.slice(pageStart, pageStart + PAGE_SIZE);

  useEffect(() => {
    setCurrentPage(1);
  }, [activeFilter, monthFilter, reportTypeFilter, searchQuery]);

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  const loadJobs = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const result = await loadMaintenanceReports({ token });
      setJobs(getFeatureRows(result.payload));
      onSyncStatusChange?.(result);
      if (result.fromCache) setError(result.message || "Showing offline data.");
    } catch (err) {
      onSyncStatusChange?.({ online: false });
      setError(err?.message || "Unable to load jobs.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [onSyncStatusChange, token]);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  function handleRefresh() {
    setRefreshing(true);
    loadJobs({ silent: true });
  }

  function clearFilters() {
    setReportTypeFilter(ALL_REPORT_TYPES);
    setSearchQuery("");
    setMonthFilter("");
    setActiveFilter("all");
    setDropdownOpen(false);
  }

  function selectReportType(value) {
    setReportTypeFilter(value);
    setDropdownOpen(false);
  }

  function confirmCloseJob(job) {
    if (isCompletedStatus(job.status)) return;
    Alert.alert(
      "Close Maintenance Order",
      `Set MO #${job.id} to CLOSED?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Close MO",
          style: "destructive",
          onPress: async () => {
            setRefreshing(true);
            setError("");
            try {
              const result = await updateMaintenanceReport({ token, id: job.id, payload: makeClosePayload(job, user) });
              onSyncStatusChange?.(result.refreshed);
              setJobs(getFeatureRows(result.refreshed.payload));
            } catch (err) {
              onSyncStatusChange?.({ online: false });
              setError(err?.message || "Unable to close maintenance order.");
            } finally {
              setRefreshing(false);
            }
          },
        },
      ]
    );
  }

  const activeFilterLabel = FILTERS.find((filter) => filter.key === activeFilter)?.label || "All";
  const selectedReportTypeLabel = reportTypeFilter || "All types";
  const hasExtraFilter = Boolean(reportTypeFilter || searchQuery.trim() || monthFilter);

  return (
    <View style={styles.wrap}>
      <View style={styles.filterBar}>
        {FILTERS.map((filter) => {
          const active = activeFilter === filter.key;
          return (
            <Pressable key={filter.key} onPress={() => setActiveFilter(filter.key)} style={[styles.filterButton, active && styles.filterButtonActive]}>
              <Text style={[styles.filterText, active && styles.filterTextActive]}>{filter.label}</Text>
              <Text style={[styles.filterCount, active && styles.filterCountActive]}>{counts[filter.key]}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.searchPanel}>
        <View style={styles.fieldLabels}>
          <Text style={[styles.searchLabel, styles.reportTypeLabel]}>Report type</Text>
          <Text style={[styles.searchLabel, styles.moSearchLabel]}>Search MO</Text>
        </View>
        <View style={styles.searchRow}>
          <View style={styles.dropdownWrap}>
            <Pressable onPress={() => setDropdownOpen((open) => !open)} style={styles.dropdownButton}>
              <Text style={styles.dropdownText} numberOfLines={1}>{selectedReportTypeLabel}</Text>
              <Text style={styles.dropdownArrow}>{dropdownOpen ? "▲" : "▼"}</Text>
            </Pressable>
            <Modal visible={dropdownOpen} transparent animationType="fade" onRequestClose={() => setDropdownOpen(false)}>
              <Pressable style={styles.modalBackdrop} onPress={() => setDropdownOpen(false)}>
                <Pressable style={styles.pickerPanel} onPress={(event) => event.stopPropagation?.()}>
                  <View style={styles.pickerHeader}>
                    <Text style={styles.pickerTitle}>Report type</Text>
                    <Pressable onPress={() => setDropdownOpen(false)} style={styles.pickerCloseButton}>
                      <Text style={styles.pickerCloseText}>Close</Text>
                    </Pressable>
                  </View>
                  <ScrollView style={styles.pickerScroll} nestedScrollEnabled keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator>
                    <Pressable onPress={() => selectReportType(ALL_REPORT_TYPES)} style={[styles.dropdownOption, !reportTypeFilter && styles.dropdownOptionActive]}>
                      <Text style={[styles.dropdownOptionText, !reportTypeFilter && styles.dropdownOptionTextActive]}>All report types</Text>
                    </Pressable>
                    {reportTypeOptions.map((type) => (
                      <Pressable key={type} onPress={() => selectReportType(type)} style={[styles.dropdownOption, reportTypeFilter === type && styles.dropdownOptionActive]}>
                        <Text style={[styles.dropdownOptionText, reportTypeFilter === type && styles.dropdownOptionTextActive]} numberOfLines={1}>{type}</Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                </Pressable>
              </Pressable>
            </Modal>
          </View>
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="MO #, location, feeder"
            placeholderTextColor="#64748b"
            style={styles.searchInput}
          />
          {hasExtraFilter ? (
            <Pressable onPress={clearFilters} style={styles.clearButton}>
              <Text style={styles.clearText}>Clear</Text>
            </Pressable>
          ) : null}
        </View>
        {monthFilter ? <Text style={styles.activeHint}>Showing jobs for {monthFilter}</Text> : null}
      </View>

      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#38bdf8" />}
      >
        <View style={styles.listHeader}>
          <View>
            <Text style={styles.listTitle}>{activeFilterLabel} Jobs</Text>
            <Text style={styles.listSub}>{filteredJobs.length} maintenance report{filteredJobs.length === 1 ? "" : "s"} - page {Math.min(currentPage, totalPages)} of {totalPages}</Text>
          </View>
          <Pressable onPress={handleRefresh} style={styles.refreshButton}>
            <Text style={styles.refreshText}>Refresh</Text>
          </Pressable>
        </View>

        {loading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator color="#38bdf8" />
            <Text style={styles.loadingText}>Loading jobs...</Text>
          </View>
        ) : null}

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {!loading && !error && filteredJobs.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyTitle}>No jobs found</Text>
            <Text style={styles.emptyText}>There are no maintenance reports under this filter.</Text>
          </View>
        ) : null}

        {pagedJobs.map((job) => <JobCard key={String(job.id)} job={job} user={user} onOpen={onOpenJob} onCloseRequest={confirmCloseJob} />)}

        {!loading && !error && filteredJobs.length > PAGE_SIZE ? (
          <View style={styles.paginationRow}>
            <Pressable disabled={currentPage <= 1} onPress={() => setCurrentPage((page) => Math.max(1, page - 1))} style={[styles.pageButton, currentPage <= 1 && styles.pageButtonDisabled]}>
              <Text style={styles.pageButtonText}>Prev</Text>
            </Pressable>
            <Text style={styles.pageText}>{pageStart + 1}-{Math.min(pageStart + PAGE_SIZE, filteredJobs.length)} of {filteredJobs.length}</Text>
            <Pressable disabled={currentPage >= totalPages} onPress={() => setCurrentPage((page) => Math.min(totalPages, page + 1))} style={[styles.pageButton, currentPage >= totalPages && styles.pageButtonDisabled]}>
              <Text style={styles.pageButtonText}>Next</Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: "#07111f" },
  filterBar: {
    flexDirection: "row",
    gap: 7,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8,
    backgroundColor: "#0b1424",
  },
  filterButton: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#243247",
    backgroundColor: "#101b2c",
    paddingHorizontal: 4,
  },
  filterButtonActive: { backgroundColor: "#0f8b4c", borderColor: "#22c55e" },
  filterText: { color: "#94a3b8", fontSize: 11, fontWeight: "900" },
  filterTextActive: { color: "#ffffff" },
  filterCount: { color: "#cbd5e1", fontSize: 13, fontWeight: "900", marginTop: 2 },
  filterCountActive: { color: "#ffffff" },
  searchPanel: { backgroundColor: "#0b1424", borderBottomWidth: 1, borderBottomColor: "#1e293b", paddingHorizontal: 12, paddingBottom: 10, zIndex: 5 },
  fieldLabels: { flexDirection: "row", gap: 8, marginBottom: 6 },
  searchLabel: { color: "#94a3b8", fontSize: 10, fontWeight: "900", textTransform: "uppercase" },
  reportTypeLabel: { flex: 0.45 },
  moSearchLabel: { flex: 0.55 },
  searchRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, zIndex: 6 },
  dropdownWrap: { flex: 0.45, zIndex: 20 },
  dropdownButton: { minHeight: 42, borderRadius: 7, borderWidth: 1, borderColor: "#334155", backgroundColor: "#07111f", paddingHorizontal: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6 },
  dropdownText: { color: "#f8fafc", fontSize: 12, fontWeight: "800", flex: 1 },
  dropdownArrow: { color: "#7dd3fc", fontSize: 9, fontWeight: "900" },
  modalBackdrop: { flex: 1, justifyContent: "flex-start", backgroundColor: "rgba(2, 6, 23, 0.56)", paddingHorizontal: 18, paddingTop: 118 },
  pickerPanel: { maxHeight: 360, borderRadius: 8, borderWidth: 1, borderColor: "#334155", backgroundColor: "#07111f", overflow: "hidden", elevation: 12 },
  pickerHeader: { minHeight: 44, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: "#1e293b", backgroundColor: "#0b1424" },
  pickerTitle: { color: "#f8fafc", fontSize: 13, fontWeight: "900" },
  pickerCloseButton: { minHeight: 34, justifyContent: "center", paddingHorizontal: 8 },
  pickerCloseText: { color: "#7dd3fc", fontSize: 12, fontWeight: "900" },
  pickerScroll: { maxHeight: 310 },
  dropdownMenu: { position: "absolute", top: 46, left: 0, right: 0, height: 260, borderRadius: 8, borderWidth: 1, borderColor: "#334155", backgroundColor: "#07111f", overflow: "hidden", zIndex: 30, elevation: 8 },
  dropdownScroll: { flex: 1 },
  dropdownOption: { minHeight: 39, justifyContent: "center", borderBottomWidth: 1, borderBottomColor: "#1e293b", paddingHorizontal: 10 },
  dropdownOptionActive: { backgroundColor: "#0f8b4c" },
  dropdownOptionText: { color: "#cbd5e1", fontSize: 12, fontWeight: "800" },
  dropdownOptionTextActive: { color: "#ffffff" },
  searchInput: { flex: 0.55, minHeight: 42, borderRadius: 7, borderWidth: 1, borderColor: "#334155", backgroundColor: "#07111f", color: "#f8fafc", fontSize: 13, paddingHorizontal: 11 },
  clearButton: { minHeight: 42, justifyContent: "center", borderRadius: 7, borderWidth: 1, borderColor: "#334155", paddingHorizontal: 11, backgroundColor: "#101b2c" },
  clearText: { color: "#7dd3fc", fontSize: 12, fontWeight: "900" },
  activeHint: { color: "#7dd3fc", fontSize: 11, fontWeight: "800", marginTop: 6 },
  list: { flex: 1, zIndex: 1 },
  listContent: { padding: 14, paddingBottom: 28 },
  listHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  listTitle: { color: "#f8fafc", fontSize: 18, fontWeight: "900", letterSpacing: 0 },
  listSub: { color: "#94a3b8", fontSize: 12, marginTop: 2 },
  refreshButton: { borderWidth: 1, borderColor: "#334155", borderRadius: 7, paddingHorizontal: 11, paddingVertical: 7, backgroundColor: "#0b1424" },
  refreshText: { color: "#7dd3fc", fontSize: 12, fontWeight: "900" },
  loadingBox: { flexDirection: "row", gap: 8, alignItems: "center", backgroundColor: "#0b1424", borderWidth: 1, borderColor: "#1e293b", borderRadius: 8, padding: 12, marginBottom: 12 },
  loadingText: { color: "#cbd5e1", fontSize: 13, fontWeight: "700" },
  errorBox: { backgroundColor: "#33151b", borderColor: "#7f1d1d", borderWidth: 1, borderRadius: 8, padding: 12, marginBottom: 12 },
  errorText: { color: "#fecdd3", fontSize: 13, lineHeight: 19, fontWeight: "700" },
  emptyBox: { alignItems: "center", justifyContent: "center", backgroundColor: "#101b2c", borderWidth: 1, borderColor: "#243247", borderRadius: 8, padding: 22 },
  emptyTitle: { color: "#f8fafc", fontSize: 16, fontWeight: "900" },
  emptyText: { color: "#94a3b8", fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 4 },
  swipeShell: { marginBottom: 10, borderRadius: 8, overflow: "hidden", backgroundColor: "#33151b" },
  closeActionPane: { position: "absolute", left: 0, top: 0, bottom: 0, width: 118, alignItems: "center", justifyContent: "center", backgroundColor: "#7f1d1d" },
  closeActionText: { color: "#fee2e2", fontSize: 13, fontWeight: "900", textTransform: "uppercase" },
  jobCard: { backgroundColor: "#101b2c", borderColor: "#243247", borderWidth: 1, borderRadius: 8, padding: 14 },
  jobCardPressed: { borderColor: "#38bdf8", backgroundColor: "#132238" },
  jobTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  jobId: { color: "#7dd3fc", fontSize: 12, fontWeight: "900" },
  statusPill: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 4 },
  statusOpen: { backgroundColor: "#33151b", borderColor: "#7f1d1d" },
  statusClosed: { backgroundColor: "#10291d", borderColor: "#166534" },
  statusText: { fontSize: 10, fontWeight: "900" },
  statusOpenText: { color: "#fecdd3" },
  statusClosedText: { color: "#bbf7d0" },
  jobType: { color: "#f8fafc", fontSize: 15, fontWeight: "900", letterSpacing: 0 },
  jobDesc: { color: "#cbd5e1", fontSize: 13, lineHeight: 18, marginTop: 4 },
  jobDate: { color: "#94a3b8", fontSize: 12, fontWeight: "800", marginTop: 8 },
  jobLocation: { color: "#e2e8f0", fontSize: 13, fontWeight: "800", marginTop: 6 },
  jobAddress: { color: "#94a3b8", fontSize: 12, lineHeight: 17, marginTop: 3 },
  jobMeta: { color: "#7dd3fc", fontSize: 12, fontWeight: "800", marginTop: 7 },
  endorsedWrap: { borderTopWidth: 1, borderTopColor: "#243247", marginTop: 10, paddingTop: 9 },
  endorsedLabel: { color: "#94a3b8", fontSize: 10, fontWeight: "900", textTransform: "uppercase" },
  endorsedNames: { color: "#dbeafe", fontSize: 12, lineHeight: 17, marginTop: 3, fontWeight: "700" },
  swipeHint: { color: "#64748b", fontSize: 10, fontWeight: "900", textTransform: "uppercase", marginTop: 9 },
  paginationRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 6, paddingTop: 8 },
  pageButton: { minHeight: 40, minWidth: 78, alignItems: "center", justifyContent: "center", borderRadius: 7, borderWidth: 1, borderColor: "#334155", backgroundColor: "#0b1424" },
  pageButtonDisabled: { opacity: 0.45 },
  pageButtonText: { color: "#7dd3fc", fontSize: 12, fontWeight: "900" },
  pageText: { color: "#cbd5e1", fontSize: 12, fontWeight: "800" },
});







