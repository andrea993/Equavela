# Expression type inspection and SI base-unit extraction.
eq_isfunction(value) = _boolean(value isa Function)
eq_isrange(value) = _boolean(value isa EqRange)

function eq_siunitsof(value)
    value isa Number && iszero(imag(value)) || eqerror("SIUnitsOf needs a real scalar")
    if value isa Unitful.AbstractQuantity
        dimension(value) == NoDims && return 1.0
        return oneunit(upreferred(value))
    end
    1.0
end
