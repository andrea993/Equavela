@testset "Legacy XLS bridge" begin
    mktempdir() do dir
        path = joinpath(dir, "values.xls")
        @test EqRuntime.eq_WRITEEXCEL(path, Any[1 "hello"; 3 4]) == 0
        @test read(path)[1:8] == UInt8[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
        @test EqRuntime.eq_READFILE(path, "Excel") == Any[1 "hello"; 3 4]
        @test EqRuntime.eq_WRITEEXCEL(path, [8;;], "Sheet1!B2") == 0
        @test EqRuntime.eq_READFILE(path, "Excel") == Any[1 "hello"; 3 8]
        # Construct a genuine two-sheet workbook with a style and a formula fixture.
        EquavelaKernel._xls_call("read_xls", path)
        Base.invokelatest() do
            py = EquavelaKernel.BRIDGE[].PythonCall
            scope = py.pydict()
            py.pyexec("""
import xlwt, xlrd

def fixture(path, formula):
    book = xlwt.Workbook()
    a = book.add_sheet('First')
    b = book.add_sheet('Second')
    style = xlwt.easyxf('font: bold on')
    a.write(0, 0, 12, style)
    b.write(0, 0, xlwt.Formula('1+2') if formula else 25, style)
    book.save(path)

def custom(path, header):
    b = xlwt.Workbook()
    b.set_colour_RGB(8, 123, 45, 67)
    sheet = b.add_sheet('First')
    font = xlwt.Font()
    font.shadow = True
    style = xlwt.XFStyle()
    style.font = font
    sheet.write(0, 0, 5, style)
    if header:
        sheet.set_header_str(b'Important header')
    b.save(path)

def custom_values(path):
    b = xlrd.open_workbook(path, formatting_info=True)
    sheet = b.sheet_by_index(0)
    xf = b.xf_list[sheet.cell_xf_index(0, 0)]
    return (*b.colour_map[8], b.font_list[xf.font_index].shadow)

def inspect(path):
    b = xlrd.open_workbook(path, formatting_info=True)
    return (b.nsheets, b.sheet_by_name('First').cell_value(0, 0),
            b.sheet_by_name('Second').cell_value(0, 0),
            b.font_list[b.xf_list[b.sheet_by_name('First').cell_xf_index(0, 0)].font_index].bold)
""", scope)
            multi = joinpath(dir, "multi.xls")
            scope["fixture"](multi, false)
            @test EqRuntime.eq_WRITEEXCEL(multi, [37;;], "Second!B2") == 0
            @test EqRuntime.eq_WRITEEXCEL(multi, [13;;], "First!A1") == 0
            data = py.pyconvert(Tuple{Int,Float64,Float64,Int}, scope["inspect"](multi))
            @test data == (2, 13.0, 25.0, 1)
            @test EqRuntime.eq_READFILE(multi, "Excel") == [13;;]
            styled = joinpath(dir, "palette.xls")
            scope["custom"](styled, false)
            @test EqRuntime.eq_WRITEEXCEL(styled, [9;;], "First!B1") == 0
            @test py.pyconvert(Tuple{Int,Int,Int,Int}, scope["custom_values"](styled)) == (123, 45, 67, 1)
            with_header = joinpath(dir, "header.xls")
            scope["custom"](with_header, true)
            saved_header = read(with_header)
            @test_throws EqRuntime.EqError EqRuntime.eq_WRITEEXCEL(with_header, [1;;])
            @test read(with_header) == saved_header
            formula = joinpath(dir, "formula.xls")
            scope["fixture"](formula, true)
            original = read(formula)
            @test EqRuntime.eq_READFILE(formula, "Excel") == [12;;]
            @test_throws EqRuntime.EqError EqRuntime.eq_WRITEEXCEL(formula, [8;;], "First!A1")
            @test read(formula) == original
        end
        worksheet = joinpath(dir, "worksheet.xls")
        params = JSON3.read(JSON3.write(Dict("worksheet" => "xls-integration", "regions" => [
            Dict("id" => "write", "value" => "eq_WRITEEXCEL($(repr(worksheet)), [20;;])"),
            Dict("id" => "read", "value" => "eq_READFILE($(repr(worksheet)), \"Excel\")")
        ])))
        context = EquavelaKernel.RequestContext(1, IOBuffer(), 0)
        result = EquavelaKernel.default_handler("evaluate", params, context, Vector{UInt8}[])
        @test all(region -> region["status"] == "ok", result.result["regions"])
        @test EqRuntime.eq_READFILE(worksheet, "Excel") == [20;;]
        before = read(path)
        @test_throws EqRuntime.EqError EqRuntime.eq_WRITEEXCEL(path, [Inf;;])
        @test read(path) == before
        @test_throws EqRuntime.EqError EqRuntime.eq_WRITEEXCEL(path, [1;;], "ZZZ1")
        @test read(path) == before
        write(path, "not an XLS")
        corrupt = read(path)
        @test_throws EqRuntime.EqError EqRuntime.eq_WRITEEXCEL(path, [1;;])
        @test read(path) == corrupt
    end
end
