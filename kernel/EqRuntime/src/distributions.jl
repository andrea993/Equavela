# the reference application probability distribution functions.
# The parameterizations and support rules follow the vendor the reference application help.

function _dist_real(value, function_name, argument_name)
    x = _unitless_real(value, function_name)
    isfinite(x) || eqerror("$function_name: $argument_name must be finite")
    x
end

function _dist_integer(value, function_name, argument_name; minimum=nothing)
    x = _dist_real(value, function_name, argument_name)
    int_limit = 2.0^(8sizeof(Int) - 1)
    isinteger(x) && -int_limit <= x < int_limit ||
        eqerror("$function_name: $argument_name must be an integer")
    result = Int(x)
    minimum === nothing || result >= minimum ||
        eqerror("$function_name: $argument_name is outside its valid range")
    result
end

function _dist_probability(value, function_name)
    p = _dist_real(value, function_name, "probability")
    0 <= p <= 1 || eqerror("$function_name: probability must be between 0 and 1")
    p
end

function _dist_positive(value, function_name, argument_name)
    x = _dist_real(value, function_name, argument_name)
    x > 0 || eqerror("$function_name: $argument_name must be positive")
    x
end

function _dist_density(distribution, x, function_name)
    _elementwise_map(x) do value
        Distributions.pdf(distribution, _dist_real(value, function_name, "x"))
    end
end

function _dist_cdf(distribution, x, function_name)
    _elementwise_map(x) do value
        Distributions.cdf(distribution, _dist_real(value, function_name, "x"))
    end
end

function _dist_quantile(distribution, p, function_name)
    Distributions.quantile(distribution, _dist_probability(p, function_name))
end

function _dist_random(distribution, count, function_name)
    n = _dist_integer(count, function_name, "number of values"; minimum=1)
    draws = lock(_RANDOM_LOCK) do
        rand(_RANDOM[], distribution, n)
    end
    reshape(Float64.(draws), n, 1)
end

function _dist_discrete_pdf(distribution, x, function_name)
    _elementwise_map(x) do item
        value = _dist_real(item, function_name, "x")
        isinteger(value) ? Distributions.pdf(distribution, value) : 0.0
    end
end

function _dist_discrete_cdf(distribution, x, function_name)
    _elementwise_map(x) do item
        value = _dist_real(item, function_name, "x")
        Distributions.cdf(distribution, floor(value))
    end
end

function _dist_trials_success(q, function_name)
    p = _dist_real(q, function_name, "q")
    0 <= p <= 1 || eqerror("$function_name: q must be between 0 and 1")
    p
end

# Beta(s1,s2)
eq_dbeta(x, s1, s2) = _dist_density(Distributions.Beta(_dist_positive(s1, "dbeta", "s1"), _dist_positive(s2, "dbeta", "s2")), x, "dbeta")
eq_pbeta(x, s1, s2) = _dist_cdf(Distributions.Beta(_dist_positive(s1, "pbeta", "s1"), _dist_positive(s2, "pbeta", "s2")), x, "pbeta")
eq_qbeta(p, s1, s2) = _dist_quantile(Distributions.Beta(_dist_positive(s1, "qbeta", "s1"), _dist_positive(s2, "qbeta", "s2")), p, "qbeta")
eq_rbeta(m, s1, s2) = _dist_random(Distributions.Beta(_dist_positive(s1, "rbeta", "s1"), _dist_positive(s2, "rbeta", "s2")), m, "rbeta")

# Binomial(n trials, q success probability).
function _binomial(n, q, name)
    trials = _dist_integer(n, name, "n"; minimum=0)
    probability = _dist_trials_success(q, name)
    Distributions.Binomial(trials, probability)
end
eq_dbinom(k, n, q) = _dist_discrete_pdf(_binomial(n, q, "dbinom"), k, "dbinom")
eq_pbinom(k, n, q) = _dist_discrete_cdf(_binomial(n, q, "pbinom"), k, "pbinom")
eq_qbinom(p, n, q) = _dist_quantile(_binomial(n, q, "qbinom"), p, "qbinom")
eq_rbinom(m, n, q) = _dist_random(_binomial(n, q, "rbinom"), m, "rbinom")

# Cauchy(location l, scale s).
eq_dcauchy(x, l, s) = _dist_density(Distributions.Cauchy(_dist_real(l, "dcauchy", "l"), _dist_positive(s, "dcauchy", "s")), x, "dcauchy")
eq_pcauchy(x, l, s) = _dist_cdf(Distributions.Cauchy(_dist_real(l, "pcauchy", "l"), _dist_positive(s, "pcauchy", "s")), x, "pcauchy")
eq_qcauchy(p, l, s) = _dist_quantile(Distributions.Cauchy(_dist_real(l, "qcauchy", "l"), _dist_positive(s, "qcauchy", "s")), p, "qcauchy")
eq_rcauchy(m, l, s) = _dist_random(Distributions.Cauchy(_dist_real(l, "rcauchy", "l"), _dist_positive(s, "rcauchy", "s")), m, "rcauchy")

# Chi-square(d degrees of freedom).
eq_dchisq(x, d) = _dist_density(Distributions.Chisq(_dist_positive(d, "dchisq", "d")), x, "dchisq")
eq_pchisq(x, d) = _dist_cdf(Distributions.Chisq(_dist_positive(d, "pchisq", "d")), x, "pchisq")
eq_qchisq(p, d) = _dist_quantile(Distributions.Chisq(_dist_positive(d, "qchisq", "d")), p, "qchisq")
eq_rchisq(m, d) = _dist_random(Distributions.Chisq(_dist_positive(d, "rchisq", "d")), m, "rchisq")

# Exponential takes the reference application's rate r; Distributions.jl takes scale θ=1/r.
function _exponential(r, name)
    Distributions.Exponential(inv(_dist_positive(r, name, "r")))
end
eq_dexp(x, r) = _dist_density(_exponential(r, "dexp"), x, "dexp")
eq_pexp(x, r) = _dist_cdf(_exponential(r, "pexp"), x, "pexp")
eq_qexp(p, r) = _dist_quantile(_exponential(r, "qexp"), p, "qexp")
eq_rexp(m, r) = _dist_random(_exponential(r, "rexp"), m, "rexp")

# F distribution(d1,d2).
function _fdist(d1, d2, name)
    Distributions.FDist(_dist_positive(d1, name, "d1"), _dist_positive(d2, name, "d2"))
end
eq_dF(x, d1, d2) = _dist_density(_fdist(d1, d2, "dF"), x, "dF")
eq_pF(x, d1, d2) = _dist_cdf(_fdist(d1, d2, "pF"), x, "pF")
eq_qF(p, d1, d2) = _dist_quantile(_fdist(d1, d2, "qF"), p, "qF")
eq_rF(m, d1, d2) = _dist_random(_fdist(d1, d2, "rF"), m, "rF")

# the reference application gamma is unit-scale with shape s.
function _gamma_shape(s, name)
    Distributions.Gamma(_dist_positive(s, name, "s"), 1.0)
end
eq_dgamma(x, s) = _dist_density(_gamma_shape(s, "dgamma"), x, "dgamma")
eq_pgamma(x, s) = _dist_cdf(_gamma_shape(s, "pgamma"), x, "pgamma")
eq_qgamma(p, s) = _dist_quantile(_gamma_shape(s, "qgamma"), p, "qgamma")
eq_rgamma(m, s) = _dist_random(_gamma_shape(s, "rgamma"), m, "rgamma")

# the reference application's geometric formula is q(1-q)^k. This is Julia's failures-count convention;
# the vendor page's prose says k > 0, but its displayed formula and support wording leave
# the zero offset unclear, so this implementation follows the standard formula.
function _geometric(q, name)
    probability = _dist_trials_success(q, name)
    probability > 0 || eqerror("$name: q must be greater than 0")
    Distributions.Geometric(probability)
end
function eq_dgeom(k, q)
    distribution = _geometric(q, "dgeom")
    _elementwise_map(k) do item
        value = _dist_real(item, "dgeom", "k")
        isinteger(value) ? Distributions.pdf(distribution, value) : 0.0
    end
end
function eq_pgeom(k, q)
    distribution = _geometric(q, "pgeom")
    _elementwise_map(k) do item
        value = _dist_real(item, "pgeom", "k")
        Distributions.cdf(distribution, floor(value))
    end
end
eq_qgeom(p, q) = _dist_quantile(_geometric(q, "qgeom"), p, "qgeom")
eq_rgeom(m, q) = _dist_random(_geometric(q, "rgeom"), m, "rgeom")

# Hypergeometric(a successes, b failures, n draws), evaluated at m successes.
function _hypergeom(a, b, n, name)
    successes = _dist_integer(a, name, "a"; minimum=0)
    failures = _dist_integer(b, name, "b"; minimum=0)
    draws = _dist_integer(n, name, "n"; minimum=0)
    population = Int128(successes) + Int128(failures)
    population <= typemax(Int) || eqerror("$name: a + b exceeds the supported integer range")
    Int128(draws) <= population || eqerror("$name: n cannot exceed a + b")
    Distributions.Hypergeometric(successes, failures, draws)
end
eq_dhypergeom(m, a, b, n) = _dist_discrete_pdf(_hypergeom(a, b, n, "dhypergeom"), m, "dhypergeom")
eq_phypergeom(m, a, b, n) = _dist_discrete_cdf(_hypergeom(a, b, n, "phypergeom"), m, "phypergeom")
eq_qhypergeom(p, a, b, n) = _dist_quantile(_hypergeom(a, b, n, "qhypergeom"), p, "qhypergeom")
eq_rhypergeom(m, a, b, n) = _dist_random(_hypergeom(a, b, n, "rhypergeom"), m, "rhypergeom")

# Lognormal(log-space mean μ, standard deviation σ).
function _lognormal(mu, sigma, name)
    Distributions.LogNormal(_dist_real(mu, name, "μ"), _dist_positive(sigma, name, "σ"))
end
eq_dlnorm(x, μ, σ) = _dist_density(_lognormal(μ, σ, "dlnorm"), x, "dlnorm")
eq_plnorm(x, μ, σ) = _dist_cdf(_lognormal(μ, σ, "plnorm"), x, "plnorm")
eq_qlnorm(p, μ, σ) = _dist_quantile(_lognormal(μ, σ, "qlnorm"), p, "qlnorm")
eq_rlnorm(m, μ, σ) = _dist_random(_lognormal(μ, σ, "rlnorm"), m, "rlnorm")

# Logistic(location l, scale s).
function _logistic(l, s, name)
    Distributions.Logistic(_dist_real(l, name, "l"), _dist_positive(s, name, "s"))
end
eq_dlogis(x, l, s) = _dist_density(_logistic(l, s, "dlogis"), x, "dlogis")
eq_plogis(x, l, s) = _dist_cdf(_logistic(l, s, "plogis"), x, "plogis")
eq_qlogis(p, l, s) = _dist_quantile(_logistic(l, s, "qlogis"), p, "qlogis")
eq_rlogis(m, l, s) = _dist_random(_logistic(l, s, "rlogis"), m, "rlogis")

# Negative binomial n is the number of successes; k counts preceding failures.
function _negative_binomial(n, q, name)
    successes = _dist_integer(n, name, "n"; minimum=1)
    probability = _dist_trials_success(q, name)
    probability > 0 || eqerror("$name: q must be greater than 0")
    Distributions.NegativeBinomial(successes, probability)
end
eq_dnbinom(k, n, q) = _dist_discrete_pdf(_negative_binomial(n, q, "dnbinom"), k, "dnbinom")
eq_pnbinom(k, n, q) = _dist_discrete_cdf(_negative_binomial(n, q, "pnbinom"), k, "pnbinom")
eq_qnbinom(p, n, q) = _dist_quantile(_negative_binomial(n, q, "qnbinom"), p, "qnbinom")
eq_rnbinom(m, n, p) = _dist_random(_negative_binomial(n, p, "rnbinom"), m, "rnbinom")

# Normal density/CDF/quantile; random form is already implemented in random.jl.
function _normal(mu, sigma, name)
    Distributions.Normal(_dist_real(mu, name, "μ"), _dist_positive(sigma, name, "σ"))
end
eq_dnorm(x, μ, σ) = _dist_density(_normal(μ, σ, "dnorm"), x, "dnorm")
eq_pnorm(x, μ, σ) = _dist_cdf(_normal(μ, σ, "pnorm"), x, "pnorm")
eq_qnorm(p, μ, σ) = _dist_quantile(_normal(μ, σ, "qnorm"), p, "qnorm")

# Poisson(lambda).
function _poisson(lambda, name)
    Distributions.Poisson(_dist_positive(lambda, name, "λ"))
end
eq_dpois(k, λ) = _dist_discrete_pdf(_poisson(λ, "dpois"), k, "dpois")
eq_ppois(k, λ) = _dist_discrete_cdf(_poisson(λ, "ppois"), k, "ppois")
eq_qpois(p, λ) = _dist_quantile(_poisson(λ, "qpois"), p, "qpois")
eq_rpois(m, λ) = _dist_random(_poisson(λ, "rpois"), m, "rpois")

# Student's t(d degrees of freedom).
function _tdist(d, name)
    Distributions.TDist(_dist_positive(d, name, "d"))
end
eq_dt(x, d) = _dist_density(_tdist(d, "dt"), x, "dt")
eq_pt(x, d) = _dist_cdf(_tdist(d, "pt"), x, "pt")
eq_qt(p, d) = _dist_quantile(_tdist(d, "qt"), p, "qt")
eq_rt(m, d) = _dist_random(_tdist(d, "rt"), m, "rt")

# Uniform(a,b).
function _uniform(a, b, name)
    low = _dist_real(a, name, "a")
    high = _dist_real(b, name, "b")
    low < high || eqerror("$name: b must be greater than a")
    Distributions.Uniform(low, high)
end
eq_dunif(x, a, b) = _dist_density(_uniform(a, b, "dunif"), x, "dunif")
eq_punif(x, a, b) = _dist_cdf(_uniform(a, b, "punif"), x, "punif")
eq_qunif(p, a, b) = _dist_quantile(_uniform(a, b, "qunif"), p, "qunif")
eq_runif(m, a, b) = _dist_random(_uniform(a, b, "runif"), m, "runif")

# the reference application Weibull has unit scale and shape s.
function _weibull(s, name)
    Distributions.Weibull(_dist_positive(s, name, "s"), 1.0)
end
eq_dweibull(x, s) = _dist_density(_weibull(s, "dweibull"), x, "dweibull")
eq_pweibull(x, s) = _dist_cdf(_weibull(s, "pweibull"), x, "pweibull")
eq_qweibull(p, s) = _dist_quantile(_weibull(s, "qweibull"), p, "qweibull")
eq_rweibull(m, s) = _dist_random(_weibull(s, "rweibull"), m, "rweibull")

"Standard normal cumulative probability (cnorm)."
eq_cnorm(x) = _elementwise_map(x) do value
    Distributions.cdf(Distributions.Normal(), _dist_real(value, "cnorm", "x"))
end
