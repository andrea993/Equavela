# Random-number built-ins. The generator belongs
# to the kernel process: every draw advances it, a kernel restart seeds it from the current Unix
# timestamp, and each call is serialized by a lock because regions may be evaluated from several tasks.

import Distributions
import Random

# Bootstrap state only. __init__ replaces this at runtime, including sysimage startup.
const _RANDOM = Ref(Random.Xoshiro(1))
const _RANDOM_LOCK = ReentrantLock()
const _RANDOM_SEED = Ref{Int}(1)

function _reset_random!(seed::Integer = floor(Int, time() * 1_000_000))
    lock(_RANDOM_LOCK) do
        previous = _RANDOM_SEED[]
        _RANDOM[] = Random.Xoshiro(seed)
        _RANDOM_SEED[] = seed
        previous
    end
end

"Reset the shared random stream and return its previously configured seed."
function eq_Seed(value)
    seed = _dist_integer(value, "Seed", "seed"; minimum=1)
    seed <= 2147483647 || eqerror("Seed: seed must be between 1 and 2147483647")
    _reset_random!(seed)
end

function __init__()
    _reset_random!()
end

"A unitless real number: dimensioned quantities are errors, dimensionless ones are converted."
function _unitless_real(value, name)
    number = _plain(value, name)
    imag(number) == 0 || eqerror("$name needs a real number")
    Float64(real(number))
end

"""
`rnorm(m, μ, σ)`: an `m x 1` vector of independent random numbers from the normal distribution
with mean `μ` and standard deviation `σ`. `m` is a unitless integer > 0,
`μ` a real mean, `σ` a real standard deviation > 0, all unitless. The values are not the ones
the reference application produces; only the distribution is promised.
"""
function eq_rnorm(count, mean_value, deviation)
    _is_integer_value(count) && real(count) > 0 ||
        eqerror("rnorm: the number of values must be a positive integer")
    values = Int(real(count))
    μ = _unitless_real(mean_value, "rnorm")
    σ = _unitless_real(deviation, "rnorm")
    σ > 0 || eqerror("rnorm: the standard deviation must be positive")
    distribution = Distributions.Normal(μ, σ)
    draws = lock(_RANDOM_LOCK) do
        rand(_RANDOM[], distribution, values)
    end
    reshape(draws, :, 1)
end

"""A unitless uniform scalar between zero and `bound`."""
function eq_rnd(bound)
    limit = _unitless_real(bound, "rnd")
    isfinite(limit) || eqerror("rnd: the bound must be finite")
    lock(_RANDOM_LOCK) do
        value = rand(_RANDOM[]) * limit
        # Scaling can round to the excluded endpoint for subnormal bounds.
        if limit > 0
            return min(value, prevfloat(limit))
        elseif limit < 0
            return max(value, nextfloat(limit))
        end
        value
    end
end
