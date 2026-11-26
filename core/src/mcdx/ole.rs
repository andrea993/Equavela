//! A minimal reader of OLE compound files (the format of a component's binary item in an
//! `.xmcd`): one stream by name, and the File Input component's settings read from it.

/// The bytes of the stream `name` of the compound file that starts somewhere in `bytes`.
pub(super) fn stream(bytes: &[u8], name: &str) -> Option<Vec<u8>> {
    const SIGNATURE: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    const END: u32 = 0xFFFF_FFFA;
    let start = bytes.windows(8).position(|w| w == SIGNATURE)?;
    let file = &bytes[start..];
    let u16_at = |at: usize| Some(u16::from_le_bytes(file.get(at..at + 2)?.try_into().ok()?));
    let u32_at =
        |data: &[u8], at: usize| Some(u32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?));
    let sector_size = 1usize << u16_at(30)?.min(16);
    let mini_size = 1usize << u16_at(32)?.min(16);
    let fat_sectors = u32_at(file, 44)? as usize;
    let directory_start = u32_at(file, 48)?;
    let cutoff = u32_at(file, 56)? as usize;
    let minifat_start = u32_at(file, 60)?;
    if fat_sectors > 109 {
        return None;
    }
    let sector = |n: u32| {
        let at = sector_size.checked_mul(n as usize + 1)?;
        file.get(at..at + sector_size)
    };
    let mut fat = Vec::new();
    for k in 0..fat_sectors {
        let data = sector(u32_at(file, 76 + 4 * k)?)?;
        fat.extend((0..sector_size / 4).filter_map(|i| u32_at(data, 4 * i)));
    }
    let chain = |first: u32, table: &[u32]| {
        let mut out = Vec::new();
        let mut n = first;
        let mut steps = 0;
        while n < END {
            out.push(n);
            n = *table.get(n as usize)?;
            steps += 1;
            if steps > table.len() {
                return None;
            }
        }
        Some(out)
    };
    let read = |first: u32| -> Option<Vec<u8>> {
        let mut out = Vec::new();
        for n in chain(first, &fat)? {
            out.extend_from_slice(sector(n)?);
        }
        Some(out)
    };
    let directory = read(directory_start)?;
    let entries: Vec<(String, u32, usize)> = directory
        .as_chunks::<128>()
        .0
        .iter()
        .filter_map(|entry| {
            let length = u16::from_le_bytes(entry[64..66].try_into().ok()?) as usize;
            let units: Vec<u16> = entry[..length.saturating_sub(2).min(64)]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| u16::from_le_bytes(*c))
                .collect();
            let first = u32_at(entry, 116)?;
            let size = u32_at(entry, 120)? as usize;
            Some((String::from_utf16(&units).ok()?, first, size))
        })
        .collect();
    let (_, first, size) = entries.iter().find(|(n, _, _)| n == name)?;
    let mut data = if *size < cutoff {
        let root = read(entries.first()?.1)?;
        let minifat: Vec<u32> = read(minifat_start)?
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| u32::from_le_bytes(*c))
            .collect();
        let mut out = Vec::new();
        for n in chain(*first, &minifat)? {
            let at = n as usize * mini_size;
            out.extend_from_slice(root.get(at..at + mini_size)?);
        }
        out
    } else {
        read(*first)?
    };
    data.truncate(*size);
    Some(data)
}

/// The settings of a File Input component, from its `Contents` stream.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct FileInput {
    pub path: String,
    /// File format code: 1 text, 2 MATLAB, 3 Excel, 4 Lotus 1-2-3, 6 dBase III.
    pub format: u32,
    pub relative: bool,
    pub decimal_comma: bool,
    /// First and last row and column, from 1; `None` stops at the end of the data.
    pub rows: (u32, Option<u32>),
    pub cols: (u32, Option<u32>),
}

impl FileInput {
    pub(super) fn read(contents: &[u8]) -> Option<FileInput> {
        let int = |at: usize| {
            Some(u32::from_le_bytes(
                contents.get(at..at + 4)?.try_into().ok()?,
            ))
        };
        let stop = |value: u32| (value != u32::MAX).then_some(value);
        let flags = int(58)?;
        Some(FileInput {
            path: mfc_string(contents, 66)?.0,
            format: int(62)?,
            relative: flags & 4 != 0,
            decimal_comma: flags & 2 != 0,
            rows: (int(42)?.max(1), stop(int(46)?)),
            cols: (int(50)?.max(1), stop(int(54)?)),
        })
    }
}

/// An MFC string at `at` (`ff fe ff`, then the length and UTF-16 units): the text and the
/// offset after it.
fn mfc_string(data: &[u8], at: usize) -> Option<(String, usize)> {
    if data.get(at..at + 3)? != [0xFF, 0xFE, 0xFF] {
        return None;
    }
    let (length, start) = match *data.get(at + 3)? {
        0xFF => (
            u16::from_le_bytes(data.get(at + 4..at + 6)?.try_into().ok()?) as usize,
            at + 6,
        ),
        n => (n as usize, at + 4),
    };
    let units: Vec<u16> = data
        .get(start..start + 2 * length)?
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
        .collect();
    Some((String::from_utf16(&units).ok()?, start + 2 * length))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mfc(text: &str) -> Vec<u8> {
        let mut out = vec![0xFF, 0xFE, 0xFF, text.encode_utf16().count() as u8];
        out.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        out
    }

    fn contents(
        rows: (u32, u32),
        cols: (u32, u32),
        flags: u32,
        format: u32,
        path: &str,
    ) -> Vec<u8> {
        let mut out = vec![0u8; 42];
        for value in [rows.0, rows.1, cols.0, cols.1, flags, format] {
            out.extend(value.to_le_bytes());
        }
        out.extend(mfc(path));
        out.extend(mfc(""));
        out.extend(mfc(""));
        out.extend(mfc("A2"));
        out
    }

    #[test]
    fn the_settings_are_read_from_their_fixed_places() {
        let data = contents((2, u32::MAX), (1, u32::MAX), 4, 1, r"..\data\count.txt");
        assert_eq!(
            FileInput::read(&data),
            Some(FileInput {
                path: r"..\data\count.txt".into(),
                format: 1,
                relative: true,
                decimal_comma: false,
                rows: (2, None),
                cols: (1, None),
            })
        );
        let data = contents((1, 121), (1, 12), 2, 3, r"C:\data\book.xls");
        let input = FileInput::read(&data).unwrap();
        assert_eq!((input.rows, input.cols), ((1, Some(121)), (1, Some(12))));
        assert!(input.decimal_comma && !input.relative);
        assert_eq!(input.format, 3);
    }

    #[test]
    fn a_stream_is_read_from_a_compound_file() {
        // One 512-byte sector each: header, FAT, directory, mini FAT, mini stream.
        let payload = b"stream bytes".to_vec();
        let mut file = vec![0u8; 512 * 5];
        file[..8].copy_from_slice(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
        file[30..32].copy_from_slice(&9u16.to_le_bytes());
        file[32..34].copy_from_slice(&6u16.to_le_bytes());
        file[44..48].copy_from_slice(&1u32.to_le_bytes());
        file[48..52].copy_from_slice(&1u32.to_le_bytes());
        file[56..60].copy_from_slice(&4096u32.to_le_bytes());
        file[60..64].copy_from_slice(&2u32.to_le_bytes());
        file[76..80].copy_from_slice(&0u32.to_le_bytes());
        // FAT (sector 0): sectors 1, 2 and 3 are one-sector chains.
        let fat = 512;
        for (n, value) in [
            (0, 0xFFFF_FFFDu32),
            (1, 0xFFFF_FFFE),
            (2, 0xFFFF_FFFE),
            (3, 0xFFFF_FFFE),
        ] {
            file[fat + 4 * n..fat + 4 * n + 4].copy_from_slice(&value.to_le_bytes());
        }
        // Directory (sector 1): the root (mini stream in sector 3), then "Contents" at mini sector 0.
        let dir = 1024;
        let mut entry = |at: usize, name: &str, first: u32, size: u32| {
            let units: Vec<u8> = name
                .encode_utf16()
                .chain([0])
                .flat_map(u16::to_le_bytes)
                .collect();
            file[at..at + units.len()].copy_from_slice(&units);
            file[at + 64..at + 66].copy_from_slice(&(units.len() as u16).to_le_bytes());
            file[at + 116..at + 120].copy_from_slice(&first.to_le_bytes());
            file[at + 120..at + 124].copy_from_slice(&size.to_le_bytes());
        };
        entry(dir, "Root Entry", 3, 64);
        entry(dir + 128, "Contents", 0, payload.len() as u32);
        // Mini FAT (sector 2): mini sector 0 ends its chain.
        file[1536..1540].copy_from_slice(&0xFFFF_FFFEu32.to_le_bytes());
        // Mini stream (sector 3).
        file[2048..2048 + payload.len()].copy_from_slice(&payload);
        let mut item = b"prefix".to_vec();
        item.extend(file);
        assert_eq!(stream(&item, "Contents"), Some(payload));
        assert_eq!(stream(&item, "Missing"), None);
    }
}
