@testset "special functions" begin
    @test eq_J0(0) ≈ 1
    @test eq_J1(0) ≈ 0
    @test eq_Jn(0.5, 1) ≈ sqrt(2 / π) * sin(1)
    @test eq_Yn(0.5, 1) ≈ -sqrt(2 / π) * cos(1)
    @test eq_I0(0) ≈ 1
    @test eq_I1(0) ≈ 0
    @test eq_Kn(0.5, 1) ≈ sqrt(π / 2) * exp(-1)
    @test eq_H1(0, 1) ≈ eq_J0(1) + im * eq_Y0(1)
    @test eq_H2(0, 1) ≈ eq_J0(1) - im * eq_Y0(1)
    @test eq_Jn_sc(0.5, 1 + im) ≈ eq_Jn(0.5, 1 + im) * exp(-1)
    @test eq_H1_sc(0, 1 + im) ≈ eq_H1(0, 1 + im) * exp(-im * (1 + im))
    @test eq_Ai(0) ≈ 0.3550280538878172
    @test eq_DAi(0) ≈ -0.2588194037928068
    @test eq_Bi(0) ≈ 0.6149266274460007
    @test eq_DBi(0) ≈ 0.4482883573538264
    @test eq_Ai_sc(-1) ≈ eq_Ai(-1) * exp(-2im / 3)
    @test eq_Ai_sc(1) ≈ eq_Ai(1) * exp(2 / 3)
    @test eq_Bi_sc(1) ≈ eq_Bi(1) * exp(-2 / 3)
    @test eq_ber(0, 0) ≈ 1
    @test eq_bei(0, 0) ≈ 0
    # Saved reference values where they agree with the
    # mathematical function: the limits at 0, a complex digamma.
    # Poles and overflow are errors, as in the reference application.
    for f in (() -> eq_Γ(0), () -> eq_Γ(-2), () -> eq_Γ(172), () -> eq_lnΓ(0), () -> eq_Psi(0), () -> eq_fhyper(1, 2, -2, 0.5))
        @test_throws EqError f()
    end
    # Psi(n, y) is the polygamma function: Psi(0, y) is Psi(y), Psi(1, y) the trigamma.
    @test eq_Psi(0, 2.5) ≈ eq_Psi(2.5)
    @test eq_Psi(1, 2.5) ≈ 0.49035775610023485
    @test eq_Psi(2, 2.5) ≈ -0.23620405164172736
    @test eq_Psi(1, complex(1, 2)) ≈ 0.12493116214094457 - 0.4778255501472298im
    @test eq_Psi(1, reshape([1.0, 2.0], :, 1)) ≈ reshape([π^2 / 6, π^2 / 6 - 1], :, 1)
    @test_throws EqError eq_Psi(1.5, 2.5)
    @test_throws EqError eq_Psi(-1, 2.5)
    @test_throws EqError eq_Psi(1, 0)
    @test eq_js(0, 0) === 1.0
    @test eq_js(1, 0) === 0.0
    @test_throws EqError eq_ys(1, 0)
    @test eq_Psi(complex(1, 2)) ≈ 0.7145915153739775 + 1.3208072826422304im
    # An integer order on the negative axis is real: j1 is odd and y1 is even (the reference application's own values have
    # the opposite sign, which is not the mathematical function).
    @test eq_js(1, -2.5) ≈ -0.41621298927540684
    @test eq_js(1, -2.5) isa Real
    @test eq_ys(1, -2.5) ≈ -0.1112058791540733
    @test eq_js(0, 1) ≈ sin(1)
    @test eq_ys(0, 1) ≈ -cos(1)
    @test eq_erf(0) == 0
    @test eq_erfc(1 + im) ≈ 1 - eq_erf(1 + im)
    @test eq_Γ(5) ≈ 24
    @test isfinite(eq_Γ(200, 1000))
    @test eq_Γ(200, 1000) > 0
    @test eq_Γ(2, 1) ≈ 2exp(-1)
    @test eq_Γ(2, 0) ≈ 1
    @test eq_lnΓ(5) ≈ log(24)
    @test eq_Psi(1) ≈ -Base.MathConstants.eulergamma
    @test eq_fhyper(0, 1, 0, 0.5) == 1
    @test eq_fhyper(1, 1, 2, 0.5) ≈ 2log(2)
    @test eq_mhyper(1, 1, 1) ≈ exp(1)
    @test eq_ibeta(0.25, 2, 1) ≈ 0.25^2
    @test eq_ibeta(1, 2, 3) ≈ 1
    @test eq_Jac(2, 0, 0, 0.3) ≈ (3 * 0.3^2 - 1) / 2
    @test eq_Jn(reshape([0.0, 1.0], 2, 1), reshape([1.0, 2.0], 2, 1)) ≈ reshape([eq_J0(1), eq_J1(2)], 2, 1)
    @test_throws EqError eq_ibeta(1.1, 2, 2)
    @test_throws EqError eq_Γ(-1, 1)
    @test_throws EqError eq_Y0(0)
    @test_throws EqError eq_ber(0.5, 1)
    @test_throws EqError eq_Jac(Float64(typemax(Int)), 0, 0, 0.5)
end
