import CSV, ImageMagick, WAV, XLSX, Colors, ColorTypes, FixedPointNumbers

# The kernel provides the optional legacy BIFF codec without embedding Python in
# the numerical runtime or its sysimage.
const _XLS_READ = Ref{Any}(nothing)
const _XLS_WRITE = Ref{Any}(nothing)
function register_xls_backend!(reader, writer)
    _XLS_READ[] = reader
    _XLS_WRITE[] = writer
    return nothing
end

# Binary data files.

function _file_path(name, file)
    file isa AbstractString && !isempty(file) || eqerror("$name needs a file name")
    isabspath(file) && return String(file)
    directory = worksheet_directory()
    directory === nothing && eqerror("$name: save the worksheet first, or use an absolute path")
    return joinpath(directory, file)
end

function _file_integer(name, x, minval)
    x isa Real && !(x isa Unitful.AbstractQuantity) && isfinite(x) && isinteger(x) && minval <= x < 2.0^(8sizeof(Int) - 1) ||
        eqerror("$name must be an integer greater than or equal to $minval")
    return Int(x)
end

const _BINARY_TYPES = Dict("byte" => UInt8, "double" => Float64, "float" => Float32,
    "int16" => Int16, "int32" => Int32, "uint16" => UInt16, "uint32" => UInt32)
function _binary_type(name, type)
    type isa AbstractString && haskey(_BINARY_TYPES, type) || eqerror("$name: unknown binary type")
    return _BINARY_TYPES[type]
end
function _binary_endian(name, endian)
    endian in (0, 1) && endian isa Real || eqerror("$name: endian must be 0 or 1")
    return Int(endian)
end
_binary_bits(::Type{UInt8}) = UInt8
_binary_bits(::Type{Int16}) = UInt16
_binary_bits(::Type{UInt16}) = UInt16
_binary_bits(::Type{Int32}) = UInt32
_binary_bits(::Type{UInt32}) = UInt32
_binary_bits(::Type{Float32}) = UInt32
_binary_bits(::Type{Float64}) = UInt64
_binary_swap(endian) = (ENDIAN_BOM == 0x04030201) == (endian == 1)

function _atomic_file(f, name, path)
    temporary = nothing
    try
        temporary, io = mktemp(dirname(path); cleanup=false)
        try
            f(io)
        finally
            close(io)
        end
        mv(temporary, path; force=true)
    catch err
        temporary !== nothing && isfile(temporary) && rm(temporary; force=true)
        err isa EqError && rethrow()
        eqerror("$name: cannot write $path: $(sprint(showerror, err))")
    end
    return 0
end

function eq_READBIN(file, type, endian=0, cols=1, skip=0, maxrows=0)
    name = "READBIN"
    path = _file_path(name, file)
    T = _binary_type(name, type)
    endian = _binary_endian(name, endian)
    cols = _file_integer("READBIN: cols", cols, 1)
    skip = _file_integer("READBIN: skip", skip, 0)
    maxrows = _file_integer("READBIN: maxrows", maxrows, 0)
    bytes = try
        read(path)
    catch err
        eqerror("READBIN: cannot read $path: $(sprint(showerror, err))")
    end
    skip <= length(bytes) || eqerror("READBIN: skip exceeds file length")
    available = length(bytes) - skip
    width = sizeof(T)
    available % (width * cols) == 0 || eqerror("READBIN: incomplete row or binary value")
    rows = available ÷ (width * cols)
    maxrows > 0 && (rows = min(rows, maxrows))
    result = Matrix{Float64}(undef, rows, cols)
    U = _binary_bits(T)
    io = IOBuffer(bytes)
    seek(io, skip)
    for r in 1:rows, c in 1:cols
        bits = read(io, U)
        _binary_swap(endian) && (bits = bswap(bits))
        result[r, c] = Float64(reinterpret(T, bits))
    end
    return result
end

function eq_WRITEBIN(file, type, endian, M)
    name = "WRITEBIN"
    path = _file_path(name, file)
    T = _binary_type(name, type)
    endian = _binary_endian(name, endian)
    M isa AbstractArray && ndims(M) <= 2 || eqerror("WRITEBIN: M must be an array")
    matrix = ndims(M) == 1 ? reshape(M, :, 1) : M
    values = Matrix{T}(undef, size(matrix))
    for i in eachindex(matrix)
        x = matrix[i]
        x isa Real && !(x isa Unitful.AbstractQuantity) || eqerror("WRITEBIN: values must be unitless real numbers")
        try
            values[i] = convert(T, x)
        catch
            eqerror("WRITEBIN: value cannot be represented as $type")
        end
    end
    U = _binary_bits(T)
    return _atomic_file(name, path) do io
        for r in axes(values, 1), c in axes(values, 2)
            bits = reinterpret(U, values[r, c])
            write(io, _binary_swap(endian) ? bswap(bits) : bits)
        end
    end
end

function _file_matrix(name, data)
    data isa AbstractArray || return reshape([data], 1, 1)
    ndims(data) <= 2 || eqerror("$name: M must be a scalar, vector, or matrix")
    return ndims(data) == 1 ? reshape(data, :, 1) : data
end

function _file_indices(name, spec, count)
    spec === nothing && return 1:count
    if spec isa AbstractString
        m = match(r"^(\d+)(?:-(\d*)|)$", strip(spec))
        m === nothing && eqerror("$name: invalid range")
        first = parse(Int, m[1])
        last = m[2] === nothing ? first : isempty(m[2]) ? count : parse(Int, m[2])
    elseif spec isa Real
        first = _file_integer(name, spec, 1)
        last = count
    elseif spec isa AbstractArray && length(spec) == 2
        first = _file_integer(name, spec[begin], 1)
        last = _file_integer(name, spec[end], 1)
    else
        eqerror("$name: invalid range")
    end
    1 <= first <= last <= count || eqerror("$name: range is outside the data")
    return first:last
end

function _text_value(v, emptyfill, decsymb, thousep)
    v === missing && return emptyfill
    s = strip(String(v))
    isempty(s) && return emptyfill
    numeric = isempty(thousep) ? s : replace(s, thousep => "")
    decsymb != "." && (numeric = replace(numeric, decsymb => "."))
    value = tryparse(Float64, numeric)
    return value === nothing ? String(v) : value
end

function _read_delimited(file, name; delimiter=',', emptyfill=NaN, decsymb=".", thousep="", blankrows="read", quotechar='"')
    path = _file_path(name, file)
    text = try read(path, String) catch err; eqerror("$name: cannot read $path: $(sprint(showerror, err))") end
    isempty(text) && return Matrix{Any}(undef, 0, 0)
    blankrows in ("read", "skip", "stop") || eqerror("$name: invalid blankrows")
    if blankrows == "stop"
        lines = split(text, '\n'; keepempty=true)
        stop = findfirst(x -> isempty(strip(x)), lines)
        stop !== nothing && (text = join(lines[1:stop-1], '\n'))
    end
    isempty(text) && return Matrix{Any}(undef, 0, 0)
    table = try
        CSV.File(IOBuffer(text); header=false, delim=delimiter, types=String,
            silencewarnings=true, strict=true, ignoreemptyrows=blankrows == "skip", quotechar=quotechar)
    catch err
        eqerror("$name: invalid text data: $(sprint(showerror, err))")
    end
    nrows = length(table)
    names = propertynames(table)
    result = Matrix{Any}(undef, nrows, length(names))
    for (i, row) in enumerate(table), (j, key) in enumerate(names)
        result[i,j] = _text_value(getproperty(row, key), emptyfill, decsymb, thousep)
    end
    return result
end

function _write_delimited(file, M, name, delimiter, rows=nothing, cols=nothing, decsymb=".")
    decsymb in (".", ",") || eqerror("$name: decimal symbol must be '.' or ','")
    matrix = _file_matrix(name, M)
    selected = matrix[_file_indices("$name: rows", rows, size(matrix,1)), _file_indices("$name: cols", cols, size(matrix,2))]
    path = _file_path(name, file)
    return _atomic_file(name, path) do io
        for r in axes(selected,1)
            for c in axes(selected,2)
                c != first(axes(selected,2)) && print(io, delimiter)
                x = selected[r,c]
                x isa Unitful.AbstractQuantity && eqerror("$name: values must be unitless")
                x isa Union{Real,AbstractString} || eqerror("$name: values must be real numbers or strings")
                s = x isa Real ? replace(string(x), "." => decsymb) : String(x)
                if x isa AbstractString || occursin(delimiter, s) || occursin('\n', s) || occursin('"', s)
                    print(io, '"', replace(s, "\"" => "\"\""), '"')
                else
                    print(io, s)
                end
            end
            print(io, '\n')
        end
    end
end

eq_READCSV(file) = _read_delimited(file, "READCSV")
eq_WRITECSV(file, M, rows=nothing, cols=nothing, decsymb=".") = _write_delimited(file, M, "WRITECSV", ',', rows, cols, decsymb)
eq_WRITETEXT(file, M, rows=nothing, cols=nothing, decsymb=".") = _write_delimited(file, M, "WRITETEXT", '\t', rows, cols, decsymb)

function _text_indices(name, spec, count)
    spec === nothing && return collect(1:count)
    spec isa AbstractString || eqerror("$name: selection must be text")
    indices = Int[]
    for term in split(spec, ',')
        append!(indices, _file_indices(name, strip(term), count))
    end
    return indices
end

function _fixed_text(file, name, widths, emptyfill, decsymb, thousep, blankrows)
    path = _file_path(name, file)
    lines = try readlines(path) catch err; eqerror("$name: cannot read $path: $(sprint(showerror, err))") end
    blankrows in ("read", "skip", "stop") || eqerror("$name: invalid blankrows")
    selected = String[]
    for line in lines
        if isempty(strip(line))
            blankrows == "skip" && continue
            blankrows == "stop" && break
        end
        push!(selected, line)
    end
    widths === nothing && return reshape(Any[selected...], :, 1)
    widths isa AbstractArray && !isempty(widths) || eqerror("$name: colwidths must be a nonempty vector")
    ws = [_file_integer("$name: column width", w, 1) for w in widths]
    result = Matrix{Any}(undef, length(selected), length(ws))
    for (r,line) in enumerate(selected)
        chars = collect(line)
        pos = 1
        for (c,w) in enumerate(ws)
            field = pos <= length(chars) ? String(chars[pos:min(pos+w-1,end)]) : ""
            result[r,c] = _text_value(field, emptyfill, decsymb, thousep)
            pos += w
        end
    end
    return result
end

function eq_READTEXT(file, type="delimited", args...)
    type in ("delimited", "fixed") || eqerror("READTEXT: type must be delimited or fixed")
    length(args) <= 6 || eqerror("READTEXT: too many arguments")
    option(i, default) = i <= length(args) ? args[i] : default
    delimwidth = option(1, type == "fixed" ? nothing : "auto")
    rows, cols, emptyfill, blankrows, options = option(2,nothing), option(3,nothing), option(4,NaN), option(5,"read"), option(6,["\"", ".", ","])
    options isa AbstractArray && length(options) == 3 || eqerror("READTEXT: options must contain text qualifier, decimal symbol and thousands separator")
    qualifier, decimal, thousands = options
    qualifier in ("\"", "'", "none") || eqerror("READTEXT: invalid text qualifier")
    decimal in (".", ",") || eqerror("READTEXT: invalid decimal symbol")
    thousands in (".", ",", " ", "") || eqerror("READTEXT: invalid thousands separator")
    decimal == thousands && eqerror("READTEXT: decimal and thousands separators must differ")
    if type == "fixed"
        result = _fixed_text(file, "READTEXT", delimwidth, emptyfill, decimal, thousands, blankrows)
    else
        delimwidth isa AbstractString || eqerror("READTEXT: delimiter must be text")
        delimiter = delimwidth == "auto" ? nothing : delimwidth == "/t" ? '\t' : delimwidth == "//" ? '\\' : length(delimwidth) == 1 ? only(delimwidth) : eqerror("READTEXT: invalid delimiter")
        result = _read_delimited(file, "READTEXT"; delimiter, emptyfill, decsymb=decimal, thousep=thousands,
            blankrows, quotechar=qualifier == "none" ? '\0' : only(qualifier))
    end
    return result[_text_indices("READTEXT: rowspec", rows, size(result,1)), _text_indices("READTEXT: colspec", cols, size(result,2))]
end

function eq_READFILE(file, type, args...)
    type in ("delimited", "fixed", "Excel", "ODS") || eqerror("READFILE: unknown type")

    length(args) <= (type == "fixed" ? 5 : 4) || eqerror("READFILE: too many arguments")
    offset = type == "fixed" ? 1 : 0
    option(i, default) = i <= length(args) ? args[i] : default
    widths = offset == 1 ? option(1,nothing) : nothing
    offset == 1 && widths === nothing && eqerror("READFILE: fixed type needs column widths")
    rows, cols = option(1+offset,nothing), option(2+offset,nothing)
    emptyfill, decimal = option(3+offset,NaN), option(4+offset,".")
    decimal in (".", ",") || eqerror("READFILE: invalid decimal symbol")
    matrix = if type == "ODS"
        eq_READODS(file, "", emptyfill)
    elseif type == "Excel"
        path = _file_path("READFILE", file)
        ext = lowercase(splitext(path)[2])
        ext in (".xls", ".xlsx") || eqerror("READFILE: Excel input needs an .xls or .xlsx file")
        try
            if ext == ".xls"
                _XLS_READ[] === nothing && eqerror("READFILE: legacy Excel codec is unavailable")
                _XLS_READ[](path, emptyfill)
            else
                raw = XLSX.getdata(XLSX.readxlsx(path)[1])
                map(x -> ismissing(x) ? emptyfill : x, raw)
            end
        catch err
            err isa EqError && rethrow()
            eqerror("READFILE: cannot read $path: $(sprint(showerror,err))")
        end
    elseif type == "fixed"
        _fixed_text(file,"READFILE",widths,emptyfill,decimal,"","read")
    else
        _read_delimited(file,"READFILE"; delimiter=nothing, emptyfill, decsymb=decimal)
    end
    return matrix[_file_indices("READFILE: rows", rows, size(matrix,1)), _file_indices("READFILE: cols", cols, size(matrix,2))]
end

function eq_WRITEFILE(file, M)
    ext = lowercase(splitext(String(file))[2])
    ext == ".ods" && return eq_WRITEODS(file, M)
    ext in (".xls", ".xlsx") && return eq_WRITEEXCEL(file, M)
    return _write_delimited(file, M, "WRITEFILE", '\t')
end

# the reference application writes real matrices as bare rows (PRNCOLWIDTH 8, PRNPRECISION 4). Complex, string
# and nested matrices are blocks ".MATRIX <id> <complex> <rows> <cols>" behind two "//"
# comment lines, entries wrapped at 80 columns: real "%8.4g", complex "re, im", string
# quoted, and a nested element is a reference "{id,complex,rows,cols}" to the block with
# that id (the file's matrix is block 0). Saved .mcdx files fix this layout.
function _prn_g(x, width)
    r = round(Float64(x); sigdigits=4)
    text = isinteger(r) && abs(r) < 1e15 ? string(Int(r)) : string(r)
    return lpad(text, width)
end

function _prn_parse_block(blocks, id, name)
    haskey(blocks, id) || eqerror("$name: missing .MATRIX block $id")
    complexflag, rows, cols, body = blocks[id]
    count = rows * cols
    if occursin('{', body) || occursin('"', body)
        items = Any[]
        pattern = r"\{\s*(\d+)\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\}|\"([^\"]*)\"|([^\s,{\"]+)\s*,\s*([^\s,{\"]+)|(\S+)"
        for m in eachmatch(pattern, body)
            if m[1] !== nothing
                push!(items, _prn_parse_block(blocks, parse(Int, m[1]), name))
            elseif m[2] !== nothing
                push!(items, String(m[2]))
            elseif m[3] !== nothing
                re, im = tryparse(Float64, m[3]), tryparse(Float64, m[4])
                (re === nothing || im === nothing) && eqerror("$name: nonnumeric entry in PRN data")
                push!(items, complex(re, im))
            else
                v = tryparse(Float64, m[5])
                v === nothing && eqerror("$name: nonnumeric entry in PRN data")
                push!(items, v)
            end
        end
        length(items) == count || eqerror("$name: header does not match the number of entries")
        return permutedims(reshape(items, cols, rows))
    end
    numbers = [tryparse(Float64, f) for f in split(replace(body, ',' => ' '))]
    any(isnothing, numbers) && eqerror("$name: nonnumeric entry in PRN data")
    if complexflag
        length(numbers) == 2count || eqerror("$name: header does not match the number of entries")
        values = [complex(numbers[2k-1], numbers[2k]) for k in 1:count]
    else
        length(numbers) == count || eqerror("$name: header does not match the number of entries")
        values = Float64.(numbers)
    end
    return permutedims(reshape(values, cols, rows))
end

function eq_READPRN(file)
    path = _file_path("READPRN", file)
    lines = try readlines(path) catch err; eqerror("READPRN: cannot read $path: $(sprint(showerror,err))") end
    lines = [line for line in lines if !isempty(strip(line)) && !startswith(strip(line), "//")]
    isempty(lines) && return Matrix{Float64}(undef, 0, 0)
    header = r"^\s*\.MATRIX\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$"i
    if match(header, lines[1]) !== nothing
        blocks = Dict{Int,Tuple{Bool,Int,Int,String}}()
        current = nothing
        body = String[]
        flush() = current === nothing || (blocks[current[1]] = (current[2], current[3], current[4], join(body, "\n")))
        for line in lines
            m = match(header, line)
            if m !== nothing
                flush()
                current = (parse(Int, m[1]), parse(Int, m[2]) != 0, parse(Int, m[3]), parse(Int, m[4]))
                empty!(body)
            else
                push!(body, line)
            end
        end
        flush()
        return _prn_parse_block(blocks, 0, "READPRN")
    end
    rows = [split(strip(line)) for line in lines]
    count = length(rows[1])
    all(row -> length(row) == count, rows) || eqerror("READPRN: inconsistent row widths or unsupported PRN header")
    result = Matrix{Float64}(undef, length(rows), count)
    for (r,row) in enumerate(rows), (c,field) in enumerate(row)
        v = tryparse(Float64, field)
        v === nothing && eqerror("READPRN: nonnumeric or unsupported PRN header")
        result[r,c] = v
    end
    return result
end

_prn_plain(x) = x isa Number && !(x isa Unitful.AbstractQuantity)
_prn_real(M) = all(x -> _prn_plain(x) && x isa Real, M)

_prn_flag(M) = any(x -> _prn_plain(x) && !(x isa Real), M) ? 1 : 0

function _prn_block(io, id, M, queue, name)
    M = M isa AbstractMatrix ? M : reshape(M, :, 1)
    entries = String[]
    flag = 0
    mixed(x) = x isa AbstractArray || x isa AbstractString || _prn_plain(x)
    if all(mixed, M) && any(x -> x isa AbstractArray || x isa AbstractString, M)
        flag = _prn_flag(M)
        for x in permutedims(M)
            if x isa AbstractArray
                child = x isa AbstractMatrix ? x : reshape(x, :, 1)
                push!(queue, child)
                cflag = _prn_flag(child)
                push!(entries, " {$(length(queue)),$cflag,$(size(child,1)),$(size(child,2))}")
            elseif x isa AbstractString
                push!(entries, " \"" * x * "\"")
            else
                push!(entries, flag == 1 ? _prn_g(real(x), 8) * "," * _prn_g(imag(x), 9) : _prn_g(x, 8))
            end
        end
    elseif all(_prn_plain, M)
        if _prn_real(M)
            entries = [_prn_g(x, 8) for x in permutedims(M)]
        else
            flag = 1
            entries = [_prn_g(real(x), 8) * "," * _prn_g(imag(x), 9) for x in permutedims(M)]
        end
    else
        eqerror("$name: only unitless numeric, string or nested array PRN data is supported")
    end
    print(io, ".MATRIX ", id, ' ', flag, ' ', size(M,1), ' ', size(M,2), "\r\n")
    width = 0
    for entry in entries
        if width > 0 && width + length(entry) > 80
            print(io, "\r\n")
            width = 0
        end
        print(io, entry)
        width += length(entry)
    end
end

function _prn_render(M, name; append=false)
    if _prn_real(M)
        io = IOBuffer()
        for r in axes(M,1)
            for c in axes(M,2)
                c != first(axes(M,2)) && print(io, ' ')
                print(io, M[r,c])
            end
            print(io, '\n')
        end
        return String(take!(io))
    end
    append && eqerror("$name: only unitless real numeric PRN data can be appended")
    io = IOBuffer()
    stamp = Libc.strftime("%m/%d/%y %H:%M:%S", time())
    print(io, "// Datafile written by the reference application\r\n// ", stamp, "\r\n\r\n")
    queue = Any[]
    _prn_block(io, 0, M, queue, name)
    index = 1
    while index <= length(queue)
        print(io, "\r\n")
        _prn_block(io, index, queue[index], queue, name)
        index += 1
    end
    return String(take!(io))
end
function eq_WRITEPRN(file, M, rows=nothing, cols=nothing)
    matrix = _file_matrix("WRITEPRN", M)
    matrix = matrix[_file_indices("WRITEPRN: rows", rows, size(matrix,1)), _file_indices("WRITEPRN: cols", cols, size(matrix,2))]
    text = _prn_render(matrix,"WRITEPRN")
    path = _file_path("WRITEPRN",file)
    _atomic_file("WRITEPRN",path) do io; write(io,text); end
    return rows === nothing && cols === nothing ? M : matrix
end
const _FILE_APPEND_LOCK = ReentrantLock()

function eq_APPENDPRN(file, M)
    lock(_FILE_APPEND_LOCK) do
        matrix = _file_matrix("APPENDPRN",M)
        text = _prn_render(matrix,"APPENDPRN"; append=true)
        path = _file_path("APPENDPRN", file)
        old = isfile(path) ? eq_READPRN(path) : nothing
        old !== nothing && size(old,2) != size(matrix,2) && eqerror("APPENDPRN: column count does not match file")
        content = old === nothing ? "" : read(path,String)
        !isempty(content) && !endswith(content,"\n") && (content *= "\n")
        _atomic_file("APPENDPRN",path) do io; write(io,content,text); end
        return M
    end
end

function _wav_read(file, name)
    path = _file_path(name, file)
    try
        return WAV.wavread(path; format="native")
    catch err
        eqerror("$name: cannot read WAV file $path: $(sprint(showerror,err))")
    end
end
function eq_READWAV(file)
    data, _, bits, chunks = _wav_read(file,"READWAV")
    fmt = WAV.getformat(chunks)
    # WAV.jl exposes valid-bit integers, while the reference application uses the full PCM
    # container scale. The unused least significant bits are zero.
    shift = 8cld(Int(fmt.nbits), 8) - Int(bits)
    return Float64.(data) .* 2.0^shift
end
function eq_GETWAVINFO(file)
    data, rate, bits, chunks = _wav_read(file,"GETWAVINFO")
    fmt = WAV.getformat(chunks)
    return Float64[size(data,2), rate, fmt.ext.nbits == 0 ? bits : fmt.ext.nbits, fmt.bytes_per_second]
end
function eq_WRITEWAV(file, s, b, M)
    rate = _file_integer("WRITEWAV: sample rate", s, 1)
    bits = _file_integer("WRITEWAV: bit resolution", b, 1)
    bits <= 16 || eqerror("WRITEWAV: bit resolution must be between 1 and 16")
    matrix = _file_matrix("WRITEWAV",M)
    T = bits <= 8 ? UInt8 : Int16
    output = Matrix{T}(undef,size(matrix))
    for i in eachindex(matrix)
        x = matrix[i]
        x isa Real && !(x isa Unitful.AbstractQuantity) && isfinite(x) && isinteger(x) && (bits <= 8 ? 0 <= x <= 255 : -32768 <= x <= 32767) || eqerror("WRITEWAV: samples exceed the PCM container range")
        # PCM valid bits occupy the most significant bits of each container.
        # Quantize toward negative infinity by discarding the remaining bits.
        output[i] = T(x) >> (8sizeof(T) - bits)
    end
    path = _file_path("WRITEWAV",file)
    return _atomic_file("WRITEWAV",path) do io
        WAV.wavwrite(output,io; Fs=rate, nbits=bits)
    end
end

function _read_image(file,name)
    path = _file_path(name,file)
    try
        data = ImageMagick.load(path)
        ndims(data) == 2 || eqerror("$name: image must be two-dimensional")
        return ColorTypes.RGB{Float64}.(data)
    catch err
        err isa EqError && rethrow()
        eqerror("$name: cannot read image $path: $(sprint(showerror,err))")
    end
end
function _channels(file,name)
    img = _read_image(file,name)
    return (255 .* ColorTypes.red.(img), 255 .* ColorTypes.green.(img), 255 .* ColorTypes.blue.(img))
end
eq_READRGB(file) = hcat(_channels(file,"READRGB")...)
eq_READ_RED(file) = _channels(file,"READ_RED")[1]
eq_READ_GREEN(file) = _channels(file,"READ_GREEN")[2]
eq_READ_BLUE(file) = _channels(file,"READ_BLUE")[3]
function eq_READ_IMAGE(file)
    img = _read_image(file,"READ_IMAGE")
    return 255 .* Float64.(ColorTypes.Gray.(img))
end
eq_READBMP(file) = eq_READ_IMAGE(file)
function _write_image(file, image, name)
    path = _file_path(name,file)
    extension = splitext(path)[2]
    isempty(extension) && eqerror("$name: image file needs an extension")
    temporary = tempname(dirname(path)) * extension
    try
        ImageMagick.save(temporary,image)
        mv(temporary,path; force=true)
    catch err
        isfile(temporary) && rm(temporary; force=true)
        err isa EqError && rethrow()
        eqerror("$name: cannot write image $path: $(sprint(showerror,err))")
    end
    return 0
end
function _image_number(x,name,upper)
    x isa Real && !(x isa Unitful.AbstractQuantity) && isfinite(x) && 0 <= x <= upper || eqerror("$name: image component must be between 0 and $upper")
    return Float64(x)
end
function eq_WRITEBMP(file,M)
    matrix = _file_matrix("WRITEBMP",M)
    image = map(x -> ColorTypes.Gray{FixedPointNumbers.N0f8}(_image_number(x,"WRITEBMP",255)/255),matrix)
    return _write_image(file,image,"WRITEBMP")
end
function eq_WRITERGB(file,M)
    matrix = _file_matrix("WRITERGB",M)
    size(matrix,2) % 3 == 0 || eqerror("WRITERGB: packed image width must be divisible by 3")
    w = size(matrix,2) ÷ 3
    image = [ColorTypes.RGB{FixedPointNumbers.N0f8}((_image_number(matrix[r,c+k*w],"WRITERGB",255)/255 for k in 0:2)...) for r in axes(matrix,1), c in 1:w]
    return _write_image(file,image,"WRITERGB")
end
function _hsv_image(file,name,kind)
    rgb = _read_image(file,name)
    converted = kind == :hsv ? Colors.HSV.(rgb) : Colors.HSL.(rgb)
    hue = map(c -> Float64(c.h), converted)
    sat = map(c -> 255 * Float64(c.s), converted)
    value = kind == :hsv ? map(c -> 255 * Float64(c.v), converted) : map(c -> 255 * Float64(c.l), converted)
    return hue, sat, value
end
eq_READ_HSV(file) = ((h,s,v) = _hsv_image(file,"READ_HSV",:hsv); hcat(h,s,v))
eq_READ_HLS(file) = ((h,s,l) = _hsv_image(file,"READ_HLS",:hls); hcat(h,l,s))
eq_READ_HUE(file) = _hsv_image(file,"READ_HUE",:hsv)[1]
eq_READ_HSV_SAT(file) = _hsv_image(file,"READ_HSV_SAT",:hsv)[2]
eq_READ_HLS_SAT(file) = _hsv_image(file,"READ_HLS_SAT",:hls)[2]
eq_READ_VALUE(file) = _hsv_image(file,"READ_VALUE",:hsv)[3]
eq_READ_LIGHT(file) = _hsv_image(file,"READ_LIGHT",:hls)[3]
function _write_hsv(file,M,name,kind)
    matrix = _file_matrix(name,M)
    size(matrix,2) % 3 == 0 || eqerror("$name: packed image width must be divisible by 3")
    w = size(matrix,2) ÷ 3
    image = Matrix{ColorTypes.RGB{FixedPointNumbers.N0f8}}(undef,size(matrix,1),w)
    for r in axes(image,1), c in axes(image,2)
        h = _image_number(matrix[r,c],name,360)
        b = _image_number(matrix[r,c+w],name,255)/255
        d = _image_number(matrix[r,c+2w],name,255)/255
        col = kind == :hsv ? Colors.HSV(h,b,d) : Colors.HSL(h,d,b)
        image[r,c] = convert(ColorTypes.RGB{FixedPointNumbers.N0f8},col)
    end
    return _write_image(file,image,name)
end
eq_WRITE_HSV(file,M) = _write_hsv(file,M,"WRITE_HSV",:hsv)
eq_WRITE_HLS(file,M) = _write_hsv(file,M,"WRITE_HLS",:hls)

function eq_WRITEEXCEL(file,M,args...)
    length(args) <= 3 || eqerror("WRITEEXCEL: too many arguments")
    range = !isempty(args) && args[end] isa AbstractString ? args[end] : ""
    selections = isempty(range) ? args : args[1:end-1]
    length(selections) <= 2 || eqerror("WRITEEXCEL: too many selection arguments")
    rows = length(selections) >= 1 ? selections[1] : nothing
    cols = length(selections) >= 2 ? selections[2] : nothing
    matrix = _file_matrix("WRITEEXCEL",M)
    matrix = matrix[_file_indices("WRITEEXCEL: rows",rows,size(matrix,1)),_file_indices("WRITEEXCEL: cols",cols,size(matrix,2))]
    all(x -> x isa Union{Real,AbstractString} && !(x isa Unitful.AbstractQuantity),matrix) || eqerror("WRITEEXCEL: cells must be unitless real numbers or text")
    path = _file_path("WRITEEXCEL",file)
    ext = lowercase(splitext(path)[2])
    ext in (".xls", ".xlsx") || eqerror("WRITEEXCEL: file must have an .xls or .xlsx extension")
    sheetname = nothing
    sheetindex = 1
    anchor = "A1"
    if !isempty(range)
        m = match(r"^(?:\[(\d+)\]|([^!]+)!)?([A-Za-z]+[1-9]\d*)?(?::([A-Za-z]+[1-9]\d*))?$",range)
        m === nothing && eqerror("WRITEEXCEL: invalid range")
        m[1] !== nothing && (sheetindex = parse(Int,m[1]))
        m[2] !== nothing && (sheetname = String(m[2]))
        m[3] !== nothing && (anchor = String(m[3]))
        if m[4] !== nothing
            a, z = XLSX.CellRef(anchor), XLSX.CellRef(m[4])
            (XLSX.row_number(z)-XLSX.row_number(a)+1, XLSX.column_number(z)-XLSX.column_number(a)+1) == size(matrix) || eqerror("WRITEEXCEL: range dimensions must match matrix")
        end
    end
    if ext == ".xls"
        _XLS_WRITE[] === nothing && eqerror("WRITEEXCEL: legacy Excel codec is unavailable")
        try
            _XLS_WRITE[](path, matrix, sheetindex, sheetname, anchor)
        catch err
            err isa EqError && rethrow()
            eqerror("WRITEEXCEL: cannot write $path: $(sprint(showerror,err))")
        end
        return 0
    end
    temporary = tempname(dirname(path))*".xlsx"
    try
        exists = isfile(path)
        exists && cp(path,temporary; force=true)
        XLSX.openxlsx(temporary; mode=exists ? "rw" : "w") do book
            sheet = sheetname === nothing ? book[sheetindex] : book[sheetname]
            sheet[anchor] = matrix
        end
        mv(temporary,path; force=true)
    catch err
        isfile(temporary) && rm(temporary; force=true)
        err isa EqError && rethrow()
        eqerror("WRITEEXCEL: cannot write $path: $(sprint(showerror,err))")
    end
    return 0
end
