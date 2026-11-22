# Legacy BIFF support belongs in the kernel's lazily loaded Python environment.
# EqRuntime only stores callbacks, so loading the numeric runtime never loads Python.
const _XLS_PYTHON = raw"""
import io, json, math, os, re, struct, tempfile
import xlrd, xlwt
from xlutils.filter import process, XLRDReader, XLWTWriter
from xlrd.compdoc import CompDoc


def _open_xls(path):
    with open(path, 'rb') as f:
        data = f.read()
    return data, xlrd.open_workbook(file_contents=data, formatting_info=True, on_demand=True)


# Records not reconstructed by xlutils must retain their standard xlwt value.
# Derive those values from the installed writer rather than assuming an encoding.
_DEFAULT_OPTIONS = None
_OPTION_RECORDS = {0x0012, 0x0013, 0x0063, 0x00dd,  # protection
    0x0014, 0x0015, 0x001a, 0x001b, 0x0026, 0x0027, 0x0028, 0x0029,
    0x002a, 0x002b, 0x0083, 0x0084, 0x00a1,  # print settings
    0x0293}  # named styles


def _default_options():
    global _DEFAULT_OPTIONS
    if _DEFAULT_OPTIONS is None:
        result = xlwt.Workbook()
        result.add_sheet('Default').write(0, 0, 1)
        stream = io.BytesIO()
        result.save(stream)
        book = xlrd.open_workbook(file_contents=stream.getvalue(), formatting_info=True, on_demand=True)
        try:
            raw = book.mem[book.base:book.base + book.stream_len]
            options = {}
            pos = 0
            while pos + 4 <= len(raw):
                code, length = struct.unpack_from('<HH', raw, pos)
                pos += 4
                if code in _OPTION_RECORDS:
                    options.setdefault(code, set()).add(bytes(raw[pos:pos + length]))
                pos += length
            _DEFAULT_OPTIONS = options
        finally:
            book.release_resources()
    return _DEFAULT_OPTIONS


def _check_rewrite(data, book):
    # xlutils rewrites BIFF rather than editing it in place. Reject structures it
    # cannot faithfully reproduce, including VBA and any auxiliary OLE streams.
    if data[:8] != bytes.fromhex('d0cf11e0a1b11ae1'):
        raise ValueError('unsupported non-OLE Excel workbook')
    if book.biff_version != 80:
        raise ValueError('only BIFF8 XLS workbooks can be updated safely')
    doc = CompDoc(data)
    for item in doc.dirlist:
        if item.etype and item.name not in ('Root Entry', 'Workbook', 'Book'):
            raise ValueError('unsupported OLE stream or storage: ' + item.name)
    # BIFF record headers include length, so record contents are never mistaken
    # for opcodes. Continue through every substream including hidden sheets.
    unsupported = {0x0006:'formula', 0x0206:'formula', 0x0406:'formula',
        0x04bc:'shared formula', 0x0221:'array formula', 0x0021:'array formula',
        0x0236:'data table', 0x0036:'data table', 0x0037:'data table',
        0x002f:'encryption', 0x005d:'object', 0x00ec:'drawing', 0x00eb:'drawing',
        0x01b6:'text object', 0x01b8:'hyperlink', 0x01be:'data validation',
        0x01b2:'data validation', 0x01b0:'conditional formatting',
        0x01b1:'conditional formatting', 0x00e5:'merged cells',
        0x0018:'defined name', 0x01ae:'external reference', 0x0017:'external reference',
        0x0023:'external name',
        0x001c:'cell comment', 0x009d:'auto filter', 0x009e:'auto filter',
        0x01bb:'data validation', 0x0867:'sheet features', 0x0872:'sheet features'}
    # Unknown records may encode information the copier silently drops. Only
    # permit plain BIFF8 workbook/sheet, formatting and cell records.
    allowed = {0x0000, 0x0809, 0x000a, 0x00e1, 0x00c1, 0x00e2, 0x005c,
        0x0042, 0x0161, 0x013d, 0x009c, 0x0019, 0x01af, 0x01bc,
        0x0040, 0x008d, 0x003d, 0x0022, 0x000e, 0x01b7, 0x00da,
        0x0031, 0x041e, 0x00e0, 0x0160, 0x0085, 0x00fc, 0x000d,
        0x000c, 0x000f, 0x0011, 0x0010, 0x005f, 0x0080, 0x0225,
        0x0081, 0x0200, 0x0082, 0x0208, 0x027e, 0x023e, 0x003c,
        0x020b, 0x00d7, 0x00ff, 0x008c, 0x007d, 0x0055, 0x0099,
        0x0041, 0x00a0, 0x0092, 0x00bd, 0x00be, 0x0201, 0x0203,
        0x0204, 0x0205, 0x00fd} | _OPTION_RECORDS
    defaults = _default_options()
    raw = book.mem[book.base:book.base + book.stream_len]
    offset = 0
    while offset + 4 <= len(raw):
        code, size = struct.unpack_from('<HH', raw, offset)
        offset += 4
        if offset + size > len(raw):
            raise ValueError('truncated BIFF record')
        if code in unsupported:
            raise ValueError('unsupported existing XLS feature: ' + unsupported[code])
        if code not in allowed:
            raise ValueError('unsupported existing XLS record: 0x%04x' % code)
        payload = bytes(raw[offset:offset + size])
        if code in _OPTION_RECORDS and payload not in defaults.get(code, ()):
            raise ValueError('unsupported existing XLS print, protection or named-style settings')
        if code == 0x0099 and (size != 2 or struct.unpack('<H', payload)[0] % 256):
            raise ValueError('unsupported fractional default column width')
        if code in (0x0809, 0x0409, 0x0209, 0x0009) and size >= 4:
            kind = struct.unpack_from('<H', raw, offset + 2)[0]
            if kind not in (0x0005, 0x0010):
                raise ValueError('unsupported XLS substream')
        offset += size
    if offset != len(raw) and any(raw[offset:]):
        raise ValueError('truncated BIFF stream')


class _PreservingWriter(XLWTWriter):
    def workbook(self, source, name):
        super().workbook(source, name)
        # Fix xlutils' incorrect shadow = outline mapping before styles are
        # registered while copying cells.
        for xf, style in zip(source.xf_list, self.style_list):
            style.font.shadow = source.font_list[xf.font_index].shadow


def read_xls(path):
    _, book = _open_xls(path)
    try:
        sheet = book.sheet_by_index(0)
        rows = []
        for r in range(sheet.nrows):
            row = []
            for c in range(sheet.ncols):
                cell = sheet.cell(r, c)
                if cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
                    row.append(None)
                elif cell.ctype == xlrd.XL_CELL_ERROR:
                    raise ValueError('Excel error cells cannot be read as values')
                else:
                    row.append(cell.value)
            rows.append(row)
        return json.dumps(rows, allow_nan=False)
    finally:
        book.release_resources()


def write_xls(path, rows_json, sheetindex, sheetname, anchor):
    rows = json.loads(rows_json)
    m = re.fullmatch(r'([A-Za-z]+)([1-9][0-9]*)', anchor)
    if not m:
        raise ValueError('invalid XLS cell reference')
    col = 0
    for ch in m.group(1).upper():
        col = col * 26 + ord(ch) - 64
    col -= 1
    row = int(m.group(2)) - 1
    if row + len(rows) > 65536 or col + len(rows[0]) > 256:
        raise ValueError('XLS range exceeds BIFF8 limits')
    if os.path.exists(path):
        data, source = _open_xls(path)
        try:
            _check_rewrite(data, source)
            for source_sheet in source.sheets():
                if source_sheet.rich_text_runlist_map:
                    raise ValueError('unsupported rich text formatting')
                if any(c >= source_sheet.ncols for c in source_sheet.colinfo_map):
                    raise ValueError('unsupported formatting on empty columns')
                if any(r >= source_sheet.nrows for r in source_sheet.rowinfo_map):
                    raise ValueError('unsupported formatting on empty rows')
            names = source.sheet_names()
            if sheetname is not None:
                if sheetname not in names:
                    raise ValueError('sheet does not exist: ' + sheetname)
                index = names.index(sheetname)
            else:
                index = sheetindex - 1
                if index < 0 or index >= len(names):
                    raise ValueError('sheet index is out of bounds')
            target_source = source.sheet_by_index(index)
            writer = _PreservingWriter()
            process(XLRDReader(source, 'workbook.xls'), writer)
            result = writer.output[0][1]
            # xlutils omits the custom palette.
            for palette_index in range(8, 64):
                rgb = source.colour_map.get(palette_index)
                if rgb is not None:
                    result.set_colour_RGB(palette_index, *rgb)
            styles = {}
            for r, values in enumerate(rows):
                for c, _ in enumerate(values):
                    sr, sc = row + r, col + c
                    if sr < target_source.nrows and sc < target_source.ncols:
                        xf = target_source.cell(sr, sc).xf_index
                        if xf is not None:
                            styles[(r, c)] = writer.style_list[xf]
        finally:
            source.release_resources()
        target = result.get_sheet(index)
        target._cell_overwrite_ok = True
    else:
        if sheetindex != 1:
            raise ValueError('sheet index is out of bounds')
        result = xlwt.Workbook()
        target = result.add_sheet(sheetname or 'Sheet1', cell_overwrite_ok=True)
        styles = {}
    for r, values in enumerate(rows):
        for c, value in enumerate(values):
            target.write(row + r, col + c, value, styles.get((r, c), xlwt.Style.default_style))
    fd, temporary = tempfile.mkstemp(prefix='.equavela-', suffix='.xls', dir=os.path.dirname(os.path.abspath(path)))
    os.close(fd)
    try:
        result.save(temporary)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
"""

const _XLS_MODULE = Ref{Any}(nothing)
const _XLS_LOCK = ReentrantLock()

function _xls_call(name, args...)
    lock(_XLS_LOCK) do
        _ensure_symbolic!()
        # PythonCall and its methods are loaded at runtime and live in a newer world.
        Base.invokelatest() do
            py = BRIDGE[].PythonCall
            if _XLS_MODULE[] === nothing
                namespace = py.pydict()
                py.pyexec(_XLS_PYTHON, namespace)
                _XLS_MODULE[] = namespace
            end
            result = _XLS_MODULE[][name](args...)
            name == "read_xls" ? py.pyconvert(String, result) : nothing
        end
    end
end

function _xls_read(path, emptyfill)
    rows = JSON3.read(_xls_call("read_xls", path))
    nrows = length(rows)
    ncols = nrows == 0 ? 0 : length(rows[1])
    matrix = Matrix{Any}(undef, nrows, ncols)
    for r in 1:nrows, c in 1:ncols
        value = rows[r][c]
        matrix[r, c] = value === nothing ? emptyfill : value
    end
    return matrix
end

function _xls_write(path, matrix, sheetindex, sheetname, anchor)
    isempty(matrix) && error("empty XLS data is unsupported")
    function cell_value(value)
        if value isa AbstractString || value isa Bool
            value
        elseif value isa Real
            number = Float64(value)
            isfinite(number) || error("XLS numbers must be finite")
            number
        else
            error("unsupported XLS cell value")
        end
    end
    rows = [Any[cell_value(matrix[r, c]) for c in axes(matrix, 2)] for r in axes(matrix, 1)]
    _xls_call("write_xls", path, JSON3.write(rows), sheetindex, sheetname, anchor)
    return nothing
end
