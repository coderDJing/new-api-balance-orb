import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Power, RefreshCw, Save, Settings, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

const REFRESH_INTERVAL_MS = 60_000;
const NON_DRAG_SELECTOR =
  "button, input, textarea, select, label, a, [role='button'], [data-window-no-drag]";

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

function startWindowDrag(event: React.MouseEvent<HTMLElement>) {
  if (!isTauriRuntime() || event.button !== 0 || event.buttons !== 1) return;

  const target = event.target;
  if (!(target instanceof HTMLElement) || target.closest(NON_DRAG_SELECTOR)) {
    return;
  }

  void getCurrentWindow().startDragging().catch(() => undefined);
}

function BalanceWindow() {
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
        // 配置未完成，隐藏主窗口，显示设置
        if (!promptedSetupRef.current) {
          promptedSetupRef.current = true;
          await hideWindow();
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

      if (!loaded.hasAccessToken || !loaded.endpointUrl || !loaded.userId) {
        // 配置未完成，隐藏主窗口，只显示设置
        promptedSetupRef.current = true;
        await hideWindow();
        await showSettings();
        return;
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
    listen<ClientConfig>("config-saved", async () => {
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
        : "在线";

  const refreshLabel = status === "ok" ? `${secondsLeft}s` : "--";

  return (
    <main className="shell main-shell">
      <div className="orb-window">
        <header className="topbar" data-window-drag-handle onMouseDown={startWindowDrag}>
          <div className="brand">
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

        <section className="balance-stage">
          <div
            className="progress-ring"
            style={{ "--progress": progress } as React.CSSProperties}
          >
            <div className="ring-core">
              <Power size={18} />
            </div>
          </div>
          <div className="balance-copy">
            <span className={`status-pill ${status}`}>{healthText}</span>
            <strong className={snapshot?.remaining && snapshot.remaining < 0 ? "negative" : ""}>
              {remainingText}
            </strong>
            <div className="meta-line">
              <span>{refreshLabel}</span>
            </div>
          </div>
        </section>

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

  return (
    <main className="shell settings-shell">
      <section className="settings-window">
        <header className="topbar settings-topbar" data-window-drag-handle onMouseDown={startWindowDrag}>
          <div className="brand">
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
          <label className="settings-field" htmlFor="endpoint-url">
            <span>Base URL</span>
            <input
              id="endpoint-url"
              data-window-no-drag
              value={endpointUrl}
              placeholder="https://example.com"
              onChange={(event) => {
                setEndpointUrl(event.currentTarget.value);
                setSaveStatus("idle");
              }}
            />
          </label>

          <label className="settings-field" htmlFor="access-token">
            <span>Access Token</span>
            <input
              id="access-token"
              data-window-no-drag
              value={accessToken}
              placeholder={config.hasAccessToken ? "已保存，留空不改" : "Access Token"}
              onChange={(event) => {
                setAccessToken(event.currentTarget.value);
                setSaveStatus("idle");
              }}
            />
          </label>

          <label className="settings-field" htmlFor="user-id">
            <span>User ID</span>
            <input
              id="user-id"
              data-window-no-drag
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
