# Differential equation solvers against closed-form solutions.
col(v) = reshape(Float64.(collect(v)), :, 1)

@testset "Initial value solvers" begin
    decay(x, y) = [-2 * y[1]]
    exact = exp(-2.0)
    for solver in (EqRuntime.eq_rkfixed, EqRuntime.eq_Rkadapt, EqRuntime.eq_Bulstoer, EqRuntime.eq_Adams,
                   EqRuntime.eq_BDF, EqRuntime.eq_Radau, EqRuntime.eq_AdamsBDF)
        table = solver(col([1]), 0, 1, 10, decay)
        @test size(table) == (11, 2)
        @test table[:, 1] ≈ collect(0:0.1:1)
        @test table[1, 2] == 1
        @test table[end, 2] ≈ exact atol = 1e-4
    end
    @test EqRuntime.eq_Bulstoer(col([1]), 0, 1, 10, decay)[end, 2] ≈ exact atol = 1e-10
    jacobian_extended(x, y) = [0.0 -2.0]
    @test EqRuntime.eq_Stiffb(col([1]), 0, 1, 10, decay, jacobian_extended)[end, 2] ≈ exact atol = 1e-7
    @test EqRuntime.eq_Stiffr(col([1]), 0, 1, 10, decay, jacobian_extended)[end, 2] ≈ exact atol = 1e-5
    oscillator(x, y) = [y[2]; -y[1]]
    table = EqRuntime.eq_Rkadapt(col([0, 1]), 0, pi, 4, oscillator)
    @test size(table) == (5, 3)
    @test table[end, 2:3] ≈ [0, -1] atol = 1e-7
    @test EqRuntime.eq_rkfixed(col([0, 1]), 0, pi, 200, oscillator)[end, 2] ≈ 0 atol = 1e-6
    backwards = EqRuntime.eq_Rkadapt(col([exp(-2.0)]), 1, 0, 4, decay)
    @test backwards[end, 2] ≈ 1 atol = 1e-6
    @test_throws EqError EqRuntime.eq_rkfixed(col([1]), 0, 1, 10, 5)
    @test_throws EqError EqRuntime.eq_rkfixed(col([1]), 0, 1, 0, decay)
    @test_throws EqError EqRuntime.eq_rkfixed(col([1]), 0, 1, 10, (x, y) -> [1.0, 2.0])
end

@testset "Stiff systems and mass matrices" begin
    stiff(x, y) = [-1000 * (y[1] - cos(x))]
    reference = (1000^2 * cos(1) + 1000 * sin(1)) / (1000^2 + 1)
    jacobian(x, y) = [-1000.0;;]
    augmented(x, y) = [1000 * -sin(x) -1000.0]
    @test EqRuntime.eq_BDF(col([0]), 0, 1, 10, stiff, jacobian)[end, 2] ≈ reference atol = 1e-6
    @test EqRuntime.eq_Radau(col([0]), 0, 1, 10, stiff)[end, 2] ≈ reference atol = 1e-6
    @test EqRuntime.eq_Stiffb(col([0]), 0, 1, 10, stiff, augmented)[end, 2] ≈ reference atol = 1e-6
    @test EqRuntime.eq_Stiffr(col([0]), 0, 1, 10, stiff, augmented)[end, 2] ≈ reference atol = 1e-5
    @test EqRuntime.eq_AdamsBDF(col([0]), 0, 1, 10, stiff)[end, 2] ≈ reference atol = 1e-6
    # y1' = -y1, 0 = y1 - y2 (singular mass matrix): y2 follows y1.
    algebraic(x, y) = [-y[1]; y[1] - y[2]]
    table = EqRuntime.eq_Radau(col([1, 1]), 0, 1, 4, algebraic, [1.0 0; 0 0])
    @test table[end, 2] ≈ exp(-1) atol = 1e-6
    @test table[end, 3] ≈ exp(-1) atol = 1e-6
    @test_throws EqError EqRuntime.eq_Stiffb(col([1]), 0, 1, 4, stiff, (x, y) -> [1.0 2.0 3.0])
end

@testset "statespace" begin
    rotation(t) = [0.0 1; -1 0]
    table = EqRuntime.eq_statespace(col([0, 1]), 0, pi, 4, rotation)
    @test size(table) == (5, 3)
    @test table[end, 2:3] ≈ [0, -1] atol = 1e-7
    forced = EqRuntime.eq_statespace(col([0]), 0, 1, 2, [0.0;;], [1.0;;], t -> [2.0])
    @test forced[:, 2] ≈ [0, 1, 2]
    @test_throws EqError EqRuntime.eq_statespace(col([0]), 0, 1, 2, [0.0;;], [1.0;;])
end

@testset "Shooting methods" begin
    oscillator(x, y) = [y[2]; -y[1]]
    load(x, v) = [0.0, v[1]]
    score(x, y) = [y[1] - 1.0]
    @test EqRuntime.eq_sbval(col([0.5]), 0, pi / 2, oscillator, load, score) ≈ col([1]) atol = 1e-8
    load1(x, v) = [0.0, v[1]]
    load2(x, v) = [1.0, v[1]]
    @test EqRuntime.eq_bvalfit(col([0.5]), col([0.5]), 0, pi / 2, pi / 4, oscillator, load1, load2, (x, y) -> y) ≈ [1.0 0.0] atol = 1e-7
    @test_throws EqError EqRuntime.eq_sbval(col([0.5]), 0, 1, oscillator, load, (x, y) -> [y[1], y[2]])
end

@testset "Partial differential equations" begin
    heat(x, t, u, ux, uxx) = [uxx[1]]
    result = EqRuntime.eq_numol(col([0, 1]), 21, col([0, 0.1]), 3, 1, 0, heat, x -> [sin(pi * x)], t -> Any[0.0 0.0 "D"])
    @test size(result) == (21, 3)
    @test result[:, 1] ≈ sin.(pi .* range(0, 1; length=21))
    @test result[11, 3] ≈ exp(-pi^2 * 0.1) atol = 5e-3
    @test result[1, 3] ≈ 0 atol = 1e-12
    @test result[end, 3] ≈ 0 atol = 1e-12
    neumann = EqRuntime.eq_numol(col([0, 1]), 21, col([0, 0.1]), 2, 1, 0, heat, x -> [cos(pi * x)], Any[0.0 0.0 "N"])
    @test neumann[1, 2] ≈ exp(-pi^2 * 0.1) atol = 5e-3
    system = (x, t, u, ux, uxx) -> [uxx[1]; u[2] - u[1]]
    coupled = EqRuntime.eq_numol(col([0, 1]), 11, col([0, 0.05]), 2, 1, 1, system, x -> [sin(pi * x), sin(pi * x)], t -> Any[0.0 0.0 "D"])
    @test size(coupled) == (11, 4)
    @test coupled[:, 4] ≈ coupled[:, 2] atol = 1e-6
    @test coupled[:, 3] ≈ coupled[:, 1] atol = 1e-6
    @test_throws EqError EqRuntime.eq_numol(col([0, 1]), 21, col([0, 1]), 2, 1, 0, heat, x -> [1.0], Any[0.0 0.0 "Q"])

    # the reference application's x scheme: the five-point fourth-order difference,
    # exact for a polynomial of degree 4, and the same difference applied twice for u_xx.
    grid = collect(range(0, 1; length=7))
    @test EqRuntime._numol_derivative(grid .^ 4, 1 / 6) ≈ 4 .* grid .^ 3 atol = 1e-12
    # Saved reference values: u_t = u_xx, u(x, 0) = sin(pi x),
    # 7 points, t = 0, 0.05, 0.1. the reference application's own time integration is good to about 1e-6.
    prime7 = [0 0 0
        0.5000000000014733 0.3051598823513163 0.18651655640134052
        0.8660254037861398 0.5285480765037226 0.32293828571337924
        1 0.611354802791271 0.37358234737695195
        0.8660254037810364 0.528548076502628 0.3229382857167513
        0.4999999999926342 0.30515988235014996 0.18651655640309314
        0 0 0]
    seven = EqRuntime.eq_numol(col([0, 1]), 7, col([0, 0.1]), 3, 1, 0, heat, x -> [sin(3.14159265358979 * x)], t -> Any[0.0 0.0 "D"])
    @test seven ≈ prime7 atol = 5e-6
    # Neumann ends, 9 points, u(x, 0) = cos(pi x): the reference application's values at x = 0 and x = 0.125 for t = 0.05 and 0.1.
    nine = EqRuntime.eq_numol(col([0, 1]), 9, col([0, 0.1]), 3, 1, 0, heat, x -> [cos(3.14159265358979 * x)], t -> Any[0.0 0.0 "N"])
    @test nine[1, 2:3] ≈ [0.6106930013645865, 0.37307107499515185] atol = 5e-6
    @test nine[2, 2:3] ≈ [0.5642693507259358, 0.3446657206586763] atol = 5e-6
    # u_t = u_xx + 2 u_x, Dirichlet, 9 points: the reference application's values at x = 0.125 and x = 0.5.
    drift = EqRuntime.eq_numol(col([0, 1]), 9, col([0, 0.1]), 3, 1, 0, (x, t, u, ux, uxx) -> [uxx[1] + 2ux[1]],
        x -> [sin(3.14159265358979 * x)], t -> Any[0.0 0.0 "D"])
    @test drift[2, 2:3] ≈ [0.30444288942166214, 0.1878740762297414] atol = 5e-6
    @test drift[5, 2:3] ≈ [0.5903214698595043, 0.34318445921774904] atol = 5e-6
    # the reference application: "There are too few spatial discretization points" below 6.
    @test_throws EqError EqRuntime.eq_numol(col([0, 1]), 5, col([0, 0.1]), 2, 1, 0, heat, x -> [1.0], Any[0.0 0.0 "N"])

    n = 9
    ones_matrix = ones(n, n)
    boundary = zeros(n, n)
    boundary[:, end] .= 1
    relaxed = EqRuntime.eq_relax(ones_matrix, ones_matrix, ones_matrix, ones_matrix, fill(-4.0, n, n), zeros(n, n), boundary, cos(pi / n))
    @test relaxed[5, 5] ≈ 0.25 atol = 1e-4
    @test relaxed[:, end] == boundary[:, end]
    @test_throws EqError EqRuntime.eq_relax(ones_matrix, ones_matrix, ones_matrix, ones_matrix, fill(-4.0, n, n), zeros(n, n), boundary, 1.5)

    grid = range(0, 1; length=17)
    source = [-2pi^2 * sin(pi * x) * sin(pi * y) for x in grid, y in grid]
    solved = EqRuntime.eq_multigrid(source, 2)
    @test maximum(abs.(solved .- [sin(pi * x) * sin(pi * y) for x in grid, y in grid])) < 0.01
    @test_throws EqError EqRuntime.eq_multigrid(zeros(6, 6), 2)
    # the reference application's numbers for a unit source in the centre of a 9 x 9 grid: the cycles are not converged.
    centred = zeros(9, 9); centred[5, 5] = 1
    @test EqRuntime.eq_multigrid(centred, 1)[5, 5] ≈ -0.00732421875
    @test EqRuntime.eq_multigrid(centred, 1)[2, 2] ≈ -0.00030517578125
    @test EqRuntime.eq_multigrid(centred, 2)[5, 5] ≈ -0.007659912109375
    @test EqRuntime.eq_multigrid(centred, 3)[2, 2] ≈ -0.0002586245536804199
    @test EqRuntime.eq_multigrid(centred, 10)[5, 5] ≈ -0.007640165441181068
    centre5 = zeros(5, 5); centre5[3, 3] = 1
    @test EqRuntime.eq_multigrid(centre5, 1)[3, 3] ≈ -0.0234375
    # And for relax (the reference application's stopping rule): rjac = 0.5 and 0.95.
    five = ones(5, 5); source5 = zeros(5, 5); source5[3, 3] = 1
    @test EqRuntime.eq_relax(five, five, five, five, fill(-4.0, 5, 5), source5, zeros(5, 5), 0.5)[3, 3] ≈ -0.3749997583998037
    @test EqRuntime.eq_relax(five, five, five, five, fill(-4.0, 5, 5), source5, zeros(5, 5), 0.95)[3, 3] ≈ -0.3749996721489395
    # A nonzero boundary and no source: the reference application stops after 11 sweeps for rjac = 0.8.
    edge = zeros(5, 5); edge[1, :] .= 1
    @test EqRuntime.eq_relax(five, five, five, five, fill(-4.0, 5, 5), zeros(5, 5), edge, 0.8)[3, 3] ≈ 0.25000023592185733
end

@testset "odesolve" begin
    equation = (t, y) -> EqRuntime.eq_sub(EqRuntime.eq_add(EqRuntime.eq_derivative(y, t, 2), y(t)), 0.0)
    start = y -> EqRuntime.eq_sub(y(0.0), 0.0)
    slope = y -> EqRuntime.eq_sub(EqRuntime.eq_derivative(y, 0.0, 1), 1.0)
    solution = EqRuntime.eq_odesolve([equation], [start, slope], 1, pi, nothing, false)
    @test solution(1.0) ≈ sin(1.0) atol = 1e-8
    @test_throws EqError solution(10.0)
    boundary = y -> EqRuntime.eq_sub(y(pi / 2), 1.0)
    shot = EqRuntime.eq_odesolve([equation], [start, boundary], 1, pi / 2, 50, false)
    @test shot(0.5) ≈ sin(0.5) atol = 1e-7
    first_equation = (t, x, y) -> EqRuntime.eq_sub(EqRuntime.eq_derivative(x, t, 1), y(t))
    second_equation = (t, x, y) -> EqRuntime.eq_add(EqRuntime.eq_derivative(y, t, 1), x(t))
    x0 = (x, y) -> EqRuntime.eq_sub(x(0.0), 1.0)
    y0 = (x, y) -> y(0.0)
    pair = EqRuntime.eq_odesolve([first_equation, second_equation], [x0, y0], 2, 2.0, 100, true)
    @test size(pair) == (2, 1)
    @test pair[1](1.0) ≈ cos(1.0) atol = 1e-8
    @test pair[2](1.0) ≈ -sin(1.0) atol = 1e-8
    @test_throws EqError EqRuntime.eq_odesolve([equation], [start], 1, 1.0, nothing, false)
    @test_throws EqError EqRuntime.eq_odesolve([equation, equation], [start, slope], 1, 1.0, nothing, false)
end
