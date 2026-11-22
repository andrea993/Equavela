//! Names written under the product's former name. Documents and projects saved
//! before the rename are read as they are; a project folder's files are renamed to the current
//! names the first time it is opened.

use std::fs;
use std::path::Path;

/// The worksheet identity prefix before the rename.
pub const WORKSHEET_FORMAT_PREFIX: &str = "mathmaster-worksheet/";
/// The project manifest identity before the rename.
pub const PROJECT_FORMAT: &str = "mathmaster-project/1";
/// The project files and folders before the rename, with their current names.
pub const PROJECT_ENTRIES: [(&str, &str); 4] = [
    (
        "mathmaster-project.yaml",
        crate::project_directory::MANIFEST_FILE,
    ),
    (
        ".mathmaster-references",
        crate::project_archive::REFERENCES_FOLDER,
    ),
    (".mathmaster-trash.json", ".equavela-trash.json"),
    (".mathmaster-relocation", ".equavela-relocation"),
];

/// The current name of an archive entry or project path written under the former name.
pub fn current_entry_name(name: &str) -> Option<String> {
    PROJECT_ENTRIES.iter().find_map(|(former, current)| {
        if name == *former {
            Some((*current).to_owned())
        } else {
            name.strip_prefix(former)
                .filter(|rest| rest.starts_with('/'))
                .map(|rest| format!("{current}{rest}"))
        }
    })
}

/// Renames the former project files of `folder` to their current names, once: an entry whose
/// current name already exists is left alone. Failures are ignored; the folder then reads as
/// one without a project.
pub fn adopt_project_folder(folder: &Path) {
    for (former, current) in PROJECT_ENTRIES {
        let from = folder.join(former);
        let to = folder.join(current);
        if fs::symlink_metadata(&from).is_ok() && fs::symlink_metadata(&to).is_err() {
            let _ = fs::rename(&from, &to);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_project_folder_written_under_the_former_name_is_adopted() {
        let root = std::env::temp_dir().join(format!("equavela-former-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".mathmaster-references")).unwrap();
        fs::write(root.join("mathmaster-project.yaml"), "x").unwrap();
        adopt_project_folder(&root);
        assert!(root.join("equavela-project.yaml").is_file());
        assert!(root.join(".equavela-references").is_dir());
        assert!(!root.join("mathmaster-project.yaml").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn archive_entries_take_the_current_names() {
        assert_eq!(
            current_entry_name("mathmaster-project.yaml").as_deref(),
            Some("equavela-project.yaml")
        );
        assert_eq!(
            current_entry_name(".mathmaster-references/a/b.eqv").as_deref(),
            Some(".equavela-references/a/b.eqv")
        );
        assert_eq!(current_entry_name("mathmaster-project.yaml.bak"), None);
    }
}
