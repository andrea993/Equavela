use std::collections::BTreeMap;
use std::io::{Cursor, Write};

use equavela_core::eqvz::{EqvzArchive, EqvzError, EqvzKind, EqvzLimits, EqvzManifest};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

fn archive(kind: EqvzKind, names: &[&str]) -> EqvzArchive {
    EqvzArchive {
        manifest: EqvzManifest {
            format_version: 1,
            kind,
            main: names[0].into(),
            worksheets: names.iter().map(|s| (*s).into()).collect(),
            document_id: None,
            references: Vec::new(),
        },
        entries: names
            .iter()
            .map(|s| ((*s).into(), b"worksheet: 1\n".to_vec()))
            .collect::<BTreeMap<_, _>>(),
    }
}

fn zip_files(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, data) in files {
        zip.start_file(
            *name,
            SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
        )
        .unwrap();
        zip.write_all(data).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

#[test]
fn document_and_project_roundtrip_deterministically() {
    let document = archive(EqvzKind::Document, &["main.eqv"]);
    let bytes = document.encode().unwrap();
    assert_eq!(bytes, document.encode().unwrap());
    assert_eq!(EqvzArchive::decode(&bytes).unwrap(), document);
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    assert_eq!(
        zip.by_index(0).unwrap().compression(),
        CompressionMethod::Deflated
    );

    let mut project = archive(EqvzKind::Project, &["worksheets/a.eqv", "worksheets/b.eqv"]);
    for (path, data) in [
        ("assets/images/a.png", &b"image"[..]),
        ("julia/Project.toml", &b"[deps]"[..]),
        ("julia/Manifest.toml", &b"lock"[..]),
        ("unknown.bin", &b"\x00\xff"[..]),
    ] {
        project.entries.insert(path.into(), data.into());
    }
    let bytes = project.encode().unwrap();
    assert_eq!(EqvzArchive::decode(&bytes).unwrap(), project);
    assert_eq!(bytes, project.encode().unwrap());
}

#[test]
fn rejects_invalid_manifests_and_references() {
    assert!(EqvzArchive::decode(&zip_files(&[("manifest.json", b"{")])).is_err());
    let mut a = archive(EqvzKind::Document, &["a.eqv"]);
    a.manifest.format_version = 2;
    assert!(matches!(a.encode(), Err(EqvzError::Version(2))));
    let manifest =
        br#"{"format_version":2,"kind":"document","main":"a.eqv","worksheets":["a.eqv"]}"#;
    assert!(matches!(
        EqvzArchive::decode(&zip_files(&[("manifest.json", manifest), ("a.eqv", b"x")])),
        Err(EqvzError::Version(2))
    ));
    a.manifest.format_version = 1;
    a.manifest.main = "missing.eqv".into();
    assert!(a.encode().is_err());
    a.manifest.main = "a.eqv".into();
    a.entries.remove("a.eqv");
    assert!(a.encode().is_err());
    let a = archive(EqvzKind::Document, &["a.eqv", "b.eqv"]);
    assert!(a.encode().is_err());
}

#[test]
fn rejects_unsafe_and_colliding_paths() {
    for path in [
        "../x", "/x", "a//x", "a/./x", "a\\x", "C:x", "nul.txt", "a.", "bad?.txt", "a/CON",
    ] {
        let mut a = archive(EqvzKind::Document, &["a.eqv"]);
        a.entries.insert(path.into(), vec![]);
        assert!(a.encode().is_err(), "accepted {path}");
        let bytes = zip_files(&[(path, b"")]);
        assert!(
            EqvzArchive::decode(&bytes).is_err(),
            "accepted ZIP path {path}"
        );
    }
    let mut a = archive(EqvzKind::Document, &["a.eqv"]);
    a.entries.insert("A.EQV".into(), vec![]);
    assert!(a.encode().is_err());

    for (file, child) in [
        ("assets", "ASSETS/image.png"),
        ("a.eqv", "A.EQV/child"),
        ("manifest.json", "MANIFEST.JSON/child"),
    ] {
        let mut a = archive(EqvzKind::Document, &["a.eqv"]);
        if file != "manifest.json" {
            a.entries.insert(file.into(), vec![]);
        }
        a.entries.insert(child.into(), vec![]);
        assert!(matches!(a.encode(), Err(EqvzError::Invalid(s)) if s.contains("collision")));
        let manifest =
            br#"{"format_version":1,"kind":"document","main":"a.eqv","worksheets":["a.eqv"]}"#;
        let mut files: Vec<(&str, &[u8])> =
            vec![("manifest.json", manifest), ("a.eqv", b"worksheet")];
        if file != "manifest.json" && file != "a.eqv" {
            files.push((file, b""));
        }
        files.push((child, b""));
        assert!(
            matches!(EqvzArchive::decode(&zip_files(&files)), Err(EqvzError::Invalid(s)) if s.contains("collision"))
        );
    }

    let mut a = archive(EqvzKind::Project, &["a.eqv"]);
    a.manifest.worksheets.push("A.EQV".into());
    assert!(a.encode().is_err());
}

#[test]
fn rejects_duplicate_entries_symlinks_and_unsupported_compression() {
    // Change both local and central names in the second file to duplicate the first.
    let mut duplicate = zip_files(&[("a.eqv", b"one"), ("b.eqv", b"two")]);
    for i in 0..duplicate.len() - 4 {
        if &duplicate[i..i + 5] == b"b.eqv" {
            duplicate[i] = b'a';
        }
    }
    assert!(
        matches!(EqvzArchive::decode(&duplicate), Err(EqvzError::Invalid(s)) if s.contains("duplicate"))
    );
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    zip.add_symlink("link", "target", SimpleFileOptions::default())
        .unwrap();
    assert!(
        matches!(EqvzArchive::decode(&zip.finish().unwrap().into_inner()), Err(EqvzError::Invalid(s)) if s.contains("symlink"))
    );
    // Replace a symlink's Unix mode in the central directory with FIFO and device modes.
    for mode in [0o010644u32, 0o020644, 0o060644] {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        zip.add_symlink("special", "target", SimpleFileOptions::default())
            .unwrap();
        let mut bytes = zip.finish().unwrap().into_inner();
        let central = bytes.windows(4).position(|w| w == b"PK\x01\x02").unwrap();
        bytes[central + 38..central + 42].copy_from_slice(&(mode << 16).to_le_bytes());
        assert!(
            matches!(EqvzArchive::decode(&bytes), Err(EqvzError::Invalid(s)) if s.contains("non-regular"))
        );
    }
    let mut unsupported = zip_files(&[("a.eqv", b"a")]);
    for i in 0..unsupported.len() - 12 {
        if &unsupported[i..i + 4] == b"PK\x03\x04" {
            unsupported[i + 8..i + 10].copy_from_slice(&99u16.to_le_bytes());
        }
        if &unsupported[i..i + 4] == b"PK\x01\x02" {
            unsupported[i + 10..i + 12].copy_from_slice(&99u16.to_le_bytes());
        }
    }
    assert!(EqvzArchive::decode(&unsupported).is_err());
}

#[test]
fn limits_apply_to_both_reading_and_writing() {
    let a = archive(EqvzKind::Document, &["a.eqv"]);
    let bytes = a.encode().unwrap();
    let default = EqvzLimits::default();
    for limits in [
        EqvzLimits {
            archive_bytes: 1,
            ..default
        },
        EqvzLimits {
            entries: 1,
            ..default
        },
        EqvzLimits {
            entry_bytes: 1,
            ..default
        },
        EqvzLimits {
            total_bytes: 1,
            ..default
        },
    ] {
        assert!(matches!(
            a.encode_with_limits(limits),
            Err(EqvzError::Limit(_))
        ));
        assert!(matches!(
            EqvzArchive::decode_with_limits(&bytes, limits),
            Err(EqvzError::Limit(_))
        ));
    }
}
