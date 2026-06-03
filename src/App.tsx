import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Power, RefreshCw, Save, Settings, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

const REFRESH_INTERVAL_MS = 60_000;

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

type ClientConfig = {
  hasAccessToken: boolean;
  endpointUrl?: string;
  userId?: string;
};

type BalanceSnapshot = {
  configured: boolean;
  remaining: number | null;
  username?: string | null;
  group?: string | null;
  requestCount?: number | null;
  refreshedAtMs: number;
};

type WindowKind = "main" | "settings";
type Status = "idle" | "loading" | "ok" | "error" | "setup";
type SaveStatus = "idle" | "saving" | "saved" | "error";

function isTauriRuntime() {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

function previewWindowKind(): WindowKind {
  const params = new URLSearchParams(window.location.search);
  return params.get("window") === "settings" ? "settings" : "main";
}

async function runCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    return runPreviewCommand<T>(command, args);
  }

  return invoke<T>(command, args);
}

async function runPreviewCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (command === "load_config") {
    return {
      hasAccessToken: false,
      endpointUrl: "",
      userId: "",
    } as T;
  }

  if (command === "query_balance") {
    return {
      configured: false,
      remaining: null,
      username: null,
      group: null,
      requestCount: null,
      refreshedAtMs: Date.now(),
    } as T;
  }

  if (command === "save_config") {
    return {
      hasAccessToken: Boolean(args?.accessToken),
      endpointUrl: String(args?.endpointUrl || ""),
      userId: String(args?.userId || ""),
    } as T;
  }

  return undefined as T;
}

function App() {
  const [windowKind, setWindowKind] = useState<WindowKind>(previewWindowKind);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    setWindowKind(getCurrentWindow().label === "settings" ? "settings" : "main");
  }, []);

  return windowKind === "settings" ? <SettingsWindow /> : <BalanceWindow />;
}

function BalanceWindow() {
  const [config, setConfig] = useState<ClientConfig>({
    hasAccessToken: false,
  });
  const [snapshot, setSnapshot] = useState<BalanceSnapshot | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const promptedSetupRef = useRef(false);

  const showSettings = useCallback(async () => {
    await runCommand("show_settings_window").catch(() => undefined);
  }, []);

  const refresh = useCallback(async () => {
    setStatus("loading");
    setError("");

    try {
      const nextSnapshot = await runCommand<BalanceSnapshot>("query_balance");
      setSnapshot(nextSnapshot);

      if (!nextSnapshot.configured) {
        setStatus("setup");
        if (!promptedSetupRef.current) {
          promptedSetupRef.current = true;
          await showSettings();
        }
        return;
      }

      setStatus("ok");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [showSettings]);

  useEffect(() => {
    let mounted = true;

    async function bootstrap() {
      const loaded = await runCommand<ClientConfig>("load_config");
      if (!mounted) return;

      setConfig(loaded);
      if (!loaded.hasAccessToken || !loaded.endpointUrl || !loaded.userId) {
        promptedSetupRef.current = true;
        await showSettings();
      }
      if (mounted) await refresh();
    }

    bootstrap().catch((err) => {
      if (!mounted) return;
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      mounted = false;
    };
  }, [refresh, showSettings]);

  useEffect(() => {
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const ticker = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(ticker);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let unlisten: (() => void) | undefined;
    listen<ClientConfig>("config-saved", async (event) => {
      setConfig(event.payload);
      promptedSetupRef.current = false;
      await refresh();
    })
      .then((handler) => {
        unlisten = handler;
      })
      .catch(() => undefined);

    return () => {
      unlisten?.();
    };
  }, [refresh]);

  const remainingText = useMemo(() => {
    if (typeof snapshot?.remaining !== "number") return "--";
    return snapshot.remaining.toLocaleString("zh-CN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });
  }, [snapshot]);

  const elapsed = snapshot?.refreshedAtMs
    ? Math.max(0, now - Number(snapshot.refreshedAtMs))
    : 0;
  const progress = Math.min(1, elapsed / REFRESH_INTERVAL_MS);
  const secondsLeft = Math.max(
    0,
    Math.ceil((REFRESH_INTERVAL_MS - elapsed) / 1000),
  );

  const healthText =
    status === "loading"
      ? "刷新中"
      : status === "error"
        ? "异常"
        : status === "setup"
          ? "待配置"
          : "在线";

  const userLabel = snapshot?.username || config.userId || "未绑定";
  const groupLabel = snapshot?.group || "default";
  const refreshLabel = status === "ok" ? `${secondsLeft}s` : "--";
  const requestLabel =
    typeof snapshot?.requestCount === "number"
      ? snapshot.requestCount.toLocaleString("zh-CN")
      : "--";

  return (
    <main className="shell main-shell">
      <div className="orb-window" data-tauri-drag-region>
        <header className="topbar" data-tauri-drag-region>
          <div className="brand" data-tauri-drag-region>
            <span className="brand-mark" />
            <span>AI Balance</span>
          </div>
          <div className="actions">
            <button
              className="icon-button"
              type="button"
              title="刷新"
              onClick={refresh}
              disabled={status === "loading"}
            >
              <RefreshCw size={15} />
            </button>
            <button
              className="icon-button"
              type="button"
              title="设置"
              onClick={showSettings}
            >
              <Settings size={15} />
            </button>
            <button
              className="icon-button close"
              type="button"
              title="隐藏到托盘"
              onClick={hideWindow}
            >
              <X size={15} />
            </button>
          </div>
        </header>

        <section className="balance-stage" data-tauri-drag-region>
          <div
            className="progress-ring"
            style={{ "--progress": progress } as React.CSSProperties}
          >
            <div className="ring-core">
              <Power size={18} />
            </div>
          </div>
          <div className="balance-copy" data-tauri-drag-region>
            <span className={`status-pill ${status}`}>{healthText}</span>
            <strong className={snapshot?.remaining && snapshot.remaining < 0 ? "negative" : ""}>
              {remainingText}
            </strong>
            <div className="meta-line">
              <span>{userLabel}</span>
              <span>{groupLabel}</span>
              <span>{refreshLabel}</span>
            </div>
          </div>
        </section>

        <footer className="orb-footer" data-tauri-drag-region>
          <span>REQ</span>
          <strong>{requestLabel}</strong>
        </footer>

        {error && <div className="error-line">{error}</div>}
      </div>
    </main>
  );
}

function SettingsWindow() {
  const [config, setConfig] = useState<ClientConfig>({ hasAccessToken: false });
  const [accessToken, setAccessToken] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [userId, setUserId] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;

    runCommand<ClientConfig>("load_config")
      .then((loaded) => {
        if (!mounted) return;
        setConfig(loaded);
        setEndpointUrl(loaded.endpointUrl || "");
        setUserId(loaded.userId || "");
      })
      .catch((err) => {
        if (!mounted) return;
        setSaveStatus("error");
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      mounted = false;
    };
  }, []);

  async function saveSettings() {
    setSaveStatus("saving");
    setError("");

    try {
      const saved = await runCommand<ClientConfig>("save_config", {
        endpointUrl: endpointUrl.trim(),
        accessToken: accessToken.trim() || undefined,
        userId: userId.trim(),
      });
      setConfig(saved);
      setAccessToken("");
      setSaveStatus("saved");
    } catch (err) {
      setSaveStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const statusText =
    saveStatus === "saving"
      ? "保存中"
      : saveStatus === "saved"
        ? "已保存"
        : saveStatus === "error"
          ? "保存失败"
          : config.hasAccessToken
            ? "已配置"
            : "未配置";

  return (
    <main className="shell settings-shell">
      <section className="settings-window">
        <header className="topbar settings-topbar" data-tauri-drag-region>
          <div className="brand" data-tauri-drag-region>
            <span className="brand-mark" />
            <span>Settings</span>
          </div>
          <button
            className="icon-button close"
            type="button"
            title="隐藏设置"
            onClick={hideWindow}
          >
            <X size={15} />
          </button>
        </header>

        <div className="settings-body">
          <div className={`status-strip ${saveStatus}`}>
            <span>{statusText}</span>
          </div>

          <label className="settings-field" htmlFor="endpoint-url">
            <span>API Endpoint</span>
            <input
              id="endpoint-url"
              value={endpointUrl}
              placeholder="https://example.com/api/user/self"
              onChange={(event) => {
                setEndpointUrl(event.currentTarget.value);
                setSaveStatus("idle");
              }}
            />
          </label>

          <label className="settings-field" htmlFor="access-token">
            <span>Access Token</span>
            <div className="input-wrap">
              <input
                id="access-token"
                type={showToken ? "text" : "password"}
                value={accessToken}
                placeholder={config.hasAccessToken ? "已保存，留空不改" : "Access Token"}
                onChange={(event) => {
                  setAccessToken(event.currentTarget.value);
                  setSaveStatus("idle");
                }}
              />
              <button
                className="inline-icon"
                type="button"
                title={showToken ? "隐藏" : "显示"}
                onClick={() => setShowToken((show) => !show)}
              >
                {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </label>

          <label className="settings-field" htmlFor="user-id">
            <span>User ID</span>
            <input
              id="user-id"
              value={userId}
              placeholder="User ID"
              onChange={(event) => {
                setUserId(event.currentTarget.value);
                setSaveStatus("idle");
              }}
            />
          </label>

          {error && <div className="settings-error">{error}</div>}

          <div className="settings-actions">
            <button className="secondary-button" type="button" onClick={hideWindow}>
              <span>隐藏</span>
            </button>
            <button
              className="save-button"
              type="button"
              onClick={saveSettings}
              disabled={saveStatus === "saving"}
            >
              <Save size={14} />
              <span>{saveStatus === "saving" ? "保存中" : "保存"}</span>
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

function hideWindow() {
  runCommand("hide_window").catch(() => undefined);
}

export default App;
