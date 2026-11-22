# Reading OpenDocument spreadsheets: the built-in READODS. Spec: the specification
# section 22.1 and .
#
# An .ods file is a zip archive whose content.xml holds the sheets. This file reads it with
# the standard library only: a small zip reader (end-of-central-directory record, central
# directory, local header; stored and deflate entries), the inflation of a raw DEFLATE stream
# through the zlib library Julia itself ships (opened by path, no package dependency), and a scanner of content.xml for the elements and attributes the rules
# name. Nothing else of the archive is looked at, no formula is evaluated and no cache is
# kept: the file is read again at every evaluation.

# Julia's own zlib, opened by path: a package dependency on Zlib_jll made EqRuntime fail to load
# where the active manifest did not list it (a Windows checkout whose manifest Julia 1.12 had
# rewritten), and the library is part of every Julia install anyway.
const _LIBZ = Ref{Ptr{Cvoid}}(C_NULL)

"The handle of the zlib that ships with Julia (`bin` on Windows, `lib/julia` elsewhere)."
function _libz()
    _LIBZ[] == C_NULL || return _LIBZ[]
    Libdl = Base.Libc.Libdl
    names = Sys.iswindows() ? ("libz.dll", "zlib1.dll") :
            Sys.isapple() ? ("libz.1.dylib", "libz.dylib") : ("libz.so.1", "libz.so")
    directories = (Sys.BINDIR, normpath(Sys.BINDIR, Base.PRIVATE_LIBDIR), normpath(Sys.BINDIR, Base.LIBDIR))
    for directory in directories, name in names
        path = joinpath(directory, name)
        isfile(path) || continue
        handle = Libdl.dlopen(path; throw_error = false)
        handle === nothing || return (_LIBZ[] = handle)
    end
    for name in names
        handle = Libdl.dlopen(name; throw_error = false)
        handle === nothing || return (_LIBZ[] = handle)
    end
    odserror("zlib, which reads compressed .ods files, was not found next to Julia")
end

_zfunction(name::Symbol) = Base.Libc.Libdl.dlsym(_libz(), name)

"Limits of a Calc sheet: a range or a run outside them is an error, not a huge matrix."
const ODS_MAX_COLUMNS = 16384
const ODS_MAX_ROWS = 1_048_576

"""
    BASE_DIR

The directory a relative file name is resolved against: the `base_dir` of the evaluate
request, which the kernel keeps for the duration of
that request. `nothing` means the worksheet has no directory yet (it was never saved), where
a relative path is an error.
"""
const BASE_DIR = ScopedValue{Union{Nothing,String}}(nothing)

worksheet_directory() = BASE_DIR[]

with_base_dir(f, directory) =
    with(f, BASE_DIR => (directory === nothing ? nothing : String(directory)))

odserror(message::AbstractString) = eqerror("READODS: " * message)

# ---------------------------------------------------------------------------------------
# Zip archive
# ---------------------------------------------------------------------------------------

const _ZIP_LOCAL_HEADER = 0x04034b50
const _ZIP_CENTRAL_HEADER = 0x02014b50
const _ZIP_END_RECORD = 0x06054b50
const _ZIP_END_RECORD_SIZE = 22
const _ZIP_MAX_COMMENT = 65535

"One entry of the central directory: where its local header is and how its data is stored."
struct _ZipEntry
    name::String
    method::Int
    compressed::Int
    plain::Int
    header::Int
end

function _zip_u16(bytes::Vector{UInt8}, index::Int)
    index + 1 <= length(bytes) || odserror("the file is not a readable .ods file (truncated)")
    Int(UInt16(bytes[index]) | (UInt16(bytes[index + 1]) << 8))
end

function _zip_u32(bytes::Vector{UInt8}, index::Int)
    index + 3 <= length(bytes) ||
        odserror("the file is not a readable .ods file (truncated)")
    value = UInt32(bytes[index])
    value |= UInt32(bytes[index + 1]) << 8
    value |= UInt32(bytes[index + 2]) << 16
    value |= UInt32(bytes[index + 3]) << 24
    return Int(value)
end

"The offset of the end-of-central-directory record, or `nothing`."
function _zip_end_record(bytes::Vector{UInt8})
    last_start = max(1, length(bytes) - _ZIP_END_RECORD_SIZE - _ZIP_MAX_COMMENT)
    for index in (length(bytes) - _ZIP_END_RECORD_SIZE + 1):-1:last_start
        _zip_u32(bytes, index) == _ZIP_END_RECORD && return index
    end
    return nothing
end

function _zip_entries(bytes::Vector{UInt8})
    record = _zip_end_record(bytes)
    record === nothing &&
        odserror("the file is not a readable .ods file (no zip end-of-directory record)")
    count = _zip_u16(bytes, record + 10)
    directory = _zip_u32(bytes, record + 16) + 1
    entries = _ZipEntry[]
    index = directory
    for _ in 1:count
        _zip_u32(bytes, index) == _ZIP_CENTRAL_HEADER ||
            odserror("the file is not a readable .ods file (bad zip central directory)")
        method = _zip_u16(bytes, index + 10)
        compressed = _zip_u32(bytes, index + 20)
        plain = _zip_u32(bytes, index + 24)
        name_length = _zip_u16(bytes, index + 28)
        extra_length = _zip_u16(bytes, index + 30)
        comment_length = _zip_u16(bytes, index + 32)
        header = _zip_u32(bytes, index + 42) + 1
        index + 45 + name_length <= length(bytes) ||
            odserror("the file is not a readable .ods file (truncated)")
        name = String(bytes[index+46:index+45+name_length])
        push!(entries, _ZipEntry(name, method, compressed, plain, header))
        index += 46 + name_length + extra_length + comment_length
    end
    return entries
end

"`z_stream` of zlib (zlib.h): the layout of the fields `inflate` reads and writes."
struct _ZStream
    next_in::Ptr{UInt8}
    avail_in::Cuint
    total_in::Culong
    next_out::Ptr{UInt8}
    avail_out::Cuint
    total_out::Culong
    msg::Ptr{UInt8}
    state::Ptr{Cvoid}
    zalloc::Ptr{Cvoid}
    zfree::Ptr{Cvoid}
    opaque::Ptr{Cvoid}
    data_type::Cint
    adler::Culong
    reserved::Culong
end

const _Z_OK = 0
const _Z_STREAM_END = 1
const _Z_FINISH = 4
# A raw DEFLATE stream, the payload of a zip entry of method 8.
const _Z_RAW_DEFLATE = -15

"Inflate the raw DEFLATE stream `payload` into `plain` bytes (Julia's zlib, no zlib header)."
function _inflate_raw(payload::Vector{UInt8}, plain::Int)
    plain >= 0 || odserror("the file is not a readable .ods file (bad entry size)")
    plain == 0 && odserror("the file is not a readable .ods file (an empty entry)")
    output = Vector{UInt8}(undef, plain)
    stream = Ref(
        _ZStream(
            pointer(payload),
            Cuint(length(payload)),
            0,
            pointer(output),
            Cuint(plain),
            0,
            C_NULL,
            C_NULL,
            C_NULL,
            C_NULL,
            C_NULL,
            0,
            0,
            0,
        ),
    )
    version = ccall(_zfunction(:zlibVersion), Cstring, ())
    status = GC.@preserve payload output begin
        ccall(
            _zfunction(:inflateInit2_),
            Cint,
            (Ref{_ZStream}, Cint, Cstring, Cint),
            stream,
            _Z_RAW_DEFLATE,
            version,
            sizeof(_ZStream),
        )
    end
    status == _Z_OK || odserror("the file is not a readable .ods file (zlib is unavailable)")
    stream[].state == C_NULL &&
        odserror("the file is not a readable .ods file (zlib is unavailable)")
    try
        status = GC.@preserve payload output begin
            ccall(_zfunction(:inflate), Cint, (Ref{_ZStream}, Cint), stream, _Z_FINISH)
        end
        status == _Z_STREAM_END ||
            odserror("the file is not a readable .ods file (a compressed entry is damaged)")
        written = Int(stream[].total_out)
        written == plain ||
            odserror("the file is not a readable .ods file (an entry has an unexpected size)")
    finally
        ccall(_zfunction(:inflateEnd), Cint, (Ref{_ZStream},), stream)
    end
    return output
end

"The bytes of the archive entry `name`; stored (0) and deflate (8) entries are supported."
function _zip_entry(bytes::Vector{UInt8}, name::AbstractString)
    entry = nothing
    for candidate in _zip_entries(bytes)
        if candidate.name == String(name)
            entry = candidate
            break
        end
    end
    entry === nothing && odserror("the file has no $name part, so it is not a readable .ods file")
    _zip_u32(bytes, entry.header) == _ZIP_LOCAL_HEADER ||
        odserror("the file is not a readable .ods file (bad zip local header)")
    name_length = _zip_u16(bytes, entry.header + 26)
    extra_length = _zip_u16(bytes, entry.header + 28)
    start = entry.header + 30 + name_length + extra_length
    entry.compressed > 0 ||
        odserror("the $name part of the file is empty, so it is not a readable .ods file")
    start + entry.compressed - 1 <= length(bytes) ||
        odserror("the file is not a readable .ods file (truncated entry)")
    payload = bytes[start:(start+entry.compressed-1)]
    entry.method == 0 && return payload
    entry.method == 8 || odserror(
        "the $name part uses the compression method $(entry.method), which this reader does not know",
    )
    return _inflate_raw(payload, entry.plain)
end

# ---------------------------------------------------------------------------------------
# content.xml
# ---------------------------------------------------------------------------------------

"One event of the scanner: an element start, an element end, an empty element or text."
struct _DocumentEvent
    kind::Symbol
    name::String
    attributes::Dict{String,String}
    text::String
end

function _document_event(
    kind::Symbol, name::AbstractString, attributes, text::AbstractString=""
)
    fields = attributes isa Dict{String,String} ? attributes : Dict{String,String}()
    return _DocumentEvent(kind, String(name), fields, String(text))
end

const _ENTITIES = Dict(
    "amp" => "&",
    "lt" => "<",
    "gt" => ">",
    "quot" => "\"",
    "apos" => "'",
)

"The five predefined entities and the numeric ones."
function _decode_entities(text::AbstractString)
    occursin('&', text) || return String(text)
    plain = IOBuffer()
    index = firstindex(text)
    last_index = lastindex(text)
    while index <= last_index
        character = text[index]
        if character != '&'
            print(plain, character)
            index = nextind(text, index)
            continue
        end
        semicolon = findnext(';', text, index)
        semicolon === nothing && (print(plain, character); index = nextind(text, index); continue)
        name = text[nextind(text, index):prevind(text, semicolon)]
        decoded = get(_ENTITIES, name, nothing)
        if decoded === nothing
            decoded = _numeric_entity(name)
        end
        if decoded === nothing
            print(plain, text[index:semicolon])
        else
            print(plain, decoded)
        end
        index = nextind(text, semicolon)
    end
    return String(take!(plain))
end

function _numeric_entity(name::AbstractString)
    startswith(name, "#") || return nothing
    digits = name[2:end]
    code = if startswith(digits, "x") || startswith(digits, "X")
        tryparse(UInt32, digits[2:end]; base=16)
    else
        tryparse(UInt32, digits)
    end
    (code === nothing || code > 0x10ffff) && return nothing
    return string(Char(code))
end

const _NAMESPACE_PREFIXES = Dict(
    "urn:oasis:names:tc:opendocument:xmlns:office:1.0" => "office",
    "urn:oasis:names:tc:opendocument:xmlns:table:1.0" => "table",
    "urn:oasis:names:tc:opendocument:xmlns:text:1.0" => "text",
)

"`prefix:local` with the prefix the document declared for that namespace."
function _canonical_name(name::AbstractString, prefixes::Dict{String,String})
    colon = findfirst(':', name)
    colon === nothing && return String(name)
    prefix = name[firstindex(name):prevind(name, colon)]
    local_part = name[nextind(name, colon):end]
    canonical = get(prefixes, prefix, nothing)
    canonical === nothing && return String(name)
    return canonical * ":" * local_part
end

"Collect the `xmlns:` declarations of the root element: prefix of the document => prefix of ODS."
function _declare_prefixes!(prefixes::Dict{String,String}, attributes::Dict{String,String})
    for (key, value) in attributes
        startswith(key, "xmlns:") || continue
        canonical = get(_NAMESPACE_PREFIXES, value, nothing)
        canonical === nothing && continue
        prefixes[key[7:end]] = canonical
    end
    return prefixes
end

"The index of the `>` that ends the tag starting at `angle`, `nothing` when it is unterminated."
function _tag_end(xml::String, angle::Int)
    delimiter = '\0'
    index = nextind(xml, angle)
    while index <= lastindex(xml)
        character = xml[index]
        if delimiter != '\0'
            character == delimiter && (delimiter = '\0')
        elseif character == '"' || character == '\''
            delimiter = character
        elseif character == '>'
            return index
        end
        index = nextind(xml, index)
    end
    return nothing
end

"Split the body of a tag into its name and its attributes (values entity-decoded)."
function _tag_parts(body::AbstractString)
    text = strip(body)
    closing = startswith(text, "/")
    closing && (text = strip(text[2:end]))
    self_closing = endswith(text, "/")
    self_closing && (text = strip(text[1:prevind(text, lastindex(text))]))
    index = firstindex(text)
    start = index
    while index <= lastindex(text) && !isspace(text[index])
        index = nextind(text, index)
    end
    name = text[start:prevind(text, index)]
    attributes = Dict{String,String}()
    while index <= lastindex(text)
        while index <= lastindex(text) && isspace(text[index])
            index = nextind(text, index)
        end
        index > lastindex(text) && break
        key_start = index
        while index <= lastindex(text) && !isspace(text[index]) && text[index] != '='
            index = nextind(text, index)
        end
        key = text[key_start:prevind(text, index)]
        while index <= lastindex(text) && (isspace(text[index]) || text[index] == '=')
            index = nextind(text, index)
        end
        value = IOBuffer()
        if index <= lastindex(text) && (text[index] == '"' || text[index] == '\'')
            delimiter = text[index]
            index = nextind(text, index)
            while index <= lastindex(text) && text[index] != delimiter
                print(value, text[index])
                index = nextind(text, index)
            end
            index = index <= lastindex(text) ? nextind(text, index) : index
        else
            while index <= lastindex(text) && !isspace(text[index])
                print(value, text[index])
                index = nextind(text, index)
            end
        end
        isempty(key) || (attributes[key] = _decode_entities(String(take!(value))))
    end
    return name, attributes, closing, self_closing
end

"Whether the bytes of `text` start at `index` of `xml` (an ASCII marker after a `<`)."
function _starts_at(xml::String, text::AbstractString, index::Int)
    width = ncodeunits(text)
    index + width - 1 <= ncodeunits(xml) || return false
    for offset in 0:(width-1)
        codeunit(xml, index + offset) == codeunit(text, offset + 1) || return false
    end
    return true
end

"The tokenizer: comments, processing instructions and the DOCTYPE are dropped."
function _document_events(xml::String)
    events = _DocumentEvent[]
    prefixes = Dict{String,String}()
    position = firstindex(xml)
    while position <= lastindex(xml)
        angle = findnext(==('<'), xml, position)
        if angle === nothing
            text = xml[position:end]
            isempty(text) || push!(events, _document_event(:text, "", nothing, _decode_entities(text)))
            break
        end
        if angle > position
            text = xml[position:prevind(xml, angle)]
            isempty(strip(text)) ||
                push!(events, _document_event(:text, "", nothing, _decode_entities(text)))
        end
        if _starts_at(xml, "<!--", angle)
            stop = findnext("-->", xml, angle)
            stop === nothing && odserror("the content.xml part is not readable (unclosed comment)")
            position = last(stop) + 1
            continue
        end
        if _starts_at(xml, "<?", angle) || _starts_at(xml, "<!", angle)
            stop = findnext(==('>'), xml, angle)
            stop === nothing && odserror("the content.xml part is not readable (unclosed tag)")
            position = stop + 1
            continue
        end
        stop = _tag_end(xml, angle)
        stop === nothing && odserror("the content.xml part is not readable (unclosed tag)")
        body = xml[nextind(xml, angle):prevind(xml, stop)]
        position = stop + 1
        name, attributes, closing, self_closing = _tag_parts(body)
        isempty(name) && continue
        _declare_prefixes!(prefixes, attributes)
        canonical = _canonical_name(name, prefixes)
        canonical_attributes = attributes
        if !isempty(prefixes)
            canonical_attributes = Dict{String,String}()
            for (key, value) in attributes
                startswith(key, "xmlns:") && continue
                canonical_attributes[_canonical_name(key, prefixes)] = value
            end
        end
        kind = closing ? :end : (self_closing ? :empty : :start)
        push!(events, _document_event(kind, canonical, canonical_attributes))
    end
    return events
end

"Skip the element that starts at `index` and return the index after its end."
function _skip_element(events::Vector{_DocumentEvent}, index::Int)
    depth = 1
    index += 1
    while index <= length(events) && depth > 0
        kind = events[index].kind
        if kind == :start
            depth += 1
        elseif kind == :end
            depth -= 1
        end
        index += 1
    end
    return index
end

# ---------------------------------------------------------------------------------------
# Cell values
# ---------------------------------------------------------------------------------------

"The days from 1970-01-01 to `y-m-d` (Howard Hinnant's `days_from_civil`)."
function _days_from_civil(year::Int, month::Int, day::Int)
    adjusted = year - (month <= 2 ? 1 : 0)
    era = fld(adjusted, 400)
    year_of_era = adjusted - era * 400
    day_of_year = div(153 * (month + (month > 2 ? -3 : 9)) + 2, 5) + day - 1
    day_of_era =
        year_of_era * 365 + div(year_of_era, 4) - div(year_of_era, 100) + day_of_year
    return era * 146097 + day_of_era - 719468
end

"The spreadsheet serial day of 1899-12-30, where the reference application and Calc start counting."
const ODS_SERIAL_EPOCH = _days_from_civil(1899, 12, 30)

const _ODS_DATE = r"^(-?\d{1,6})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?)?"
const _ODS_DURATION =
    r"^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$"

"`office:date-value` as the spreadsheet serial day, with the fraction of a day of a time."
function _serial_date(text::AbstractString)
    parts = match(_ODS_DATE, strip(text))
    parts === nothing && return nothing
    year = tryparse(Int, parts.captures[1])
    month = tryparse(Int, parts.captures[2])
    day = tryparse(Int, parts.captures[3])
    (year === nothing || month === nothing || day === nothing) && return nothing
    (1 <= month <= 12 && 1 <= day <= 31) || return nothing
    serial = Float64(_days_from_civil(year, month, day) - ODS_SERIAL_EPOCH)
    hour = parts.captures[4] === nothing ? 0.0 : something(tryparse(Float64, parts.captures[4]), 0.0)
    minute =
        parts.captures[5] === nothing ? 0.0 : something(tryparse(Float64, parts.captures[5]), 0.0)
    second =
        parts.captures[6] === nothing ? 0.0 : something(tryparse(Float64, parts.captures[6]), 0.0)
    return serial + hour / 24 + minute / 1440 + second / 86400
end

"`office:time-value`, an ISO 8601 duration, as the fraction of a day it covers."
function _day_fraction(text::AbstractString)
    parts = match(_ODS_DURATION, strip(text))
    parts === nothing && return nothing
    value = 0.0
    for (capture, unit) in zip(parts.captures, (1.0, 1 / 24, 1 / 1440, 1 / 86400))
        capture === nothing && continue
        number = tryparse(Float64, capture)
        number === nothing && return nothing
        value += number * unit
    end
    return value
end

"The value of one cell, `nothing` for an empty one."
function _cell_value(attributes::Dict{String,String}, paragraphs::Vector{String})
    raw = get(attributes, "office:value-type", "")
    kind = lowercase(strip(raw))
    if kind == "float" || kind == "percentage" || kind == "currency"
        number = get(attributes, "office:value", nothing)
        number === nothing && return nothing
        return tryparse(Float64, strip(number))
    elseif kind == "boolean"
        flag = get(attributes, "office:boolean-value", nothing)
        flag === nothing && return nothing
        lowered = lowercase(strip(flag))
        lowered == "true" && return 1.0
        lowered == "false" && return 0.0
        return nothing
    elseif kind == "date"
        stamp = get(attributes, "office:date-value", nothing)
        return stamp === nothing ? nothing : _serial_date(stamp)
    elseif kind == "time"
        stamp = get(attributes, "office:time-value", nothing)
        return stamp === nothing ? nothing : _day_fraction(stamp)
    elseif kind == "string"
        isempty(paragraphs) && return get(attributes, "office:string-value", "")
        return join(paragraphs, "\n")
    end
    return nothing
end

# ---------------------------------------------------------------------------------------
# Sheets, rows and cells
# ---------------------------------------------------------------------------------------

"One sheet: the name of `table:name` and the rows that hold a value, by 1-based index."
struct _OdsSheet
    name::String
    rows::Dict{Int,Vector{Any}}
end

"The repeat count of `key` (`table:number-columns-repeated`, `table:number-rows-repeated`)."
function _repeat_count(attributes::Dict{String,String}, key::AbstractString)
    text = get(attributes, key, nothing)
    text === nothing && return 1
    count = tryparse(Int, strip(text))
    (count === nothing || count < 1) && return 1
    return count
end

"Read the pieces of text of one cell: the paragraphs of `text:p`, joined with a line break."
function _read_cell(events::Vector{_DocumentEvent}, index::Int)
    event = events[index]
    attributes = event.attributes
    covered = event.name == "table:covered-table-cell"
    paragraphs = String[]
    if event.kind == :empty
        return (covered ? nothing : _cell_value(attributes, paragraphs)), index + 1
    end
    paragraph = IOBuffer()
    index += 1
    while index <= length(events)
        event = events[index]
        kind = event.kind
        if kind == :end && (event.name == "table:table-cell" || event.name == "table:covered-table-cell")
            return (covered ? nothing : _cell_value(attributes, paragraphs)), index + 1
        elseif kind == :end && event.name == "text:p"
            push!(paragraphs, String(take!(paragraph)))
        elseif kind == :empty && event.name == "text:s"
            print(paragraph, " " ^ _repeat_count(event.attributes, "text:c"))
        elseif kind == :empty && event.name == "text:tab"
            print(paragraph, '\t')
        elseif kind == :empty && event.name == "text:line-break"
            print(paragraph, '\n')
        elseif kind == :text
            print(paragraph, event.text)
        end
        index += 1
    end
    odserror("the content.xml part is not readable (unclosed cell)")
end

"Read the cells of one row, trailing empty cells dropped; returns the values and the index."
function _read_row(events::Vector{_DocumentEvent}, index::Int)
    event = events[index]
    values = Any[]
    column = 0
    event.kind == :empty && return values, index + 1
    index += 1
    while index <= length(events)
        event = events[index]
        kind = event.kind
        if kind == :end && event.name == "table:table-row"
            while !isempty(values) && last(values) === nothing
                pop!(values)
            end
            return values, index + 1
        elseif kind in (:start, :empty) &&
               (event.name == "table:table-cell" || event.name == "table:covered-table-cell")
            value, index = _read_cell(events, index)
            repeat = _repeat_count(event.attributes, "table:number-columns-repeated")
            if column + repeat > ODS_MAX_COLUMNS
                value === nothing ||
                    odserror("a row of the sheet has more than $ODS_MAX_COLUMNS columns")
                repeat = max(ODS_MAX_COLUMNS - column, 0)
            end
            for _ in 1:repeat
                push!(values, value)
            end
            column += repeat
        elseif kind == :start
            index = _skip_element(events, index)
        else
            index += 1
        end
    end
    odserror("the content.xml part is not readable (unclosed row)")
end

"Read one `table:table`: its name and the rows that hold a value."
function _read_table(events::Vector{_DocumentEvent}, index::Int)
    event = events[index]
    sheet = _OdsSheet(get(event.attributes, "table:name", ""), Dict{Int,Vector{Any}}())
    next_row = 1
    event.kind == :empty && return sheet, index + 1
    index += 1
    while index <= length(events)
        event = events[index]
        kind = event.kind
        if kind == :end && event.name == "table:table"
            return sheet, index + 1
        elseif kind in (:start, :empty) && event.name == "table:table-row"
            repeat = _repeat_count(event.attributes, "table:number-rows-repeated")
            values, index = _read_row(events, index)
            if next_row + repeat - 1 > ODS_MAX_ROWS
                isempty(values) ||
                    odserror("the sheet '$(sheet.name)' has more than $ODS_MAX_ROWS rows")
                repeat = max(ODS_MAX_ROWS - next_row + 1, 0)
            end
            if !isempty(values)
                for offset in 0:(repeat-1)
                    sheet.rows[next_row+offset] = copy(values)
                end
            end
            next_row += repeat
        elseif kind == :start
            index = _skip_element(events, index)
        else
            index += 1
        end
    end
    odserror("the content.xml part is not readable (unclosed table)")
end

"The sheets of `content.xml`, in file order."
function _read_sheets(xml::String)
    events = _document_events(xml)
    sheets = _OdsSheet[]
    index = 1
    while index <= length(events)
        event = events[index]
        if event.kind in (:start, :empty) && event.name == "table:table"
            sheet, index = _read_table(events, index)
            push!(sheets, sheet)
        else
            # Everything around the sheets (styles, font declarations, the named expressions)
            # is stepped over one event at a time: a sheet is a `table:table` wherever it sits.
            index += 1
        end
    end
    return sheets
end

# ---------------------------------------------------------------------------------------
# Ranges
# ---------------------------------------------------------------------------------------

"The column number of a run of letters: `A` is 1, `Z` 26, `AA` 27."
function _column_number(letters::AbstractString)
    column = 0
    for character in letters
        upper = uppercase(character)
        ('A' <= upper <= 'Z') || return nothing
        column = column * 26 + (Int(upper) - Int('A') + 1)
        column > ODS_MAX_COLUMNS && return nothing
    end
    return column
end

"A corner of a range: its row and its column, or `nothing` when it is not a cell reference."
function _corner(text::AbstractString)
    parts = match(r"^([A-Za-z]+)([0-9]+)$", text)
    parts === nothing && return nothing
    column = _column_number(parts.captures[1])
    row = tryparse(Int, parts.captures[2])
    (column === nothing || row === nothing) && return nothing
    (1 <= row <= ODS_MAX_ROWS) || return nothing
    return (row, column)
end

"""
Split the sheet name of a range from its cells: a quoted name, the last `!`, or the last `.`
that is followed by a cell reference. `nothing` when the text has no sheet name.
"""
function _range_sheet(text::AbstractString)
    if startswith(text, "'")
        name = IOBuffer()
        index = nextind(text, firstindex(text))
        while index <= lastindex(text)
            character = text[index]
            if character == '\''
                next = nextind(text, index)
                if next <= lastindex(text) && text[next] == '\''
                    print(name, '\'')
                    index = nextind(text, next)
                    continue
                end
                separator = next
                (separator <= lastindex(text) && (text[separator] == '!' || text[separator] == '.')) ||
                    return nothing
                return String(take!(name)), text[nextind(text, separator):end]
            end
            print(name, character)
            index = nextind(text, index)
        end
        return nothing
    end
    bang = findlast('!', text)
    if bang !== nothing
        return text[firstindex(text):prevind(text, bang)], text[nextind(text, bang):end]
    end
    dot = findlast('.', text)
    if dot !== nothing
        cells = text[nextind(text, dot):end]
        if occursin(r"^[A-Za-z]+[0-9]+(?::[A-Za-z]+[0-9]+)?$", strip(cells))
            return text[firstindex(text):prevind(text, dot)], cells
        end
    end
    return nothing
end

"""
    _parse_range(text)

The rectangle a range names: `(sheet name or nothing, first row, first column, last row,
last column)`, or `nothing` for the used range of the first sheet.
"""
function _parse_range(text::AbstractString)
    body = strip(text)
    isempty(body) && return nothing
    sheet = nothing
    cells = body
    split = _range_sheet(body)
    if split !== nothing
        name, cells = split
        name = strip(name)
        isempty(name) && odserror("\"$body\" is not a cell range")
        sheet = String(name)
    end
    cells = strip(cells)
    parts = match(r"^([A-Za-z]+[0-9]+)(?::([A-Za-z]+[0-9]+))?$", cells)
    parts === nothing && odserror("\"$body\" is not a cell range")
    first_corner = _corner(parts.captures[1])
    first_corner === nothing && odserror("\"$body\" is not a cell range")
    last_corner = parts.captures[2] === nothing ? first_corner : _corner(parts.captures[2])
    last_corner === nothing && odserror("\"$body\" is not a cell range")
    (first_corner[1] <= last_corner[1] && first_corner[2] <= last_corner[2]) ||
        odserror("\"$body\" does not start at its top-left cell")
    return (sheet, first_corner[1], first_corner[2], last_corner[1], last_corner[2])
end

# ---------------------------------------------------------------------------------------
# The built-in
# ---------------------------------------------------------------------------------------

"The matrix of a rectangle of a sheet; every empty cell is `emptyfill`."
function _ods_rectangle(sheet, first_row, first_column, last_row, last_column, emptyfill)
    row_count = last_row - first_row + 1
    column_count = last_column - first_column + 1
    values = Matrix{Any}(undef, row_count, column_count)
    for row in 1:row_count
        cells = get(sheet.rows, first_row + row - 1, nothing)
        for column in 1:column_count
            position = first_column + column - 1
            value = cells === nothing || position > length(cells) ? nothing : cells[position]
            values[row, column] = value === nothing ? emptyfill : value
        end
    end
    all(value -> value isa Float64, values) && return Float64.(values)
    return values
end

"An absolute path as written, a relative one against the worksheet directory."
function _ods_path(file::AbstractString)
    path = String(file)
    isempty(path) && eqerror("READODS needs a file name")
    isabspath(path) && return path
    directory = BASE_DIR[]
    directory === nothing &&
        eqerror("READODS: save the worksheet first, or use an absolute path")
    return joinpath(directory, path)
end

"The sheets of the `.ods` file at `path`."
function _ods_read(path::String)
    isfile(path) || eqerror("READODS: cannot read $path: no such file")
    bytes = try
        read(path)
    catch exception
        exception isa InterruptException && rethrow()
        eqerror("READODS: cannot read $path")
    end
    content = _zip_entry(bytes, "content.xml")
    xml = try
        String(content)
    catch exception
        exception isa InterruptException && rethrow()
        odserror("$path is not a readable .ods file")
    end
    return _read_sheets(xml)
end

"The sheet a range names, or the first sheet; an unknown name is an error that names it."
function _ods_sheet(sheets::Vector{_OdsSheet}, name::Union{Nothing,AbstractString})
    isempty(sheets) && odserror("the file has no sheets")
    name === nothing && return first(sheets)
    for sheet in sheets
        sheet.name == name && return sheet
    end
    odserror("the file has no sheet named '$name'")
end

function _readods(file, sheet_range, emptyfill)
    file isa AbstractString || eqerror("READODS needs a file name")
    sheet_range === nothing || sheet_range isa AbstractString ||
        eqerror("READODS needs a range as text")
    emptyfill === nothing && (emptyfill = NaN)
    (emptyfill isa Number || emptyfill isa AbstractString) ||
        eqerror("READODS: emptyfill must be a scalar")
    range = sheet_range === nothing ? nothing : strip(String(sheet_range))
    (range !== nothing && isempty(range)) && (range = nothing)
    selection = range === nothing ? nothing : _parse_range(range)
    sheets = _ods_read(_ods_path(file))
    if selection === nothing
        sheet = _ods_sheet(sheets, nothing)
        isempty(sheet.rows) && odserror("sheet '$(sheet.name)' has no values")
        last_row = maximum(keys(sheet.rows))
        last_column = maximum(length(cells) for cells in values(sheet.rows))
        return _ods_rectangle(sheet, 1, 1, last_row, last_column, emptyfill)
    end
    name, first_row, first_column, last_row, last_column = selection
    sheet = _ods_sheet(sheets, name)
    return _ods_rectangle(sheet, first_row, first_column, last_row, last_column, emptyfill)
end

"""
    eq_READODS("file", ["range", [emptyfill]])

The cells of a range of an OpenDocument spreadsheet (`.ods`) as a matrix: rules to
 of the specification section 22.1. The file is read at every
evaluation; a relative path is resolved against the worksheet directory of the request.
"""
eq_READODS(file) = _readods(file, nothing, NaN)

eq_READODS(file, sheet_range) = _readods(file, sheet_range, NaN)

eq_READODS(file, sheet_range, emptyfill) = _readods(file, sheet_range, emptyfill)
