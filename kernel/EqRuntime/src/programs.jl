# the reference application programs: the runtime API that generated code calls.
# The Rust code generator (later) emits plain Julia
# control flow plus the helpers below; all reference-specific semantics live
# here. test/programs.jl contains hand-written Julia that
# mimics the emitted code and is the executable form of this contract.
#
# ---------------------------------------------------------------- the contract
#
# Shape. A program that defines a function is a Julia `function`. A program
# nested in an expression is an immediately called closure
# `(() -> begin ... end)()`; `return` leaves exactly that program.
# `if`/`for`/`while` bodies and `try`
# bodies are plain Julia blocks, never closures, so `return`, `break` and
# `continue` work in them.
#
# Locals. Every name a program assigns (`x <- e`, `x[i] <- e`, destructuring
# targets, loop variables, the function name of `f(x) <- e`) is declared once at
# the top as `local x = nothing`,
# one declaration per line (`local a = nothing, b = nothing` parses as a tuple).
# `local` is required: in a closure a bare `x = ...` would write to a variable
# of the enclosing program, and Julia's soft scope would make an assignment
# inside `for`/`if` private to that block, while the specification says a local is visible
# after the block in which it was made. `nothing` means "not defined yet".
#   - the first `x[i] <- v` on `nothing` creates the array;
#   - a read that may happen before any assignment (assigned only inside an
#     `if`/loop) is emitted as `eq_local(x, "x")`, which raises "x is
#     undefined" (an EqError, catchable by `try`) instead of a Julia MethodError;
#   - a read of a local that has the name of a sheet variable and may happen
#     before its assignment (`X <- X + 1`, or a read after an assignment made
#     only inside an `if`/loop) is `eq_local_or(X, X_sheet)`: the local once it
#     is assigned, the sheet value before; the generator renames the
#     sheet variable it captures. The local starts as `nothing`, so an element
#     assignment (`X[0] <- v`) starts a new array.
#
# Value tracking. Every statement that evaluates an
# expression is emitted `__v = <expr>`; `x <- e` is `__v = (x = e)`; a string
# statement is `__v = "text"`. `if` and loops leave `__v` unchanged when their
# body does not run, so a program ending with a false `if`, or with a loop whose
# body never ran, returns the last value evaluated before it. Conditions and
# loop sources are not statements and do not set `__v`. The program ends with
# `return eq_result(__v)`, which raises when nothing was evaluated (`__v ===
# nothing`). An empty body (`if` without a statement, loop without an
# expression) is a compile-time error for the generator, not a runtime check.
# `return e` is a plain Julia `return e` (no `eq_result`).
#
# Statements.
#   x <- e `__v = (x = eq_val(e))` when `e` can alias an array (a
#                      bare name, an indexed element, anything that is not a
#                      call or operator result); plain `e` otherwise.
#   x[i] <- e `__v = (x = eq_setindex!(x, e, i))`, `x[i, j]` likewise.
#                      Growth and zero fill are those of the sheet.
#                      Nested `(x[i])[j] <- e`: `inner = eq_val(eq_index(x, i));
#                      inner = eq_setindex!(inner, e, j); x = eq_setindex!(x, inner, i)`.
#   x<j> <- e `x = eq_setcol!(x, e, j)`; rows with `eq_setrow!`.
#   [a, b[0]] <- e `t1, t2 = eq_unpack(e, rows, cols)`, then assign each target
#                      in reading order.
#   [a, [b; c]] <- e nested destructuring: a cell
#                      that is itself a matrix unpacks the value the outer level handed it, so a
#                      nested array is taken apart one `eq_unpack` per level. Each level
#                      checks its own shape with `eq_unpack`'s two errors -- the value is not an
#                      array, or its size is not the shape written in the text -- and
#                      the last cell in reading order carries the value of the statement.
#   f(x) <- e a local function. The name is a local like any other,
#                      declared `local f = nothing` at the top, and the body is a
#                      closure assigned to it: `f = (x) -> e`, or
#                      `f = function (x) ... end` when the body is a nested program
#                      (the head's parameters are then the program's locals). The body
#                      runs only when the function is called, sees the locals of the
#                      program, and a call inside it reads the same local, so recursion
#                      works. The statement sets no `__v`.
#   parameters a parameter the body assigns into is copied on entry
#                      (`L = eq_val(L)`): arguments are by value.
#   if / else if / else
#                      `if eq_true(c1) ... elseif eq_true(c2) ... else ... end`.
#   if / also if / else
#                      a flag: `__ran = false; if eq_true(c1); __ran = true; ...;
#                      end; if eq_true(c2); __ran = true; ...; end;
#                      if !__ran; <else body>; end`.
#   for i in src `for __i in eq_for_items(src); i = __i; ...; end`. The copy
#                      out keeps the last value after the loop and
#                      `local i` was declared at the top. `src` is `eq_range(a, b)`
#                      / `eq_range(a, next, b)` (a range variable of the sheet
#                      is just the EqRange value), or any vector/matrix value.
#                      Ranges iterate ascending or descending and are empty
#                      when the step opposes the end; a matrix
#                      iterates its elements row by row, a column
#                      vector its elements; the source is snapshotted, so the
#                      body may assign into it without changing the iteration.
#   while c `while eq_true(c) ... end`.
#   break / continue Julia `break` / `continue`. Outside
#                      a loop the generator emits `eq_error("break
#                      outside a loop")` as the statement instead.
#   try / on error expression-only body: `eq_try(() -> body, () -> handler)`.
#                      Body or handler containing `return`/`break`/`continue`.
#                      the inline form, which keeps them working.
#                        __v = try
#                            <body statements, last value>
#                        catch __e
#                            eq_caught(__e)
#                            <handler statements, last value>
#                        end
#                      `eq_caught` re-throws interrupts so a user
#                      interrupt is never swallowed; every other Exception, Julia
#                      ones included (bounds, domain, singular), is a reference application
#                      error.
#   error("text") `eq_error("text")`; catchable by `try`.
#   lazy operands `eq_and(a, () -> b)`, `eq_or(a, () -> b)`,
#                      `eq_if(c, () -> a, () -> b)` as in semantics.jl.
#
# Error location. The generator keeps `__s = <statement id>` updated
# before each statement of a program and wraps the body.
#     try ... catch __e; throw(eq_locate(__e, __s)); end
# `eq_locate` returns an EqError carrying the statement id (an error already
# located is kept, so a nested program reports the statement where it
# happened). `return` inside the `try` body is fine in Julia.
#
# Workworksheet level. An indexed assignment on the sheet (`x[2] := 7`) uses
# `eq_sheet_setindex!`, which differs from the program form only by .
# a defined scalar is an error. Inside programs a local scalar is promoted to
# a 1x1 array.

"""
    eq_result(v)

Final value of a program. `v` is the tracked `__v`; `nothing` means no
expression was evaluated, which is an error.
"""
eq_result(value) =
    value === nothing ? eqerror("the program did not evaluate any expression") : value

"""
    eq_for_items(source)

Iteration source of a reference application `for`: a range variable as is, a matrix or row
vector as its elements row by row, a column vector as its elements.
Arrays are copied, so assigning into the source in the loop body does not change
the iteration. A scalar iterates once (spec silent).
"""
eq_for_items(range::EqRange) = range
eq_for_items(matrix::AbstractMatrix) = collect(vec(permutedims(matrix)))
eq_for_items(value::Number) = (value,)
eq_for_items(::Nothing) = eqerror("the loop source is not defined")
eq_for_items(::Any) = eqerror("a loop needs a range, a vector or a matrix")

"""
    eq_local(value, name)

Read of a local that may not be assigned yet (`nothing`): raises "name is
undefined" instead of letting `nothing` flow into an operator.
"""
eq_local(value, name) = value === nothing ? eqerror("$name is undefined") : value

"""
    eq_local_or(value, sheet)

Read of a local that has the name of a sheet variable and may not be assigned yet:
the local once the program has assigned it, the sheet value before. The
local itself starts as `nothing`, so an element assignment never copies the sheet
array into it.
"""
eq_local_or(value, sheet) = value === nothing ? eq_val(sheet) : value

"`error(\"text\")`."
eq_error(message) =
    message isa AbstractString ? eqerror(message) : eqerror("error() needs a string")

"""
    eq_caught(exception)

First line of the `catch` block of an inline `try`/`on error`: interrupts
propagate, everything else is an evaluation error that the `on error` body
handles.
"""
eq_caught(exception) = exception isa InterruptException ? throw(exception) : nothing

"""
    eq_try(body, handler)

`try`/`on error` for expression-only bodies. Bodies with `return`, `break` or
`continue` use the inline form instead (see the contract above).
"""
function eq_try(body, handler)
    try
        return body()
    catch exception
        eq_caught(exception)
    end
    handler()
end

"""
    eq_locate(exception, statement)

The exception to throw from a program's catch-all: an `EqError` tagged with the
statement id. Interrupts and already located errors pass unchanged.
"""
eq_locate(exception::InterruptException, ::Integer) = exception
eq_locate(exception::EqError, statement::Integer) =
    exception.statement === nothing ? EqError(exception.message, Int(statement)) : exception
eq_locate(exception::Exception, statement::Integer) =
    EqError(sprint(showerror, exception), Int(statement))

"""
    eq_sheet_setindex!(target, value, indices...)

Indexed assignment at worksheet level (`x[i] := e`): like `eq_setindex!`, but a
defined scalar target is an error. An undefined target is `nothing`.
"""
function eq_sheet_setindex!(target, value, indices...)
    target === nothing || target isa AbstractMatrix ||
        eqerror("cannot assign an element of a scalar")
    eq_setindex!(target, value, indices...)
end
