# OpenDocument spreadsheet output, paired with READODS.
import ZipArchives
import XML

const _ODS_WRITE_LOCK = ReentrantLock()

function _ods_escape(value)
    text = String(value)
    valid_xml(c) = c in ('\t', '\n', '\r') || 0x20 <= UInt32(c) <= 0xd7ff ||
        0xe000 <= UInt32(c) <= 0xfffd || 0x10000 <= UInt32(c) <= 0x10ffff
    isvalid(text) && all(valid_xml, text) || eqerror("WRITEODS: text contains invalid XML characters")
    replace(text, '&' => "&amp;", '<' => "&lt;", '>' => "&gt;", '"' => "&quot;", '\'' => "&apos;", '\r' => "&#13;")
end

function _ods_write_cell(io, value)
    if value === missing || (value isa Real && isnan(value))
        print(io, "<table:table-cell/>")
    elseif value isa AbstractString
        text = replace(_ods_escape(value), " " => "<text:s/>", "\t" => "<text:tab/>", "\n" => "<text:line-break/>")
        print(io, "<table:table-cell office:value-type=\"string\"><text:p>", text, "</text:p></table:table-cell>")
    elseif value isa Bool
        print(io, "<table:table-cell office:value-type=\"boolean\" office:boolean-value=\"", value, "\"/>")
    elseif value isa Real && !(value isa Unitful.AbstractQuantity) && isfinite(value)
        number = try
            Float64(value)
        catch
            eqerror("WRITEODS: numeric cells must be representable as Float64")
        end
        isfinite(number) || eqerror("WRITEODS: numeric cells must be finite Float64 values")
        print(io, "<table:table-cell office:value-type=\"float\" office:value=\"", number, "\"/>")
    else
        eqerror("WRITEODS: cells must contain finite unitless real numbers, strings or empty values")
    end
end

# Locate top-level sheets using their expanded names, while retaining the original XML
# byte-for-byte everywhere outside the replaced sheet. Namespace bindings are scoped.
function _ods_xml_spans(xml, wanted)
    isvalid(xml) || eqerror("WRITEODS: content.xml is not UTF-8")
    XML.parse(xml, XML.Node; wellformed=:strict)
    occursin("<!DOCTYPE", uppercase(xml)) && eqerror("WRITEODS: XML document types are unsupported")
    stack = []
    pos = 1
    found = nothing
    insertion = nothing
    spreadsheet_count = 0
    names = Set{String}()
    while (angle = findnext('<', xml, pos)) !== nothing
        if _starts_at(xml, "<!--", angle) || _starts_at(xml, "<![CDATA[", angle) || _starts_at(xml, "<?", angle)
            marker = _starts_at(xml, "<!--", angle) ? "-->" : (_starts_at(xml, "<![CDATA[", angle) ? "]]>" : "?>")
            stop = findnext(marker, xml, angle)
            stop === nothing && error("unterminated XML markup")
            pos = last(stop) + 1
            continue
        end
        stop = _tag_end(xml, angle)
        stop === nothing && error("unterminated XML tag")
        rawname, attrs, closing, empty = _tag_parts(xml[nextind(xml, angle):prevind(xml, stop)])
        pos = stop + 1
        if closing
            isempty(stack) && error("unexpected closing tag")
            frame = pop!(stack)
            frame.rawname == rawname || error("mismatched XML tags")
            if frame.issheet && frame.sheetname == wanted
                found = (frame.start, stop, frame.openend, angle, false)
            end
            frame.isspreadsheet && (insertion = angle)
            continue
        end
        ns = isempty(stack) ? Dict{String,String}() : copy(stack[end].ns)
        for (key, value) in attrs
            key == "xmlns" && (ns[""] = value)
            startswith(key, "xmlns:") && (ns[key[7:end]] = value)
        end
        expanded(name; attribute=false) = begin
            parts = split(name, ':'; limit=2)
            length(parts) == 2 ? (get(ns, String(parts[1]), ""), String(parts[2])) :
                (attribute ? "" : get(ns, "", ""), String(parts[1]))
        end
        uri, localname = expanded(rawname)
        office = "urn:oasis:names:tc:opendocument:xmlns:office:1.0"
        table = "urn:oasis:names:tc:opendocument:xmlns:table:1.0"
        inspreadsheet = any(frame -> frame.isspreadsheet, stack)
        isspreadsheet = (uri, localname) == (office, "spreadsheet")
        if isspreadsheet
            length(stack) == 2 && stack[1].expanded == (office, "document-content") &&
                stack[2].expanded == (office, "body") || error("invalid spreadsheet structure")
            spreadsheet_count += 1
            empty && error("empty spreadsheet element is unsupported")
        end
        # Table groups can contain sheets; tables nested in cells are not sheets.
        insheet = any(frame -> frame.issheet, stack)
        issheet = inspreadsheet && !insheet && (uri, localname) == (table, "table")
        sheetname = nothing
        if issheet
            for (key, value) in attrs
                expanded(key; attribute=true) == (table, "name") && (sheetname = value)
            end
            sheetname === nothing && error("sheet has no name")
            sheetname in names && error("duplicate sheet name")
            push!(names, sheetname)
            empty && sheetname == wanted && (found = (angle, stop, stop, stop, true))
        end
        if !empty
            push!(stack, (; rawname, ns, expanded=(uri, localname), isspreadsheet, issheet, sheetname, start=angle, openend=stop))
        end
    end
    isempty(stack) || error("unclosed XML element")
    spreadsheet_count == 1 && insertion !== nothing || error("missing or ambiguous spreadsheet")
    return found, insertion
end

function _ods_validate_manifest(manifest)
    isvalid(manifest) || error("invalid manifest encoding")
    occursin("<!DOCTYPE", uppercase(manifest)) && error("manifest document types are unsupported")
    doc = XML.parse(manifest, XML.Node; wellformed=:strict)
    uri = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"
    entries = Dict{String,String}()
    roots = 0
    function visit(node, parentns, depth)
        XML.nodetype(node) == XML.Element || return
        ns = copy(parentns)
        attrs = something(XML.attributes(node), ())
        for (key, value) in attrs
            key == "xmlns" && (ns[""] = value)
            startswith(key, "xmlns:") && (ns[key[7:end]] = value)
        end
        expanded(name; attribute=false) = begin
            parts = split(name, ':'; limit=2)
            length(parts) == 2 ? (get(ns, String(parts[1]), ""), String(parts[2])) :
                (attribute ? "" : get(ns, "", ""), String(parts[1]))
        end
        name = expanded(XML.tag(node))
        if depth == 0
            name == (uri, "manifest") || error("invalid ODS manifest root")
            roots += 1
        end
        name == (uri, "encryption-data") && error("encrypted ODS files are unsupported")
        if name == (uri, "file-entry") && depth == 1
            path = nothing
            media = nothing
            for (key, value) in attrs
                expanded(key; attribute=true) == (uri, "full-path") && (path = value)
                expanded(key; attribute=true) == (uri, "media-type") && (media = value)
            end
            path === nothing && error("manifest file entry has no path")
            haskey(entries, path) && error("duplicate manifest entry")
            entries[path] = something(media, "")
        end
        for child in XML.children(node)
            visit(child, ns, depth + 1)
        end
    end
    for child in XML.children(doc)
        visit(child, Dict{String,String}(), 0)
    end
    roots == 1 || error("invalid ODS manifest")
    get(entries, "/", "") == "application/vnd.oasis.opendocument.spreadsheet" || error("invalid ODS media type in manifest")
    haskey(entries, "content.xml") || error("content.xml is missing from manifest")
end

function _ods_existing(path, sheet, table_xml)
    try
        archive = ZipArchives.ZipReader(read(path))
        names = ZipArchives.zip_names(archive)
        length(unique(names)) == length(names) || error("duplicate archive entries")
        all(name -> name in names, ("mimetype", "content.xml", "META-INF/manifest.xml")) || error("missing required ODS entries")
        entries = [name => ZipArchives.zip_readentry(archive, i) for (i, name) in enumerate(names)]
        lookup = Dict(entries)
        String(copy(lookup["mimetype"])) == "application/vnd.oasis.opendocument.spreadsheet" || error("not an ODS spreadsheet")
        manifest = String(copy(lookup["META-INF/manifest.xml"]))
        _ods_validate_manifest(manifest)
        any(name -> startswith(lowercase(name), "meta-inf/") && occursin("signatures", lowercase(name)), names) &&
            error("digitally signed ODS files are unsupported")
        content = String(copy(lookup["content.xml"]))
        span, insertion = _ods_xml_spans(content, sheet)
        if span === nothing
            content = content[1:prevind(content, insertion)] * table_xml * content[insertion:end]
        else
            a, b, openend, close_start, empty = span
            opening = content[a:openend]
            if empty
                slash = findprev('/', opening, prevind(opening, lastindex(opening)))
                opening = opening[1:prevind(opening, slash)] * opening[nextind(opening, slash):end]
                rawname, _, _, _ = _tag_parts(opening[2:prevind(opening, lastindex(opening))])
                closing = "</" * rawname * ">"
            else
                closing = content[close_start:b]
            end
            body_start = findfirst('>', table_xml)
            body_end = findlast("</table:table>", table_xml)
            body = table_xml[nextind(table_xml, body_start):prevind(table_xml, first(body_end))]
            content = content[1:prevind(content, a)] * opening * body * closing * content[nextind(content, b):end]
        end
        return [name => (name == "content.xml" ? collect(codeunits(content)) : data) for (name, data) in entries]
    catch err
        err isa EqError && rethrow()
        eqerror("WRITEODS: cannot update existing ODS file: $(sprint(showerror, err))")
    end
end

function eq_WRITEODS(file, data, sheet="Sheet1")
    sheet isa AbstractString && !isempty(sheet) || eqerror("WRITEODS: sheet name must be nonempty text")
    path = _file_path("WRITEODS", file)
    lowercase(splitext(path)[2]) == ".ods" || eqerror("WRITEODS needs an .ods file name")
    matrix = _file_matrix("WRITEODS", data)
    0 < size(matrix, 1) <= ODS_MAX_ROWS && 0 < size(matrix, 2) <= ODS_MAX_COLUMNS ||
        eqerror("WRITEODS: matrix dimensions exceed spreadsheet limits or are empty")
    table = IOBuffer()
    print(table, "<table:table xmlns:table=\"urn:oasis:names:tc:opendocument:xmlns:table:1.0\" xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\" xmlns:text=\"urn:oasis:names:tc:opendocument:xmlns:text:1.0\" table:name=\"", _ods_escape(sheet), "\">")
    for row in axes(matrix, 1)
        print(table, "<table:table-row xmlns:table=\"urn:oasis:names:tc:opendocument:xmlns:table:1.0\" xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\" xmlns:text=\"urn:oasis:names:tc:opendocument:xmlns:text:1.0\">")
        for col in axes(matrix, 2)
            _ods_write_cell(table, matrix[row, col])
        end
        print(table, "</table:table-row>")
    end
    print(table, "</table:table>")
    table_xml = String(take!(table))
    manifest = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><manifest:manifest xmlns:manifest=\"urn:oasis:names:tc:opendocument:xmlns:manifest:1.0\" manifest:version=\"1.3\"><manifest:file-entry manifest:full-path=\"/\" manifest:media-type=\"application/vnd.oasis.opendocument.spreadsheet\"/><manifest:file-entry manifest:full-path=\"content.xml\" manifest:media-type=\"text/xml\"/></manifest:manifest>"
    # Serialize the complete read-modify-write operation to retain concurrent sheet updates.
    lock(_ODS_WRITE_LOCK) do
        entries = if ispath(path)
            _ods_existing(path, sheet, table_xml)
        else
            content = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><office:document-content xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\" office:version=\"1.3\"><office:body><office:spreadsheet>" * table_xml * "</office:spreadsheet></office:body></office:document-content>"
            ["mimetype" => collect(codeunits("application/vnd.oasis.opendocument.spreadsheet")), "content.xml" => collect(codeunits(content)), "META-INF/manifest.xml" => collect(codeunits(manifest))]
        end
        _atomic_file("WRITEODS", path) do io
            ZipArchives.ZipWriter(io) do archive
                # ODF requires the mimetype entry first and uncompressed.
                ZipArchives.zip_writefile(archive, "mimetype", only(last(pair) for pair in entries if first(pair) == "mimetype"))
                for (name, bytes) in entries
                    name == "mimetype" && continue
                    if endswith(name, "/")
                        ZipArchives.zip_writefile(archive, name, bytes; external_attrs=UInt32(0x10))
                    else
                        ZipArchives.zip_writefile(archive, name, bytes)
                    end
                end
            end
        end
    end
end
