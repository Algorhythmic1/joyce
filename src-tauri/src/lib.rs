mod github;

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const TEXT_EXTENSIONS: &[&str] = &["md", "markdown", "txt"];
/// Pasted images live in a folder with this name beside their document. It's
/// plumbing, not writing, so the sidebar leaves it out.
const ASSETS_DIR: &str = "assets";
/// Per-folder settings, e.g. that a folder is a project and the order of its sections.
const MANIFEST: &str = ".joyce.json";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    children: Option<Vec<Entry>>,
    /// Contents of the folder's manifest, if it has one. Ordering is applied by the UI.
    meta: Option<serde_json::Value>,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn is_text_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| TEXT_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn read_tree(dir: &Path) -> Result<Vec<Entry>, String> {
    let mut entries = Vec::new();
    for item in fs::read_dir(dir).map_err(err)? {
        let item = item.map_err(err)?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = item.path();
        let is_dir = item.file_type().map_err(err)?.is_dir();
        if (!is_dir && !is_text_file(&path)) || (is_dir && name == ASSETS_DIR) {
            continue;
        }
        entries.push(Entry {
            name,
            path: path.to_string_lossy().into_owned(),
            is_dir,
            // Unreadable subfolders shouldn't take down the whole tree.
            children: if is_dir { Some(read_tree(&path).unwrap_or_default()) } else { None },
            // A damaged manifest just means no custom order, never a broken tree.
            meta: if is_dir {
                fs::read_to_string(path.join(MANIFEST)).ok().and_then(|s| serde_json::from_str(&s).ok())
            } else {
                None
            },
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
fn list_tree(root: String) -> Result<Vec<Entry>, String> {
    read_tree(Path::new(&root))
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(err)
}

/// Writes via a temp file + rename so a crash mid-save never truncates a document.
#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let name = target.file_name().ok_or("invalid path")?.to_string_lossy();
    let tmp = target.with_file_name(format!(".{name}.joyce-tmp"));
    let mut file = fs::File::create(&tmp).map_err(err)?;
    file.write_all(contents.as_bytes()).map_err(err)?;
    file.sync_all().map_err(err)?;
    fs::rename(&tmp, &target).map_err(err)
}

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(|_| ())
        .map_err(err)
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir(path).map_err(err)
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err("Something with that name already exists".into());
    }
    // Moving an image into a document's assets folder may need to create it.
    if let Some(parent) = Path::new(&to).parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    fs::rename(from, to).map_err(err)
}

/// Saves a pasted image. Never overwrites, and creates the assets folder as needed.
#[tauri::command]
fn write_image(path: String, base64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64).map_err(err)?;
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(err)?;
    file.write_all(&bytes).map_err(err)
}

/// Lets the webview display images from the writing folder (and nowhere else).
#[tauri::command]
fn allow_images_from(app: tauri::AppHandle, dir: String) -> Result<(), String> {
    use tauri::Manager;
    app.asset_protocol_scope().allow_directory(dir, true).map_err(err)
}

#[tauri::command]
fn trash_path(path: String) -> Result<(), String> {
    trash::delete(path).map_err(err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            list_tree,
            read_file,
            write_file,
            create_file,
            create_dir,
            rename_path,
            trash_path,
            write_image,
            allow_images_from,
            github::github_signed_in,
            github::github_sign_out,
            github::github_device_start,
            github::github_device_poll,
            github::github_import_gh_cli,
            github::github_gh_cli_available,
            github::github_open,
            github::github_api
        ])
        .run(tauri::generate_context!())
        .expect("error while running Joyce");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_round_trip() {
        let root = std::env::temp_dir().join(format!("joyce-test-{}", std::process::id()));
        fs::create_dir_all(root.join("Drafts")).unwrap();
        fs::write(root.join("ignored.png"), "").unwrap();
        fs::write(root.join(".hidden.md"), "").unwrap();
        let p = |name: &str| root.join(name).to_string_lossy().into_owned();

        create_file(p("b.md")).unwrap();
        assert!(create_file(p("b.md")).is_err(), "must not clobber existing files");
        write_file(p("b.md"), "Hello".into()).unwrap();
        assert_eq!(read_file(p("b.md")).unwrap(), "Hello");
        rename_path(p("b.md"), p("Drafts/a.md")).unwrap();

        let tree = list_tree(root.to_string_lossy().into_owned()).unwrap();
        let names: Vec<_> = tree.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Drafts"], "folders only, no hidden or non-text files");
        assert_eq!(tree[0].children.as_ref().unwrap()[0].name, "a.md");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folders_report_their_manifest() {
        let root = std::env::temp_dir().join(format!("joyce-proj-{}", std::process::id()));
        fs::create_dir_all(root.join("Novel")).unwrap();
        fs::create_dir_all(root.join("Broken")).unwrap();
        fs::write(root.join("Novel/.joyce.json"), r#"{"project":true,"order":["b.md","a.md"]}"#).unwrap();
        fs::write(root.join("Novel/a.md"), "A").unwrap();
        fs::write(root.join("Novel/b.md"), "B").unwrap();
        fs::write(root.join("Broken/.joyce.json"), "{not json").unwrap();

        let tree = list_tree(root.to_string_lossy().into_owned()).unwrap();
        let novel = tree.iter().find(|e| e.name == "Novel").unwrap();
        assert_eq!(novel.meta.as_ref().unwrap()["project"], true);
        assert_eq!(novel.meta.as_ref().unwrap()["order"][0], "b.md");
        assert_eq!(novel.children.as_ref().unwrap().len(), 2, "the manifest itself stays hidden");
        let broken = tree.iter().find(|e| e.name == "Broken").unwrap();
        assert!(broken.meta.is_none(), "a damaged manifest means no custom order, not an error");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn images_go_in_hidden_assets_folder() {
        let root = std::env::temp_dir().join(format!("joyce-img-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let img = root.join("assets/pic.png").to_string_lossy().into_owned();
        write_image(img.clone(), "iVBORw0KGgo=".into()).unwrap();
        assert_eq!(fs::read(&img).unwrap()[..4], [0x89, b'P', b'N', b'G']);
        assert!(write_image(img.clone(), "AAAA".into()).is_err(), "must not overwrite");

        // Moving an image into another folder's assets creates that folder.
        let moved = root.join("Drafts/assets/pic.png").to_string_lossy().into_owned();
        rename_path(img, moved.clone()).unwrap();
        assert!(Path::new(&moved).exists());

        let tree = list_tree(root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(tree.len(), 1, "only Drafts; assets folders stay out of the sidebar");
        assert!(tree[0].children.as_ref().unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
