//! Native macOS menu bar (Clauge / Edit / View / Window / Help).
//!
//! Constructs the application-wide menu. Custom item ids ("preferences",
//! "refresh", "github") are dispatched by the `on_menu_event` handler wired
//! up in `lib.rs::run`.
//!
//! Generic over `R: Runtime` (per the plan): `build` only constructs menu
//! structure and does not call any concrete-runtime IPC, so the generic
//! signature compiles cleanly. The lib.rs caller passes a concrete
//! `&AppHandle<Wry>` which unifies `R = Wry`.
//!
//! Note on id collision with `tray.rs`: tray uses ids `open_dashboard`,
//! `preferences`, `check_updates`, `quit`. The "preferences" id overlaps,
//! but that's fine — each menu (tray, app menu) registers its own
//! `on_menu_event` handler scoped to its own builder, so they don't fight.
//! Both handlers happen to run the same effect (show popover with
//! preferences event), so behavior is consistent regardless.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Runtime,
};

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_name = "Clauge";

    let app_menu = Submenu::with_items(
        app,
        app_name,
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Clauge"), None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "preferences", "Preferences…", true, Some("Cmd+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, "refresh", "Refresh", true, Some("Cmd+R"))?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[&MenuItem::with_id(
            app,
            "github",
            "GitHub Repository",
            true,
            None::<&str>,
        )?],
    )?;

    Menu::with_items(app, &[&app_menu, &edit, &view, &window, &help])
}
