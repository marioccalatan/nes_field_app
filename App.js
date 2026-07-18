import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import LoginScreen from "./src/screens/LoginScreen";
import OverviewScreen from "./src/screens/OverviewScreen";
import JobsScreen from "./src/screens/JobsScreen";
import AddJobScreen from "./src/screens/AddJobScreen";
import MapScreen from "./src/screens/MapScreen";
import { initOfflineStore, getSyncMeta } from "./src/services/offlineStore";
import { loadMaintenanceReports, syncPendingMaintenanceReports } from "./src/services/maintenanceReportsService";

const TABS = [
  { key: "overview", label: "Overview", marker: "OV" },
  { key: "jobs", label: "Jobs", marker: "JB" },
  { key: "add", label: "+", marker: "+" },
  { key: "map", label: "Map", marker: "MP" },
  { key: "more", label: "More", marker: "MR" },
];

function PlaceholderScreen({ title, caption }) {
  return (
    <View style={styles.placeholderWrap}>
      <Text style={styles.placeholderTitle}>{title}</Text>
      <Text style={styles.placeholderCaption}>{caption}</Text>
    </View>
  );
}

function formatSyncTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not synced";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState(null);
  const [activeTab, setActiveTab] = useState("overview");
  const [jobsShortcut, setJobsShortcut] = useState(null);
  const [editingReport, setEditingReport] = useState(null);
  const [editReturnTab, setEditReturnTab] = useState("jobs");
  const [mapMounted, setMapMounted] = useState(false);
  const [syncInfo, setSyncInfo] = useState({ online: true, syncedAt: "" });

  useEffect(() => {
    let cancelled = false;
    async function loadStoredSession() {
      try {
        await initOfflineStore();
        const meta = await getSyncMeta();
        if (!cancelled) setSyncInfo((current) => ({ ...current, syncedAt: meta.syncedAt || "" }));

        const pairs = await AsyncStorage.multiGet(["nes_token", "nes_user"]);
        const token = pairs.find(([key]) => key === "nes_token")?.[1] || "";
        const rawUser = pairs.find(([key]) => key === "nes_user")?.[1] || "";
        if (token && rawUser) {
          const user = JSON.parse(rawUser);
          if (!cancelled) setSession({ token, user });
        }
      } catch {
        await AsyncStorage.multiRemove(["nes_token", "nes_user"]);
      } finally {
        if (!cancelled) setBooting(false);
      }
    }
    loadStoredSession();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSyncResult = useCallback((result) => {
    if (!result) return;
    setSyncInfo((current) => ({
      online: Boolean(result.online),
      syncedAt: result.syncedAt || current.syncedAt || "",
    }));
  }, []);

  const syncMaintenanceReports = useCallback(async ({ silent = true } = {}) => {
    if (!session?.token) return;
    try {
      const pendingResult = await syncPendingMaintenanceReports({ token: session.token });
      if (pendingResult.failed > 0) {
        setSyncInfo((current) => ({ ...current, online: false }));
      }
      const result = await loadMaintenanceReports({ token: session.token });
      handleSyncResult(result);
    } catch {
      setSyncInfo((current) => ({ ...current, online: false }));
    }
  }, [handleSyncResult, session?.token]);

  useEffect(() => {
    if (!session?.token) return undefined;
    syncMaintenanceReports({ silent: true });
    const timer = setInterval(() => {
      syncMaintenanceReports({ silent: true });
    }, 60000);
    return () => clearInterval(timer);
  }, [session?.token, syncMaintenanceReports]);

  const title = useMemo(() => {
    if (activeTab === "overview") return "Overview";
    if (activeTab === "jobs") return "Jobs";
    if (activeTab === "add") return "Add Job";
    if (activeTab === "map") return "Map";
    return "More";
  }, [activeTab]);

  async function handleLogout() {
    await AsyncStorage.multiRemove(["nes_token", "nes_user"]);
    setSession(null);
    setActiveTab("overview");
    setJobsShortcut(null);
    setEditingReport(null);
    setEditReturnTab("jobs");
    setMapMounted(false);
  }

  function handleLogin(nextSession) {
    setSession(nextSession);
    setSyncInfo((current) => ({ ...current, online: nextSession?.online !== false }));
  }

  function openJobs(shortcut = null) {
    setJobsShortcut(shortcut ? { ...shortcut, token: Date.now() } : { filter: "all", reportType: "", month: "", token: Date.now() });
    setEditingReport(null);
    setActiveTab("jobs");
  }

  function openEditReport(report) {
    if (!report?.id) return;
    setEditReturnTab(activeTab === "map" ? "map" : "jobs");
    setEditingReport({ ...report, token: Date.now() });
    setActiveTab("add");
  }

  function closeEditReport() {
    setEditingReport(null);
    setActiveTab(editReturnTab === "map" ? "map" : "jobs");
  }

  function handleTabPress(tabKey) {
    if (tabKey !== "add") setEditingReport(null);
    if (tabKey === "map") setMapMounted(true);
    if (tabKey === "jobs") {
      setJobsShortcut((prev) => prev || { filter: "all", reportType: "", month: "", token: Date.now() });
    }
    setActiveTab(tabKey);
  }

  function renderActiveScreen() {
    if (activeTab === "overview") return <OverviewScreen token={session?.token} onOpenJobs={openJobs} onSyncStatusChange={handleSyncResult} />;
    if (activeTab === "jobs") return <JobsScreen token={session?.token} user={session?.user} shortcut={jobsShortcut} onOpenJob={openEditReport} onSyncStatusChange={handleSyncResult} />;
    if (activeTab === "add") return <AddJobScreen token={session?.token} user={session?.user} editReport={editingReport} onCancelEdit={closeEditReport} onSyncStatusChange={handleSyncResult} onSaved={() => syncMaintenanceReports({ silent: true })} />;
    return <PlaceholderScreen title="More" caption="Profile, settings, sync, and logout actions." />;
  }

  if (booting) {
    return (
      <SafeAreaView style={styles.bootScreen}>
        <StatusBar style="light" />
        <Text style={styles.bootText}>Loading NES Field App...</Text>
      </SafeAreaView>
    );
  }

  if (!session) {
    return (
      <>
        <StatusBar style="light" />
        <LoginScreen onLogin={handleLogin} />
      </>
    );
  }

  return (
    <SafeAreaView style={styles.shell}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <View style={styles.titleBlock}>
          <Text style={styles.eyebrow}>NES Field App</Text>
          <Text style={styles.headerTitle}>{title}</Text>
        </View>
        <View style={styles.userBlock}>
          <Text style={styles.userName} numberOfLines={1}>{session.user?.fullname || session.user?.username || "User"}</Text>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, syncInfo.online ? styles.statusDotOnline : styles.statusDotOffline]} />
            <Text style={[styles.statusText, syncInfo.online ? styles.statusTextOnline : styles.statusTextOffline]}>{syncInfo.online ? "API Online" : "API Offline"}</Text>
          </View>
          <Text style={styles.syncedText} numberOfLines={1}>Synced {formatSyncTime(syncInfo.syncedAt)}</Text>
          <Pressable onPress={handleLogout} hitSlop={8}>
            <Text style={styles.logoutText}>Logout</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.content}>
        {activeTab !== "map" ? renderActiveScreen() : null}
        {mapMounted || activeTab === "map" ? (
          <View pointerEvents={activeTab === "map" ? "auto" : "none"} style={[styles.mapPane, activeTab !== "map" && styles.hiddenMapPane]}>
            <MapScreen token={session?.token} onOpenMaintenanceReport={openEditReport} onSyncStatusChange={handleSyncResult} />
          </View>
        ) : null}
      </View>

      <View style={styles.tabBar}>
        {TABS.map((tab) => {
          const active = activeTab === tab.key;
          const isAdd = tab.key === "add";
          return (
            <Pressable key={tab.key} onPress={() => handleTabPress(tab.key)} style={styles.tabItem}>
              <View style={[styles.tabMarker, active && styles.tabMarkerActive, isAdd && styles.addMarker]}>
                <Text style={[styles.tabMarkerText, active && styles.tabMarkerTextActive, isAdd && styles.addMarkerText]}>{tab.marker}</Text>
              </View>
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{tab.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  bootScreen: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#07111f" },
  bootText: { color: "#dbeafe", fontSize: 15, fontWeight: "700" },
  shell: { flex: 1, backgroundColor: "#07111f" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
    gap: 12,
  },
  titleBlock: { flex: 1, minWidth: 0 },
  eyebrow: { color: "#38bdf8", fontSize: 11, fontWeight: "900", letterSpacing: 0, textTransform: "uppercase" },
  headerTitle: { color: "#f8fafc", fontSize: 24, fontWeight: "900", letterSpacing: 0, marginTop: 2 },
  userBlock: { alignItems: "flex-end", maxWidth: 170 },
  userName: { color: "#cbd5e1", fontSize: 12, fontWeight: "800" },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 3 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusDotOnline: { backgroundColor: "#22c55e" },
  statusDotOffline: { backgroundColor: "#f59e0b" },
  statusText: { fontSize: 11, fontWeight: "900" },
  statusTextOnline: { color: "#86efac" },
  statusTextOffline: { color: "#fbbf24" },
  syncedText: { color: "#94a3b8", fontSize: 10, fontWeight: "700", marginTop: 2 },
  logoutText: { color: "#7dd3fc", fontSize: 12, fontWeight: "900", marginTop: 4 },
  content: { flex: 1, position: "relative" },
  mapPane: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  hiddenMapPane: { opacity: 0 },
  tabBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 8,
    backgroundColor: "#0b1424",
    borderTopWidth: 1,
    borderTopColor: "#1e293b",
  },
  tabItem: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 58 },
  tabMarker: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#111c2e",
    borderWidth: 1,
    borderColor: "#26364d",
  },
  tabMarkerActive: { backgroundColor: "#0f8b4c", borderColor: "#22c55e" },
  addMarker: { width: 42, height: 42, borderRadius: 21, backgroundColor: "#0f8b4c", borderColor: "#86efac", marginTop: -18 },
  tabMarkerText: { color: "#94a3b8", fontSize: 10, fontWeight: "900" },
  tabMarkerTextActive: { color: "#ffffff" },
  addMarkerText: { color: "#ffffff", fontSize: 24, lineHeight: 26 },
  tabLabel: { color: "#94a3b8", fontSize: 11, fontWeight: "800", marginTop: 4 },
  tabLabelActive: { color: "#f8fafc" },
  placeholderWrap: { flex: 1, justifyContent: "center", padding: 24 },
  placeholderTitle: { color: "#f8fafc", fontSize: 24, fontWeight: "900", textAlign: "center" },
  placeholderCaption: { color: "#94a3b8", fontSize: 14, lineHeight: 21, marginTop: 8, textAlign: "center" },
});


