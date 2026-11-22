# Reading OpenDocument spreadsheets with READODS. Spec: the specification section 22.1
#, .
#
# The committed fixtures are made by LibreOffice from `fixtures/readods.fods`:
#
#   soffice --headless --convert-to ods --outdir kernel/EqRuntime/test/fixtures \
#       kernel/EqRuntime/test/fixtures/readods.fods
#
# `readods.ods` holds DEFLATE entries; `readods-stored.ods` is the same archive with every
# entry STORED, which is a copy of it with another writer:
#
#   python3 -c '
#   import zipfile
#   src = zipfile.ZipFile("kernel/EqRuntime/test/fixtures/readods.ods")
#   with zipfile.ZipFile("kernel/EqRuntime/test/fixtures/readods-stored.ods", "w",
#                        compression=zipfile.ZIP_STORED) as out:
#       for name in src.namelist():
#           out.writestr(name, src.read(name))'
#
# The other tests build tiny archives in a temporary directory, which is also how (no
# cache) is checked: the same path answers with the new content after the file changed.

const ODS_FIXTURE = joinpath(@__DIR__, "fixtures", "readods.ods")
const ODS_STORED_FIXTURE = joinpath(@__DIR__, "fixtures", "readods-stored.ods")

function _push_u16!(bytes::Vector{UInt8}, value::Integer)
    push!(bytes, UInt8(value & 0xff))
    push!(bytes, UInt8((value >> 8) & 0xff))
    return bytes
end

function _push_u32!(bytes::Vector{UInt8}, value::Integer)
    for shift in 0:8:24
        push!(bytes, UInt8((value >> shift) & 0xff))
    end
    return bytes
end

"""
Write a zip archive with every entry STORED: `entries` are `name => bytes`. A hand-written
archive keeps the tests independent of a zip library.
"""
function write_zip(path::String, entries::Vector{Pair{String,Vector{UInt8}}}; method::Integer=0)
    bytes = UInt8[]
    central = UInt8[]
    for (name, data) in entries
        offset = length(bytes)
        _push_u32!(bytes, 0x04034b50)
        _push_u16!(bytes, 20) # version needed
        _push_u16!(bytes, 0) # flags
        _push_u16!(bytes, method)
        _push_u16!(bytes, 0) # time
        _push_u16!(bytes, 0) # date
        _push_u32!(bytes, 0) # crc32: the reader does not check it
        _push_u32!(bytes, length(data))
        _push_u32!(bytes, length(data))
        _push_u16!(bytes, ncodeunits(name))
        _push_u16!(bytes, 0)
        append!(bytes, codeunits(name))
        append!(bytes, data)
        _push_u32!(central, 0x02014b50)
        _push_u16!(central, 20) # version made by
        _push_u16!(central, 20) # version needed
        _push_u16!(central, 0) # flags
        _push_u16!(central, method)
        _push_u16!(central, 0) # time
        _push_u16!(central, 0) # date
        _push_u32!(central, 0) # crc32
        _push_u32!(central, length(data))
        _push_u32!(central, length(data))
        _push_u16!(central, ncodeunits(name))
        _push_u16!(central, 0) # extra
        _push_u16!(central, 0) # comment
        _push_u16!(central, 0) # disk
        _push_u16!(central, 0) # internal attributes
        _push_u32!(central, 0) # external attributes
        _push_u32!(central, offset)
        append!(central, codeunits(name))
    end
    directory = length(bytes)
    append!(bytes, central)
    _push_u32!(bytes, 0x06054b50)
    _push_u16!(bytes, 0) # this disk
    _push_u16!(bytes, 0) # directory disk
    _push_u16!(bytes, length(entries))
    _push_u16!(bytes, length(entries))
    _push_u32!(bytes, length(central))
    _push_u32!(bytes, directory)
    _push_u16!(bytes, 0) # comment
    write(path, bytes)
    return path
end

"The entries of a real `.ods` fixture: the mimetype first, then the part the reader wants."
function write_ods(path::String, content::AbstractString; method::Integer=0)
    return write_zip(
        path,
        [
            "mimetype" => Vector{UInt8}(codeunits("application/vnd.oasis.opendocument.spreadsheet")),
            "content.xml" => Vector{UInt8}(codeunits(String(content))),
        ];
        method=method,
    )
end

"One row of one cell per entry of `values`, each a `(attributes, text)` pair."
function _sheet_xml(name::AbstractString, rows::Vector{Vector{String}})
    xml = "<office:document-content office:version=\"1.3\"><office:body><office:spreadsheet>"
    xml *= "<table:table table:name=\"$name\">"
    for row in rows
        xml *= "<table:table-row>" * join(row) * "</table:table-row>"
    end
    xml *= "</table:table></office:spreadsheet></office:body></office:document-content>"
    return xml
end

"An error message from a call that must fail."
function ods_failure(f)
    try
        f()
    catch exception
        exception isa EqError || rethrow()
        return sprint(showerror, exception)
    end
    return ""
end

@testset "READODS: the used range of the first sheet" begin
    # A1 to the last row and column that hold a value. The fixture's first sheet is
    # "Data": 6 rows, 5 columns (row 3 is empty and the trailing empty column is dropped).
    matrix = eq_READODS(ODS_FIXTURE)
    @test size(matrix) == (6, 5)
    @test matrix[1, 1] == "Tom & Jerry <1>"   # the entities of the text are decoded
    @test matrix[1, 5] == "five"
    @test matrix[4, 1] == "far"
    @test matrix[4, 5] == 7.0                 # three repeated empty cells in between
    @test matrix[5, 1] == 1.0                 # the merged cell keeps its value
    @test matrix[6, 1] == 1.75                # a formula cell uses its cached value
    @test all(isnan, matrix[3, :])            # an empty row is emptyfill
    # A sheet name is matched exactly: no case folding.
    @test occursin("no sheet named 'data'", ods_failure(() -> eq_READODS(ODS_FIXTURE, "data!A1")))
end

@testset "READODS: the cell values the file stores" begin
    # every value type of the table of the spec, read from the fixture's first rows.
    @test eq_READODS(ODS_FIXTURE, "Data!A1:A1") == ["Tom & Jerry <1>";;]
    @test eq_READODS(ODS_FIXTURE, "Data!B1:B1") == [1.5;;]
    @test eq_READODS(ODS_FIXTURE, "Data!C1:C1") == [1.0;;]           # boolean TRUE
    @test eq_READODS(ODS_FIXTURE, "Data!E2:E2") == [0.0;;]           # boolean FALSE
    @test eq_READODS(ODS_FIXTURE, "Data!D1:D1") == [45366.0;;]       # 2024-03-15, the serial day
    @test eq_READODS(ODS_FIXTURE, "Data!B2:B2") == [0.25;;]          # percentage: the fraction
    @test eq_READODS(ODS_FIXTURE, "Data!C2:C2") == [12.5;;]          # currency: the number, no unit
    @test eq_READODS(ODS_FIXTURE, "Data!D2:D2") == [0.5625;;]        # time: 13:30, a day's fraction
    # A serial date with a time of day keeps the fraction of the day (the same base as Calc).
    @test EqRuntime._serial_date("2024-03-15T12:00:00") == 45366.5
    @test EqRuntime._serial_date("1899-12-30") == 0.0
    @test EqRuntime._serial_date("1900-01-01") == 2.0
    @test EqRuntime._day_fraction("PT1H") == 1 / 24
    @test EqRuntime._day_fraction("PT13H30M0S") == 0.5625
    @test EqRuntime._day_fraction("PT0S") == 0.0
    # A value type this reader does not know is an empty cell, not an error.
    directory = mktempdir()
    path = write_ods(
        joinpath(directory, "types.ods"),
        _sheet_xml("S", [["<table:table-cell office:value-type=\"void\"/>",
                          "<table:table-cell office:value-type=\"float\" office:value=\"2\"/>",
                          "<table:table-cell office:value-type=\"string\" office:string-value=\"given\"/>"]])
    )
    @test isequal(eq_READODS(path, "S!A1:C1"), [NaN 2.0 "given"])
end

@testset "READODS: empty and covered cells are emptyfill" begin
    # the default is NaN, a given emptyfill replaces every empty cell.
    @test isequal(eq_READODS(ODS_FIXTURE, "Data!A3:C3"), [NaN NaN NaN])
    @test eq_READODS(ODS_FIXTURE, "Data!A3:C3", -1) == [-1.0 -1.0 -1.0]
    @test eq_READODS(ODS_FIXTURE, "Data!A3:C3", 0) == [0.0 0.0 0.0]
    @test eq_READODS(ODS_FIXTURE, "Data!A3:C3", "empty") == ["empty" "empty" "empty"]
    # B5 is covered by the merged A5:B5, so it is empty while A5 keeps its value.
    @test isequal(eq_READODS(ODS_FIXTURE, "Data!A5:B5"), [1.0 NaN])
    @test eq_READODS(ODS_FIXTURE, "Data!A5:B5", 0) == [1.0 0.0]
end

@testset "READODS: the range forms" begin
    # a cell, a rectangle, a sheet with either separator, a quoted name, past Z.
    @test eq_READODS(ODS_FIXTURE, "B2") == [0.25;;]
    @test eq_READODS(ODS_FIXTURE, "A1:C2") == eq_READODS(ODS_FIXTURE, "Data!A1:C2")
    @test eq_READODS(ODS_FIXTURE, "Data.A1:C2") == eq_READODS(ODS_FIXTURE, "Data!A1:C2")
    @test eq_READODS(ODS_FIXTURE, "a1:b1") == eq_READODS(ODS_FIXTURE, "A1:B1")
    expected = Any["x" 2.0; 3.0 4.0]
    @test eq_READODS(ODS_FIXTURE, "'My sheet'!A1:B2") == expected
    @test eq_READODS(ODS_FIXTURE, "'My sheet'.A1:B2") == expected
    @test eq_READODS(ODS_FIXTURE, "My sheet!A1:B2") == expected
    @test eq_READODS(ODS_FIXTURE, "My sheet.A1:B2") == expected
    # Columns past Z: AA is 27 and AB is 28, where the second sheet holds 99 at AA1.
    @test isequal(eq_READODS(ODS_FIXTURE, "My sheet!AA1:AB2"), [99.0 NaN; NaN NaN])
    @test isequal(eq_READODS(ODS_FIXTURE, "My sheet!aa1:ab2"), [99.0 NaN; NaN NaN])
    @test EqRuntime._column_number("A") == 1
    @test EqRuntime._column_number("Z") == 26
    @test EqRuntime._column_number("AA") == 27
    @test EqRuntime._column_number("XFD") == 16384
    @test EqRuntime._column_number("XFE") === nothing
    # The empty range text is the used range of the first sheet.
    @test isequal(eq_READODS(ODS_FIXTURE, ""), eq_READODS(ODS_FIXTURE))
    # A rectangle outside the data is emptyfill, not an error: reading is not bounded by the file.
    @test isequal(eq_READODS(ODS_FIXTURE, "Data!Z100:AA101"), [NaN NaN; NaN NaN])
end

@testset "READODS: stored and deflate entries" begin
    # the two compression methods of a zip give the same matrix.
    @test isequal(eq_READODS(ODS_STORED_FIXTURE), eq_READODS(ODS_FIXTURE))
    @test eq_READODS(ODS_STORED_FIXTURE, "Data!A1:C2") == eq_READODS(ODS_FIXTURE, "Data!A1:C2")
    # A hand-made archive with STORED entries reads the same way.
    directory = mktempdir()
    path = write_ods(
        joinpath(directory, "stored.ods"),
        _sheet_xml("S", [["<table:table-cell office:value-type=\"float\" office:value=\"4\"/>"]]),
    )
    @test eq_READODS(path) == [4.0;;]
    # Another compression method is named in the error.
    other = write_ods(
        joinpath(directory, "other.ods"),
        _sheet_xml("S", [[
            "<table:table-cell office:value-type=\"float\" office:value=\"4\"/>",
        ]]);
        method=99,
    )
    @test occursin("compression method 99", ods_failure(() -> eq_READODS(other)))
end

@testset "READODS: the text of a cell" begin
    # paragraphs, spans, spaces, tabs, line breaks and the entities.
    directory = mktempdir()
    path = write_ods(
        joinpath(directory, "text.ods"),
        _sheet_xml(
            "S",
            [[
                "<table:table-cell office:value-type=\"string\"><text:p>a<text:span>span</text:span>" *
                "<text:s text:c=\"2\"/>b<text:tab/>c<text:line-break/>d</text:p>" *
                "<text:p>&amp;&lt;&gt;&quot;&apos; &#65;&#x42;</text:p></table:table-cell>",
            ]],
        ),
    )
    @test eq_READODS(path, "S!A1") == ["aspan  b\tc\nd\n&<>\"' AB";;]
end

@testset "READODS: the namespace prefixes of the document" begin
    # the prefix of each element and attribute comes from the document itself.
    directory = mktempdir()
    content = """
    <?xml version="1.0" encoding="UTF-8"?>
    <o:document-content
        xmlns:o="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
        xmlns:t="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
        xmlns:x="urn:oasis:names:tc:opendocument:xmlns:text:1.0" o:version="1.3">
      <o:body><o:spreadsheet>
        <t:table t:name="Renamed">
          <t:table-row>
            <t:table-cell o:value-type="string"><x:p>one</x:p></t:table-cell>
            <t:table-cell o:value-type="float" o:value="2"><x:p>2</x:p></t:table-cell>
          </t:table-row>
        </t:table>
      </o:spreadsheet></o:body>
    </o:document-content>
    """
    path = write_ods(joinpath(directory, "prefixed.ods"), content)
    @test eq_READODS(path) == Any["one" 2.0]
    @test eq_READODS(path, "Renamed!B1") == [2.0;;]
end

@testset "READODS: repeated rows" begin
    # `table:number-rows-repeated` places the row at every position of its run.
    directory = mktempdir()
    path = write_ods(
        joinpath(directory, "repeated.ods"),
        "<office:document-content><office:body><office:spreadsheet>"
        * "<table:table table:name=\"S\">"
        * "<table:table-row table:number-rows-repeated=\"2\">"
        * "<table:table-cell office:value-type=\"float\" office:value=\"3\"/>"
        * "<table:table-cell/>"
        * "</table:table-row>"
        * "<table:table-row><table:table-cell office:value-type=\"float\" office:value=\"9\"/>"
        * "</table:table-row>"
        * "</table:table></office:spreadsheet></office:body></office:document-content>",
    )
    @test eq_READODS(path) == [3.0; 3.0; 9.0;;]
end

@testset "READODS: the file is read at every call" begin
    # nothing is cached, so a changed file is seen by the next call.
    directory = mktempdir()
    path = write_ods(
        joinpath(directory, "fresh.ods"),
        _sheet_xml("S", [["<table:table-cell office:value-type=\"float\" office:value=\"1\"/>"]]),
    )
    @test eq_READODS(path) == [1.0;;]
    write_ods(
        path,
        _sheet_xml("S", [["<table:table-cell office:value-type=\"float\" office:value=\"2\"/>"]]),
    )
    @test eq_READODS(path) == [2.0;;]
end

@testset "READODS: paths" begin
    # an absolute path as it is, a relative one against the worksheet directory.
    @test eq_READODS(ODS_FIXTURE, "A1") == ["Tom & Jerry <1>";;]
    @test occursin(
        "save the worksheet first, or use an absolute path",
        ods_failure(() -> eq_READODS("readods.ods")),
    )
    directory = dirname(ODS_FIXTURE)
    @test with_base_dir(() -> eq_READODS("readods.ods", "A1"), directory) ==
          ["Tom & Jerry <1>";;]
    # A missing file names the path as resolved, relative or absolute.
    relative = ods_failure(() -> with_base_dir(() -> eq_READODS("nowhere.ods"), directory))
    absolute = ods_failure(() -> eq_READODS(joinpath(directory, "nowhere.ods")))
    @test relative == absolute
    @test occursin(joinpath(directory, "nowhere.ods"), relative)
    @test occursin("no such file", relative)
    # The directory is only in force inside the scope.
    @test EqRuntime.worksheet_directory() === nothing
    # A missing file names the path as resolved.
    message = ods_failure(() -> with_base_dir(() -> eq_READODS("nowhere.ods"), directory))
    @test occursin(joinpath(directory, "nowhere.ods"), message)
    @test occursin("no such file", message)
end

@testset "READODS: errors" begin
    # a range the function cannot read names the range as written.
    for range in ("A1:", "1:2", "A", "A0", ":A1", "A1:B", "1A", "A1-B2", "XFE1")
        message = ods_failure(() -> eq_READODS(ODS_FIXTURE, range))
        @test occursin("\"$range\"", message)
    end
    @test occursin("top-left", ods_failure(() -> eq_READODS(ODS_FIXTURE, "C10:A1")))
    @test occursin(
        "no sheet named 'Nope'", ods_failure(() -> eq_READODS(ODS_FIXTURE, "Nope!A1"))
    )
    # an argument of the wrong kind names the argument.
    @test occursin("needs a file name", ods_failure(() -> eq_READODS(3)))
    @test occursin("needs a range as text", ods_failure(() -> eq_READODS(ODS_FIXTURE, 3)))
    @test occursin(
        "emptyfill must be a scalar",
        ods_failure(() -> eq_READODS(ODS_FIXTURE, "A1", [1, 2])),
    )
    # a file that is not a readable archive is an error, never a crash.
    directory = mktempdir()
    plain = joinpath(directory, "plain.ods")
    write(plain, "not a zip at all")
    @test occursin("not a readable .ods file", ods_failure(() -> eq_READODS(plain)))
    empty = joinpath(directory, "empty.ods")
    write(empty, "")
    @test occursin("not a readable .ods file", ods_failure(() -> eq_READODS(empty)))
    no_content = write_zip(joinpath(directory, "nocontent.ods"), ["mimetype" => UInt8[]])
    @test occursin(
        "has no content.xml part", ods_failure(() -> eq_READODS(no_content))
    )
    # A sheet with no value at all is an error instead of an empty matrix.
    blank = write_ods(
        joinpath(directory, "blank.ods"),
        "<office:document-content><office:body><office:spreadsheet>"
        * "<table:table table:name=\"Blank\"><table:table-row>"
        * "<table:table-cell table:number-columns-repeated=\"3\"/>"
        * "</table:table-row></table:table>"
        * "</office:spreadsheet></office:body></office:document-content>",
    )
    @test occursin("sheet 'Blank' has no values", ods_failure(() -> eq_READODS(blank)))
    @test isequal(eq_READODS(blank, "Blank!A1:B1"), [NaN NaN])
end

@testset "READODS: ORIGIN is not read" begin
    # the matrix is a value, not an index; ORIGIN changes nothing.
    @test with_origin(() -> eq_READODS(ODS_FIXTURE, "Data!A1:C2"), 1) ==
          eq_READODS(ODS_FIXTURE, "Data!A1:C2")
    @test isequal(with_origin(() -> eq_READODS(ODS_FIXTURE), 5), eq_READODS(ODS_FIXTURE))
end
