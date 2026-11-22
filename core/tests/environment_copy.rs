use equavela_core::environment_copy::copy_environment;
use std::fs;

#[test]
fn copies_only_metadata_and_preserves_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let dest = temp.path().join("dest");
    fs::create_dir(&source).unwrap();
    let project = b"# comment\n[deps]\nFoo = \"abc\"\n";
    let manifest = b"manifest_format = \"2.0\"\n[[deps.Foo]]\nuuid = \"abc\"\n";
    fs::write(source.join("Project.toml"), project).unwrap();
    fs::write(source.join("Manifest.toml"), manifest).unwrap();
    fs::create_dir(source.join("cache")).unwrap();
    fs::write(source.join("cache/data"), "untouched").unwrap();
    copy_environment(&source, &dest).unwrap();
    assert_eq!(fs::read(dest.join("Project.toml")).unwrap(), project);
    assert_eq!(fs::read(dest.join("Manifest.toml")).unwrap(), manifest);
    assert_eq!(fs::read(source.join("Project.toml")).unwrap(), project);
    assert_eq!(fs::read(source.join("Manifest.toml")).unwrap(), manifest);
    assert!(!dest.join("cache").exists());
    assert_eq!(fs::read(source.join("cache/data")).unwrap(), b"untouched");
}

#[test]
fn existing_destination_is_untouched_and_manifest_is_optional() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let dest = temp.path().join("dest");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("Project.toml"), "name = 'Example'\n").unwrap();
    fs::create_dir(&dest).unwrap();
    fs::write(dest.join("keep"), "keep").unwrap();
    assert!(copy_environment(&source, &dest).is_err());
    assert_eq!(fs::read(dest.join("keep")).unwrap(), b"keep");
    fs::remove_dir_all(&dest).unwrap();
    copy_environment(&source, &dest).unwrap();
    assert!(!dest.join("Manifest.toml").exists());
}

#[test]
fn validates_before_creating_destination() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let dest = temp.path().join("dest");
    fs::create_dir(&source).unwrap();
    assert!(copy_environment(&source, &dest).is_err());
    for project in [
        "broken = [",
        "[sources.Foo]\npath = '../Foo'\n",
        "[sources.Foo.nested]\npath = '../Foo'\n",
    ] {
        fs::write(source.join("Project.toml"), project).unwrap();
        assert!(copy_environment(&source, &dest).is_err());
        assert!(!dest.exists());
    }
    fs::write(source.join("Project.toml"), "name = 'Example'\n").unwrap();
    for manifest in [
        "invalid = [",
        "[[Foo]]\npath = '../Foo'\n",
        "manifest_format = '2.0'\n[[deps.Foo]]\npath = '../Foo'\n",
    ] {
        fs::write(source.join("Manifest.toml"), manifest).unwrap();
        let error = copy_environment(&source, &dest).unwrap_err().to_string();
        assert!(error.contains("Manifest.toml"));
        assert!(!dest.exists());
    }
}

#[test]
fn prefers_julia_names() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let dest = temp.path().join("dest");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("Project.toml"), "broken = [").unwrap();
    fs::write(source.join("JuliaProject.toml"), "name = 'Preferred'\n").unwrap();
    fs::write(
        source.join("JuliaManifest.toml"),
        "julia_version = '1.11'\n",
    )
    .unwrap();
    copy_environment(&source, &dest).unwrap();
    assert!(dest.join("JuliaProject.toml").exists());
    assert!(dest.join("JuliaManifest.toml").exists());
    assert!(!dest.join("Project.toml").exists());
}

#[cfg(unix)]
#[test]
fn rejects_symlink_metadata() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let dest = temp.path().join("dest");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("real"), "name = 'Example'\n").unwrap();
    symlink("real", source.join("Project.toml")).unwrap();
    assert!(copy_environment(&source, &dest).is_err());
    assert!(!dest.exists());
    fs::remove_file(source.join("Project.toml")).unwrap();
    fs::write(source.join("Project.toml"), "name = 'Example'\n").unwrap();
    symlink("real", source.join("Manifest.toml")).unwrap();
    assert!(copy_environment(&source, &dest).is_err());
    assert!(!dest.exists());
}

#[test]
fn rejects_version_specific_manifest() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let dest = temp.path().join("dest");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("Project.toml"), "name = 'Example'\n").unwrap();
    fs::write(source.join("Manifest-v1.11.toml"), "").unwrap();
    let error = copy_environment(&source, &dest).unwrap_err().to_string();
    assert!(error.contains("Manifest-v1.11.toml"));
    assert!(!dest.exists());
}

#[test]
fn rejects_workspaces_and_allows_package_named_path() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let dest = temp.path().join("dest");
    fs::create_dir(&source).unwrap();
    fs::write(
        source.join("Project.toml"),
        "[workspace]\nprojects = ['subproject']\n",
    )
    .unwrap();
    let error = copy_environment(&source, &dest).unwrap_err().to_string();
    assert!(error.contains("workspace"));
    assert!(!dest.exists());
    fs::write(
        source.join("Project.toml"),
        "[sources.path]\nurl = 'https://example.com/path'\n",
    )
    .unwrap();
    fs::write(
        source.join("Manifest.toml"),
        "manifest_format = '2.0'\n[[deps.path]]\nuuid = 'abc'\n",
    )
    .unwrap();
    copy_environment(&source, &dest).unwrap();
}
