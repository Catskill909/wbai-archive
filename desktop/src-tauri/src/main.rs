// Prevents a console window from opening alongside the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Url, WebviewUrl, WebviewWindowBuilder};

/// Where the window points.
///
/// The desktop app is a native shell around the same web app the server
/// already serves — deliberately not a second implementation. Every listing,
/// image and on-air lookup still goes through the Node proxies, because the
/// upstream feeds send no CORS headers and a webview enforces CORS exactly as
/// a browser does. So a server is always involved: that station's own
/// deployment for a release build, or `npm start` on localhost while developing.
///
/// One station per build. Set at compile time:
///     STATION_URL=https://archive.wbai.org npm run build -- --config src-tauri/stations/wbai.json
const APP_URL: &str = match option_env!("STATION_URL") {
    Some(url) => url,
    None => "http://localhost:8080",
};

/// Window title. The rest of a station's identity — product name, bundle
/// identifier, copyright — lives in `stations/<slug>.json`, but the title is
/// set in code when the window is built, so it comes through the environment
/// the same way the URL does.
const STATION_NAME: &str = match option_env!("STATION_NAME") {
    Some(name) => name,
    None => "Station Archive",
};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let url: Url = APP_URL
                .parse()
                .expect("STATION_URL must be an absolute URL, e.g. https://example.org");

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title(STATION_NAME)
                .inner_size(1180.0, 820.0)
                // below this the player bar's controls start colliding
                .min_inner_size(380.0, 520.0)
                .resizable(true)
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the station archive desktop app");
}
