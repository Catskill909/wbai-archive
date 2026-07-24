// Prevents a console window from opening alongside the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Url, WebviewUrl, WebviewWindowBuilder};

/// Where the window points.
///
/// The desktop app is a native shell around the same web app the server
/// already serves — deliberately not a second implementation. Every listing,
/// image and on-air lookup still goes through the Node proxies, because the
/// upstream feeds send no CORS headers and a webview enforces CORS exactly as
/// a browser does. So a server is always involved: your own deployment for a
/// release build, or `npm start` on localhost while developing.
///
/// Set at compile time:
///     WBAI_APP_URL=https://your-domain npm run build
const APP_URL: &str = match option_env!("WBAI_APP_URL") {
    Some(url) => url,
    None => "http://localhost:8080",
};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let url: Url = APP_URL
                .parse()
                .expect("WBAI_APP_URL must be an absolute URL, e.g. https://example.org");

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("WBAI 99.5 FM Archive")
                .inner_size(1180.0, 820.0)
                // below this the player bar's controls start colliding
                .min_inner_size(380.0, 520.0)
                .resizable(true)
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the WBAI Archive desktop app");
}
