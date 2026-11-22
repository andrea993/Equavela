@testset "distribution densities and cumulative probabilities" begin
    @test eq_dbeta(0.5, 1, 1) ≈ 1
    @test eq_pbeta(0.5, 1, 1) ≈ 0.5
    @test eq_dbinom(2, 4, 0.5) ≈ 6 / 16
    @test eq_pbinom(1.5, 4, 0.5) ≈ 5 / 16
    @test eq_dcauchy(0, 0, 1) ≈ 1 / π
    @test eq_dchisq(2, 2) ≈ exp(-1) / 2
    @test eq_dexp(0.5, 2) ≈ 2exp(-1)
    @test eq_pexp(0.5, 2) ≈ 1 - exp(-1)
    @test eq_dF(1, 2, 2) ≈ 1 / 4
    @test eq_dgamma(1, 2) ≈ exp(-1)
    @test eq_dgeom(2, 0.25) ≈ 0.25 * 0.75^2
    @test eq_pgeom(1.5, 0.25) ≈ 1 - 0.75^2
    @test eq_dhypergeom(1, 3, 2, 2) ≈ 6 / 10
    @test eq_dlnorm(1, 0, 1) ≈ 1 / sqrt(2π)
    @test eq_dlogis(0, 0, 1) ≈ 0.25
    @test eq_dnbinom(2, 3, 0.5) ≈ 6 / 32
    @test eq_dnorm(0, 0, 1) ≈ 1 / sqrt(2π)
    @test eq_pnorm(0, 0, 1) ≈ 0.5
    @test eq_dpois(2, 3) ≈ 9exp(-3) / 2
    @test eq_dt(0, 1) ≈ 1 / π
    @test eq_dunif(2, 0, 4) ≈ 0.25
    @test eq_dweibull(1, 2) ≈ 2exp(-1)
    @test eq_pweibull(1, 2) ≈ 1 - exp(-1)
    @test eq_cnorm(0) ≈ 0.5
    @test eq_pcauchy(0, 0, 1) ≈ 0.5
    @test eq_pchisq(2, 2) ≈ 1 - exp(-1)
    @test eq_pF(1, 2, 2) ≈ 0.5
    @test eq_pgamma(1, 2) ≈ 1 - 2exp(-1)
    @test eq_phypergeom(1, 3, 2, 2) ≈ 0.7
    @test eq_plnorm(1, 0, 1) ≈ 0.5
    @test eq_plogis(0, 0, 1) ≈ 0.5
    @test eq_pnbinom(0, 3, 0.5) ≈ 0.125
    @test eq_ppois(0, 3) ≈ exp(-3)
    @test eq_pt(0, 1) ≈ 0.5
    @test eq_punif(2, 0, 4) ≈ 0.5
    @test eq_dbinom(1.5, 4, 0.5) == 0
    @test eq_pbinom(-1, 4, 0.5) == 0
    @test eq_dexp(-1, 2) == 0
    @test eq_pexp(-1, 2) == 0
    @test eq_dnorm(reshape([0, 1], :, 1), 0, 1) ≈ reshape([1 / sqrt(2π), exp(-0.5) / sqrt(2π)], :, 1)
    @test eq_dgeom(reshape([0, 1], :, 1), 0.5) ≈ reshape([0.5, 0.25], :, 1)
    @test eq_pgeom(reshape([0, 1], :, 1), 0.5) ≈ reshape([0.5, 0.75], :, 1)
    @test eq_cnorm(reshape([0, 1], :, 1)) ≈ reshape([0.5, 0.8413447460685429], :, 1)
end

@testset "distribution quantiles" begin
    @test eq_qbeta(0.5, 1, 1) ≈ 0.5
    @test eq_qbeta(0, 1, 1) == 0
    @test eq_qbeta(1, 1, 1) == 1
    @test eq_qbinom(0.5, 4, 0.5) == 2
    @test eq_qexp(0.5, 2) ≈ log(2) / 2
    @test eq_qgamma(0.5, 1) ≈ log(2)
    @test eq_qgeom(0.5, 0.5) == 0
    @test eq_qnorm(0.5, 2, 3) ≈ 2
    @test eq_qnorm(0, 2, 3) == -Inf
    @test eq_qnorm(1, 2, 3) == Inf
    @test eq_qbinom(1, 4, 0.5) == 4
    @test eq_qgeom(1, 0.5) == Inf
    @test eq_qunif(0.25, 2, 6) ≈ 3
    @test eq_qweibull(1 - exp(-1), 2) ≈ 1
    @test eq_qlogis(0.5, 4, 2) ≈ 4
    @test eq_qt(0.5, 4) == 0
    @test eq_qcauchy(0.5, 2, 1) ≈ 2
    @test eq_qchisq(1 - exp(-1), 2) ≈ 2
    @test eq_qF(0.5, 2, 2) ≈ 1
    @test eq_qhypergeom(0.5, 3, 2, 2) == 1
    @test eq_qlnorm(0.5, 0, 1) ≈ 1
    @test eq_qnbinom(0.1, 3, 0.5) == 0
    @test eq_qpois(exp(-3) / 2, 3) == 0
end

@testset "random distribution vectors and validation" begin
    for values in (eq_rbeta(3, 2, 3), eq_rbinom(3, 4, 0.5), eq_rcauchy(3, 0, 1),
                   eq_rchisq(3, 2), eq_rexp(3, 2), eq_rF(3, 2, 2), eq_rgamma(3, 2),
                   eq_rgeom(3, 0.5), eq_rhypergeom(3, 3, 2, 2), eq_rlnorm(3, 0, 1),
                   eq_rlogis(3, 0, 1), eq_rnbinom(3, 3, 0.5), eq_rnorm(3, 0, 1),
                   eq_rpois(3, 2), eq_rt(3, 4), eq_runif(3, -1, 1), eq_rweibull(3, 2))
        @test size(values) == (3, 1)
        @test eltype(values) == Float64
    end

    EqRuntime._reset_random!(19)
    expected = eq_rnorm(4, 0, 1)
    EqRuntime._reset_random!(19)
    @test_throws EqError eq_rbeta(0, 2, 3)
    @test_throws EqError eq_rbinom(2, -1, 0.5)
    @test_throws EqError eq_rexp(2, 0)
    @test_throws EqError eq_rgeom(2, 0)
    @test_throws EqError eq_rhypergeom(2, 1, 1, 3)
    @test_throws EqError eq_rbinom(2, 1e20, 0.5)
    @test_throws EqError eq_rhypergeom(2, 6e18, 6e18, 1)
    @test eq_rnorm(4, 0, 1) == expected

    @test_throws EqError eq_qbeta(1.1, 2, 3)
    @test_throws EqError eq_dnorm(0, 0, 0)
    @test_throws EqError eq_dnorm(0, eq_mul(2, eq_unit("m")), 1)
    @test_throws EqError eq_dbinom(1, 2.5, 0.5)
    @test_throws EqError eq_dgeom(1.5, -0.1)

    EqRuntime._reset_random!(23)
    expected = eq_rnorm(4, 0, 1)
    EqRuntime._reset_random!(23)
    eq_rbeta(1, 2, 3)
    after_beta = eq_rnorm(4, 0, 1)
    @test after_beta != expected
    EqRuntime._reset_random!(23)
    @test eq_rbeta(1, 2, 3) == (EqRuntime._reset_random!(23); eq_rbeta(1, 2, 3))
end
