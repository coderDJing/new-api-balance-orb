import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  ChevronDown,
  ChevronUp,
  CircleQuestionMark,
  Plus,
  Save,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import formGuideImage from "../docs/assets/form-guide.png";

const PREVIEW_BALANCE = 1286.734;
const MAIN_WINDOW_MIN_WIDTH = 244;
const MAIN_WINDOW_MAX_WIDTH = 520;
const MAIN_WINDOW_SIDE_CONTROL_WIDTH = 40;
const MAIN_WINDOW_HORIZONTAL_PADDING = 18;
const SITE_FLAP_DIGIT_WIDTH = 30;
const SITE_FLAP_DECIMAL_WIDTH = 9;
const SITE_FLAP_MINUS_WIDTH = 19;
const SITE_FLAP_STATIC_WIDTH = 9;

type UiLocale = "zh" | "en";

const UI_TEXT = {
  zh: {
    accessToken: "Access Token",
    autostart: "开机自启动",
    balanceAriaLabel: "余额",
    copied: "已复制",
    copyErrorTitle: "点击复制",
    endpointUrl: "接口地址",
    formGuideAlt: "New API 表单填写指引",
    hide: "隐藏",
    hideSettings: "隐藏设置",
    loading: "查询中...",
    refreshInterval: "刷新间隔（秒）",
    save: "保存",
    saving: "保存中",
    settings: "设置",
    setupRequired: "请先完成配置",
    unknownError: "未知错误",
    userId: "User ID",
  },
  en: {
    accessToken: "Access Token",
    autostart: "Launch at startup",
    balanceAriaLabel: "Balance",
    copied: "Copied",
    copyErrorTitle: "Click to copy",
    endpointUrl: "Base URL",
    formGuideAlt: "New API form guide",
    hide: "Hide",
    hideSettings: "Hide settings",
    loading: "Loading...",
    refreshInterval: "Refresh interval (seconds)",
    save: "Save",
    saving: "Saving",
    settings: "Settings",
    setupRequired: "Finish setup first",
    unknownError: "Unknown error",
    userId: "User ID",
  },
} as const;

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

type SiteConfig = {
  id: string;
  displayName: string;
  endpointUrl: string;
  hasAccessToken: boolean;
  accessToken: string;
  userId: string;
  refreshIntervalSecs: number;
  sortOrder: number;
};

type ClientConfig = {
  autostartEnabled: boolean;
  sites: SiteConfig[];
};

type BalanceSnapshot = {
  configured: boolean;
  remaining: number | null;
  username?: string | null;
  group?: string | null;
  requestCount?: number | null;
  refreshedAtMs: number;
};

type SiteBalanceSnapshot = {
  siteId: string;
  configured: boolean;
  remaining: number | null;
  username?: string | null;
  group?: string | null;
  requestCount?: number | null;
  refreshedAtMs: number;
  error?: string | null;
};

type WindowKind = "main" | "settings";
type SaveStatus = "idle" | "saving" | "saved" | "error";

type ConfirmOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

function useConfirmDialog() {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setOptions(opts);
    });
  }, []);

  const handleConfirm = useCallback(() => {
    resolveRef.current?.(true);
    resolveRef.current = null;
    setOptions(null);
  }, []);

  const handleCancel = useCallback(() => {
    resolveRef.current?.(false);
    resolveRef.current = null;
    setOptions(null);
  }, []);

  return { options, confirm, handleConfirm, handleCancel };
}

type AnchoredConfirmState = ConfirmOptions & {
  siteId: string;
};

function ConfirmDialog({
  title = "确认操作",
  message,
  confirmLabel = "确定",
  cancelLabel = "取消",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-title">{title}</div>
        <p className="confirm-message">{message}</p>
        <div className="confirm-actions">
          <button className="secondary-button" type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            className={danger ? "confirm-danger-button" : "save-button"}
            type="button"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function isTauriRuntime() {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

function detectUiLocale(): UiLocale {
  const languages =
    typeof navigator === "undefined"
      ? []
      : [...(navigator.languages || []), navigator.language].filter(
          (language): language is string => Boolean(language),
        );

  return languages.some(isSimplifiedChineseLocale) ? "zh" : "en";
}

function isSimplifiedChineseLocale(locale: string) {
  const normalized = locale
    .split(".")[0]
    .replace("_", "-")
    .toLowerCase();

  return (
    normalized === "zh-cn" ||
    normalized === "zh-sg" ||
    normalized === "zh-my" ||
    normalized === "zh-hans" ||
    normalized.startsWith("zh-hans-")
  );
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
      autostartEnabled: true,
      sites: [
        {
          id: "preview_1",
          displayName: "主站",
          endpointUrl: "https://api.example.com",
          hasAccessToken: true,
          accessToken: "sk-preview-token",
          userId: "preview",
          refreshIntervalSecs: 60,
          sortOrder: 0,
        },
        {
          id: "preview_2",
          displayName: "备用站",
          endpointUrl: "https://backup.example.com",
          hasAccessToken: true,
          accessToken: "sk-preview-token",
          userId: "preview",
          refreshIntervalSecs: 60,
          sortOrder: 1,
        },
      ],
    } as T;
  }

  if (command === "query_balance" || command === "query_site_balance") {
    return {
      configured: true,
      remaining: PREVIEW_BALANCE,
      username: null,
      group: null,
      requestCount: null,
      refreshedAtMs: Date.now(),
    } as T;
  }

  if (command === "save_config" || command === "save_site_config") {
    return {
      autostartEnabled: true,
      sites: [
        {
          id: "preview_1",
          displayName: "",
          endpointUrl: String(args?.endpointUrl || "https://example.com"),
          hasAccessToken: Boolean(args?.accessToken),
          accessToken: String(args?.accessToken || ""),
          userId: String(args?.userId || "preview"),
          refreshIntervalSecs: Number(args?.refreshIntervalSecs) || 60,
          sortOrder: 0,
        },
      ],
    } as T;
  }

  if (command === "delete_site") {
    return {
      autostartEnabled: true,
      sites: [],
    } as T;
  }

  if (command === "update_site_orders") {
    return undefined as T;
  }

  if (command === "resize_main_window") {
    return undefined as T;
  }

  if (command === "show_balance_context_menu") {
    return undefined as T;
  }

  return undefined as T;
}

function InlineConfirmDialog({
  title = "确认操作",
  message,
  confirmLabel = "确定",
  cancelLabel = "取消",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="inline-confirm" onClick={(e) => e.stopPropagation()}>
      <div className="inline-confirm-title">{title}</div>
      <div className="inline-confirm-message">{message}</div>
      <div className="inline-confirm-actions">
        <button className="inline-confirm-cancel" type="button" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button
          className={danger ? "inline-confirm-danger" : "inline-confirm-primary"}
          type="button"
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

function App() {
  const [windowKind, setWindowKind] = useState<WindowKind>(previewWindowKind);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    setWindowKind(getCurrentWindow().label === "settings" ? "settings" : "main");
  }, []);

  return windowKind === "settings" ? <SettingsWindow /> : <BalanceWindow />;
}

function formatBalance(value: number | null): string {
  if (value == null) return "--";
  if (!Number.isFinite(value)) return "--";
  return value.toFixed(3);
}

function measureBalanceWindowWidth(text: string) {
  const unscaledContentWidth = text.split("").reduce((width, char) => {
    if (isFlipDigit(char)) return width + SITE_FLAP_DIGIT_WIDTH;
    if (char === ".") return width + SITE_FLAP_DECIMAL_WIDTH;
    if (char === "-") return width + SITE_FLAP_MINUS_WIDTH;
    return width + SITE_FLAP_STATIC_WIDTH;
  }, 8);
  const gapWidth = Math.max(0, text.length - 1);
  const contentWidth = (unscaledContentWidth + gapWidth) * getSiteFlapScale(text.length);
  const fixedChromeWidth = MAIN_WINDOW_HORIZONTAL_PADDING + MAIN_WINDOW_SIDE_CONTROL_WIDTH;
  return Math.max(
    MAIN_WINDOW_MIN_WIDTH,
    Math.min(
      MAIN_WINDOW_MAX_WIDTH,
      Math.ceil(contentWidth + gapWidth + fixedChromeWidth),
    ),
  );
}

function getSiteFlapScale(length: number) {
  return Math.max(0.76, Math.min(0.9, 10.8 / Math.max(length, 1)));
}

function isFlipDigit(char: string) {
  return char >= "0" && char <= "9";
}

function extractDomainPrefix(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    const parts = hostname.split(".");
    if (parts.length >= 3 && parts[0] !== "www") {
      return parts[0];
    }
    if (parts.length >= 2) {
      return parts[parts.length - 2];
    }
    return hostname;
  } catch {
    return "未配置";
  }
}

function getSiteDisplayName(site: SiteConfig): string {
  if (site.displayName.trim()) return site.displayName.trim();
  if (site.endpointUrl) return extractDomainPrefix(site.endpointUrl);
  return "未配置";
}

function SiteFlapBalance({ value }: { value: number | null }) {
  const text = formatBalance(value);
  const chars = text.split("");
  const scale = getSiteFlapScale(chars.length);

  return (
    <div
      className="site-flap-machine"
      style={{ "--flap-scale": scale } as CSSProperties}
    >
      {chars.map((char, index) => {
        if (!isFlipDigit(char)) {
          const cls = `flap-static${char === "." ? " decimal" : ""}${char === "-" ? " minus" : ""}`;
          return (
            <span key={`static-${index}-${char}`} className={cls}>
              {char}
            </span>
          );
        }
        return (
          <span key={`flap-${index}`} className="flap-card">
            <span className="flap-half flap-top current">
              <span className="flap-glyph">{char}</span>
            </span>
            <span className="flap-half flap-bottom current">
              <span className="flap-glyph">{char}</span>
            </span>
          </span>
        );
      })}
    </div>
  );
}

function BalanceWindow() {
  const text = UI_TEXT[detectUiLocale()];
  const [sites, setSites] = useState<SiteConfig[]>([]);
  const [balances, setBalances] = useState<Record<string, SiteBalanceSnapshot>>({});
  const [deleteConfirm, setDeleteConfirm] = useState<AnchoredConfirmState | null>(null);
  const promptedSetupRef = useRef(false);
  const timersRef = useRef<Record<string, number>>({});

  const loadSites = useCallback(async () => {
    const config = await runCommand<ClientConfig>("load_config");
    const sorted = [...config.sites].sort((a, b) => a.sortOrder - b.sortOrder);
    setSites(sorted);
    return config;
  }, []);

  const refreshSite = useCallback(async (siteId: string) => {
    try {
      const snapshot = await runCommand<BalanceSnapshot>("query_site_balance", { siteId });
      setBalances((prev) => ({ ...prev, [siteId]: { ...snapshot, siteId } }));
    } catch (err) {
      setBalances((prev) => ({
        ...prev,
        [siteId]: {
          siteId,
          configured: true,
          remaining: null,
          refreshedAtMs: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const config = await loadSites();
      if (!mounted) return;

      const configuredSites = config.sites.filter(
        (s) => s.endpointUrl && s.hasAccessToken && s.userId,
      );

      if (configuredSites.length === 0 && !promptedSetupRef.current) {
        promptedSetupRef.current = true;
        await runCommand("show_settings_window");
        return;
      }

      for (const site of configuredSites) {
        refreshSite(site.id);
      }
    })();
    return () => { mounted = false; };
  }, [loadSites, refreshSite]);

  useEffect(() => {
    for (const timer of Object.values(timersRef.current)) {
      window.clearInterval(timer);
    }
    timersRef.current = {};

    for (const site of sites) {
      if (!site.endpointUrl || !site.hasAccessToken || !site.userId) continue;
      const intervalMs = (site.refreshIntervalSecs || 60) * 1000;
      timersRef.current[site.id] = window.setInterval(() => refreshSite(site.id), intervalMs);
    }
    return () => {
      for (const timer of Object.values(timersRef.current)) {
        window.clearInterval(timer);
      }
      timersRef.current = {};
    };
  }, [sites, refreshSite]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    listen<ClientConfig>("config-saved", async () => {
      promptedSetupRef.current = false;
      await loadSites();
    }).then((h) => { unlisten = h; }).catch(() => undefined);
    return () => { unlisten?.(); };
  }, [loadSites]);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    const showTrayMenu = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      runCommand("show_balance_context_menu", {
        x: event.clientX,
        y: event.clientY,
      }).catch(() => undefined);
    };

    document.addEventListener("contextmenu", showTrayMenu, { capture: true });
    return () => {
      document.removeEventListener("contextmenu", showTrayMenu, { capture: true });
    };
  }, []);

  const siteCount = sites.length;
  const showSortControls = siteCount > 1;
  const windowWidth = Math.max(
    MAIN_WINDOW_MIN_WIDTH,
    ...sites.map((site) => {
      const balance = balances[site.id];
      const isConfigured = site.endpointUrl && site.hasAccessToken && site.userId;
      const balanceText =
        isConfigured && !balance?.error ? formatBalance(balance?.remaining ?? null) : "--";
      return measureBalanceWindowWidth(balanceText);
    }),
  );

  useEffect(() => {
    if (!isTauriRuntime()) return;
    runCommand("resize_main_window", {
      width: windowWidth,
    }).catch(() => undefined);
  }, [windowWidth]);

  const handleAddSite = useCallback(async () => {
    await runCommand("show_settings_window", { newSite: true });
  }, []);

  const handleEditSite = useCallback(async (siteId: string) => {
    await runCommand("show_settings_window", { editSiteId: siteId });
  }, []);

  const requestDeleteSite = useCallback((siteId: string) => {
    const site = sites.find((s) => s.id === siteId);
    if (!site) return;
    const name = getSiteDisplayName(site);
    setDeleteConfirm({
      siteId,
      title: "删除站点",
      message: `「${name}」将从余额窗移除。`,
      confirmLabel: "删除",
      cancelLabel: "取消",
      danger: true,
    });
  }, [sites]);

  const confirmDeleteSite = useCallback(async () => {
    if (!deleteConfirm) return;
    await runCommand("delete_site", { siteId: deleteConfirm.siteId });
    setDeleteConfirm(null);
    await loadSites();
  }, [deleteConfirm, loadSites]);

  const cancelDeleteSite = useCallback(() => {
    setDeleteConfirm(null);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    runCommand("show_balance_context_menu", {
      x: e.clientX,
      y: e.clientY,
    }).catch(() => undefined);
  }, []);

  const handleWindowMouseDown = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (e.button !== 0 || !isTauriRuntime()) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest("button, input, [data-window-no-drag]")) return;
    getCurrentWindow().startDragging().catch(() => undefined);
  }, []);

  const moveSite = useCallback(async (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= sites.length) return;
    const reordered = [...sites];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIndex, 0, moved);
    const siteIds = reordered.map((s) => s.id);
    await runCommand("update_site_orders", { siteIds });
    setDeleteConfirm(null);
    await loadSites();
  }, [sites, loadSites]);

  return (
    <main className="shell main-shell">
      <div
        className="orb-window multi-site"
        onContextMenu={handleContextMenu}
        onMouseDown={handleWindowMouseDown}
      >
        <div className="site-list">
          {siteCount === 0 && (
            <div className="site-block site-empty-block" onContextMenu={handleContextMenu}>
              <button
                className="site-empty-add-btn"
                type="button"
                title="新增站点"
                aria-label="新增站点"
                data-window-no-drag
                onClick={(e) => { e.stopPropagation(); handleAddSite(); }}
              >
                <Plus size={18} strokeWidth={2.5} />
              </button>
            </div>
          )}
          {sites.map((site, index) => {
            const balance = balances[site.id];
            const isConfigured = site.endpointUrl && site.hasAccessToken && site.userId;
            const displayName = getSiteDisplayName(site);
            const isLoading = isConfigured && !balance;
            const hasError = balance?.error;
            const isLastSite = index === siteCount - 1;

            return (
              <div
                key={site.id}
                className={`site-block${hasError ? " has-error" : ""}`}
                onContextMenu={handleContextMenu}
              >
                {(showSortControls || isLastSite) && (
                  <div className="site-left-controls" data-window-no-drag>
                    {showSortControls && (
                      <button
                        className="site-control-btn"
                        type="button"
                        title="上移"
                        aria-label="上移"
                        disabled={index === 0}
                        onClick={(e) => { e.stopPropagation(); moveSite(index, -1); }}
                      >
                        <ChevronUp size={10} strokeWidth={2.4} />
                      </button>
                    )}
                    {isLastSite && (
                      <button
                        className="site-control-btn site-add-btn"
                        type="button"
                        title="新增站点"
                        aria-label="新增站点"
                        onClick={(e) => { e.stopPropagation(); handleAddSite(); }}
                      >
                        <Plus size={11} strokeWidth={2.5} />
                      </button>
                    )}
                    {showSortControls && (
                      <button
                        className="site-control-btn"
                        type="button"
                        title="下移"
                        aria-label="下移"
                        disabled={index === siteCount - 1}
                        onClick={(e) => { e.stopPropagation(); moveSite(index, 1); }}
                      >
                        <ChevronDown size={10} strokeWidth={2.4} />
                      </button>
                    )}
                  </div>
                )}
                <span className="site-name" title={displayName}>
                  {displayName}
                </span>
                <div className="site-actions">
                  <button
                    className="site-action-btn site-edit-btn"
                    type="button"
                    title={text.settings}
                    aria-label={text.settings}
                    onClick={(e) => { e.stopPropagation(); handleEditSite(site.id); }}
                  >
                    <Settings size={10} strokeWidth={2.3} />
                  </button>
                  <button
                    className="site-action-btn site-delete-btn"
                    type="button"
                    title="删除"
                    aria-label="删除"
                    onClick={(e) => { e.stopPropagation(); requestDeleteSite(site.id); }}
                  >
                    <Trash2 size={10} strokeWidth={2.3} />
                  </button>
                </div>
                <div className="site-balance">
                  {isLoading ? (
                    <span className="site-loading">{text.loading}</span>
                  ) : !isConfigured ? (
                    <span className="site-unconfigured">--</span>
                  ) : hasError ? (
                    <span className="site-error" title={balance.error || ""}>
                      ERR
                    </span>
                  ) : (
                    <SiteFlapBalance value={balance?.remaining ?? null} />
                  )}
                </div>
                {deleteConfirm?.siteId === site.id && (
                  <InlineConfirmDialog
                    {...deleteConfirm}
                    onConfirm={confirmDeleteSite}
                    onCancel={cancelDeleteSite}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}

function SettingsWindow() {
  const text = UI_TEXT[detectUiLocale()];
  const { options: confirmOptions, confirm, handleConfirm, handleCancel } = useConfirmDialog();
  const [displayName, setDisplayName] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [userId, setUserId] = useState("");
  const [refreshIntervalSecs, setRefreshIntervalSecs] = useState("60");
  const [autostartEnabled, setAutostartEnabled] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState("");
  const [setupHint, setSetupHint] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const originalFormRef = useRef("");
  const editingSiteIdRef = useRef<string | null>(null);
  const isDraftRef = useRef(false);

  const snapshotForm = useCallback(() => {
    return JSON.stringify({ displayName, endpointUrl, accessToken, userId, refreshIntervalSecs });
  }, [displayName, endpointUrl, accessToken, userId, refreshIntervalSecs]);

  useEffect(() => {
    setHasUnsavedChanges(snapshotForm() !== originalFormRef.current);
  }, [snapshotForm]);

  function loadSiteIntoForm(site: SiteConfig) {
    editingSiteIdRef.current = site.id;
    isDraftRef.current = false;
    setDisplayName(site.displayName);
    setEndpointUrl(site.endpointUrl);
    setAccessToken(site.accessToken);
    setUserId(site.userId);
    setRefreshIntervalSecs(String(site.refreshIntervalSecs));
    setSaveStatus("idle");
    setError("");
    setTimeout(() => {
      originalFormRef.current = JSON.stringify({
        displayName: site.displayName, endpointUrl: site.endpointUrl,
        accessToken: site.accessToken, userId: site.userId,
        refreshIntervalSecs: String(site.refreshIntervalSecs),
      });
    }, 0);
  }

  function loadEmptyDraft() {
    editingSiteIdRef.current = null;
    isDraftRef.current = true;
    setDisplayName("");
    setEndpointUrl("");
    setAccessToken("");
    setUserId("");
    setRefreshIntervalSecs("60");
    setSaveStatus("idle");
    setError("");
    originalFormRef.current = JSON.stringify({
      displayName: "", endpointUrl: "", accessToken: "", userId: "", refreshIntervalSecs: "60",
    });
  }

  const loadFormFromConfig = useCallback(async () => {
    const config = await runCommand<ClientConfig>("load_config");
    setAutostartEnabled(config.autostartEnabled);
    const sorted = [...config.sites].sort((a, b) => a.sortOrder - b.sortOrder);
    if (sorted.length > 0) {
      loadSiteIntoForm(sorted[0]);
    } else {
      loadEmptyDraft();
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      await loadFormFromConfig();
      if (!mounted) return;
    })();
    return () => { mounted = false; };
  }, [loadFormFromConfig]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    listen<string>("setup-required", (event) => {
      setSetupHint(event.payload);
      setTimeout(() => setSetupHint(""), 3000);
    }).then((h) => { unlisten = h; }).catch(() => undefined);
    return () => { unlisten?.(); };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    listen("new-site", () => {
      loadEmptyDraft();
    }).then((h) => { unlisten = h; }).catch(() => undefined);
    return () => { unlisten?.(); };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    listen<string>("edit-site", async (event) => {
      const config = await runCommand<ClientConfig>("load_config");
      setAutostartEnabled(config.autostartEnabled);
      const site = config.sites.find((s) => s.id === event.payload);
      if (site) {
        loadSiteIntoForm(site);
      }
    }).then((h) => { unlisten = h; }).catch(() => undefined);
    return () => { unlisten?.(); };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    listen("refresh-form", () => {
      loadFormFromConfig();
    }).then((h) => { unlisten = h; }).catch(() => undefined);
    return () => { unlisten?.(); };
  }, [loadFormFromConfig]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    getVersion().then((v) => setAppVersion(v)).catch(() => undefined);
  }, []);

  async function handleSave() {
    setSaveStatus("saving");
    setError("");
    try {
      const interval = Math.max(10, Math.min(3600, parseInt(refreshIntervalSecs) || 60));
      await runCommand<ClientConfig>("save_site_config", {
        siteId: isDraftRef.current ? undefined : editingSiteIdRef.current,
        displayName: displayName.trim(),
        endpointUrl: endpointUrl.trim(),
        accessToken: accessToken.trim() || undefined,
        userId: userId.trim(),
        refreshIntervalSecs: interval,
      });
      setSaveStatus("saved");
      setHasUnsavedChanges(false);
      await hideWindow();
    } catch (err) {
      setSaveStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleClose() {
    if (hasUnsavedChanges) {
      const discard = await confirm({
        title: "放弃修改",
        message: "当前表单有未保存内容。",
        confirmLabel: "放弃修改",
      });
      if (!discard) return;
    }
    hideWindow();
  }

  return (
    <main className="shell settings-shell">
      <section className="settings-window">
        <header className="topbar settings-topbar" data-window-drag-handle>
          <div className="brand">
            <span className="brand-mark" />
            <span>{text.settings}</span>
          </div>
          <div className="settings-topbar-actions" data-window-no-drag>
            <div className="guide-trigger">
              <button className="icon-button" type="button" title={text.formGuideAlt} aria-label={text.formGuideAlt}>
                <CircleQuestionMark size={15} />
              </button>
              <figure className="settings-guide-popover">
                <img src={formGuideImage} alt={text.formGuideAlt} />
              </figure>
            </div>
            <button className="icon-button close" type="button" title={text.hideSettings} onClick={handleClose}>
              <X size={15} />
            </button>
          </div>
        </header>
        <div className="settings-body">
          {setupHint && <div className="setup-hint">{setupHint}</div>}
          <label className="settings-field" htmlFor="display-name">
            <span>显示名称</span>
            <input id="display-name" data-window-no-drag value={displayName}
              placeholder={endpointUrl ? extractDomainPrefix(endpointUrl) : "自动使用域名前缀"}
              onChange={(e) => { setDisplayName(e.currentTarget.value); setSaveStatus("idle"); }} />
          </label>
          <label className="settings-field" htmlFor="endpoint-url">
            <span>{text.endpointUrl}</span>
            <input id="endpoint-url" data-window-no-drag value={endpointUrl} placeholder="https://example.com"
              onChange={(e) => { setEndpointUrl(e.currentTarget.value); setSaveStatus("idle"); }} />
          </label>
          <label className="settings-field" htmlFor="access-token">
            <span>{text.accessToken}</span>
            <input id="access-token" data-window-no-drag value={accessToken}
              placeholder={text.accessToken}
              onChange={(e) => { setAccessToken(e.currentTarget.value); setSaveStatus("idle"); }} />
          </label>
          <label className="settings-field" htmlFor="user-id">
            <span>{text.userId}</span>
            <input id="user-id" data-window-no-drag value={userId} placeholder="User ID"
              onChange={(e) => { setUserId(e.currentTarget.value); setSaveStatus("idle"); }} />
          </label>
          <label className="settings-field" htmlFor="refresh-interval">
            <span>{text.refreshInterval}</span>
            <input id="refresh-interval" type="number" data-window-no-drag value={refreshIntervalSecs}
              placeholder="60" min={10} max={3600}
              onChange={(e) => { setRefreshIntervalSecs(e.currentTarget.value); setSaveStatus("idle"); }} />
          </label>
          <label className="settings-field settings-field-toggle" htmlFor="autostart">
            <span>{text.autostart}</span>
            <input id="autostart" type="checkbox" data-window-no-drag checked={autostartEnabled}
              onChange={(e) => { setAutostartEnabled(e.currentTarget.checked); setSaveStatus("idle"); }} />
          </label>
          <div className={`settings-error${error ? "" : " is-empty"}`} title={error} aria-live="polite">
            {error}
          </div>
          <div className="settings-actions">
            <button className="secondary-button" type="button" onClick={handleClose}>
              <span>{text.hide}</span>
            </button>
            <button className="save-button" type="button" onClick={handleSave} disabled={saveStatus === "saving"}>
              <Save size={14} />
              <span>{saveStatus === "saving" ? text.saving : text.save}</span>
            </button>
          </div>
          {appVersion && (<div className="settings-version">v{appVersion}</div>)}
        </div>
      </section>
      {confirmOptions && (
        <ConfirmDialog
          {...confirmOptions}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </main>
  );
}

function hideWindow() {
  runCommand("hide_window").catch(() => undefined);
}

export default App;
