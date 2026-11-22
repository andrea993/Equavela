@testset "OpenDocument spreadsheet writing" begin
    mktempdir() do dir
        path = joinpath(dir, "roundtrip.ods")
        data = Any[1.25 "a & <b>  two\twords\nnext"; NaN -3]
        @test eq_WRITEODS(path, data, "My data & values") == 0
        loaded = eq_READODS(path)
        @test loaded[1, 1] == 1.25
        @test loaded[1, 2] == data[1, 2]
        @test isnan(loaded[2, 1])
        @test loaded[2, 2] == -3
        @test eq_READFILE(path, "ODS")[1, 2] == data[1, 2]
        @test eq_WRITEFILE(path, [2 3; 4 5]) == 0
        @test eq_READODS(path, "Sheet1!A1:B2") == [2 3; 4 5]
        eq_WRITEODS(path, [1//3;;])
        @test eq_READODS(path, "Sheet1!A1")[1] ≈ 1/3
        before = read(path)
        @test_throws EqError eq_WRITEODS(path, [1+im;;])
        @test read(path) == before
        @test_throws EqError eq_WRITEODS(path, eq_vec(eq_unit("m")))
        @test_throws EqError eq_WRITEODS(path, [Inf;;])
        @test read(path) == before
        for invalid in ("\0", "a\u0001b", String(UInt8[0xff]))
            @test_throws EqError eq_WRITEODS(path, [invalid;;])
            @test read(path) == before
        end
        eq_WRITEODS(path, ["carriage\rreturn";;])
        @test eq_READODS(path, "Sheet1!A1")[1] == "carriage\rreturn"
        with_base_dir(dir) do
            @test eq_WRITEODS("relative.ods", Any[true "ok"]) == 0
            @test eq_READODS("relative.ods") == Any[1 "ok"]
        end
    end
end

@testset "WRITEODS preserves an existing workbook" begin
    ZipArchives = EqRuntime.ZipArchives
    mktempdir() do dir
        # A real LibreOffice archive includes compressed XML, metadata, thumbnail,
        # and a directory entry; writing a new sheet must preserve all of them.
        realpath = joinpath(dir, "real.ods")
        cp(joinpath(@__DIR__, "fixtures", "readods.ods"), realpath)
        before_real = ZipArchives.ZipReader(read(realpath))
        original_entries = Dict(name => ZipArchives.zip_readentry(before_real, name) for name in ZipArchives.zip_names(before_real))
        @test eq_WRITEODS(realpath, [99;;]) == 0
        after_real = ZipArchives.ZipReader(read(realpath))
        for (name, bytes) in original_entries
            name == "content.xml" && continue
            @test ZipArchives.zip_readentry(after_real, name) == bytes
        end
        @test eq_READODS(realpath, "Data!B1") == [1.5;;]
        @test eq_READODS(realpath, "Sheet1!A1") == [99;;]
        path = joinpath(dir, "multi.ods")
        content = """<?xml version="1.0" encoding="UTF-8"?>
<o:document-content xmlns:o="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:t="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:x="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><o:automatic-styles><x:p>styles</x:p></o:automatic-styles><o:body><o:spreadsheet><!-- <t:table t:name="decoy"/> -->
<t:table t:name="Keep"><t:table-row><t:table-cell t:formula="of:=1+2" o:value-type="float" o:value="3"><x:p>3</x:p></t:table-cell></t:table-row></t:table>
<t:table t:name="Replace &amp; More" t:style-name="sheet &gt; style"><t:table-row><t:table-cell o:value-type="float" o:value="4"/></t:table-row></t:table><t:named-expressions/></o:spreadsheet></o:body></o:document-content>"""
        manifest = """<?xml version="1.0"?><m:manifest xmlns:m="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><m:file-entry m:full-path="/" m:media-type="application/vnd.oasis.opendocument.spreadsheet"/><m:file-entry m:full-path="content.xml" m:media-type="text/xml"/></m:manifest>"""
        entries = ["mimetype" => "application/vnd.oasis.opendocument.spreadsheet", "content.xml" => content, "META-INF/manifest.xml" => manifest, "styles.xml" => "<styles>retained</styles>", "Pictures/image.bin" => "binary\0data"]
        ZipArchives.ZipWriter(path) do zip
            for (name, bytes) in entries
                ZipArchives.zip_writefile(zip, name, collect(codeunits(bytes)))
            end
        end
        @test eq_WRITEODS(path, [42;;], "Replace & More") == 0
        archive = ZipArchives.ZipReader(read(path))
        updated = ZipArchives.zip_readentry(archive, "content.xml", String)
        @test occursin("t:formula=\"of:=1+2\"", updated)
        @test occursin("<!-- <t:table t:name=\"decoy\"/> -->", updated)
        @test occursin("<t:named-expressions/>", updated)
        @test occursin("t:style-name=\"sheet &gt; style\"", updated)
        for (name, bytes) in entries
            name == "content.xml" && continue
            @test ZipArchives.zip_readentry(archive, name) == collect(codeunits(bytes))
        end
        @test eq_READODS(path, "Keep!A1") == [3;;]
        @test eq_READODS(path, "'Replace & More'!A1") == [42;;]
        @test eq_WRITEODS(path, [7;;]) == 0
        @test eq_READODS(path, "Sheet1!A1") == [7;;]
        @test eq_READODS(path, "Keep!A1") == [3;;]
        @test eq_WRITEODS(path, [8;;], "Added") == 0
        @test eq_READODS(path, "Added!A1") == [8;;]
        concurrent_path = joinpath(dir, "concurrent.ods")
        @sync for index in 1:8
            Threads.@spawn eq_WRITEODS(concurrent_path, [index;;], "Sheet$(index)")
        end
        for index in 1:8
            @test eq_READODS(concurrent_path, "Sheet$(index)!A1") == [index;;]
        end
        for invalid in ("broken ZIP",)
            write(path, invalid)
            before = read(path)
            @test_throws EqError eq_WRITEODS(path, [1;;])
            @test read(path) == before
        end
        encrypted = replace(manifest, "</m:manifest>" => "<m:encryption-data/></m:manifest>")
        ZipArchives.ZipWriter(path) do zip
            for (name, bytes) in entries
                ZipArchives.zip_writefile(zip, name, collect(codeunits(name == "META-INF/manifest.xml" ? encrypted : bytes)))
            end
        end
        before = read(path)
        @test_throws EqError eq_WRITEODS(path, [1;;])
        @test read(path) == before
        for invalid_content in ("<broken>", replace(content, "</o:spreadsheet>" => ""))
            ZipArchives.ZipWriter(path) do zip
                for (name, bytes) in entries
                    ZipArchives.zip_writefile(zip, name, collect(codeunits(name == "content.xml" ? invalid_content : bytes)))
                end
            end
            before = read(path)
            @test_throws EqError eq_WRITEODS(path, [1;;])
            @test read(path) == before
        end
    end
end
