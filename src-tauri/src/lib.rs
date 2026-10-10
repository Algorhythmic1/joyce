mod github;

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const TEXT_EXTENSIONS: &[&str] = &["md", "markdown", "txt"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    children: Option<Vec<Entry>>,
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
        if !is_dir && !is_text_file(&path) {
            continue;
        }
        entries.push(Entry {
            name,
            path: path.to_string_lossy().into_owned(),
            is_dir,
            // Unreadable subfolders shouldn't take down the whole tree.
            children: if is_dir { Some(read_tree(&path).unwrap_or_default()) } else { None },
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
    fs::rename(from, to).map_err(err)
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
}
