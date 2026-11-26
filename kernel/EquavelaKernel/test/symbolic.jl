# Symbolic bridge tests: AST -> SymPy -> AST on plain data, the
# `symbolic` and `symbolic_status` requests. They need the Python environment with SymPy;
# without it the suite reports one skipped test.

using Test
using JSON3
using EquavelaKernel
using EqRuntime

const SYMBOLIC_READY = try
    EquavelaKernel._ensure_symbolic!()
    true
catch exception
    haskey(ENV, "EQUAVELA_REQUIRE_SYMPY") && rethrow()
    @info "Skipping the symbolic tests: the Python environment is not available" exception
    false
end

# ---- AST builders (the serde JSON shape of core/src/ast.rs) ----------------------------

nm(text) = Dict{String,Any}("segments" => Any[Dict{String,Any}("text" => text, "subscript" => false)], "label" => nothing)
nm(base, sub) = Dict{String,Any}("segments" => Any[
        Dict{String,Any}("text" => base, "subscript" => false),
        Dict{String,Any}("text" => sub, "subscript" => true)], "label" => nothing)
N(text) = Dict{String,Any}("type" => "Num", "text" => text)
V(text) = Dict{String,Any}("type" => "Ident", "name" => nm(text))
bin(kind, a, b) = Dict{String,Any}("type" => kind, "left" => a, "right" => b)
Add(a, b) = merge(bin("Add", a, b), Dict("split" => false))
Sub(a, b) = merge(bin("Sub", a, b), Dict("split" => false))
Mul(a, b) = merge(bin("Mul", a, b), Dict("split" => false))
Div(a, b) = bin("Div", a, b)
Pw(a, b) = bin("Pow", a, b)
Eqn(a, b) = bin("Eq", a, b)
Neg(a) = Dict{String,Any}("type" => "Neg", "expr" => a)
Par(a) = Dict{String,Any}("type" => "Paren", "expr" => a)
call(f, args...) = Dict{String,Any}("type" => "Call", "callee" => V(f),
    "args" => Any[Dict{String,Any}("type" => "Expr", "expr" => a) for a in args])
kw(name, args...) = Dict{String,Any}("keyword" => name, "args" => Any[args...])
deriv(var, body) = Dict{String,Any}("type" => "Deriv", "var" => Dict{String,Any}("name" => nm(var)),
    "order" => nothing, "body" => body)
function defn(name, body; params=nothing, keywords=Any[])
    return Dict{String,Any}("name" => nm(name), "params" => params === nothing ? nothing : Any[nm(p) for p in params],
        "body" => body, "keywords" => keywords)
end

run_symbolic(expr; keywords=Any[], definitions=Any[]) = EquavelaKernel.symbolic_request(
    Dict{String,Any}("expr" => expr, "keywords" => keywords, "definitions" => definitions), nothing)

function value_expr(result)
    @assert result["status"] == "ok" result
    return result["value"]["expr"]
end

# Mathematical equality of two ASTs, through SymPy.
same(a, b) = EquavelaKernel._bridge_call(:equivalent, a, b)

function round_trips(expr)
    result = run_symbolic(expr)
    result["status"] == "ok" || return false
    return same(value_expr(result), expr)
end

if !SYMBOLIC_READY
    @testset "symbolic (skipped: no Python environment)" begin
        @test_skip false
    end
else
    @testset "symbolic" begin
        @testset "dsolve" begin
            prime(f, n, arg) = Dict{String,Any}("type" => "Call",
                "callee" => Dict{String,Any}("type" => "PrimeDeriv", "function" => V(f), "order" => n),
                "args" => Any[Dict{String,Any}("type" => "Expr", "expr" => arg)])
            col(cells...) = Dict{String,Any}("type" => "Matrix", "rows" => length(cells), "cols" => 1, "cells" => Any[cells...])
            # y'' + y = 0, y(0) = 0, y'(0) = 1 is sin(t).
            oscillator = col(Eqn(Add(prime("y", 2, V("t")), call("y", V("t"))), N("0")),
                Eqn(call("y", N("0")), N("0")), Eqn(prime("y", 1, N("0")), N("1")))
            result = value_expr(run_symbolic(oscillator; keywords=Any[kw("dsolve", call("y", V("t")))]))
            @test same(result, call("sin", V("t")))
            # A worksheet value of t does not reach the variable of the equation.
            result = value_expr(run_symbolic(oscillator; keywords=Any[kw("dsolve", call("y", V("t")))],
                definitions=Any[defn("t", N("5"))]))
            @test same(result, call("sin", V("t")))
            # A system: x' = y, y' = -x, x(0) = 0, y(0) = 1.
            system = col(Eqn(prime("x", 1, V("t")), call("y", V("t"))), Eqn(prime("y", 1, V("t")), Neg(call("x", V("t")))),
                Eqn(call("x", N("0")), N("0")), Eqn(call("y", N("0")), N("1")))
            result = value_expr(run_symbolic(system; keywords=Any[kw("dsolve", col(call("x", V("t")), call("y", V("t"))))]))
            @test result["type"] == "Matrix" && (result["rows"], result["cols"]) == (2, 1)
            @test same(result["cells"][1], call("sin", V("t"))) && same(result["cells"][2], call("cos", V("t")))
            # Without conditions the integration constants stay.
            free = run_symbolic(Eqn(prime("y", 1, V("t")), call("y", V("t"))); keywords=Any[kw("dsolve", call("y", V("t")))])
            @test free["status"] == "ok" && occursin("C1", JSON3.write(free["value"]["expr"]))
            # A definition by the solution is a function of the variable.
            definition = defn("y", oscillator; params=["t"], keywords=Any[kw("dsolve", call("y", V("t")))])
            @test same(value_expr(run_symbolic(call("y", V("s")); definitions=Any[definition])), call("sin", V("s")))
            # Not a differential equation.
            bad = run_symbolic(Eqn(call("y", N("0")), N("1")); keywords=Any[kw("dsolve", call("y", V("t")))])
            @test bad["status"] == "error"
        end
        @testset "Jacobian" begin
            idx(i) = Dict{String,Any}("type" => "Index", "base" => V("x"), "indices" => Any[N(string(i))])
            mat(cells) = Dict{String,Any}("type" => "Matrix", "rows" => length(cells), "cols" => 1, "cells" => Any[cells...] )
            defs = Any[defn("F", mat([Mul(idx(0), idx(1)), Pw(idx(0), N("2"))]); params=["x"])]
            result = value_expr(run_symbolic(call("Jacob", call("F", V("x")), V("x")); definitions=defs))
            @test result["type"] == "Matrix"
            @test (result["rows"], result["cols"]) == (2, 2)
            @test result["cells"][1] == idx(1)
            @test result["cells"][2] == idx(0)
            @test result["cells"][4] == N("0")
            extra = value_expr(run_symbolic(call("Jacob", call("F", V("x")), V("x"), N("3")); definitions=defs))
            @test (extra["rows"], extra["cols"]) == (2, 3)
            @test extra["cells"][3] == N("0") && extra["cells"][6] == N("0")
            small = value_expr(run_symbolic(call("Jacob", call("F", V("x")), V("x"), N("1")); definitions=defs))
            @test (small["rows"], small["cols"]) == (2, 1) && small["cells"][1] == idx(1)
            origin_defs = Any[defn("F", mat([Mul(idx(1), idx(2))]); params=["x"])]
            origin_result = value_expr(EquavelaKernel.symbolic_request(Dict{String,Any}("expr" => call("Jacob", call("F", V("x")), V("x")), "definitions" => origin_defs, "origin" => 1), nothing))
            @test origin_result["cells"] == Any[idx(2), idx(1)]
            other = Dict{String,Any}("type" => "Index", "base" => V("y"), "indices" => Any[N("9")])
            ydef = defn("y", mat([N(string(i)) for i in 1:10]))
            direct = value_expr(run_symbolic(call("Jacob", mat([Mul(idx(0), other)]), V("x")); definitions=Any[ydef]))
            @test (direct["rows"], direct["cols"], direct["cells"]) == (1, 1, Any[N("10")])
            u0 = Dict{String,Any}("type" => "Index", "base" => V("u"), "indices" => Any[N("0")])
            v9 = Dict{String,Any}("type" => "Index", "base" => V("v"), "indices" => Any[N("9")])
            hdef = defn("H", mat([Mul(u0, v9)]); params=["u", "v"])
            nested = value_expr(run_symbolic(call("Jacob", call("H", V("x"), V("y")), V("x")); definitions=Any[ydef, hdef]))
            @test (nested["rows"], nested["cols"], nested["cells"]) == (1, 1, Any[N("10")])
            vals = vcat(defs, Any[defn("x", mat([N("2"), N("3")]))])
            numeric = value_expr(run_symbolic(call("Jacob", call("F", V("x")), V("x")); definitions=vals))
            @test numeric["cells"] == Any[N("3"), N("2"), N("4"), N("0")]
            @test run_symbolic(call("Jacob", call("F", V("x")), V("x"), N("0")); definitions=defs)["status"] == "error"
            # A vector of names: Jacob([g·i; g^2], [g; i]) = [i g; 2·g 0].
            names = value_expr(run_symbolic(call("Jacob", mat([Mul(V("g"), V("i")), Pw(V("g"), N("2"))]), mat([V("g"), V("i")]))))
            @test (names["rows"], names["cols"]) == (2, 2)
            @test names["cells"][1] == V("i") && names["cells"][2] == V("g") && names["cells"][4] == N("0")
            # A name with a value stands for itself while differentiating; its value comes back.
            valued = value_expr(run_symbolic(call("Jacob", mat([Mul(V("g"), V("i"))]), mat([V("g"), V("i")])); definitions=Any[defn("i", N("3"))]))
            @test valued["cells"] == Any[N("3"), V("g")]
            @test run_symbolic(call("Jacob", mat([V("g")]), mat([N("1")])))["status"] == "error"
        end

        @testset "status and protocol errors" begin
            status = EquavelaKernel.symbolic_status_request()
            @test status["state"] in ("idle", "warming", "ready", "failed")
            @test_throws EquavelaKernel.KernelFailure EquavelaKernel.symbolic_request(Dict{String,Any}(), nothing)
            @test_throws EquavelaKernel.KernelFailure EquavelaKernel.symbolic_request(
                Dict{String,Any}("expr" => N("1"), "keywords" => 3), nothing)
        end

        @testset "the warm-up task reports readiness" begin
            saved = get(ENV, "EQUAVELA_SYMBOLIC_WARMUP", nothing)
            try
                EquavelaKernel.SYMBOLIC_STATUS["state"] = "idle"
                ENV["EQUAVELA_SYMBOLIC_WARMUP"] = "off"
                EquavelaKernel.start_symbolic_warmup!()
                @test EquavelaKernel.symbolic_status_request()["state"] == "idle"
                ENV["EQUAVELA_SYMBOLIC_WARMUP"] = "auto"
                EquavelaKernel.start_symbolic_warmup!()
                @test EquavelaKernel.symbolic_status_request()["state"] == "warming"
                deadline = time() + 60
                while EquavelaKernel.symbolic_status_request()["state"] == "warming" && time() < deadline
                    sleep(0.1)
                end
                status = EquavelaKernel.symbolic_status_request()
                @test status["state"] == "ready"
                @test startswith(status["sympy"], "1.14")
                @test startswith(status["python"], "3.12")
                @test status["seconds"] isa Real
            finally
                saved === nothing ? delete!(ENV, "EQUAVELA_SYMBOLIC_WARMUP") : (ENV["EQUAVELA_SYMBOLIC_WARMUP"] = saved)
            end
        end

        @testset "numbers, constants and arithmetic evaluate automatically" begin
            @test value_expr(run_symbolic(Add(N("2"), N("3")))) == N("5")
            @test value_expr(run_symbolic(Div(N("1"), N("3")))) == Div(N("1"), N("3"))
            @test value_expr(run_symbolic(Neg(N("4")))) == Neg(N("4"))
            @test value_expr(run_symbolic(Add(V("x"), V("x")))) == Mul(N("2"), V("x"))
            @test value_expr(run_symbolic(Mul(N("0.5"), V("x")))) == Mul(N("0.5"), V("x"))
            @test value_expr(run_symbolic(N("100000000000000000000000000000000000000000"))) ==
                  N("100000000000000000000000000000000000000000")
            @test value_expr(run_symbolic(V("π"))) == V("π")
            @test value_expr(run_symbolic(Pw(V("e"), V("x")))) == Pw(V("e"), V("x"))
            @test value_expr(run_symbolic(call("exp", V("x")))) == Pw(V("e"), V("x"))
            @test value_expr(run_symbolic(call("ln", V("x")))) == call("ln", V("x"))
            @test value_expr(run_symbolic(call("sqrt", N("2")))) == Dict{String,Any}(
                "type" => "Root", "index" => nothing, "radicand" => N("2"))
            @test value_expr(run_symbolic(Dict{String,Any}("type" => "Imag", "text" => "3", "symbol" => "i"))) ==
                  Dict{String,Any}("type" => "Imag", "text" => "3", "symbol" => "i")
        end

        @testset "special functions use the reference application names and preserve AST results" begin
            x = V("x")
            @test value_expr(run_symbolic(call("Γ", N("3")))) == N("2")
            @test same(value_expr(run_symbolic(call("Γ", N("2"), N("1")))),
                Div(N("2"), call("exp", N("1"))))
            @test same(value_expr(run_symbolic(Add(call("erf", x), call("erfc", x)))), N("1"))

            # The SymPy derivative of J₀ is -J₁; both results must return through
            # the bridge as registered the reference application built-ins, not SymPy-only names.
            @test same(value_expr(run_symbolic(deriv("x", call("Jn", N("0"), x)))),
                Neg(call("Jn", N("1"), x)))
            jac2 = call("Jac", N("2"), N("0"), N("0"), x)
            legendre2 = Div(Sub(Mul(N("3"), Pw(x, N("2"))), N("1")), N("2"))
            @test same(value_expr(run_symbolic(jac2)), legendre2)

            # the reference application's incomplete beta and generalized hypergeometric argument
            # conventions are retained as symbolic expressions.
            @test same(value_expr(run_symbolic(call("ibeta", N("0.5"), N("1"), N("1")))), N("0.5"))
            @test same(value_expr(run_symbolic(call("fhyper", N("1"), N("1"), N("2"), N("0.5")))),
                Div(call("ln", N("2")), N("0.5")))
            # Expanded results must survive conversion back into a worksheet AST.
            z = Add(N("1.2"), Dict{String,Any}("type" => "Imag", "text" => "0.7", "symbol" => "i"))
            negative = Neg(N("2"))
            cases = [(prefix * suffix * ".sc", Symbol("eq_", prefix, suffix, "_sc"), suffix == "n")
                     for prefix in ("J", "Y", "I", "K") for suffix in ("0", "1", "n")]
            append!(cases, [(name * ".sc", Symbol("eq_", name, "_sc"), true) for name in ("H1", "H2")])
            append!(cases, [(name * ".sc", Symbol("eq_", name, "_sc"), false) for name in ("Ai", "DAi", "Bi", "DBi")])
            for (name, _, has_order) in cases
                expr = has_order ? call(name, N("2"), x) : call(name, x)
                @test same(value_expr(run_symbolic(expr)), expr)
            end
            for (name, numeric_name, has_order) in cases, (arg, number) in ((z, 1.2 + 0.7im), (negative, -2.0))
                expr = has_order ? call(name, N("2"), x) : call(name, x)
                expanded = value_expr(run_symbolic(expr))
                result = value_expr(run_symbolic(expanded; definitions=Any[defn("x", arg)]))
                ctx = EquavelaKernel._bridge_call(:Context)
                pyexpr = EquavelaKernel._bridge_call(:tosympy, ctx, result)
                pc = getfield(EquavelaKernel.BRIDGE[], :PythonCall)
                actual = pc.pyconvert(ComplexF64, pc.pybuiltins.complex(pyexpr.evalf()))
                numeric = getfield(EqRuntime, numeric_name)
                expected = has_order ? numeric(2, number) : numeric(number)
                @test actual ≈ expected rtol=1e-11 atol=1e-12
            end
            # K scaling is analytic, so its product derivative has no branch assumptions.
            expected_derivative = Mul(call("exp", x), Sub(call("Kn", N("0"), x), call("Kn", N("1"), x)))
            @test same(value_expr(run_symbolic(deriv("x", call("K0.sc", x)))), expected_derivative)
            deferred = value_expr(run_symbolic(call("ibeta", V("a"), N("2"), N("3"))))
            @test same(value_expr(run_symbolic(deferred; definitions=Any[defn("a", N("0.5"))])), N("0.6875"))
            shadow = defn("J0.sc", Add(x, N("1")); params=["x"])
            @test same(value_expr(run_symbolic(call("J0.sc", N("2")); definitions=Any[shadow])), N("3"))
        end

        @testset "subscripted names survive the round trip" begin
            expr = Add(Dict{String,Any}("type" => "Ident", "name" => nm("F", "max")), N("1"))
            result = value_expr(run_symbolic(expr))
            @test result["type"] == "Add"
            @test result["left"]["name"]["segments"] == nm("F", "max")["segments"]
            @test result["right"] == N("1")
        end

        @testset "derivative of a worksheet function: the phase 5 exit case" begin
            # f(x) := x^2·sin(x); d/dx f(x) →
            f = defn("f", Mul(Pw(V("x"), N("2")), call("sin", V("x"))); params=["x"])
            result = run_symbolic(deriv("x", call("f", V("x"))); definitions=Any[f])
            @test result["status"] == "ok"
            expected = Add(Mul(Pw(V("x"), N("2")), call("cos", V("x"))),
                Mul(Mul(N("2"), V("x")), call("sin", V("x"))))
            @test same(value_expr(result), expected)
        end

        @testset "variable definitions are substituted, binders and keyword variables are not" begin
            a = defn("a", N("3"))
            @test value_expr(run_symbolic(Mul(V("a"), V("x")); definitions=Any[a])) == Mul(N("3"), V("x"))
            # x is defined, but the derivative binds its own x
            xdef = defn("x", N("5"))
            result = run_symbolic(deriv("x", Pw(V("x"), N("3"))); definitions=Any[xdef])
            @test same(value_expr(result), Mul(N("3"), Pw(V("x"), N("2"))))
            # solve, x does not substitute x
            result = run_symbolic(Eqn(Mul(N("2"), V("x")), N("6")); keywords=Any[kw("solve", V("x"))], definitions=Any[xdef])
            @test value_expr(result) == N("3")
            # a later definition replaces an earlier one
            @test value_expr(run_symbolic(V("a"); definitions=Any[a, defn("a", N("4"))])) == N("4")
            # definitions bind in order: y keeps the x it saw
            sequential = Any[defn("x", N("1")), defn("y", Add(V("x"), N("1"))), defn("x", N("5"))]
            @test value_expr(run_symbolic(Add(V("y"), V("x")); definitions=sequential)) == N("7")
            # `free` names are never substituted (function head parameters)
            result = EquavelaKernel.symbolic_request(Dict{String,Any}("expr" => V("a"),
                "definitions" => Any[a], "free" => Any[nm("a")]), nothing)
            @test value_expr(result) == V("a")
            # unsupported definitions leave the name free
            program = defn("p", Dict{String,Any}("type" => "Program", "body" => Any[]))
            @test same(value_expr(run_symbolic(Add(V("p"), N("1")); definitions=Any[program])), Add(V("p"), N("1")))
            @test value_expr(run_symbolic(Add(V("p"), N("1")); definitions=Any[program]))["type"] == "Add"
        end

        @testset "keywords" begin
            x = V("x")
            # simplify
            expr = Add(Add(Pw(call("sin", x), N("2")), Pw(call("cos", x), N("2"))), Div(Sub(Pw(x, N("2")), N("1")), Sub(x, N("1"))))
            @test value_expr(run_symbolic(expr; keywords=Any[kw("simplify")])) == Add(x, N("2"))
            # expand
            expr = Pw(Par(Add(x, V("y"))), N("2"))
            @test same(value_expr(run_symbolic(expr; keywords=Any[kw("expand")])),
                Add(Add(Pw(x, N("2")), Mul(Mul(N("2"), x), V("y"))), Pw(V("y"), N("2"))))
            # factor
            expr = Sub(Pw(x, N("2")), N("1"))
            result = run_symbolic(expr; keywords=Any[kw("factor")])
            @test same(value_expr(result), expr)
            @test value_expr(result)["type"] == "Mul"
            # solve: two roots give a column vector, one root a scalar
            expr = Eqn(Add(Sub(Pw(x, N("2")), Mul(N("5"), x)), N("6")), N("0"))
            result = value_expr(run_symbolic(expr; keywords=Any[kw("solve", x)]))
            @test result["type"] == "Matrix" && result["rows"] == 2 && result["cols"] == 1
            @test sort(string.([c["type"] == "Num" ? c["text"] : "?" for c in result["cells"]])) == ["2", "3"]
            # solve with no variable named: the single free symbol
            @test value_expr(run_symbolic(Sub(Mul(N("2"), x), N("6")); keywords=Any[kw("solve")])) == N("3")
            # no solution
            result = run_symbolic(Eqn(N("1"), N("2")); keywords=Any[kw("solve", x)])
            @test result["status"] == "error"
            # substitute
            result = run_symbolic(Add(Pw(x, N("2")), V("y")); keywords=Any[kw("substitute", Eqn(x, N("3")))])
            @test same(value_expr(result), Add(V("y"), N("9")))
            # series (default order 6 and an explicit order)
            result = run_symbolic(call("sin", x); keywords=Any[kw("series", x, N("4"))])
            @test same(value_expr(result), Sub(x, Div(Pw(x, N("3")), N("6"))))
            # series with no argument: the only free variable, about 0, order 6
            result = value_expr(run_symbolic(Div(N("1"), Sub(N("1"), x)); keywords=Any[kw("series")]))
            @test same(result, value_expr(run_symbolic(Div(N("1"), Sub(N("1"), x)); keywords=Any[kw("series", x)])))
            @test run_symbolic(Add(x, V("y")); keywords=Any[kw("series")])["status"] == "error"
            # The terms in rising powers, as a series is written: 1 + x + x²/2 + x³/6 + x⁴/24.
            terms(e) = e["type"] in ("Add", "Sub") ? [terms(e["left"]); terms(e["right"])] : Any[e]
            power(t) = t["type"] == "Num" ? 0 : t["type"] == "Ident" ? 1 :
                t["type"] == "Div" ? power(t["left"]) : t["type"] == "Pow" ? parse(Int, t["right"]["text"]) : -1
            ordered = terms(value_expr(run_symbolic(call("exp", x); keywords=Any[kw("series", x, N("5"))])))
            @test map(power, ordered) == [0, 1, 2, 3, 4]
            ordered = terms(value_expr(run_symbolic(call("cos", x); keywords=Any[kw("series", x, N("6"))])))
            @test map(power, ordered) == [0, 2, 4]
            # Psi(n, y) is polygamma: the derivative of Psi(x) is Psi(1, x), Psi(0, x) is Psi(x)
            @test same(value_expr(run_symbolic(deriv("x", call("Psi", x)))), call("Psi", N("1"), x))
            @test same(value_expr(run_symbolic(call("Psi", N("0"), x))), call("Psi", x))
            @test same(value_expr(run_symbolic(deriv("x", call("Psi", N("2"), x)))), call("Psi", N("3"), x))
            # collect
            expr = Add(Add(Mul(V("a"), x), Mul(V("b"), x)), V("c"))
            result = run_symbolic(expr; keywords=Any[kw("collect", x)])
            @test same(value_expr(result), expr)
            # float
            result = run_symbolic(V("π"); keywords=Any[kw("float", N("10"))])
            @test value_expr(result)["type"] == "Num"
            @test startswith(value_expr(result)["text"], "3.14159265")
            # no digits: 15 (the reference application shows 20; `float, 20` gives them)
            @test value_expr(run_symbolic(V("π"); keywords=Any[kw("float")]))["text"] == "3.14159265358979"
            @test value_expr(run_symbolic(V("π"); keywords=Any[kw("float", N("20"))]))["text"] == "3.1415926535897932385"
            # coeffs (ascending)
            expr = Add(Add(N("1"), Mul(N("2"), x)), Mul(N("3"), Pw(x, N("2"))))
            result = value_expr(run_symbolic(expr; keywords=Any[kw("coeffs", x)]))
            @test [c["text"] for c in result["cells"]] == ["1", "2", "3"]
            # partial fractions
            expr = Div(N("1"), Mul(x, Add(x, N("1"))))
            result = run_symbolic(expr; keywords=Any[kw("parfrac", x)])
            @test same(value_expr(result), expr)
            @test value_expr(result)["type"] in ("Sub", "Add")
            # several keywords apply in order
            result = run_symbolic(Pw(Par(Add(x, N("1"))), N("2")); keywords=Any[kw("expand"), kw("substitute", Eqn(x, N("2")))])
            @test value_expr(result) == N("9")
            # assume
            expr = call("sqrt", Pw(V("p"), N("2")))
            plain = value_expr(run_symbolic(expr; keywords=Any[kw("simplify")]))
            assumed = value_expr(run_symbolic(expr; keywords=Any[kw("assume", bin("Gt", V("p"), N("0"))), kw("simplify")]))
            @test plain["type"] == "Root"
            @test assumed == V("p")
        end

        @testset "algebraic substitution" begin
            x, r, z, a, b = V("X"), V("R"), V("Z"), V("a"), V("b")
            two = N("2")
            pattern = Add(Pw(x, two), Pw(r, two))
            replacement = Pw(z, two)
            rule = Eqn(pattern, replacement)
            substitute(expr, rules...; assumptions=Any[], definitions=Any[]) =
                value_expr(run_symbolic(expr; keywords=Any[assumptions..., kw("substitute", rules...)], definitions=definitions))
            expanded_square = Add(Add(Pw(x, N("4")), Mul(two, Mul(Pw(x, two), Pw(r, two)))), Pw(r, N("4")))
            cases = [
                (pattern, replacement),
                (Add(Pw(r, two), Pw(x, two)), replacement),
                (Mul(two, pattern), Mul(two, replacement)),
                (expanded_square, Pw(z, N("4"))),
                (Add(Add(Mul(a, Pw(x, two)), Mul(a, Pw(r, two))), b), Add(Mul(a, replacement), b)),
                (Div(N("1"), pattern), Div(N("1"), replacement)),
                (call("sin", Mul(two, pattern)), call("sin", Mul(two, replacement))),
                (call("exp", expanded_square), call("exp", Pw(z, N("4")))),
                (Div(N("1"), Add(Mul(two, pattern), N("1"))), Div(N("1"), Add(Mul(two, replacement), N("1")))),
            ]
            for (input, expected) in cases
                actual = substitute(input, rule)
                @test same(actual, expected)
                @test !occursin("\"text\":\"X\"", JSON3.write(actual))
                @test !occursin("\"text\":\"R\"", JSON3.write(actual))
            end
            nonnegative = kw("assume", bin("Ge", z, N("0")))
            @test substitute(call("sqrt", pattern), rule; assumptions=Any[nonnegative]) == z
            @test same(substitute(call("sqrt", expanded_square), rule; assumptions=Any[nonnegative]), replacement)
            unrestricted = substitute(call("sqrt", pattern), rule)
            @test unrestricted != z
            @test same(unrestricted, call("sqrt", replacement))
            real = kw("assume", Eqn(z, V("real")))
            @test same(substitute(call("sqrt", pattern), rule; assumptions=Any[real]), call("abs", z))

            l, omega, voltage = V("L"), V("ω"), V("V")
            impedance = Div(voltage, Mul(call("sqrt", two), Add(Mul(Pw(l, two), Pw(omega, two)), Pw(r, two))))
            chain = Eqn(Mul(omega, l), x)
            expected = Div(voltage, Mul(call("sqrt", two), replacement))
            @test same(substitute(impedance, chain, rule), expected)
            @test same(substitute(call("exp", impedance), chain, rule), call("exp", expected))
            @test same(substitute(call("sin", impedance), chain, rule), call("sin", expected))
            @test same(substitute(Div(N("1"), Add(N("1"), impedance)), chain, rule), Div(N("1"), Add(N("1"), expected)))

            current, angle = V("current"), V("angle")
            negative_terms = Sub(Mul(N("0"), x), Add(Mul(current, Pw(r, two)), Mul(current, Pw(x, two))))
            for f in ("cos", "exp")
                other = Mul(Mul(current, replacement), call(f, angle))
                actual = substitute(Add(negative_terms, other), rule)
                @test same(actual, Sub(other, Mul(current, replacement)))
                @test !occursin("\"text\":\"X\"", JSON3.write(actual))
                @test !occursin("\"text\":\"R\"", JSON3.write(actual))
            end
            coefficient = call("sin", angle)
            @test same(substitute(Add(Mul(coefficient, Pw(x, two)), Mul(coefficient, Pw(r, two))), rule), Mul(coefficient, replacement))
            # A non-polynomial term depending on the same variables remains intact.
            other = call("exp", Div(Mul(r, Sub(angle, V("angle0"))), x))
            actual = substitute(Add(negative_terms, other), rule)
            @test same(actual, Sub(other, Mul(current, replacement)))
            @test occursin("\"text\":\"angle0\"", JSON3.write(actual))

            reverse_rule = Eqn(replacement, pattern)
            @test same(substitute(pattern, reverse_rule), replacement)
            @test same(substitute(Add(negative_terms, other), reverse_rule), Sub(other, Mul(current, replacement)))
            @test same(substitute(Add(pattern, replacement), reverse_rule), Mul(two, replacement))
            # If only the left side occurs, the ordinary substitution direction still applies.
            @test same(substitute(replacement, reverse_rule), pattern)
            @test same(substitute(pattern, reverse_rule; definitions=Any[defn("X", N("3")), defn("R", N("4"))]), replacement)

            # A complete fraction with exponential and trigonometric terms.
            phase = Div(Mul(r, Sub(angle, V("angle0"))), x)
            exponential = call("exp", phase)
            v = V("voltage")
            voltage_term = Mul(v, Sub(Mul(r, call("sin", angle)), Mul(x, call("cos", angle))))
            numerator = Add(Add(negative_terms, Mul(Mul(current, pattern), exponential)), Add(Mul(v, r), Mul(voltage_term, exponential)))
            full = Div(numerator, Mul(Mul(two, pattern), exponential))
            expected_full = Div(Add(Add(Neg(Mul(current, replacement)), Mul(Mul(current, replacement), exponential)), Add(Mul(v, r), Mul(voltage_term, exponential))), Mul(Mul(two, replacement), exponential))
            for direction in (rule, reverse_rule)
                full_result = substitute(full, direction)
                @test same(full_result, expected_full)
                @test occursin("\"text\":\"Z\"", JSON3.write(full_result))
            end
            alias = Dict{String,Any}("type" => "Ident", "name" => nm("e", "θ"))
            alias_rule = Eqn(alias, exponential)
            combined = value_expr(run_symbolic(full; keywords=Any[kw("substitute", reverse_rule), kw("substitute", alias_rule)]))
            expected_alias = Div(Add(Add(Neg(Mul(current, replacement)), Mul(Mul(current, replacement), alias)), Add(Mul(v, r), Mul(voltage_term, alias))), Mul(Mul(two, replacement), alias))
            @test same(combined, expected_alias)
            @test occursin("\"text\":\"θ\"", JSON3.write(combined))
            @test same(substitute(call("sin", angle), Eqn(alias, call("sin", angle))), alias)
            # An existing symbol keeps the usual left-to-right substitution.
            @test same(substitute(Add(alias, call("sin", angle)), Eqn(alias, call("sin", angle))), Mul(two, call("sin", angle)))
            @test same(substitute(alias, Eqn(alias, Add(V("k"), N("1"))); definitions=Any[defn("k", N("3"))]), N("4"))

            @test substitute(Add(x, N("1")), Eqn(x, r)) == Add(r, N("1"))
            @test substitute(x, Eqn(x, r), Eqn(r, z)) == z
            @test substitute(x, Eqn(x, r), Eqn(r, x)) == x
            @test substitute(x, Eqn(x, r), Eqn(x, z)) == r
            @test same(substitute(pattern, rule, Eqn(replacement, pattern)), pattern)
            @test same(value_expr(run_symbolic(pattern; keywords=Any[kw("substitute", rule), kw("substitute", Eqn(z, N("3")))])), N("9"))
            @test substitute(V("q"), rule) == V("q")
            # A compound pattern's variables remain symbolic even if the worksheet defines them.
            @test same(substitute(pattern, rule; definitions=Any[defn("X", N("3")), defn("R", N("4"))]), replacement)
            # A partial term must not be eliminated by solving the rule for one variable.
            @test substitute(Pw(x, two), rule) == Pw(x, two)
            @test same(substitute(Add(Pw(x, two), Pw(r, N("4"))), rule), Add(Pw(x, two), Pw(r, N("4"))))
            # Reaching the operation budget falls back to direct substitution.
            large = foldl((left, i) -> Add(left, Pw(V("q$i"), two)), 1:110; init=pattern)
            large_result = substitute(large, rule)
            @test occursin("\"text\":\"Z\"", JSON3.write(large_result))
            large_factored = foldl((left, i) -> Add(left, Pw(V("q$i"), two)), 1:110; init=Mul(two, pattern))
            @test !occursin("\"text\":\"Z\"", JSON3.write(substitute(large_factored, rule)))
            # Rewriting a sum in a denominator must not cancel unrelated singularities.
            pole = Div(N("1"), Mul(Sub(x, N("1")), Add(x, N("1"))))
            @test same(substitute(pole, Eqn(Sub(Pw(x, two), N("1")), z)), pole)
        end

        @testset "collect by an expression" begin
            x, r, z, a, b, t = V("X"), V("R"), V("Z"), V("a"), V("b"), V("t")
            target = Mul(a, Pw(z, N("2")))
            input = Add(Sub(Mul(target, call("exp", t)), target), b)
            collected = value_expr(run_symbolic(input; keywords=Any[kw("collect", target)]))
            expected = Add(Mul(target, Sub(call("exp", t), N("1"))), b)
            @test same(collected, expected)
            function has_factored_sum(node)
                node isa AbstractDict || return false
                if get(node, "type", nothing) == "Mul" && any(get(get(node, key, Dict()), "type", nothing) in ("Add", "Sub") for key in ("left", "right"))
                    return true
                end
                return any(has_factored_sum(child) for child in values(node))
            end
            @test has_factored_sum(collected)
            sum_target = Add(Pw(x, N("2")), Pw(r, N("2")))
            expanded = Add(Add(Mul(a, Pw(x, N("2"))), Mul(a, Pw(r, N("2")))), b)
            grouped = value_expr(run_symbolic(expanded; keywords=Any[kw("collect", sum_target)]))
            @test same(grouped, Add(Mul(a, sum_target), b))
            @test has_factored_sum(grouped)
        end

        @testset "transforms (laplace, fourier, ztrans and their inverses)" begin
            t, s, ω, z, n = V("t"), V("s"), V("ω"), V("z"), V("n")
            e = V("e")
            subs_at(expr, var, value) = value_expr(run_symbolic(expr; keywords=Any[kw("substitute", Eqn(var, value))]))
            # laplace: t -> s
            expr = Mul(call("exp", Neg(Mul(N("2"), t))), call("sin", Mul(N("3"), t)))
            result = value_expr(run_symbolic(expr; keywords=Any[kw("laplace")]))
            @test same(result, Div(N("3"), Add(Pw(Par(Add(s, N("2"))), N("2")), N("9"))))
            @test same(value_expr(run_symbolic(expr; keywords=Any[kw("laplace", t)])), result)
            # the transform variable can be named, with an optional result variable
            result = value_expr(run_symbolic(Pw(e, Mul(V("a"), t)); keywords=Any[kw("laplace", t)]))
            @test same(result, Div(N("1"), Sub(s, V("a"))))
            result = value_expr(run_symbolic(Pw(e, Mul(V("a"), t)); keywords=Any[kw("laplace", t, V("p"))]))
            @test same(result, Div(N("1"), Sub(V("p"), V("a"))))
            # a clash between the result variable and a parameter is an error
            result = run_symbolic(Pw(e, Mul(s, t)); keywords=Any[kw("laplace", t)])
            @test result["status"] == "error" && result["error"]["category"] == "invalid"
            # a numeric base transforms as e^(t ln b)
            @test same(value_expr(run_symbolic(Pw(Add(N("1"), call("sqrt", N("5"))), t); keywords=Any[kw("laplace")])),
                Div(N("1"), Sub(s, call("ln", Add(N("1"), call("sqrt", N("5")))))))
            # invlaplace: s -> t, without the Heaviside factor
            @test same(value_expr(run_symbolic(Div(N("1"), Add(Pw(s, N("2")), N("1"))); keywords=Any[kw("invlaplace")])),
                call("sin", t))
            @test same(value_expr(run_symbolic(Div(N("1"), s); keywords=Any[kw("invlaplace")])), N("1"))
            # round trip
            expr = Mul(t, call("cos", Mul(N("2"), t)))
            back = run_symbolic(expr; keywords=Any[kw("laplace"), kw("invlaplace")])
            @test same(value_expr(back), expr)
            # fourier: F(ω) = ∫ f(t) e^(-iωt) dt
            result = value_expr(run_symbolic(call("exp", Neg(Pw(t, N("2")))); keywords=Any[kw("fourier")]))
            @test same(result, Mul(call("sqrt", V("π")), call("exp", Neg(Div(Pw(ω, N("2")), N("4"))))))
            result = value_expr(run_symbolic(call("exp", Neg(call("abs", t))); keywords=Any[kw("fourier")]))
            @test same(result, Div(N("2"), Add(Pw(ω, N("2")), N("1"))))
            # invfourier: f(t) = 1/(2π) ∫ F(ω) e^(iωt) dω
            expr = Div(N("2"), Add(Pw(ω, N("2")), N("1")))
            result = value_expr(run_symbolic(expr; keywords=Any[kw("invfourier")]))
            @test same(result, call("exp", Neg(call("abs", t))))
            # ztrans: n -> z (unilateral)
            @test same(value_expr(run_symbolic(Pw(V("a"), n); keywords=Any[kw("ztrans")])), Div(z, Sub(z, V("a"))))
            @test same(value_expr(run_symbolic(N("1"); keywords=Any[kw("ztrans")])), Div(z, Sub(z, N("1"))))
            @test same(value_expr(run_symbolic(n; keywords=Any[kw("ztrans")])), Div(z, Pw(Par(Sub(z, N("1"))), N("2"))))
            # invztrans: z -> n; the corpus case 1/(1 - z^-1 - z^-2) is the Fibonacci sequence
            fib = Div(N("1"), Sub(Sub(N("1"), Pw(z, Neg(N("1")))), Pw(z, Neg(N("2")))))
            result = run_symbolic(fib; keywords=Any[kw("invztrans")])
            @test result["status"] == "ok"
            terms = [1, 1, 2, 3, 5, 8, 13]
            for (index, expected) in enumerate(terms)
                @test same(subs_at(value_expr(result), n, N(string(index - 1))), N(string(expected)))
            end
            @test same(value_expr(run_symbolic(Div(z, Sub(z, V("a"))); keywords=Any[kw("invztrans")])), Pw(V("a"), n))
            # a pole at the origin gives a Kronecker delta
            result = value_expr(run_symbolic(Div(N("1"), z); keywords=Any[kw("invztrans")]))
            @test same(subs_at(result, n, N("1")), N("1"))
            @test same(subs_at(result, n, N("2")), N("0"))
            # round trip with ztrans
            expr = Mul(N("3"), Pw(N("2"), n))
            @test same(value_expr(run_symbolic(expr; keywords=Any[kw("ztrans"), kw("invztrans")])), expr)
            # a double pole
            result = value_expr(run_symbolic(Div(z, Pw(Par(Sub(z, N("1"))), N("2"))); keywords=Any[kw("invztrans")]))
            @test same(result, n)
            # an improper transform (non-causal sequence) is not supported
            result = run_symbolic(Pw(z, N("2")); keywords=Any[kw("invztrans")])
            @test result["status"] == "error"
        end

        @testset "SymPy imports restore the assumptions module on its parent" begin
            # Reproduce a cached submodule with a missing parent attribute, as seen in solve.
            bridge = EquavelaKernel.BRIDGE[]
            Base.invokelatest() do
                sympy = bridge.pyimport("sympy")
                assumptions = bridge.pyimport("sympy.assumptions")
                try
                    bridge.pydelattr(sympy, "assumptions")
                    bridge.import_sympy!()
                    @test bridge.pyis(sympy.assumptions, assumptions)
                finally
                    bridge.pysetattr(sympy, "assumptions", assumptions)
                end
            end
        end

        @testset "solve: systems, modifiers and assumptions" begin
            x, y = V("x"), V("y")
            mat(rows, cols, cells...) = Dict{String,Any}("type" => "Matrix", "rows" => rows, "cols" => cols, "cells" => Any[cells...])
            cell(m, i, j) = m["cells"][(i - 1) * m["cols"] + j]
            # a linear system: one solution is a 1×n row (rows are solutions, columns the unknowns)
            system = mat(2, 1, Eqn(Add(x, y), N("3")), Eqn(Sub(x, y), N("1")))
            result = value_expr(run_symbolic(system; keywords=Any[kw("solve", mat(2, 1, x, y))]))
            @test result["type"] == "Matrix" && result["rows"] == 1 && result["cols"] == 2
            @test cell(result, 1, 1) == N("2") && cell(result, 1, 2) == N("1")
            # the unknowns as separate arguments, and expressions equal to zero
            system = mat(2, 1, Sub(Add(x, y), N("3")), Sub(x, y))
            result = value_expr(run_symbolic(system; keywords=Any[kw("solve", x, y)]))
            @test result["rows"] == 1 && result["cols"] == 2
            @test same(cell(result, 1, 1), Div(N("3"), N("2"))) && same(cell(result, 1, 2), Div(N("3"), N("2")))
            # no unknowns named: all the free variables, in name order
            result = value_expr(run_symbolic(system; keywords=Any[kw("solve")]))
            @test result["rows"] == 1 && result["cols"] == 2
            # several solutions: a matrix with one row per solution
            system = mat(2, 1, Eqn(Add(Pw(x, N("2")), Pw(y, N("2"))), N("5")), Eqn(Mul(x, y), N("2")))
            result = value_expr(run_symbolic(system; keywords=Any[kw("solve", mat(2, 1, x, y))]))
            @test result["type"] == "Matrix" && result["rows"] == 4 && result["cols"] == 2
            pairs = sort([(cell(result, i, 1)["type"] == "Num" ? cell(result, i, 1)["text"] : "?",
                           cell(result, i, 2)["type"] == "Num" ? cell(result, i, 2)["text"] : "?") for i in 1:4])
            @test length(pairs) == 4
            # a system with no solution
            system = mat(2, 1, Eqn(Add(x, y), N("1")), Eqn(Add(x, y), N("2")))
            failure = run_symbolic(system; keywords=Any[kw("solve", x, y)])
            @test failure["status"] == "error"
            @test occursin("x, y in the system of 2 equations", failure["error"]["message"])
            # modifiers: real keeps the real solutions, RealRange(a, b) those in the range
            quartic = Eqn(Sub(Pw(x, N("4")), N("1")), N("0"))
            all_roots = value_expr(run_symbolic(quartic; keywords=Any[kw("solve", x)]))
            @test all_roots["rows"] == 4
            real_roots = value_expr(run_symbolic(quartic; keywords=Any[kw("solve", x, V("real"))]))
            @test real_roots["rows"] == 2
            ranged = value_expr(run_symbolic(quartic; keywords=Any[kw("solve", x, call("RealRange", N("0"), N("5")))]))
            @test ranged == N("1")
            complex_roots = value_expr(run_symbolic(quartic; keywords=Any[kw("solve", x, V("complex"))]))
            @test complex_roots["rows"] == 4
            # fully: roots that have no closed form are evaluated numerically
            quintic = Eqn(Sub(Sub(Pw(x, N("5")), x), N("1")), N("0"))
            fully = value_expr(run_symbolic(quintic; keywords=Any[kw("solve", x, V("fully"))]))
            @test fully["rows"] == 5 && all(c -> c["type"] in ("Num", "Neg", "Add", "Sub", "Mul", "Imag"), fully["cells"])
            # assume, x == real / RealRange / integer / even
            expr = call("sqrt", Pw(x, N("2")))
            real_x = value_expr(run_symbolic(expr; keywords=Any[kw("assume", Eqn(x, V("real"))), kw("simplify")]))
            @test real_x == call("abs", x) || real_x["type"] == "Abs"
            ranged_x = value_expr(run_symbolic(expr; keywords=Any[kw("assume", Eqn(x, call("RealRange", N("0"), N("2")))), kw("simplify")]))
            @test ranged_x == x
            integer_x = value_expr(run_symbolic(call("sin", Mul(N("2"), Mul(V("π"), x)));
                keywords=Any[kw("assume", Eqn(x, V("integer"))), kw("simplify")]))
            @test integer_x == N("0")
            # a RealRange assumption restricts solve
            solved = value_expr(run_symbolic(Eqn(Pw(x, N("2")), N("4"));
                keywords=Any[kw("assume", Eqn(x, call("RealRange", N("0"), N("5")))), kw("solve", x)]))
            @test solved == N("2")
            @test run_symbolic(x; keywords=Any[kw("assume", Eqn(x, V("blue")))])["status"] == "error"
        end

        @testset "real and imaginary part operators" begin
            unary(kind, e) = Dict{String,Any}("type" => kind, "expr" => e)
            @test value_expr(run_symbolic(unary("RealPart", N("3")))) == N("3")
            @test value_expr(run_symbolic(unary("ImagPart", N("3")))) == N("0")
            # a symbol keeps the operation, which SymPy writes as re/im
            @test run_symbolic(unary("RealPart", V("x")))["status"] == "ok"
            # the polar form r·e^(i·θ): 2∠0 is 2
            polar = Dict{String,Any}("type" => "Polar", "left" => N("2"), "right" => N("0"))
            @test value_expr(run_symbolic(polar)) == N("2")
            # the gradient: ∇[x, y] x·y is the column [y; x]
            grad = Dict{String,Any}("type" => "Gradient",
                "vars" => Any[Dict{String,Any}("name" => nm("x")), Dict{String,Any}("name" => nm("y"))],
                "body" => Mul(V("x"), V("y")))
            result = value_expr(run_symbolic(grad))
            @test result["type"] == "Matrix" && result["rows"] == 2 && result["cols"] == 1
        end

        @testset "rewrite, combine, confrac, rectangular, factor complex" begin
            x = V("x")
            # rewrite
            result = value_expr(run_symbolic(call("tan", x); keywords=Any[kw("rewrite", V("sincos"))]))
            @test same(result, Div(call("sin", x), call("cos", x)))
            @test result["type"] == "Div"
            result = value_expr(run_symbolic(call("cos", x); keywords=Any[kw("rewrite", V("exp"))]))
            @test same(result, call("cos", x)) && result["type"] != "Call"
            result = value_expr(run_symbolic(call("sinh", x); keywords=Any[kw("rewrite", V("exp"))]))
            @test same(result, call("sinh", x)) && result["type"] != "Call"
            result = value_expr(run_symbolic(call("asin", x); keywords=Any[kw("rewrite", V("ln"))]))
            @test result["type"] != "Call"
            result = value_expr(run_symbolic(call("Gamma", Add(x, N("1"))); keywords=Any[kw("rewrite", V("fact"))]))
            @test result["type"] == "Factorial"
            @test run_symbolic(x; keywords=Any[kw("rewrite")])["status"] == "error"
            @test run_symbolic(x; keywords=Any[kw("rewrite", V("nonsense"))])["error"]["category"] == "unsupported"
            # combine
            expr = Add(Div(N("1"), x), Div(N("1"), Add(x, N("1"))))
            result = value_expr(run_symbolic(expr; keywords=Any[kw("combine")]))
            @test same(result, expr) && result["type"] == "Div"
            expr = Mul(Pw(V("e"), x), Pw(V("e"), V("y")))
            result = value_expr(run_symbolic(expr; keywords=Any[kw("combine", V("exp"))]))
            @test result == Pw(V("e"), Add(x, V("y"))) || result == Pw(V("e"), Add(V("y"), x))
            expr = Add(call("ln", x), call("ln", V("y")))
            result = value_expr(run_symbolic(expr; keywords=Any[kw("combine", V("ln"))]))
            @test result == call("ln", Mul(x, V("y"))) || result == call("ln", Mul(V("y"), x))
            expr = Mul(call("sin", x), call("cos", V("y")))
            result = value_expr(run_symbolic(expr; keywords=Any[kw("combine", V("sincos"))]))
            @test same(result, expr) && result["type"] in ("Div", "Add", "Sub", "Mul")
            @test value_expr(run_symbolic(expr; keywords=Any[kw("combine", V("sincos"))]))["type"] != "Mul"
            # confrac: terms of a rational number, π with a term count, a rational function
            result = value_expr(run_symbolic(Div(N("415"), N("93")); keywords=Any[kw("confrac")]))
            @test result["type"] == "Add" && result["left"] == N("4")
            frac = EquavelaKernel._bridge_call(:equivalent, result, Div(N("415"), N("93")))
            @test frac
            pi_result = value_expr(run_symbolic(V("π"); keywords=Any[kw("confrac", N("4"))]))
            @test pi_result["type"] == "Add" && pi_result["left"] == N("3")
            @test abs(parse(Float64, value_expr(run_symbolic(pi_result; keywords=Any[kw("float", N("8"))]))["text"]) - π) < 1e-3
            rational_function = Div(Add(Pw(x, N("2")), N("1")), Add(x, N("1")))
            result = value_expr(run_symbolic(rational_function; keywords=Any[kw("confrac", x)]))
            @test same(result, rational_function)
            @test run_symbolic(N("1"); keywords=Any[kw("confrac"), kw("simplify")])["status"] == "error"
            # rectangular
            expr = Pw(Par(Add(N("1"), Dict{String,Any}("type" => "Imag", "text" => "1", "symbol" => "i"))), N("2"))
            @test value_expr(run_symbolic(expr; keywords=Any[kw("rectangular")])) ==
                  Dict{String,Any}("type" => "Imag", "text" => "2", "symbol" => "i")
            result = value_expr(run_symbolic(Mul(Dict{String,Any}("type" => "Imag", "text" => "1", "symbol" => "i"), x);
                keywords=Any[kw("assume", Eqn(x, V("real"))), kw("rectangular")]))
            @test same(result, Mul(Dict{String,Any}("type" => "Imag", "text" => "1", "symbol" => "i"), x))
            # without an assumption the variables are real, as the reference application: e^(i·x) is cos(x) + i·sin(x)
            imag1 = Dict{String,Any}("type" => "Imag", "text" => "1", "symbol" => "i")
            result = value_expr(run_symbolic(Pw(V("e"), Mul(imag1, x)); keywords=Any[kw("rectangular")]))
            @test same(result, Add(call("cos", x), Mul(imag1, call("sin", x))))
            # factor over the complex numbers
            result = value_expr(run_symbolic(Add(Pw(x, N("2")), N("1")); keywords=Any[kw("factor", V("complex"))]))
            @test result["type"] == "Mul"
            @test value_expr(run_symbolic(Add(Pw(x, N("2")), N("1")); keywords=Any[kw("factor")]))["type"] == "Add"
        end

        @testset "calculus constructs" begin
            x = V("x")
            integral = Dict{String,Any}("type" => "Integral", "var" => Dict{String,Any}("name" => nm("x")),
                "bounds" => nothing, "algorithm" => nothing, "body" => Mul(x, Pw(V("e"), x)))
            result = run_symbolic(integral)
            @test same(value_expr(result), Mul(Sub(x, N("1")), Pw(V("e"), x)))
            definite = Dict{String,Any}("type" => "Integral", "var" => Dict{String,Any}("name" => nm("x")),
                "bounds" => Dict{String,Any}("lo" => N("0"), "hi" => N("1")), "algorithm" => nothing, "body" => Pw(x, N("2")))
            @test value_expr(run_symbolic(definite)) == Div(N("1"), N("3"))
            for kind in ("Integral", "Deriv", "Partial", "Sum", "Prod", "Limit")
                draft = Dict{String,Any}("type" => kind,
                    "var" => Dict{String,Any}("name" => Dict{String,Any}("segments" => [], "label" => nothing)),
                    "bounds" => Dict{String,Any}("lo" => N("0"), "hi" => N("1")),
                    "order" => nothing, "target" => N("0"), "side" => "both", "body" => x)
                incomplete = run_symbolic(draft)
                @test incomplete["status"] == "error"
                @test incomplete["error"]["category"] == "invalid"
                @test occursin("incomplete", incomplete["error"]["message"])
            end
            missing_keyword = run_symbolic(x; keywords=Any[kw("", x)])
            @test missing_keyword["status"] == "error"
            @test occursin("incomplete", missing_keyword["error"]["message"])
            limit = Dict{String,Any}("type" => "Limit", "var" => Dict{String,Any}("name" => nm("x")),
                "target" => N("0"), "side" => "both", "body" => Div(call("sin", x), x))
            @test value_expr(run_symbolic(limit)) == N("1")
            sum_ = Dict{String,Any}("type" => "Sum", "var" => Dict{String,Any}("name" => nm("k")),
                "bounds" => Dict{String,Any}("lo" => N("1"), "hi" => N("4")), "body" => V("k"))
            @test value_expr(run_symbolic(sum_)) == N("10")
            # f'(x)
            f = defn("f", Pw(x, N("3")); params=["x"])
            prime = Dict{String,Any}("type" => "Call",
                "callee" => Dict{String,Any}("type" => "PrimeDeriv", "function" => V("f"), "order" => 1),
                "args" => Any[Dict{String,Any}("type" => "Expr", "expr" => V("t"))])
            @test same(value_expr(run_symbolic(prime; definitions=Any[f])), Mul(N("3"), Pw(V("t"), N("2"))))
        end

        @testset "matrices" begin
            m = Dict{String,Any}("type" => "Matrix", "rows" => 2, "cols" => 2,
                "cells" => Any[V("a"), N("2"), N("3"), V("x")])
            result = value_expr(run_symbolic(Dict{String,Any}("type" => "Det", "expr" => m)))
            @test same(result, Sub(Mul(V("a"), V("x")), N("6")))
            result = value_expr(run_symbolic(Dict{String,Any}("type" => "Transpose", "expr" => m)))
            @test result["type"] == "Matrix" && result["cells"][2] == N("3")
            result = value_expr(run_symbolic(Mul(m, m)))
            @test result["type"] == "Matrix" && length(result["cells"]) == 4
        end

        @testset "errors are results" begin
            for word in ("cauchy", "decomp", "explicit", "fully", "standard", "using")
                result = run_symbolic(N("1"); keywords=Any[kw(word)])
                @test result["status"] == "error" && result["error"]["category"] == "unsupported"
            end
            result = run_symbolic(N("1"); keywords=Any[kw("frobnicate")])
            @test result["error"]["category"] == "unknown_keyword"
            result = run_symbolic(Dict{String,Any}("type" => "Str", "text" => "s"))
            @test result["error"]["category"] == "unsupported"
            result = run_symbolic(Dict{String,Any}("type" => "Placeholder"))
            @test result["error"]["category"] == "invalid"
            result = run_symbolic(V("x"); keywords=Any[kw("solve", N("3"))])
            @test result["error"]["category"] == "invalid"
            # an undefined function stays a call
            @test value_expr(run_symbolic(call("g", V("x")))) == call("g", V("x"))
        end

        @testset "round trips: SymPy output is read back as the same mathematics" begin
            x = V("x")
            cases = [
                Div(Add(x, N("1")), Sub(x, N("2"))),
                Mul(Pw(x, N("2")), call("sin", x)),
                Add(Div(N("1"), N("3")), Mul(N("2"), x)),
                Pw(Add(x, N("1")), Div(N("3"), N("2"))),
                call("ln", Add(x, N("1"))),
                Div(call("cos", x), Pw(x, N("2"))),
                Neg(Mul(N("3"), x)),
                Sub(Mul(Pw(V("e"), x), call("sin", x)), call("cosh", x)),
            ]
            for case in cases
                @test round_trips(case)
            end
        end

        @testset "the request through serve" begin
            body = JSON3.write(Dict("jsonrpc" => "2.0", "id" => 1, "method" => "symbolic",
                "params" => Dict("expr" => Add(N("2"), N("3")))))
            out = IOBuffer()
            EquavelaKernel.serve(IOBuffer(body * "\n"), out)
            response = JSON3.read(String(take!(out)))
            @test response.result.status == "ok"
            @test response.result.value.expr.text == "5"
            @test response.result.value.type == "symbolic"
        end
    end
end

@testset "a stale CondaPkg lock is removed, a live one is kept" begin
    mktempdir() do project
        meta = joinpath(project, ".CondaPkg")
        mkpath(meta)
        lockfile = joinpath(meta, "lock")
        # no lock
        @test !EquavelaKernel._remove_stale_condapkg_lock!(project)
        # held by this process: kept
        write(lockfile, "$(getpid()) $(gethostname())")
        @test !EquavelaKernel._remove_stale_condapkg_lock!(project)
        @test isfile(lockfile)
        # another host: cannot be inspected, kept
        write(lockfile, "4000000000 some-other-host")
        @test !EquavelaKernel._remove_stale_condapkg_lock!(project)
        @test isfile(lockfile)
        # garbage: kept
        write(lockfile, "not a pidfile")
        @test !EquavelaKernel._remove_stale_condapkg_lock!(project)
        # a dead pid on this host (a short-lived child), read-only as found on the machine: removed
        pid = open(process -> read(process, String), `$(Base.julia_cmd()) --startup-file=no -e "print(getpid())"`)
        write(lockfile, "$pid $(gethostname())")
        chmod(lockfile, 0o444)
        @test EquavelaKernel._remove_stale_condapkg_lock!(project)
        @test !isfile(lockfile)
    end
end
