use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, time::Duration};
use tauri::{
    menu::{Menu, MenuBuilder},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Manager, Runtime, WebviewWindow, WindowEvent,
};

const QUOTA_SCALE: f64 = 500_000.0;
const CONFIG_FILE: &str = "config.json";
const WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
const WEBVIEW2_CRASH_REPORTER_FEATURE: &str = "msEdgeCrashReporter";
const WEBVIEW2_SHUTDOWN_FLAGS: [&str; 2] = ["--disable-crash-reporter", "--disable-breakpad"];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct StoredConfig {
    endpoint_url: String,
    access_token: String,
    user_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientConfig {
    has_access_token: bool,
    endpoint_url: Option<String>,
    user_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NewApiSelfResponse {
    success: bool,
    message: Option<String>,
    data: Option<NewApiUserData>,
}

#[derive(Debug, Deserialize)]
struct NewApiUserData {
    quota: f64,
    username: Option<String>,
    group: Option<String>,
    request_count: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BalanceSnapshot {
    configured: bool,
    remaining: Option<f64>,
    username: Option<String>,
    group: Option<String>,
    request_count: Option<u64>,
    refreshed_at_ms: u128,
}

#[tauri::command]
fn load_config(app: AppHandle) -> Result<ClientConfig, String> {
    Ok(client_config(read_config(&app).ok()))
}

#[tauri::command]
fn save_config(
    app: AppHandle,
    #[allow(non_snake_case)] endpointUrl: String,
    #[allow(non_snake_case)] accessToken: Option<String>,
    #[allow(non_snake_case)] userId: String,
) -> Result<ClientConfig, String> {
    let endpoint_url = endpointUrl.trim().trim_end_matches('/').to_string();
    if endpoint_url.is_empty() {
        return Err("接口地址不能为空".to_string());
    }
    if !endpoint_url.starts_with("https://") && !endpoint_url.starts_with("http://localhost") {
        return Err("接口地址必须使用 HTTPS".to_string());
    }

    let user_id = userId.trim().to_string();
    if user_id.is_empty() {
        return Err("userId 不能为空".to_string());
    }

    let existing = read_config(&app).ok();
    let access_token = accessToken
        .unwrap_or_default()
        .trim()
        .to_string()
        .if_empty_then(|| {
            existing
                .map(|config| config.access_token)
                .unwrap_or_default()
        });

    if access_token.is_empty() {
        return Err("Access Token 不能为空".to_string());
    }

    let config = StoredConfig {
        endpoint_url,
        access_token,
        user_id,
    };
    write_config(&app, &config)?;
    let next_config = client_config(Some(config));
    let _ = app.emit_to("main", "config-saved", &next_config);
    Ok(next_config)
}

#[tauri::command]
async fn query_balance(app: AppHandle) -> Result<BalanceSnapshot, String> {
    let config = match read_config(&app) {
        Ok(config)
            if !config.endpoint_url.is_empty()
                && !config.access_token.is_empty()
                && !config.user_id.is_empty() =>
        {
            config
        }
        _ => {
            return Ok(BalanceSnapshot {
                configured: false,
                remaining: None,
                username: None,
                group: None,
                request_count: None,
                refreshed_at_ms: now_ms(),
            });
        }
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("ai-balance-orb/0.1")
        .build()
        .map_err(|err| format!("创建 HTTP 客户端失败: {err}"))?;

    let url = format!(
        "{}/api/user/self",
        config.endpoint_url.trim_end_matches('/')
    );

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", config.access_token))
        .header("New-Api-User", config.user_id)
        .send()
        .await
        .map_err(|err| format!("请求失败: {err}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("读取响应失败: {err}"))?;

    if !status.is_success() {
        return Err(format!("接口返回 HTTP {status}: {}", preview(&body)));
    }

    let parsed: NewApiSelfResponse =
        serde_json::from_str(&body).map_err(|err| format!("响应不是有效 JSON: {err}"))?;

    if !parsed.success {
        return Err(parsed
            .message
            .filter(|message| !message.trim().is_empty())
            .unwrap_or_else(|| "查询失败".to_string()));
    }

    let data = parsed.data.ok_or_else(|| "响应缺少 data".to_string())?;
    Ok(BalanceSnapshot {
        configured: true,
        remaining: Some(data.quota / QUOTA_SCALE),
        username: data.username,
        group: data.group,
        request_count: data.request_count,
        refreshed_at_ms: now_ms(),
    })
}

#[tauri::command]
fn hide_window(window: WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|err| err.to_string())
}

#[tauri::command]
fn show_settings_window(app: AppHandle) -> Result<(), String> {
    show_settings(&app).map_err(|err| err.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_webview2_shutdown_flags();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            install_dev_shutdown_handler(app.handle().clone());
            install_tray(app)?;
            position_main_window(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            query_balance,
            hide_window,
            show_settings_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn configure_webview2_shutdown_flags() {
    let existing = std::env::var(WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS).unwrap_or_default();
    let mut arguments = existing
        .split_whitespace()
        .map(ToString::to_string)
        .collect::<Vec<_>>();

    merge_disabled_webview2_feature(&mut arguments);

    for flag in WEBVIEW2_SHUTDOWN_FLAGS {
        if !arguments.iter().any(|existing| existing == flag) {
            arguments.push(flag.to_string());
        }
    }

    std::env::set_var(WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, arguments.join(" "));
}

fn merge_disabled_webview2_feature(arguments: &mut Vec<String>) {
    for argument in arguments.iter_mut() {
        let Some(disabled_features) = argument.strip_prefix("--disable-features=") else {
            continue;
        };

        if !disabled_features
            .split(',')
            .any(|feature| feature == WEBVIEW2_CRASH_REPORTER_FEATURE)
        {
            argument.push(',');
            argument.push_str(WEBVIEW2_CRASH_REPORTER_FEATURE);
        }
        return;
    }

    arguments.push(format!(
        "--disable-features={WEBVIEW2_CRASH_REPORTER_FEATURE}"
    ));
}

fn install_dev_shutdown_handler(app: AppHandle) {
    #[cfg(debug_assertions)]
    {
        if let Err(err) = ctrlc::set_handler(move || {
            app.exit(0);
        }) {
            eprintln!("安装开发退出处理失败: {err}");
        }
    }

    #[cfg(not(debug_assertions))]
    {
        let _ = app;
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("读取配置目录失败: {err}"))?;
    fs::create_dir_all(&dir).map_err(|err| format!("创建配置目录失败: {err}"))?;
    Ok(dir.join(CONFIG_FILE))
}

fn read_config(app: &AppHandle) -> Result<StoredConfig, String> {
    let path = config_path(app)?;
    let text = fs::read_to_string(&path).map_err(|err| format!("读取配置失败: {err}"))?;
    serde_json::from_str(&text).map_err(|err| format!("解析配置失败: {err}"))
}

fn write_config(app: &AppHandle, config: &StoredConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let text =
        serde_json::to_string_pretty(config).map_err(|err| format!("序列化配置失败: {err}"))?;
    fs::write(path, text).map_err(|err| format!("写入配置失败: {err}"))
}

fn client_config(config: Option<StoredConfig>) -> ClientConfig {
    ClientConfig {
        has_access_token: config
            .as_ref()
            .is_some_and(|config| !config.access_token.is_empty()),
        endpoint_url: config
            .as_ref()
            .map(|config| config.endpoint_url.clone())
            .filter(|endpoint_url| !endpoint_url.is_empty()),
        user_id: config
            .map(|config| config.user_id)
            .filter(|user_id| !user_id.is_empty()),
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn preview(value: &str) -> String {
    const MAX: usize = 220;
    if value.len() <= MAX {
        return value.to_string();
    }

    let mut end = MAX;
    while !value.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    format!("{}...", &value[..end])
}

fn install_tray(app: &mut App) -> tauri::Result<()> {
    let handle = app.handle();
    let menu = build_tray_menu(handle)?;

    let mut tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("AI Balance Orb")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "settings" => {
                let _ = show_settings(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    app.manage(tray.build(handle)?);
    Ok(())
}

fn build_tray_menu<R, M>(manager: &M) -> tauri::Result<Menu<R>>
where
    R: Runtime,
    M: Manager<R>,
{
    MenuBuilder::new(manager)
        .text("show", "显示余额窗")
        .text("settings", "设置")
        .separator()
        .text("quit", "退出")
        .build()
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn show_settings(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("settings") {
        window.show()?;
        window.set_focus()?;
    }

    Ok(())
}

fn position_main_window(app: &App) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        // 窗口逻辑尺寸
        let window_width: f64 = 348.0;
        // 距屏幕边缘的边距
        let margin: f64 = 20.0;

        // 获取主显示器信息
        match app.primary_monitor() {
            Ok(Some(monitor)) => {
                let size = monitor.size();
                let scale = monitor.scale_factor();
                let logical_width = size.width as f64 / scale;
                let logical_height = size.height as f64 / scale;
                eprintln!("[position] physical: {}x{}, scale: {scale}, logical: {logical_width}x{logical_height}", size.width, size.height);

                let x = logical_width - window_width - margin;
                let y = margin;

                eprintln!("[position] placing at logical ({x}, {y})");
                window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)))?;
            }
            _ => {
                eprintln!("[position] could not get monitor, using fallback");
                let x = 1920.0 - window_width - margin;
                window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
                    x, margin,
                )))?;
            }
        }
    } else {
        eprintln!("[position] main window not found");
    }

    Ok(())
}

trait EmptyStringExt {
    fn if_empty_then<F>(self, fallback: F) -> String
    where
        F: FnOnce() -> String;
}

impl EmptyStringExt for String {
    fn if_empty_then<F>(self, fallback: F) -> String
    where
        F: FnOnce() -> String,
    {
        if self.is_empty() {
            fallback()
        } else {
            self
        }
    }
}
