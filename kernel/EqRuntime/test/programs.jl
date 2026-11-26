# Program semantics (compatibility section 9). The functions below are hand
# written Julia that mimics what the code generator will emit; the contract is
# documented at the top of src/programs.jl.

# demo(n, v) := | acc <- 0
#               | w <- 0
#               | for i in 0..n
#               | | if i = 2 then continue
#               | | if i > 5 then break
#               | | acc <- acc + i
#               | cnt <- 0
#               | for x in v
#               | | w[cnt] <- x^2
#               | | cnt <- cnt + 1
#               | k <- 0
#               | while k < 3
#               | | k <- k + 1
#               | if acc > 100
#               | | return "big"
#               | else
#               | | r <- try error("boom") on error acc + k
#               | augment(w, stack(r, acc, k))
function program_demo(n, v)
    local acc = nothing
    local w = nothing
    local cnt = nothing
    local k = nothing
    local r = nothing
    local i = nothing
    local x = nothing
    __v = nothing
    __v = (acc = 0.0)
    __v = (w = 0.0)
    for __i in eq_for_items(eq_range(0.0, n))
        i = __i
        if eq_true(eq_eq(i, 2.0))
            continue
        end
        if eq_true(eq_gt(i, 5.0))
            break
        end
        __v = (acc = eq_add(acc, i))
    end
    __v = (cnt = 0.0)
    for __x in eq_for_items(v)
        x = __x
        __v = (w = eq_setindex!(w, eq_pow(x, 2.0), eq_add(cnt, origin())))
        __v = (cnt = eq_add(cnt, 1.0))
    end
    __v = (k = 0.0)
    while eq_true(eq_lt(k, 3.0))
        __v = (k = eq_add(k, 1.0))
    end
    if eq_true(eq_gt(acc, 100.0))
        return "big"
    else
        __v = (r = eq_try(() -> eq_error("boom"), () -> eq_add(acc, k)))
    end
    __v = eq_augment(w, eq_stack(r, acc, k))
    return eq_result(__v)
end

@testset "program result and value tracking" begin
    @test eq_result(3.0) == 3.0
    @test eq_result("text") == "text"
    @test_throws EqError eq_result(nothing)

    # | x <- 5 value of a definition is the value of its expression
    f1() = (local __v = nothing; __v = (x = 5.0); eq_result(__v))
    @test f1() == 5.0

    # | 1 | if a > 0 | | 2 false last if: value is the last one evaluated before
    function f2(a)
        __v = nothing
        __v = 1.0
        if eq_true(eq_gt(a, 0.0))
            __v = 2.0
        end
        eq_result(__v)
    end
    @test f2(1.0) == 2.0
    @test f2(-1.0) == 1.0

    # | if a > 0 | | 2 nothing evaluated before and condition false: error
    function f3(a)
        __v = nothing
        if eq_true(eq_gt(a, 0.0))
            __v = 2.0
        end
        eq_result(__v)
    end
    @test f3(1.0) == 2.0
    @test_throws EqError f3(-1.0)

    # the condition itself is not a statement value
    function f4(a)
        __v = nothing
        if eq_true(eq_gt(a, 0.0))
            __v = 7.0
        end
        eq_result(__v)
    end
    @test_throws EqError f4(0.0)

    # a loop that runs gives the last expression inside; an empty loop the one before
    function f5(n)
        __v = nothing
        __v = 100.0
        local i = nothing
        for __i in eq_for_items(eq_range(1.0, n))
            i = __i
            __v = eq_mul(i, 2.0)
        end
        eq_result(__v)
    end
    @test f5(3.0) == 6.0
    @test f5(0.0) == 0.0      # 1..0 counts down: 1, 0, so the body runs
    function f5_empty()
        __v = nothing
        __v = 100.0
        local i = nothing
        for __i in eq_for_items(eq_range(0.0, 1.0, -1.0))   # step opposes the end: empty
            i = __i
            __v = eq_mul(i, 2.0)
        end
        eq_result(__v)
    end
    @test f5_empty() == 100.0
end

@testset "for sources" begin
    @test collect(eq_for_items(eq_range(1.0, 3.0))) == [1.0, 2.0, 3.0]
    @test collect(eq_for_items(eq_range(3.0, 1.0))) == [3.0, 2.0, 1.0]
    @test isempty(eq_for_items(eq_range(0.0, 1.0, -1.0)))
    @test eq_for_items(eq_vec(4, 5, 6)) == [4.0, 5.0, 6.0]
    @test eq_for_items(eq_rowvec(4, 5, 6)) == [4.0, 5.0, 6.0]
    # a matrix iterates row by row
    @test eq_for_items(eq_matrix(2, 3, 1, 2, 3, 4, 5, 6)) == [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]
    @test isempty(eq_for_items(Matrix{Float64}(undef, 0, 0)))
    @test eq_for_items(2.5) == (2.5,)
    # nested arrays iterate their elements (inner arrays)
    nested = eq_vec(eq_vec(1, 2), eq_vec(3))
    @test length(eq_for_items(nested)) == 2
    @test_throws EqError eq_for_items("abc")
    @test_throws EqError eq_for_items(nothing)

    # the source is a snapshot: assigning into it in the body does not change the iteration
    v = eq_vec(1, 2, 3)
    seen = Float64[]
    for __x in eq_for_items(v)
        push!(seen, __x)
        v = eq_setindex!(v, 99.0, 2)
    end
    @test seen == [1.0, 2.0, 3.0]
    @test v[3, 1] == 99.0

    # loop variable keeps its last value after the loop, also for descending ranges
    function last_value(a, b)
        local i = nothing
        for __i in eq_for_items(eq_range(a, b))
            i = __i
        end
        i
    end
    @test last_value(1.0, 4.0) == 4.0
    @test last_value(4.0, 1.0) == 1.0
    @test collect(eq_for_items(eq_range(0.0, 0.5, 2.0)))[end] == 2.0
    # an empty loop leaves it undefined
    function never_ran()
        local i = nothing
        for __i in eq_for_items(eq_range(0.0, 1.0, -1.0))
            i = __i
        end
        eq_local(i, "i")
    end
    @test_throws EqError never_ran()
end

@testset "break, continue, return, while" begin
    # demo: acc = 0+1+3+4+5 = 13 (2 skipped by continue, loop stops at 6), k = 3, r = acc + k
    @test program_demo(10.0, eq_vec(1, 2, 3)) == [1.0 16.0; 4.0 13.0; 9.0 3.0]
    # more iterations cannot pass the break at 6, so the "big" return is not reached
    @test program_demo(1000.0, eq_vec(1, 2, 3)) == [1.0 16.0; 4.0 13.0; 9.0 3.0]

    # return leaves from inside nested loops and ifs
    function find_first(v, target)
        local i = nothing
        __v = nothing
        for __i in eq_for_items(eq_range(0.0, eq_sub(eq_rows(v), 1.0)))
            i = __i
            if eq_true(eq_eq(eq_index(v, i), target))
                return i
            end
        end
        __v = -1.0
        eq_result(__v)
    end
    @test find_first(eq_vec(5, 6, 7), 7.0) == 2.0
    @test find_first(eq_vec(5, 6, 7), 9.0) == -1.0

    # break and continue act on the innermost loop only
    function nested_loops()
        local i = nothing
        local j = nothing
        local total = nothing
        __v = nothing
        __v = (total = 0.0)
        for __i in eq_for_items(eq_range(1.0, 3.0))
            i = __i
            for __j in eq_for_items(eq_range(1.0, 3.0))
                j = __j
                if eq_true(eq_eq(j, 2.0))
                    break
                end
                __v = (total = eq_add(total, eq_mul(i, 10.0)))
            end
            if eq_true(eq_eq(i, 2.0))
                continue
            end
            __v = (total = eq_add(total, 1.0))
        end
        eq_result(__v)
    end
    @test nested_loops() == 10.0 + 20.0 + 30.0 + 2.0

    # while: condition is rechecked, zero iterations leave the value alone
    function halve(x)
        local n = nothing
        __v = nothing
        __v = (n = 0.0)
        while eq_true(eq_gt(x, 1.0))
            __v = (x = eq_div(x, 2.0))
            __v = (n = eq_add(n, 1.0))
        end
        eq_result(__v)
    end
    @test halve(16.0) == 4.0
    @test halve(0.5) == 0.0

    # a program nested in an expression: return leaves only the inner program
    function outer(a)
        local inner = nothing
        __v = nothing
        __v = (inner = (() -> begin
            __v = nothing
            if eq_true(eq_gt(a, 0.0))
                return 100.0
            end
            __v = 1.0
            eq_result(__v)
        end)())
        __v = eq_add(inner, 1.0)
        eq_result(__v)
    end
    @test outer(1.0) == 101.0
    @test outer(-1.0) == 2.0

    # break outside a loop is an error statement
    stray_break() = eq_error("break outside a loop")
    @test_throws EqError stray_break()
end

@testset "if / else if / also if / else" begin
    # | if a<0 | "neg" else if a=0 | "zero" else | "pos"
    function sign_name(a)
        __v = nothing
        if eq_true(eq_lt(a, 0.0))
            __v = "neg"
        elseif eq_true(eq_eq(a, 0.0))
            __v = "zero"
        else
            __v = "pos"
        end
        eq_result(__v)
    end
    @test sign_name(-2.0) == "neg"
    @test sign_name(0.0) == "zero"
    @test sign_name(3.0) == "pos"

    # | if a>0 | log += 1 also if a>1 | log += 10 else | log += 100
    function also(a)
        __v = nothing
        local log = nothing
        __v = (log = 0.0)
        __ran = false
        if eq_true(eq_gt(a, 0.0))
            __ran = true
            __v = (log = eq_add(log, 1.0))
        end
        if eq_true(eq_gt(a, 1.0))
            __ran = true
            __v = (log = eq_add(log, 10.0))
        end
        if !__ran
            __v = (log = eq_add(log, 100.0))
        end
        eq_result(__v)
    end
    @test also(5.0) == 11.0     # both ran, else skipped
    @test also(0.5) == 1.0
    @test also(-1.0) == 100.0   # nothing ran: else runs

    # elseif stops at the first true condition: later conditions are not evaluated
    evaluated = Ref(0)
    probe(x) = (evaluated[] += 1; x)
    function first_true()
        __v = nothing
        if eq_true(probe(0.0))
            __v = 1.0
        elseif eq_true(probe(1.0))
            __v = 2.0
        elseif eq_true(probe(1.0))
            __v = 3.0
        end
        eq_result(__v)
    end
    @test first_true() == 2.0
    @test evaluated[] == 2

    # the condition must be a scalar
    @test_throws EqError eq_true(eq_vec(1, 2))
end

@testset "local definitions and scope" begin
    # a local made inside nested blocks is visible after them
    function visible_after(a)
        local x = nothing
        local i = nothing
        __v = nothing
        if eq_true(eq_lt(a, 3.0))
            for __i in eq_for_items(eq_range(0.0, 2.0))
                i = __i
                __v = (x = eq_setindex!(x, eq_add(3.0, i), i))
            end
        end
        __v = x
        eq_result(__v)
    end
    @test visible_after(1.0) == eq_vec(3, 4, 5)
    @test_throws EqError visible_after(5.0)

    # a read that may precede the assignment goes through eq_local
    function maybe_undefined(a)
        local y = nothing
        __v = nothing
        if eq_true(eq_gt(a, 0.0))
            __v = (y = 1.0)
        end
        __v = eq_add(eq_local(y, "y"), 1.0)
        eq_result(__v)
    end
    @test maybe_undefined(1.0) == 2.0
    err = try
        maybe_undefined(-1.0)
    catch e
        e
    end
    @test err isa EqError && occursin("y is undefined", err.message)

    # X <- X + 1 reads the sheet value first
    X_sheet = 10.0
    function bump()
        local X = nothing
        __v = nothing
        __v = (X = eq_add(eq_local_or(X, X_sheet), 1.0))
        eq_result(__v)
    end
    @test bump() == 11.0
    @test X_sheet == 10.0

    #  with : a read after an assignment made only inside a loop is the local
    # once assigned (here 2 elements), the sheet value when the loop never ran
    sheet_nd = eq_vec(7, 7, 7, 7)
    function fill(n)
        local ND = nothing
        __v = nothing
        for k in eq_for_items(eq_range(0.0, n))
            __v = (ND = eq_setindex!(ND, k, k))
        end
        __v = eq_local_or(ND, sheet_nd)
        eq_result(__v)
    end
    @test fill(1.0) == eq_vec(0, 1)
    @test sheet_nd == eq_vec(7, 7, 7, 7)

    # X[0] <- v starts a new local array, not a copy of the sheet array
    sheet_array = eq_vec(1, 2, 3)
    function set_first()
        local X = nothing
        __v = nothing
        __v = (X = eq_setindex!(X, 9.0, 0.0))
        __v = X
        eq_result(__v)
    end
    @test set_first() == eq_vec(9)
    @test sheet_array == eq_vec(1, 2, 3)

    # a nested program does not write to the locals of the enclosing program
    function shadowing()
        local x = nothing
        local inner = nothing
        __v = nothing
        __v = (x = 1.0)
        __v = (inner = (() -> begin
            local x = nothing
            __v = nothing
            __v = (x = 50.0)
            eq_result(__v)
        end)())
        __v = eq_add(x, inner)
        eq_result(__v)
    end
    @test shadowing() == 51.0
end

@testset "growth and value semantics in programs" begin
    # undefined target: created and zero filled
    @test eq_setindex!(nothing, 5.0, 2.0) == eq_vec(0, 0, 5)
    # two indices create a matrix
    @test eq_setindex!(nothing, 1.0, 1, 2) == [0.0 0.0 0.0; 0.0 0.0 1.0]

    # a local scalar is promoted
    function zr(r, c)
        local Z = nothing
        __v = nothing
        __v = (Z = 0.0)
        __v = (Z = eq_setindex!(Z, 0.0, eq_sub(r, 1.0), eq_sub(c, 1.0)))
        __v = Z
        eq_result(__v)
    end
    @test zr(2.0, 3.0) == zeros(2, 3)

    # at worksheet level a defined scalar is an error, an undefined name creates a vector
    @test_throws EqError eq_sheet_setindex!(5.0, 1.0, 2.0)
    @test_throws EqError eq_sheet_setindex!("s", 1.0, 0.0)
    @test eq_sheet_setindex!(nothing, 7.0, 2.0) == eq_vec(0, 0, 7)
    @test eq_sheet_setindex!(eq_vec(1, 2), 7.0, 3.0) == eq_vec(1, 2, 0, 7)

    # parameters are by value: the body assigns into a copy
    function change_param(v)
        v = eq_val(v)
        __v = nothing
        __v = (v = eq_setindex!(v, 0.0, 0.0))
        eq_result(__v)
    end
    original = eq_vec(5, 6)
    @test change_param(original) == eq_vec(0, 6)
    @test original == eq_vec(5, 6)

    # B <- A then B[...] <- v does not change A
    function copy_then_set(A)
        local B = nothing
        __v = nothing
        __v = (B = eq_val(A))
        __v = (B = eq_setindex!(B, 99.0, 1.0))
        __v = B
        eq_result(__v)
    end
    A = eq_vec(1, 2, 3)
    @test copy_then_set(A) == eq_vec(1, 99, 3)
    @test A == eq_vec(1, 2, 3)

    # nested element assignment (s[i])[j] <- x copies the inner array first
    function nested_set(S)
        local s = nothing
        __v = nothing
        __v = (s = eq_val(S))
        inner = eq_val(eq_index(s, 0.0))
        inner = eq_setindex!(inner, 42.0, 1.0)
        __v = (s = eq_setindex!(s, inner, 0.0))
        __v = s
        eq_result(__v)
    end
    S = eq_vec(eq_vec(1, 2), eq_vec(3, 4))
    changed = nested_set(S)
    @test eq_index(eq_index(changed, 0.0), 1.0) == 42.0
    @test eq_index(eq_index(S, 0.0), 1.0) == 2.0

    # eq_val is deep for arrays that hold arrays
    deep = eq_val(S)
    deep[1, 1][1, 1] = -1.0
    @test S[1, 1][1, 1] == 1.0

    # growth in a loop and in an inner array of arrays keeps the 0 fill
    function grow(n)
        local y = nothing
        local i = nothing
        __v = nothing
        for __i in eq_for_items(eq_range(0.0, n))
            i = __i
            __v = (y = eq_setindex!(y, eq_mul(i, i), eq_add(i, 2.0)))
        end
        __v = y
        eq_result(__v)
    end
    @test grow(2.0) == eq_vec(0, 0, 0, 1, 4)

    # column and row assignment with growth
    col = eq_setcol!(nothing, eq_vec(1, 2), 1.0)
    @test col == [0.0 1.0; 0.0 2.0]

    # destructuring: [a, b[0]] <- v
    function destructure(v)
        local a = nothing
        local b = nothing
        __v = nothing
        t1, t2 = eq_unpack(v, 1, 2)
        a = t1
        b = eq_setindex!(b, t2, 0.0)
        __v = eq_add(a, eq_index(b, 0.0))
        eq_result(__v)
    end
    @test destructure(eq_rowvec(3, 4)) == 7.0
    @test_throws EqError destructure(eq_rowvec(3, 4, 5))

    # Nested destructuring: [p, [q; r]] <- M. A cell that is a
    # matrix destructures the nested array the right side holds there: one `eq_unpack` per level.
    function destructure_nested(M)
        local p = nothing
        local q = nothing
        local r = nothing
        __v = nothing
        t1, t2 = eq_unpack(M, 1, 2)
        p = t1
        t3, t4 = eq_unpack(t2, 2, 1)
        q = t3
        __v = (r = t4)
        eq_result(__v)
    end
    nested = eq_matrix(1, 2, eq_rowvec(1, 2), eq_matrix(2, 1, 3.0, 4.0))
    @test destructure_nested(nested) == 4.0
    # The outer level hands each cell its element unchanged: a nested array is one value.
    t1, t2 = eq_unpack(nested, 1, 2)
    @test t1 == eq_rowvec(1, 2)
    @test t2 == eq_matrix(2, 1, 3.0, 4.0)
    # A nested cell that is not an array, and an inner shape that is not the one written in the
    # text, are the errors of an ordinary destructuring: nothing is transposed or guessed.
    error_message(M) = try
        destructure_nested(M)
        ""
    catch error
        error isa EqError ? error.message : rethrow()
    end
    @test error_message(eq_rowvec(1, 2)) ==
          "the right side of a multiple assignment must be an array"
    @test error_message(eq_matrix(1, 2, eq_rowvec(1, 2), eq_matrix(3, 1, 3.0, 4.0, 5.0))) ==
          "multiple assignment: expected a 2x1 array, got 3x1"
end

@testset "try / on error and error()" begin
    @test eq_try(() -> 1.0, () -> 2.0) == 1.0
    @test eq_try(() -> eq_error("boom"), () -> 2.0) == 2.0
    # Julia-level failures are the reference application errors too
    @test eq_try(() -> eq_index(eq_vec(1), 5.0), () -> -1.0) == -1.0
    @test eq_try(() -> eq_div(1.0, 0.0) |> x -> x, () -> -1.0) isa Number
    @test eq_try(() -> eq_pow(eq_matrix(2, 2, 1, 2, 2, 4), -1.0), () -> -2.0) == -2.0
    @test eq_try(() -> error("plain julia error"), () -> 3.0) == 3.0
    # the handler's own errors are not caught
    @test_throws EqError eq_try(() -> eq_error("a"), () -> eq_error("b"))
    # interrupts are never swallowed
    @test_throws InterruptException eq_try(() -> throw(InterruptException()), () -> 0.0)
    @test_throws EqError eq_error("text")
    @test_throws EqError eq_error(5.0)
    msg = try
        eq_error("custom message")
    catch e
        e.message
    end
    @test msg == "custom message"


    # the inline form keeps break and continue working inside a loop
    function skip_bad(v)
        local total = nothing
        local i = nothing
        __v = nothing
        __v = (total = 0.0)
        for __i in eq_for_items(eq_range(0.0, eq_sub(eq_rows(v), 1.0)))
            i = __i
            __v = try
                eq_error("bad element")
            catch __e
                eq_caught(__e)
                if eq_true(eq_lt(eq_index(v, i), 0.0))
                    continue
                end
                if eq_true(eq_gt(eq_index(v, i), 100.0))
                    break
                end
                0.0
            end
            __v = (total = eq_add(total, eq_index(v, i)))
        end
        eq_result(__v)
    end
    @test skip_bad(eq_vec(1, -1, 2, 200, 4)) == 3.0

    # try inside a nested program and value of the body that ran
    function value_of_body(flag)
        __v = nothing
        __v = try
            eq_true(flag) ? eq_error("x") : 10.0
        catch __e
            eq_caught(__e)
            20.0
        end
        eq_result(__v)
    end
    @test value_of_body(1.0) == 20.0
    @test value_of_body(0.0) == 10.0
end

@testset "error location" begin
    e = EqError("m")
    @test e.statement === nothing
    @test eq_locate(e, 3).statement == 3
    @test eq_locate(eq_locate(e, 3), 9).statement == 3     # innermost statement wins
    @test eq_locate(ErrorException("raw"), 2) isa EqError
    @test eq_locate(ErrorException("raw"), 2).message == "raw"
    not_fn = eq_locate(MethodError([1.0, 2.0], (1.0,)), 4)
    @test not_fn isa EqError && not_fn.statement == 4
    @test not_fn.message == "cannot call a value that is not a function"
    interrupt = InterruptException()
    @test eq_locate(interrupt, 1) === interrupt
    @test occursin("statement 3", sprint(showerror, eq_locate(e, 3)))
    @test !occursin("statement", sprint(showerror, e))

    # generated shape: statement ids updated before each statement, catch-all rethrows located
    function located(a)
        __s = 0
        try
            __v = nothing
            __s = 1
            __v = (x = 1.0)
            __s = 2
            __v = (y = eq_index(eq_vec(1, 2), a))
            __s = 3
            __v = eq_add(x, y)
            return eq_result(__v)
        catch __e
            throw(eq_locate(__e, __s))
        end
    end
    @test located(1.0) == 3.0
    err = try
        located(7.0)
    catch e
        e
    end
    @test err isa EqError && err.statement == 2

    # a nested program reports its own statement; the outer catch keeps it
    function outer_located()
        __s = 0
        try
            __s = 1
            return (() -> begin
                __s = 0
                try
                    __s = 1
                    eq_error("inner")
                catch __e
                    throw(eq_locate(__e, __s))
                end
            end)()
        catch __e
            throw(eq_locate(__e, __s))
        end
    end
    err = try
        outer_located()
    catch e
        e
    end
    @test err isa EqError && err.statement == 1 && err.message == "inner"
end

@testset "return from a nested block" begin
    # if acc > 100 | return "big" (reached only when the loop is not cut by break)
    function early(limit)
        local acc = nothing
        local i = nothing
        __v = nothing
        __v = (acc = 0.0)
        for __i in eq_for_items(eq_range(1.0, 20.0))
            i = __i
            __v = (acc = eq_add(acc, i))
            if eq_true(eq_gt(acc, limit))
                return "big"
            end
        end
        eq_result(__v)
    end
    @test early(50.0) == "big"
    @test early(1000.0) == 210.0
end

# demo: Z(A, Q, T) := | g(x) <- x·Q + T
#                       | g(A)
@testset "a local function of a program" begin
    # The name is a local declared at the top and the body is a closure assigned to it, so the
    # body runs only when the function is called and it reads the program's locals.
    function local_function(A, Q, T)
        local g = nothing
        local __v = nothing
        g = (x) -> eq_add(eq_mul(x, Q), T)
        __v = g(A)
        eq_result(__v)
    end
    @test local_function(2.0, 3.0, 1.0) == 7.0

    # `g(x) <- x`: the parameters of the head shadow a local of the same name.
    function parameters_shadow_locals()
        local x = nothing
        local g = nothing
        local __v = nothing
        __v = (x = 10.0)
        g = (x) -> eq_mul(x, 2.0)
        __v = eq_add(g(3.0), x)
        eq_result(__v)
    end
    @test parameters_shadow_locals() == 16.0

    # `fact(k) <- program …`: a program body, whose locals the parameters of the head start, and
    # a call inside it reads the same local, so the function recurses.
    function recursion(n)
        local fact = nothing
        local __v = nothing
        fact = function (k)
            local __v = nothing
            if eq_true(eq_le(k, 1.0))
                __v = 1.0
            else
                __v = eq_mul(k, fact(eq_sub(k, 1.0)))
            end
            eq_result(__v)
        end
        __v = fact(n)
        eq_result(__v)
    end
    @test recursion(5.0) == 120.0

    # The body is evaluated when it is called, not at the definition statement, and it sees the
    # locals of the program.
    function captures_a_local(n)
        local a = nothing
        local g = nothing
        local __v = nothing
        __v = (a = eq_add(n, 1.0))
        g = (x) -> eq_mul(a, x)
        __v = g(2.0)
        eq_result(__v)
    end
    @test captures_a_local(2.0) == 6.0

    # A parameter of the head that the body writes into is copied on entry, like any other.
    function copies_its_argument(L)
        local fill = nothing
        local __v = nothing
        fill = function (v)
            local __v = nothing
            v = eq_val(v)
            __v = (v = eq_setindex!(v, 99.0, 0.0))
            eq_result(__v)
        end
        __v = fill(L)
        __v = L
        eq_result(__v)
    end
    keep = eq_vec(1, 2)
    @test copies_its_argument(keep) == eq_vec(1, 2)
    @test keep == eq_vec(1, 2)

    # The definition statement sets no value: a program of only local functions is 's error.
    function only_definitions()
        local g = nothing
        local __v = nothing
        g = (x) -> x
        eq_result(__v)
    end
    @test_throws EqError only_definitions()

    # A call before the definition fails: the local holds no function yet.
    function call_before_the_definition()
        local g = nothing
        local __v = nothing
        __v = g(1.0)
        eq_result(__v)
    end
    @test_throws MethodError call_before_the_definition()
end

@testset "golden comparison helper detects differences" begin
    expected = JSON3.read("""{"rows": 1, "cols": 2, "data": [1.0, {"rows": 1, "cols": 1, "data": [2.0]}]}""")
    good = Matrix{Any}(undef, 1, 2)
    good[1, 1] = 1.0
    good[1, 2] = eq_matrix(1, 1, 2.0)
    @test golden_mismatch(good, expected, 1e-12, 0.0) === nothing
    bad = copy(good)
    bad[1, 2] = eq_matrix(1, 1, 2.5)
    @test golden_mismatch(bad, expected, 1e-12, 0.0) !== nothing
    @test golden_mismatch(1.0, expected, 1e-12, 0.0) !== nothing
end
