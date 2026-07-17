import AsyncStorage from "@react-native-async-storage/async-storage";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { API_BASE_URL, API_ENDPOINTS } from "../config/api";
import { getCachedSession, initOfflineStore, saveSession } from "../services/offlineStore";

export default function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("info");

  const canSubmit = useMemo(() => username.trim().length > 0 && password.length > 0 && !loading, [username, password, loading]);

  async function handleLogin() {
    if (!username.trim() || !password) {
      setMessageType("error");
      setMessage("Username and password are required.");
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      const response = await fetch(API_ENDPOINTS.login, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password: password.trim() }),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.ok) {
        throw new Error(data?.message || "Invalid credentials.");
      }

      const session = { token: data.token || "", user: data.user || {}, online: true };
      await saveSession(session);
      await AsyncStorage.multiSet([
        ["nes_token", session.token],
        ["nes_user", JSON.stringify(session.user)],
      ]);

      onLogin?.(session);
    } catch (error) {
      try {
        await initOfflineStore();
        const cachedSession = await getCachedSession(username);
        if (cachedSession) {
          const offlineSession = { ...cachedSession, online: false };
          await AsyncStorage.multiSet([
            ["nes_token", offlineSession.token],
            ["nes_user", JSON.stringify(offlineSession.user)],
          ]);
          onLogin?.(offlineSession);
          return;
        }
      } catch {
        // Keep the original login error below.
      }
      setMessageType("error");
      setMessage(error?.message || "Unable to connect to the NES API. Login online once before using offline mode.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.hero}>
            <View style={styles.logoMark}>
              <Text style={styles.logoText}>NES</Text>
            </View>
            <Text style={styles.appName}>Field App</Text>
            <Text style={styles.subtitle}>Maintenance and outage work, ready for the field.</Text>
          </View>

          <View style={styles.panel}>
            <View style={styles.panelHeader}>
              <Text style={styles.panelTitle}>Sign in</Text>
              <Text style={styles.panelHint}>Use your Network Enterprise System account.</Text>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Username</Text>
              <TextInput
                value={username}
                onChangeText={setUsername}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="username"
                placeholder="Enter username"
                placeholderTextColor="#64748b"
                returnKeyType="next"
                style={styles.input}
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Password</Text>
              <View style={styles.passwordRow}>
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="password"
                  placeholder="Enter password"
                  placeholderTextColor="#64748b"
                  secureTextEntry={!showPassword}
                  returnKeyType="done"
                  onSubmitEditing={handleLogin}
                  style={styles.passwordInput}
                />
                <Pressable onPress={() => setShowPassword((value) => !value)} style={styles.showButton}>
                  <Text style={styles.showButtonText}>{showPassword ? "Hide" : "Show"}</Text>
                </Pressable>
              </View>
            </View>

            {message ? (
              <View style={[styles.messageBox, messageType === "error" ? styles.messageError : styles.messageSuccess]}>
                <Text style={[styles.messageText, messageType === "error" ? styles.messageTextError : styles.messageTextSuccess]}>{message}</Text>
              </View>
            ) : null}

            <Pressable onPress={handleLogin} disabled={!canSubmit} style={({ pressed }) => [styles.loginButton, (!canSubmit || pressed) && styles.loginButtonPressed]}>
              {loading ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.loginButtonText}>Login</Text>}
            </Pressable>

            <Text style={styles.apiNote}>API: {API_BASE_URL}</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#07111f" },
  flex: { flex: 1 },
  scrollContent: { flexGrow: 1, justifyContent: "center", padding: 22 },
  hero: { marginBottom: 28 },
  logoMark: {
    alignItems: "center",
    justifyContent: "center",
    width: 70,
    height: 70,
    borderRadius: 18,
    backgroundColor: "#0f8b4c",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
    marginBottom: 18,
  },
  logoText: { color: "#ffffff", fontSize: 23, fontWeight: "900", letterSpacing: 0 },
  appName: { color: "#f8fafc", fontSize: 34, fontWeight: "900", letterSpacing: 0 },
  subtitle: { color: "#b6c2d2", fontSize: 15, lineHeight: 22, marginTop: 8, maxWidth: 310 },
  panel: { backgroundColor: "#101b2c", borderColor: "#243247", borderWidth: 1, borderRadius: 8, padding: 18 },
  panelHeader: { marginBottom: 18 },
  panelTitle: { color: "#f8fafc", fontSize: 22, fontWeight: "800", letterSpacing: 0 },
  panelHint: { color: "#94a3b8", fontSize: 13, marginTop: 5 },
  fieldGroup: { marginBottom: 14 },
  label: { color: "#dbeafe", fontSize: 12, fontWeight: "800", marginBottom: 7, textTransform: "uppercase" },
  input: {
    backgroundColor: "#0b1424",
    borderColor: "#334155",
    borderWidth: 1,
    borderRadius: 7,
    color: "#f8fafc",
    fontSize: 15,
    minHeight: 48,
    paddingHorizontal: 13,
  },
  passwordRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0b1424",
    borderColor: "#334155",
    borderWidth: 1,
    borderRadius: 7,
    minHeight: 48,
  },
  passwordInput: { flex: 1, color: "#f8fafc", fontSize: 15, paddingHorizontal: 13, minHeight: 48 },
  showButton: { paddingHorizontal: 13, minHeight: 48, justifyContent: "center" },
  showButtonText: { color: "#7dd3fc", fontSize: 13, fontWeight: "800" },
  messageBox: { borderRadius: 7, borderWidth: 1, padding: 11, marginBottom: 14 },
  messageError: { backgroundColor: "#33151b", borderColor: "#7f1d1d" },
  messageSuccess: { backgroundColor: "#10291d", borderColor: "#166534" },
  messageText: { fontSize: 13, lineHeight: 19 },
  messageTextError: { color: "#fecdd3" },
  messageTextSuccess: { color: "#bbf7d0" },
  loginButton: { alignItems: "center", justifyContent: "center", backgroundColor: "#0f8b4c", borderRadius: 7, minHeight: 50, marginTop: 4 },
  loginButtonPressed: { opacity: 0.72 },
  loginButtonText: { color: "#ffffff", fontSize: 15, fontWeight: "900" },
  apiNote: { color: "#64748b", fontSize: 11, marginTop: 14, textAlign: "center" },
});

