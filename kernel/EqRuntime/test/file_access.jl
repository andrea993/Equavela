@testset "binary file access" begin
    mktempdir() do dir
        path = joinpath(dir, "values.bin")
        values = [1 2; 257 65535]
        @test EqRuntime.eq_WRITEBIN(path, "uint16", 1, values) == 0
        @test read(path) == UInt8[0, 1, 0, 2, 1, 1, 255, 255]
        @test EqRuntime.eq_READBIN(path, "uint16", 1, 2) == values
        @test EqRuntime.eq_READBIN(path, "uint16", 1, 2, 0, 1) == values[1:1, :]
        @test EqRuntime.eq_READBIN(path, "uint16", 1, 1, 4) == [257; 65535;;]
        @test_throws EqRuntime.EqError EqRuntime.eq_READBIN(path, "uint16", 0, 3)
        @test_throws EqRuntime.EqError EqRuntime.eq_WRITEBIN(path, "byte", 0, [256])
        @test read(path) == UInt8[0, 1, 0, 2, 1, 1, 255, 255]
        @test EqRuntime.with_base_dir(() -> EqRuntime.eq_READBIN("values.bin", "uint16", 1, 2), dir) == values
    end
end

@testset "text, spreadsheet, images and sound" begin
    mktempdir() do dir
        csv = joinpath(dir,"data.csv")
        data = Any[1 "a,b"; 2 3]
        @test EqRuntime.eq_WRITECSV(csv,data) == 0
        @test EqRuntime.eq_READCSV(csv) == data
        txt = joinpath(dir,"data.txt")
        @test EqRuntime.eq_WRITETEXT(txt,[1 2; 3 4]) == 0
        @test EqRuntime.eq_READTEXT(txt,"delimited","/t","2","1") == [3;;]
        @test EqRuntime.eq_READFILE(txt,"delimited",[1,2],2) == [2;4;;]
        prn = joinpath(dir,"data.prn")
        @test EqRuntime.eq_WRITEPRN(prn,[1 2]) == [1 2]
        @test EqRuntime.eq_APPENDPRN(prn,[3 4]) == [3 4]
        @test EqRuntime.eq_READPRN(prn) == [1 2;3 4]
        @test EqRuntime.eq_WRITEPRN(prn,[1 2; 3 4],[2,2],[1,1]) == [3;;]
        xlsx = joinpath(dir,"book.xlsx")
        @test EqRuntime.eq_WRITEEXCEL(xlsx,[1 2;3 4]) == 0
        @test EqRuntime.eq_WRITEEXCEL(xlsx,[7;;],"Sheet1!B2") == 0
        @test EqRuntime.XLSX.readxlsx(xlsx)[1]["A1:B2"] == [1 2;3 7]
        bmp = joinpath(dir,"test.bmp")
        packed = [255 0 0; 0 255 0]
        @test EqRuntime.eq_WRITERGB(bmp,packed) == 0
        @test EqRuntime.eq_READRGB(bmp) ≈ packed
        @test EqRuntime.eq_READ_HSV(bmp) ≈ [0 255 255; 120 255 255]
        hsv = joinpath(dir,"hsv.bmp")
        @test EqRuntime.eq_WRITE_HSV(hsv,EqRuntime.eq_READ_HSV(bmp)) == 0
        @test EqRuntime.eq_READRGB(hsv) ≈ packed
        wav = joinpath(dir,"sound.wav")
        samples = [-32768 0; 123 32767]
        @test EqRuntime.eq_WRITEWAV(wav,8000,16,samples) == 0
        @test EqRuntime.eq_READWAV(wav) == samples
        @test EqRuntime.eq_GETWAVINFO(wav) == [2,8000,16,32000]
    end
end

@testset "file access options and channel functions" begin
    mktempdir() do dir
        path = joinpath(dir,"fixed.txt")
        write(path,"12ABC\n34DEF\n")
        @test EqRuntime.eq_READTEXT(path,"fixed",[2,3],"1-2","2",NaN,"read",["\"",".",","]) == ["ABC";"DEF";;]
        @test EqRuntime.eq_READFILE(path,"fixed",[2,3],[1,2],[1,1]) == [12;34;;]
        txt=joinpath(dir,"out.txt")
        @test EqRuntime.eq_WRITEFILE(txt,[2 3]) == 0
        @test EqRuntime.eq_READFILE(txt,"delimited") == [2 3]
        for typ in ("byte","double","float","int16","int32","uint16","uint32"), endian in (0,1)
            p=joinpath(dir,"$typ-$endian.bin")
            @test EqRuntime.eq_WRITEBIN(p,typ,endian,[1 2;3 4]) == 0
            @test EqRuntime.eq_READBIN(p,typ,endian,2) == [1 2;3 4]
        end
        p=joinpath(dir,"gray.bmp")
        @test EqRuntime.eq_WRITEBMP(p,[0 255]) == 0
        @test EqRuntime.eq_READBMP(p) ≈ [0 255]
        @test EqRuntime.eq_READ_IMAGE(p) ≈ [0 255]
        p=joinpath(dir,"rgb.bmp")
        @test EqRuntime.eq_WRITERGB(p,[255 0 0]) == 0
        @test EqRuntime.eq_READ_RED(p) ≈ [255;;]
        @test EqRuntime.eq_READ_GREEN(p) ≈ [0;;]
        @test EqRuntime.eq_READ_BLUE(p) ≈ [0;;]
        @test EqRuntime.eq_READ_HUE(p) ≈ [0;;]
        @test EqRuntime.eq_READ_HSV_SAT(p) ≈ [255;;]
        @test EqRuntime.eq_READ_HLS_SAT(p) ≈ [255;;]
        @test EqRuntime.eq_READ_VALUE(p) ≈ [255;;]
        @test EqRuntime.eq_READ_LIGHT(p) ≈ [127.5;;]
        q=joinpath(dir,"hls.bmp")
        @test EqRuntime.eq_WRITE_HLS(q,EqRuntime.eq_READ_HLS(p)) == 0
        @test EqRuntime.eq_READRGB(q) ≈ [255 0 0]
        x=joinpath(dir,"a.xlsx")
        @test EqRuntime.eq_WRITEFILE(x,[1 2]) == 0
        @test EqRuntime.eq_READFILE(x,"Excel") == [1 2]
        for bits in 1:16
            w=joinpath(dir,"$bits.wav")
            width = bits <= 8 ? 8 : 16
            data = bits <= 8 ? [0; 127; 255;;] : [-32768; -1; 0; 32767;;]
            @test EqRuntime.eq_WRITEWAV(w,8000,bits,data) == 0
            expected = (data .>> (width-bits)) .<< (width-bits)
            @test EqRuntime.eq_READWAV(w) == expected
            @test EqRuntime.eq_GETWAVINFO(w)[3] == bits
            # Inspect the data chunk independently of WAV.jl's decoder.
            bytes = read(w)
            data_start = findfirst(==(UInt8[0x64,0x61,0x74,0x61]), [bytes[i:i+3] for i in 1:length(bytes)-3])
            raw = bytes[data_start+8:end]
            if width == 8
                @test raw == UInt8.(vec(expected))
            else
                words = reinterpret(UInt16, Int16.(vec(expected)))
                @test raw == reduce(vcat, [UInt8[x & 0xff, x >> 8] for x in words])
            end
        end
    end
end

@testset "PRN headers for complex and string matrices (saved .mcdx files)" begin
    mktempdir() do dir
        complexfile = joinpath(dir, "c.prn")
        write(complexfile, "// Datafile written by the reference application\r\n// 11/08/26 21:06:43\r\n\r\n.MATRIX 0 1 2 2\r\n  0.2356,    0.326  0.8229,  -0.5799  0.0495,   0.6035  0.4209,   0.5066")
        @test EqRuntime.eq_READPRN(complexfile) == ComplexF64[0.2356+0.326im 0.8229-0.5799im; 0.0495+0.6035im 0.4209+0.5066im]
        stringfile = joinpath(dir, "s.prn")
        write(stringfile, "// Datafile written by the reference application\r\n// 11/08/26 21:08:42\r\n\r\n.MATRIX 0 0 2 1\r\n \"ab\" \"cd\"")
        @test EqRuntime.eq_READPRN(stringfile) == reshape(["ab", "cd"], 2, 1)
        for (name, data) in (("c2.prn", ComplexF64[1+2im 5im; 3-4im 6]), ("s2.prn", ["a b" "c"; "d" "e"]))
            path = joinpath(dir, name)
            EqRuntime.eq_WRITEPRN(path, data)
            @test startswith(read(path, String), "// Datafile written by the reference application\r\n")
            @test EqRuntime.eq_READPRN(path) == data
        end
        nestedfile = joinpath(dir, "n.prn")
        write(nestedfile, "// Datafile written by the reference application\r\n// 11/08/26 21:19:42\r\n\r\n.MATRIX 0 0 1 2\r\n {1,0,2,1} {2,0,3,1}\r\n.MATRIX 1 0 2 1\r\n       1       2\r\n.MATRIX 2 0 3 1\r\n       3       4       5")
        nested = EqRuntime.eq_READPRN(nestedfile)
        @test size(nested) == (1, 2)
        @test nested[1] == reshape([1.0, 2.0], 2, 1) && nested[2] == reshape([3.0, 4.0, 5.0], 3, 1)
        written = joinpath(dir, "n2.prn")
        EqRuntime.eq_WRITEPRN(written, nested)
        @test replace(read(written, String), r"// \d\d/.*\r\n" => "//\r\n") == replace(read(nestedfile, String), r"// \d\d/.*\r\n" => "//\r\n")
        @test EqRuntime.eq_READPRN(written) == nested
        mixedfile = joinpath(dir, "m.prn")
        write(mixedfile, "// Datafile written by the reference application\r\n// 11/08/26 21:30:04\r\n\r\n.MATRIX 0 0 4 1\r\n {1,0,2,2}       5 {2,0,1,1} \"pippo\"\r\n.MATRIX 1 0 2 2\r\n       1       2       3       4\r\n.MATRIX 2 0 1 1\r\n       6")
        mixed = EqRuntime.eq_READPRN(mixedfile)
        @test mixed[1] == [1.0 2; 3 4] && mixed[2] == 5 && mixed[3] == [6.0;;] && mixed[4] == "pippo"
        mixedout = joinpath(dir, "m2.prn")
        EqRuntime.eq_WRITEPRN(mixedout, mixed)
        @test replace(read(mixedout, String), r"// \d\d/.*\r\n" => "//\r\n") == replace(read(mixedfile, String), r"// \d\d/.*\r\n" => "//\r\n")
        varfile = joinpath(dir, "v.prn")
        write(varfile, "// Datafile written by the reference application\r\n// 11/08/26 21:37:22\r\n\r\n.MATRIX 0 1 4 1\r\n {1,1,2,2}       5,   0.3333 {2,0,1,1} \"pippo\"\r\n.MATRIX 1 1 2 2\r\n       1,        3       2,    3.142       3,        6       4,        8\r\n.MATRIX 2 0 1 1\r\n       6")
        var = EqRuntime.eq_READPRN(varfile)
        @test var[1] == ComplexF64[1+3im 2+3.142im; 3+6im 4+8im] && var[2] == 5+0.3333im && var[3] == [6.0;;] && var[4] == "pippo"
        varout = joinpath(dir, "v2.prn")
        EqRuntime.eq_WRITEPRN(varout, var)
        @test replace(read(varout, String), r"// \d\d/.*\r\n" => "//\r\n") == replace(read(varfile, String), r"// \d\d/.*\r\n" => "//\r\n")
        @test_throws EqError EqRuntime.eq_APPENDPRN(joinpath(dir, "c2.prn"), ComplexF64[1im;;])
        @test_throws EqError EqRuntime.eq_WRITEPRN(joinpath(dir, "x.prn"), Any[1.0u"m" "a"])
    end
end

@testset "Concurrent PRN append and integer bounds" begin
    mktempdir() do dir
        path = joinpath(dir, "append.prn")
        EqRuntime.eq_WRITEPRN(path, [0;;])
        @sync for value in 1:10
            Threads.@spawn EqRuntime.eq_APPENDPRN(path, [value;;])
        end
        @test sort(vec(EqRuntime.eq_READPRN(path))) == collect(0:10)
        @test_throws EqError EqRuntime.eq_READBIN(path, "byte", 0, Float64(typemax(Int)))
    end
end

@testset "the vendor image file formats" begin
    mktempdir() do dir
        image = EqRuntime.ColorTypes.Gray{Float64}.([0 1; 1 0])
        for extension in ("bmp", "gif", "jpg", "tga", "pcx", "pbm", "pgm", "ppm", "tif", "png")
            file = joinpath(dir, "fixture.$extension")
            EqRuntime.ImageMagick.save(file, image)
            @test size(EqRuntime.eq_READ_IMAGE(file)) == (2, 2)
        end
    end
end

@testset "Quoted delimiter detection" begin
    mktempdir() do dir
        file = joinpath(dir, "quoted.tsv")
        write(file, "\"a,b,c\"\t10\n\"x,y,z\"\t20\n")
        expected = Any["a,b,c" 10; "x,y,z" 20]
        @test eq_READTEXT(file) == expected
        @test eq_READFILE(file, "delimited") == expected
    end
end

@testset "Legacy workbook backend routing" begin
    mktempdir() do dir
        path = joinpath(dir, "legacy.xls")
        calls = []
        reader = (p, fill) -> (push!(calls, (:read, p, fill)); Any[1 fill; 3 4])
        writer = (p, data, index, sheet, anchor) -> push!(calls, (:write, p, data, index, sheet, anchor))
        EqRuntime.register_xls_backend!(reader, writer)
        try
            @test eq_READFILE(path, "Excel", [2,2], [1,2], -1) == [3 4]
            @test calls[1] == (:read, path, -1)
            @test eq_WRITEEXCEL(path, [1 2; 3 4], [2,2], [1,2], "Data!B3:C3") == 0
            @test calls[2] == (:write, path, [3 4], 1, "Data", "B3")
            @test eq_WRITEFILE(path, [5;;]) == 0
            @test calls[3] == (:write, path, [5;;], 1, nothing, "A1")
        finally
            EqRuntime.register_xls_backend!(nothing, nothing)
        end
    end
end
